import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CaptureHost, hookHandler } from "@seshi/kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CURSOR_CAPTURE,
  cursorInstaller,
  identifyCursorTranscript,
  locateCursorTranscript,
} from "./capture";

const HOOKS = join(import.meta.dirname, "../../testdata/hooks");
const payload = (name: string) => JSON.parse(readFileSync(join(HOOKS, `${name}.json`), "utf8"));

let home: string;
let host: CaptureHost;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "seshi-cursor-"));
  host = { env: {}, home, platform: "linux" };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("Cursor's hooks (F9.2)", () => {
  it("keys a session by its conversation, in the first workspace root", () => {
    expect(hookHandler(CURSOR_CAPTURE, "stop")?.parse(payload("stop"), host)).toEqual({
      captures: [
        {
          session_id: "c0ffee00-1111-4222-8333-444455556666",
          transcript_path:
            "/Users/dev/.cursor/projects/Users-dev-code-app/agent-transcripts/c0ffee00-1111-4222-8333-444455556666.jsonl",
          cwd: "/Users/dev/code/app",
        },
      ],
    });
  });

  it("goes without a transcript on the first prompt (found later), and ends the session", () => {
    const first = hookHandler(CURSOR_CAPTURE, "stop")?.parse(payload("stop-first-prompt"), host);
    expect(first?.captures[0]?.transcript_path).toBeUndefined();
    const end = hookHandler(CURSOR_CAPTURE, "sessionEnd")?.parse(payload("sessionEnd"), host);
    expect(end?.captures[0]).toMatchObject({ final: true, cwd: "/Users/dev/code/app" });
    expect(() => hookHandler(CURSOR_CAPTURE, "stop")?.parse({}, host)).toThrow("conversation_id");
  });
});

describe("Cursor's transcripts", () => {
  it("are known by their name and found under any project", () => {
    const dir = join(home, ".cursor", "projects", "Users-dev-app", "agent-transcripts");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "conv-1.jsonl");
    writeFileSync(file, '{"role":"user","message":{"content":"hi"}}\n');
    expect(identifyCursorTranscript(file, readFileSync(file, "utf8"))).toEqual({
      session_id: "conv-1",
    });
    expect(identifyCursorTranscript(file, '{"type":"user"}\n')).toBeNull();
    expect(locateCursorTranscript("conv-1", host)).toBe(file);
    expect(locateCursorTranscript("conv-2", host)).toBeUndefined();
    expect(CURSOR_CAPTURE.sweep[0]?.match("Users-dev-app/agent-transcripts/conv-1.jsonl")).toBe(
      true,
    );
  });
});

describe("the installer (F9.6)", () => {
  const file = () => join(home, ".cursor", "hooks.json");
  const context = () => ({ ...host, command: ["seshi"] });

  it("merges into hooks.json, keeping other hooks, and removes only its own", async () => {
    mkdirSync(join(home, ".cursor"));
    writeFileSync(
      file(),
      JSON.stringify({
        version: 1,
        hooks: {
          stop: [{ command: "./audit.sh" }],
          beforeShellExecution: [{ command: "./guard.sh" }],
        },
      }),
    );
    expect(cursorInstaller.detect(host)).toBe(true);
    await cursorInstaller.install(context());
    await cursorInstaller.install(context());
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({
      version: 1,
      hooks: {
        stop: [{ command: "./audit.sh" }, { command: "seshi hook cursor stop" }],
        beforeShellExecution: [{ command: "./guard.sh" }],
        sessionEnd: [{ command: "seshi hook cursor sessionEnd" }],
      },
    });
    expect((await cursorInstaller.status(context())).installed).toBe(true);
    await cursorInstaller.uninstall(context());
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({
      version: 1,
      hooks: {
        stop: [{ command: "./audit.sh" }],
        beforeShellExecution: [{ command: "./guard.sh" }],
      },
    });
    expect((await cursorInstaller.uninstall(context())).changed).toEqual([]);
  });

  it("writes a new hooks.json with version 1", async () => {
    await cursorInstaller.install(context());
    expect(JSON.parse(readFileSync(file(), "utf8")).version).toBe(1);
  });
});
