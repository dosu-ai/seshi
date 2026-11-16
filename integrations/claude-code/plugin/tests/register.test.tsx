/**
 * The Session Capture chip and /session-capture (F9.4), under `claude plugin test` (the engine's
 * own test kit; vitest does not run this file). The hooks registered on `on` here stand for the
 * engine and for the seshi CLI: `process.run` answers as `seshi statusline --json` and
 * `seshi capture off|on --json` would, from a small in-memory session state.
 */

import type { On } from "claude-code";
import { type Engine, expect, mock, test } from "claude-code/testing";

const SESSION = "s-1";
const SURFACES = ["terminal", "desktop"] as const;

const CHIP = {
  plugin: "seshi",
  component: "SessionMode",
  props: { modes: ["plan"] },
} as const;

const BAND = {
  plugin: "seshi",
  component: "AbovePrompt",
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 4,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 4 },
    view: {},
  },
} as const;

/** What the fake seshi knows, and every command line it was run with. */
type World = {
  capturing: boolean;
  /** Set when a shared rule keeps the session off whatever its toggle says. */
  excluded?: string;
  sent: boolean;
  problems: string[];
  missing?: boolean;
  calls: string[][];
};

/** The engine and seshi beneath the plugin, and a clock the test moves. */
function seshi(on: On, world: World) {
  const clock = mock.clock(on);
  // The engine's own drawing: the footer's mode labels, or the band's rows.
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text>plan mode</Text>;
  });
  on("session.id", () => ({ value: SESSION }));
  on("command.register", () => ({ value: { command: "session-capture" } }));
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("process.run", (_, e) => {
    const argv = [...e.argv];
    world.calls.push(argv);
    if (world.missing) throw new Error("spawn seshi ENOENT");
    const [, sub, which] = argv;
    if (sub === "statusline") {
      const capturing = world.capturing && world.excluded === undefined;
      const reason = world.excluded ?? (capturing ? "captured" : "turned off for this session");
      return {
        value: {
          exitCode: 0,
          stdout: JSON.stringify({ capturing, level: "session", reason, problems: world.problems }),
          stderr: "",
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      };
    }
    if (sub === "capture" && (which === "on" || which === "off")) {
      const retracting = which === "off" && world.sent;
      world.capturing = which === "on";
      return {
        value: {
          exitCode: 0,
          stdout: JSON.stringify({
            agent: "claude-code",
            session_id: SESSION,
            capture: which === "on",
            retracting,
            fresh: false,
            unfrozen: false,
          }),
          stderr: "",
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      };
    }
    return {
      value: {
        exitCode: 2,
        stdout: "",
        stderr: "usage: seshi …",
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    };
  });
  return clock;
}

/** `/session-capture <args>` typed at the prompt. */
const typed = ($: Engine, args: string) =>
  $.command.run({
    command: "session-capture",
    args,
    origin: { kind: "composer" },
    presentation: { isFullscreen: false, columns: 100 },
  });

const start = ($: Engine) =>
  $.session.start({ cwd: "/repo", surface: "desktop", isInteractive: true });

test("the chip shows what seshi says, on every surface, with the engine's mode labels", async ($, on) => {
  const world: World = { capturing: true, sent: true, problems: [], calls: [] };
  seshi(on, world);
  await start($);
  // It asked seshi about this session, by its id, on stdin.
  expect(world.calls[0]).toEqual(["seshi", "statusline", "--json", "--agent", "claude-code"]);
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...CHIP, surface });
    expect((await ui.find({ key: "session-capture" }))?.text).toBe("Session Capture ◉");
    expect(await ui.find({ type: "Text", text: /plan mode/ })).toBeDefined();
    await ui.unmount();
  }
});

test("the chip says ⏸ and what needs action when the session is not captured", async ($, on) => {
  const world: World = { capturing: false, sent: false, problems: ["3 queued"], calls: [] };
  seshi(on, world);
  await start($);
  const ui = await $.ui.mount({ ...CHIP, surface: "desktop" });
  expect((await ui.find({ key: "session-capture" }))?.text).toBe("Session Capture ⏸ · 3 queued");
  await ui.unmount();
});

