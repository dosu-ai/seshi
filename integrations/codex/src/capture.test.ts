import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CaptureHost, hookHandler } from "@seshi/kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CODEX_CAPTURE,
  chainedNotify,
  codexInstaller,
  identifyRollout,
  isSeshiNotify,
  locateRollout,
  topLevelAssignment,
  withNotify,
} from "./capture";

const HOOKS = join(import.meta.dirname, "../testdata/hooks");
const TRANSCRIPTS = join(import.meta.dirname, "../testdata/transcripts");
const payload = (name: string) => JSON.parse(readFileSync(join(HOOKS, `${name}.json`), "utf8"));

let home: string;
let host: CaptureHost;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "seshi-codex-"));
  host = { env: {}, home, platform: "linux" };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("Codex's notify (F9.2)", () => {
  const notify = hookHandler(CODEX_CAPTURE, "notify");

  it("captures the thread after a finished turn, nothing for other notifications", () => {
    expect(notify?.parse(payload("notify"), host)).toEqual({
      captures: [
        { session_id: "01a0ff74-a68d-7ad0-83ee-80cf02c29b14", cwd: "/Users/dev/code/app" },
      ],
    });
    expect(notify?.parse(payload("notify-other"), host)).toEqual({ captures: [] });
    expect(() => notify?.parse({ type: "agent-turn-complete" }, host)).toThrow("thread-id");
  });
});

describe("Codex's rollouts", () => {
  it("are known by their own session_meta, a fork by its parent", () => {
    const head = readFileSync(join(TRANSCRIPTS, "codex-forked-subagent.codex.jsonl"), "utf8");
    expect(
      identifyRollout("/s/2026/10/02/rollout-2026-10-02T10-00-00-01a0ff74.jsonl", head),
    ).toEqual({
      session_id: "01a0ff74-c903-73c2-b6b1-7546b84710ff",
      cwd: "/repo/app",
      started_at: "2026-10-02T10:00:00.000Z",
      parent_session_id: "01a0ff74-a68d-7ad0-83ee-80cf02c29b14",
    });
    expect(identifyRollout("/s/other.jsonl", head)).toBeNull();
    expect(identifyRollout("/s/rollout-x.jsonl", '{"type":"response_item"}\n')).toBeNull();
  });

  it("are found by thread id, newest day first, under CODEX_HOME when set", () => {
    const sessions = join(home, ".codex", "sessions");
    for (const [day, name] of [
      ["2026/10/01", "rollout-2026-10-01T09-00-00-t1.jsonl"],
      ["2026/10/02", "rollout-2026-10-02T09-00-00-t2.jsonl"],
    ] as const) {
      mkdirSync(join(sessions, day), { recursive: true });
      writeFileSync(join(sessions, day, name), "{}\n");
    }
    expect(locateRollout("t1", host)).toBe(
      join(sessions, "2026/10/01", "rollout-2026-10-01T09-00-00-t1.jsonl"),
    );
    expect(locateRollout("t3", host)).toBeUndefined();
    expect(CODEX_CAPTURE.sweep[0]?.resolve?.({ ...host, env: { CODEX_HOME: "/c" } })).toBe(
      "/c/sessions",
    );
    expect(CODEX_CAPTURE.sweep[0]?.match("2026/10/01/rollout-x.jsonl")).toBe(true);
    expect(CODEX_CAPTURE.sweep[0]?.match("2026/10/01/other.jsonl")).toBe(false);
  });
});

describe("config.toml's notify", () => {
  it("finds a top-level assignment, multi-line, before the first table only", () => {
    const text =
      '# top\nnotify = [\n  "a", # one\n  "b]",\n]\nmodel = "o3"\n[tui]\nnotify = true\n';
    const at = topLevelAssignment(text, "notify");
    expect(text.slice(at?.start, at?.end)).toBe('notify = [\n  "a", # one\n  "b]",\n]\n');
    expect(topLevelAssignment("[tui]\nnotify = true\n", "notify")).toBeNull();
  });

  it("sets and removes it, leaving the rest as written", () => {
    const text = 'model = "o3"\n\n[tui]\nnotify = true\n';
    const set = withNotify(text, ["seshi", "hook", "codex", "notify"]);
    expect(set).toBe(
      'notify = ["seshi","hook","codex","notify"]\nmodel = "o3"\n\n[tui]\nnotify = true\n',
    );
    expect(withNotify(set, null)).toBe(text);
  });

  it("tells seshi's notify from others, and what it chains to", () => {
    expect(isSeshiNotify(["/usr/local/bin/seshi", "hook", "codex", "notify"])).toBe(true);
    expect(isSeshiNotify(["notify-send", "codex"])).toBe(false);
    expect(chainedNotify(["seshi", "hook", "codex", "notify", "--", "say", "hi"])).toEqual([
      "say",
      "hi",
    ]);
  });
});

