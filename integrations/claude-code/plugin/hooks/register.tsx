/**
 * The Session Capture chip and `/session-capture` (F9.4–F9.6), for the Claude desktop app's
 * Code tab, which has no `statusLine` setting. Modelled on the Session Capture prototype
 * (dosu-ai/dosu PR 13997), wired to seshi:
 *
 * - The chip, in the footer's mode labels, reads `Session Capture ◉` while this session is
 *   captured and `Session Capture ⏸` when it is not (off, paused, excluded by a rule), with
 *   anything that needs action after a separator (B1.6). It asks `seshi statusline --json`, the
 *   same decision the hooks, the sweep and the terminal's status line make, so they never
 *   disagree. Clicking it turns capture off or on for this session.
 * - `/session-capture [on|off|status]` does the same by command.
 * - A toggle runs `seshi capture off|on --session <id>`, which writes the session's toggle in the
 *   local state, retracts what was uploaded when turned off (F9.7), and wakes the uploader. A
 *   banner above the prompt says what happened for five seconds.
 *
 * The state lives in seshi's own files, not in the mod: the chip shows what seshi will do, and a
 * new session starts from the capture rules, not from the last session's chip.
 */

import type { EngineInterface, Register } from "claude-code";
import { atom, read, update } from "claude-code";

import type { Capture } from "../types";

/** The label every surface uses (B1.6). */
const LABEL = "Session Capture";
const CAPTURING = "◉";
const NOT_CAPTURING = "⏸";
const BANNER_MS = 5_000;
/** How often the chip asks seshi again between turns: a pause or a rule can change meanwhile. */
const REFRESH_MS = 30_000;
const USAGE = "Usage: /session-capture [on|off|status]";

const capture = atom({ plugin: "seshi", key: "capture" } as const, null, { shape: "capture-1" });
const banner = atom({ plugin: "seshi", key: "banner" } as const, null);

/** The banner's hide timer and the refresh timer: the module's, so a reload drops them. */
let hide: { cancel(): void } | undefined;
let tick: { cancel(): void } | undefined;

type Ran = { exitCode: number; stdout: string; stderr: string };

/** Run the seshi CLI in the session's folder; undefined when it cannot start (not installed, or
 * not on the PATH the app runs commands with). */
async function seshi(
  $: EngineInterface,
  program: string,
  args: readonly string[],
  stdin?: string,
): Promise<Ran | undefined> {
  try {
    return await $.process.run([program, ...args], {
      timeoutMs: 15_000,
      ...(stdin === undefined ? {} : { stdin }),
    });
  } catch {
    return undefined;
  }
}

/** The first line of some text that has one. */
function firstLine(text: string): string | undefined {
  return text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
}

/** The CLI's own words for a failure: the first line of its JSON `error.message` (`--json`
 * prints `{"error":{"code","message"}}`), else the first line it printed. */
function failure(ran: Ran): string {
  for (const text of [ran.stdout, ran.stderr]) {
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      const said =
        parsed.error && typeof parsed.error === "object" && "message" in parsed.error
          ? String((parsed.error as { message: unknown }).message)
          : typeof parsed.error === "string"
            ? parsed.error
            : undefined;
      const line = said === undefined ? undefined : firstLine(said);
      if (line) return line;
    } catch {
      // not JSON: fall through to its first line
    }
  }
  return firstLine(`${ran.stderr}\n${ran.stdout}`) ?? `seshi exited ${ran.exitCode}`;
}

/** What seshi says of this session now, kept for the chip to draw. */
async function refresh($: EngineInterface, program: string): Promise<Capture> {
  const session_id = await $.session.id();
  const ran = await seshi(
    $,
    program,
    ["statusline", "--json", "--agent", "claude-code"],
    JSON.stringify({ session_id }),
  );
  let next: Capture;
  if (ran === undefined) {
    next = { capturing: false, reason: "seshi was not found", problems: ["seshi not found"] };
  } else {
    try {
      const said = JSON.parse(ran.stdout) as Partial<Capture>;
      next = {
        capturing: said.capturing === true,
        reason: typeof said.reason === "string" ? said.reason : "",
        problems: Array.isArray(said.problems) ? said.problems.map(String) : [],
      };
    } catch {
      next = { capturing: false, reason: failure(ran), problems: ["seshi failed"] };
    }
  }
  await update($, capture, () => next);
  return next;
}

/** Show the banner, and hide it five seconds after the last toggle. */
async function flash($: EngineInterface, text: string): Promise<void> {
  await update($, banner, () => text);
  hide?.cancel();
  hide = $.clock.after(BANNER_MS, () => {
    void update($, banner, () => null);
  });
}