test("without seshi on the PATH the chip says so, and a toggle says how to fix it", async ($, on) => {
  const world: World = { capturing: false, sent: false, problems: [], missing: true, calls: [] };
  seshi(on, world);
  await start($);
  const ui = await $.ui.mount({ ...CHIP, surface: "desktop" });
  expect((await ui.find({ key: "session-capture" }))?.text).toBe(
    "Session Capture ⏸ · seshi not found",
  );
  await ui.unmount();
  const answer = await typed($, "off");
  expect(answer.text).toContain("seshi was not found");
});

test("clicking the chip turns capture off, retracts, shows the banner for five seconds", async ($, on) => {
  const world: World = { capturing: true, sent: true, problems: [], calls: [] };
  const clock = seshi(on, world);
  await start($);
  for (const surface of SURFACES) {
    // Captured again, and the chip has asked seshi since (its half-minute refresh).
    world.capturing = true;
    await clock.advance(30_000);
    const chip = await $.ui.mount({ ...CHIP, surface });
    expect((await chip.find({ key: "session-capture" }))?.text).toBe("Session Capture ◉");
    await chip.press({ key: "session-capture" });
    expect(world.calls.at(-2)).toEqual([
      "seshi",
      "capture",
      "off",
      "--session",
      SESSION,
      "--agent",
      "claude-code",
      "--json",
    ]);
    expect((await chip.find({ key: "session-capture" }))?.text).toBe("Session Capture ⏸");
    await chip.unmount();

    const band = await $.ui.mount({ ...BAND, surface });
    expect((await band.find({ type: "Text" }))?.text).toBe(
      "⏸ Session Capture is off · retracting what was uploaded",
    );
    await band.unmount();
    await clock.advance(5_000);
    const later = await $.ui.mount({ ...BAND, surface });
    expect((await later.find({ type: "Text" }))?.text).toBe("plan mode");
    await later.unmount();
  }
});

test("/session-capture flips, sets, reports and refuses anything else", async ($, on) => {
  const world: World = { capturing: true, sent: true, problems: [], calls: [] };
  seshi(on, world);
  await start($);
  const run = (args: string) => typed($, args);

  expect((await run("")).text).toBe(
    "Session Capture is now OFF. What was uploaded is being retracted from the session store.",
  );
  expect((await run("ON")).text).toBe("Session Capture is now ON.");
  expect((await run("status")).text).toBe("Session Capture is ON: captured.");
  expect((await run("sometimes")).text).toBe("Usage: /session-capture [on|off|status]");
  // Nothing was run for the bad argument.
  expect(world.calls.filter((c) => c[1] === "capture")).toHaveLength(2);
});

test("turning it on where a shared rule keeps it off says so", async ($, on) => {
  const world: World = {
    capturing: false,
    excluded: "the repo turns capture off (.seshi/config.toml)",
    sent: false,
    problems: [],
    calls: [],
  };
  seshi(on, world);
  await start($);
  const answer = await typed($, "on");
  expect(answer.text).toBe(
    "Session Capture is on for this session, but it is still not captured: the repo turns capture off (.seshi/config.toml).",
  );
  const ui = await $.ui.mount({ ...CHIP, surface: "desktop" });
  expect((await ui.find({ key: "session-capture" }))?.text).toBe("Session Capture ⏸");
  await ui.unmount();
});

test("the chip asks seshi again every half minute", async ($, on) => {
  const world: World = { capturing: true, sent: true, problems: [], calls: [] };
  const clock = seshi(on, world);
  await start($);
  world.capturing = false;
  world.problems = ["sign in"];
  await clock.advance(30_000);
  const ui = await $.ui.mount({ ...CHIP, surface: "desktop" });
  expect((await ui.find({ key: "session-capture" }))?.text).toBe("Session Capture ⏸ · sign in");
  await ui.unmount();
});
