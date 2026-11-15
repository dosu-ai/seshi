import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CaptureHost, hookHandler } from "@seshi/kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_CAPTURE,
  CLAUDE_CODE_EVENTS,
  claudeAccountIds,
  claudeCodeInstaller,
  identifyClaudeTranscript,
  locateClaudeTranscript,
  SKILL_MARKER,
  seshiSkill,
} from "./capture";

const HOOKS = join(import.meta.dirname, "../testdata/hooks");
const payload = (name: string) => JSON.parse(readFileSync(join(HOOKS, `${name}.json`), "utf8"));

let home: string;
let host: CaptureHost;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "seshi-claude-"));
  host = { env: {}, home, platform: "linux" };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const parse = (event: string, body: unknown, h = host) => {
  const handler = hookHandler(CLAUDE_CODE_CAPTURE, event);
  if (!handler) throw new Error(`no ${event}`);
  return handler.parse(body, h);
};

describe("Claude Code's hooks (F9.2)", () => {
  it("captures the session on Stop, PreCompact and SessionEnd (final)", () => {
    for (const event of ["Stop", "PreCompact"]) {
      expect(parse(event, payload(event))).toEqual({
        captures: [
          {
            session_id: "1f2e3d4c-5b6a-4789-9abc-def012345678",
            transcript_path:
              "/Users/dev/.claude/projects/-Users-dev-code-app/1f2e3d4c-5b6a-4789-9abc-def012345678.jsonl",
            cwd: "/Users/dev/code/app",
          },
        ],
      });
    }
    expect(parse("SessionEnd", payload("SessionEnd")).captures[0]?.final).toBe(true);
  });

  it("captures a subagent's own transcript as its own session, child of the main one", () => {
    const { captures } = parse("SubagentStop", payload("SubagentStop"));
    expect(captures[1]).toEqual({
      session_id: "agent-a1b2c3",
      transcript_path:
        "/Users/dev/.claude/projects/-Users-dev-code-app/1f2e3d4c-5b6a-4789-9abc-def012345678/subagents/agent-a1b2c3.jsonl",
      cwd: "/Users/dev/code/app",
      parent_session_id: "1f2e3d4c-5b6a-4789-9abc-def012345678",
      final: true,
    });
    expect(parse("SubagentStop", payload("SubagentStop-older")).captures).toHaveLength(1);
  });

  it("exports the session id on SessionStart for the /seshi skill, when Claude Code gives a file", () => {
    expect(parse("SessionStart", payload("SessionStart"))).toEqual({ captures: [] });
    const withFile = { ...host, env: { CLAUDE_ENV_FILE: "/tmp/env" } };
    expect(parse("SessionStart", payload("SessionStart"), withFile).exportEnv).toEqual({
      file: "/tmp/env",
      vars: {
        SESHI_SESSION_ID: "1f2e3d4c-5b6a-4789-9abc-def012345678",
        SESHI_AGENT: "claude-code",
      },
    });
  });

  it("refuses a payload with no session", () => {
    expect(() => parse("Stop", {})).toThrow("no session_id");
    expect(() => parse("Stop", [])).toThrow("not a JSON object");
  });
});

describe("Claude Code's transcripts", () => {
  const head = [
    JSON.stringify({ type: "summary", summary: "x" }),
    JSON.stringify({
      type: "user",
      uuid: "u1",
      sessionId: "sess1",
      cwd: "/repo",
      timestamp: "2026-09-01T00:00:00.000Z",
      message: { role: "user", content: "hi" },
    }),
    "{partial",
  ].join("\n");

  it("are known by their file name, folder and first time", () => {
    expect(identifyClaudeTranscript("/p/proj/sess1.jsonl", head)).toEqual({
      session_id: "sess1",
      cwd: "/repo",
      started_at: "2026-09-01T00:00:00.000Z",
    });
    expect(identifyClaudeTranscript("/p/proj/sess1/subagents/agent-9.jsonl", head)).toEqual({
      session_id: "agent-9",
      cwd: "/repo",
      started_at: "2026-09-01T00:00:00.000Z",
      parent_session_id: "sess1",
    });
    expect(identifyClaudeTranscript("/p/proj/x.jsonl", '{"role":"user"}\n')).toBeNull();
    expect(identifyClaudeTranscript("/p/proj/x.txt", head)).toBeNull();
  });

  it("are found by id, under CLAUDE_CONFIG_DIR when it is set, and swept from projects/", () => {
    const projects = join(home, ".claude", "projects");
    mkdirSync(join(projects, "p", "s1", "subagents"), { recursive: true });
    writeFileSync(join(projects, "p", "s1.jsonl"), head);
    writeFileSync(join(projects, "p", "s1", "subagents", "agent-7.jsonl"), head);
    expect(locateClaudeTranscript("s1", host)).toBe(join(projects, "p", "s1.jsonl"));
    expect(locateClaudeTranscript("agent-7", host)).toBe(
      join(projects, "p", "s1", "subagents", "agent-7.jsonl"),
    );
    expect(locateClaudeTranscript("missing", host)).toBeUndefined();
    expect(locateClaudeTranscript("../etc", host)).toBeUndefined();
    const elsewhere = { ...host, env: { CLAUDE_CONFIG_DIR: "~/alt" } };
    expect(CLAUDE_CODE_CAPTURE.sweep[0]?.resolve?.(elsewhere)).toBe(join(home, "alt", "projects"));
    const match = CLAUDE_CODE_CAPTURE.sweep[0]?.match;
    expect(match?.("p/s1.jsonl")).toBe(true);
    expect(match?.("p/s1/subagents/agent-7.jsonl")).toBe(true);
    expect(match?.("p/s1/tool-results/x.jsonl")).toBe(false);
  });

  it("reads the account id, and nothing else, from ~/.claude.json", () => {
    expect(claudeAccountIds(host)).toEqual({});
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        oauthAccount: { accountUuid: "acct-1", emailAddress: "a@b" },
        primaryApiKey: "sk-…",
      }),
    );
    expect(claudeAccountIds(host)).toEqual({ anthropic: "acct-1" });
  });
});

