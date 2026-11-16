import type { EngineInterface, Register } from "claude-code";
import { atom, read, update } from "claude-code";

import type { Capture, CaptureShape } from "../types";

const LABEL = "Session Capture";
const CAPTURING = "◉";
const NOT_CAPTURING = "⏸";
const BANNER_MS = 5_000;
const REFRESH_MS = 30_000;
const USAGE = "Usage: /session-capture [on|off|status]";
const CAPTURE_SHAPE: CaptureShape = "capture-1";

const capture = atom({ plugin: "seshi", key: "capture" } as const, null, { shape: CAPTURE_SHAPE });
const banner = atom({ plugin: "seshi", key: "banner" } as const, null);

let hide: { cancel(): void } | undefined;
let tick: { cancel(): void } | undefined;

type Ran = { exitCode: number; stdout: string; stderr: string };

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

function firstLine(text: string): string | undefined {
  return text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function failure(ran: Ran): string {
  for (const text of [ran.stdout, ran.stderr]) {
    const parsed = tryParseJson(text) as { error?: unknown } | null | undefined;
    const said =
      parsed?.error && typeof parsed.error === "object" && "message" in parsed.error
        ? String((parsed.error as { message: unknown }).message)
        : typeof parsed?.error === "string"
          ? parsed.error
          : undefined;
    const line = said === undefined ? undefined : firstLine(said);
    if (line) return line;
  }
  return firstLine(`${ran.stderr}\n${ran.stdout}`) ?? `seshi exited ${ran.exitCode}`;
}

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

async function flash($: EngineInterface, text: string): Promise<void> {
  await update($, banner, () => text);
  hide?.cancel();
  hide = $.clock.after(BANNER_MS, () => {
    void update($, banner, () => null);
  });
}

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
    return `${LABEL} is now OFF.${retracting ? " What was uploaded is being retracted from the session store." : " Nothing of this session was uploaded."}`;
  }
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

function describe(now: Capture): string {
  const state = now.capturing ? "ON" : "OFF";
  const why = now.reason ? `: ${now.reason}` : "";
  const problems = now.problems.length > 0 ? ` (${now.problems.join(", ")})` : "";
  return `${LABEL} is ${state}${why}.${problems}`;
}

function chipLabel(now: Capture): string {
  const glyph = now.capturing ? CAPTURING : NOT_CAPTURING;
  return [`${LABEL} ${glyph}`, ...now.problems].join(" · ");
}

function startTicking($: EngineInterface, program: string): void {
  tick?.cancel();
  tick = $.clock.every(REFRESH_MS, () => {
    void refresh($, program);
  });
}

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