describe("the installer (F9.6)", () => {
  const config = () => join(home, ".codex", "config.toml");
  const context = { command: ["seshi"] };

  it("points notify at seshi and keeps the program that was there, run after seshi", async () => {
    mkdirSync(join(home, ".codex"));
    writeFileSync(
      config(),
      'model = "o3"\nnotify = ["notify-send", "Codex"]\n\n[profiles.x]\nmodel = "o4"\n',
    );
    const report = await codexInstaller.install({ ...host, ...context });
    expect(report.notes[0]).toContain("notify-send Codex");
    const parsed = Bun.TOML.parse(readFileSync(config(), "utf8")) as Record<string, unknown>;
    expect(parsed.notify).toEqual([
      "seshi",
      "hook",
      "codex",
      "notify",
      "--",
      "notify-send",
      "Codex",
    ]);
    expect(parsed.model).toBe("o3");
    expect(parsed.profiles).toEqual({ x: { model: "o4" } });
    // Twice is once: the chain is not nested.
    await codexInstaller.install({ ...host, command: ["/opt/seshi"] });
    expect((Bun.TOML.parse(readFileSync(config(), "utf8")) as { notify: string[] }).notify).toEqual(
      ["/opt/seshi", "hook", "codex", "notify", "--", "notify-send", "Codex"],
    );
    expect((await codexInstaller.status({ ...host, ...context })).installed).toBe(true);
    // Uninstall puts the old program back.
    await codexInstaller.uninstall({ ...host, ...context });
    expect((Bun.TOML.parse(readFileSync(config(), "utf8")) as { notify: string[] }).notify).toEqual(
      ["notify-send", "Codex"],
    );
  });

  it("knows its notify by a --command not named seshi, and unwinds one chained to itself", async () => {
    const notify = () =>
      (Bun.TOML.parse(readFileSync(config(), "utf8")) as { notify?: string[] }).notify;
    const npx = { ...host, command: ["npx", "seshi"] };
    await codexInstaller.install(npx);
    const second = await codexInstaller.install(npx);
    expect(second.notes).toEqual([]);
    expect(notify()).toEqual(["npx", "seshi", "hook", "codex", "notify"]);
    expect((await codexInstaller.status(npx)).installed).toBe(true);
    expect((await codexInstaller.uninstall({ ...host, ...context })).changed).toEqual([config()]);
    expect(notify()).toBeUndefined();

    // A wrapper with any name is known by the command it was installed with.
    const wrapper = { ...host, command: ["/usr/local/bin/my-wrapper"] };
    await codexInstaller.install(wrapper);
    await codexInstaller.install(wrapper);
    expect(notify()).toEqual(["/usr/local/bin/my-wrapper", "hook", "codex", "notify"]);
    expect((await codexInstaller.uninstall(wrapper)).changed).toEqual([config()]);
    expect(notify()).toBeUndefined();

    // What an older seshi left: its own notify chained after itself, then the user's program.
    writeFileSync(
      config(),
      `notify = ${JSON.stringify(["npx", "seshi", "hook", "codex", "notify", "--", "npx", "seshi", "hook", "codex", "notify", "--", "say", "hi"])}\n`,
    );
    await codexInstaller.install(npx);
    expect(notify()).toEqual(["npx", "seshi", "hook", "codex", "notify", "--", "say", "hi"]);
    await codexInstaller.uninstall({ ...host, ...context });
    expect(notify()).toEqual(["say", "hi"]);
    expect(isSeshiNotify(["notseshi", "hook", "codex", "notify"])).toBe(false);
    expect(isSeshiNotify(["hook", "codex", "notify"])).toBe(false);
  });

  it("creates the setting when there is none, and removes it all on uninstall", async () => {
    const report = await codexInstaller.install({ ...host, ...context });
    expect(report.changed).toEqual([config()]);
    await codexInstaller.uninstall({ ...host, ...context });
    expect(readFileSync(config(), "utf8")).toBe("");
    expect((await codexInstaller.uninstall({ ...host, ...context })).changed).toEqual([]);
  });

  it("refuses a config it cannot read, or a notify that is not words", async () => {
    mkdirSync(join(home, ".codex"));
    writeFileSync(config(), "notify = = [");
    await expect(codexInstaller.install({ ...host, ...context })).rejects.toThrow(/not valid TOML/);
    writeFileSync(config(), "notify = 3\n");
    await expect(codexInstaller.install({ ...host, ...context })).rejects.toThrow(/list of words/);
  });
});