/** Turn capture off or on for this session; the sentence to tell the person. */
async function setCapture(
  $: EngineInterface,
  program: string,
  which: "on" | "off",
): Promise<string> {
  const session_id = await $.session.id();
  const ran = await seshi($, program, [
    "capture",
    which,
    "--session",
    session_id,
    "--agent",
    "claude-code",
    "--json",
  ]);
  if (ran === undefined) {
    await refresh($, program);
    await flash($, `${NOT_CAPTURING} ${LABEL}: seshi was not found`);
    return `${LABEL} could not change: seshi was not found. Set its full path in the seshi plugin's options.`;
  }
  if (ran.exitCode !== 0) {
    await flash($, `${NOT_CAPTURING} ${LABEL} could not change`);
    return `${LABEL} could not change: ${failure(ran)}`;
  }
  let said: { retracting?: boolean; fresh?: boolean; unfrozen?: boolean } = {};
  try {
    said = JSON.parse(ran.stdout);
  } catch {
    said = {};
  }
  const now = await refresh($, program);
  if (which === "off") {
    const retracting = said.retracting === true;
    await flash(
      $,
      `${NOT_CAPTURING} ${LABEL} is off${retracting ? " · retracting what was uploaded" : ""}`,
    );
    return `${LABEL} is now OFF.${retracting ? " What was uploaded is being retracted from the server." : " Nothing of this session was uploaded."}`;
  }
  // On for this session, but a shared rule (a repo's capture = false, an org rule) or a broken
  // config can still keep it off: say so rather than claim it is captured.
  if (!now.capturing) {
    await flash($, `${NOT_CAPTURING} ${LABEL} is still off: ${now.reason}`);
    return `${LABEL} is on for this session, but it is still not captured: ${now.reason}.`;
  }
  await flash($, `${CAPTURING} ${LABEL} is on`);
  const more = [
    said.fresh ? "It is uploaded again from its start, as a new session." : "",
    said.unfrozen ? "A pause had stopped it: all of it is uploaded now." : "",
  ].filter(Boolean);
  return [`${LABEL} is now ON.`, ...more].join(" ");
}

/** `/session-capture status`: the chip's words, with why. */
function describe(now: Capture): string {
  const state = now.capturing ? "ON" : "OFF";
  const why = now.reason ? `: ${now.reason}` : "";
  const problems = now.problems.length > 0 ? ` (${now.problems.join(", ")})` : "";
  return `${LABEL} is ${state}${why}.${problems}`;
}

/** The chip's label: the name, then the glyph, then what needs action (B1.6). */
function chipLabel(now: Capture): string {
  const glyph = now.capturing ? CAPTURING : NOT_CAPTURING;
  return [`${LABEL} ${glyph}`, ...now.problems].join(" · ");
}

/** Ask seshi again every half minute; one timer per module load. */
function startTicking($: EngineInterface, program: string): void {
  tick?.cancel();
  tick = $.clock.every(REFRESH_MS, () => {
    void refresh($, program);
  });
}

/** The chip's click: the opposite of what it shows. */
async function toggle($: EngineInterface, program: string): Promise<void> {
  const now = (await read($, capture)) ?? (await refresh($, program));
  await setCapture($, program, now.capturing ? "off" : "on");
}

export const register: Register = (on, options) => {
  const program =
    typeof options.command === "string" && options.command.trim() !== ""
      ? options.command.trim()
      : "seshi";

  on("session.start", async ($, e, next) => {
    const started = await next(e);
    await $.command.register({
      name: "session-capture",
      description: "Turn Session Capture off or on for this session, or show its state",
    });
    await refresh($, program);
    startTicking($, program);
    return started;
  });

  // After each turn: the hooks have just spooled it, so the queue and any problem are fresh.
  on("turn.complete", async ($, e, next) => {
    const done = await next(e);
    await refresh($, program);
    return done;
  });

  on("command.run", { command: "session-capture" }, async ($, e) => {
    const arg = e.args.trim().toLowerCase();
    if (arg === "status") return { text: describe(await refresh($, program)) };
    if (arg !== "" && arg !== "on" && arg !== "off") return { text: USAGE };
    if (arg === "on" || arg === "off") return { text: await setCapture($, program, arg) };
    const now = (await read($, capture)) ?? (await refresh($, program));
    return { text: await setCapture($, program, now.capturing ? "off" : "on") };
  });

  // The chip, ahead of the engine's own mode labels.
  on("ui.render", { component: "SessionMode" }, async ($, e, next) => {
    const now = await read($, capture);
    const engine = await next(e);
    if (now === null) return engine;
    const { Box, Button } = $.ui.resolve(e);
    return (
      <Box key="seshi-session-mode" flexDirection="row" gap={1}>
        <Button
          key="session-capture"
          label={chipLabel(now)}
          plain
          dimColor
          onPress={() => toggle($, program)}
        />
        {engine}
      </Box>
    );
  });

  // The banner, for five seconds after a toggle; the band is the engine's otherwise.
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const text = await read($, banner);
    if (text === null || e.props.hasSurvey) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    return (
      <Box key="seshi-banner">
        <Text dimColor>{text}</Text>
      </Box>
    );
  });
};