describe("the installer (F9.6)", () => {
  const settings = () => join(home, ".claude", "settings.json");
  const context = () => ({ ...host, command: ["/opt/seshi/bin/seshi"] });

  it("merges seshi's hooks, status line and skill, keeping what was there", async () => {
    mkdirSync(join(home, ".claude"));
    writeFileSync(
      settings(),
      JSON.stringify({
        model: "opus",
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard" }] }],
        },
      }),
    );
    expect(claudeCodeInstaller.detect(host)).toBe(true);
    const report = await claudeCodeInstaller.install(context());
    expect(report.changed).toEqual([
      settings(),
      join(home, ".claude", "skills", "seshi", "SKILL.md"),
    ]);
    const written = JSON.parse(readFileSync(settings(), "utf8"));
    expect(written.model).toBe("opus");
    expect(written.hooks.Stop).toEqual([
      { hooks: [{ type: "command", command: "say done" }] },
      {
        hooks: [
          { type: "command", command: "/opt/seshi/bin/seshi hook claude-code Stop", timeout: 30 },
        ],
      },
    ]);
    expect(written.hooks.PreToolUse).toHaveLength(1);
    for (const event of CLAUDE_CODE_EVENTS) expect(written.hooks[event]).toBeDefined();
    expect(written.statusLine).toEqual({
      type: "command",
      command: "/opt/seshi/bin/seshi statusline",
      padding: 0,
    });
    expect(readFileSync(join(home, ".claude", "skills", "seshi", "SKILL.md"), "utf8")).toContain(
      "/opt/seshi/bin/seshi capture off --session",
    );
    expect((await claudeCodeInstaller.status(context())).installed).toBe(true);

    // Twice is the same as once; a new command replaces the old one in place.
    await claudeCodeInstaller.install({ ...host, command: ["seshi"] });
    const again = JSON.parse(readFileSync(settings(), "utf8"));
    expect(again.hooks.Stop).toHaveLength(2);
    expect(again.hooks.Stop[1].hooks[0].command).toBe("seshi hook claude-code Stop");
  });

  it("keeps someone else's status line and skill, and says so", async () => {
    mkdirSync(join(home, ".claude", "skills", "seshi"), { recursive: true });
    writeFileSync(
      settings(),
      JSON.stringify({ statusLine: { type: "command", command: "my-line" } }),
    );
    writeFileSync(join(home, ".claude", "skills", "seshi", "SKILL.md"), "mine");
    const report = await claudeCodeInstaller.install(context());
    expect(report.notes).toHaveLength(2);
    expect(JSON.parse(readFileSync(settings(), "utf8")).statusLine.command).toBe("my-line");
    expect(readFileSync(join(home, ".claude", "skills", "seshi", "SKILL.md"), "utf8")).toBe("mine");
  });

  it("removes only its own entries on uninstall", async () => {
    mkdirSync(join(home, ".claude"));
    writeFileSync(
      settings(),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } }),
    );
    await claudeCodeInstaller.install(context());
    const report = await claudeCodeInstaller.uninstall(context());
    expect(report.changed).toContain(settings());
    expect(JSON.parse(readFileSync(settings(), "utf8"))).toEqual({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] },
    });
    expect(existsSync(join(home, ".claude", "skills", "seshi"))).toBe(false);
    expect((await claudeCodeInstaller.status(context())).installed).toBe(false);
    expect((await claudeCodeInstaller.uninstall(context())).changed).toEqual([]);
  });

  it("refuses a settings file it cannot read rather than overwrite it", async () => {
    mkdirSync(join(home, ".claude"));
    writeFileSync(settings(), "{ not json");
    await expect(claudeCodeInstaller.install(context())).rejects.toThrow(/not valid JSON/);
    expect(readFileSync(settings(), "utf8")).toBe("{ not json");
  });

  it("ships the same hooks and skill as a plugin", () => {
    const plugin = join(import.meta.dirname, "../plugin");
    const hooks = JSON.parse(readFileSync(join(plugin, "hooks", "hooks.json"), "utf8")).hooks;
    expect(Object.keys(hooks)).toEqual([...CLAUDE_CODE_EVENTS]);
    for (const event of CLAUDE_CODE_EVENTS) {
      expect(hooks[event][0].hooks[0].command).toBe(`seshi hook claude-code ${event}`);
    }
    expect(readFileSync(join(plugin, "skills", "seshi", "SKILL.md"), "utf8")).toBe(
      seshiSkill(["seshi"]),
    );
    expect(
      JSON.parse(readFileSync(join(plugin, ".claude-plugin", "plugin.json"), "utf8")).name,
    ).toBe("seshi");
  });

  it("marks its skill, so it knows its own", () => {
    expect(SKILL_MARKER).toContain("seshi capture uninstall");
  });
});
