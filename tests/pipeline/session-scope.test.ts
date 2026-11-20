/** Where and with what a session ran: the repository, commit, folder and client an upload names,
 * and the harness's version and models, from the log or, for a log that names neither (Cursor's),
 * from the uploader's hints. */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CaptureAgent, hookHandler } from "@seshi/kit";
import { SessionRejected, type SessionUpload } from "@seshi/model";
import { getSession, getTrace, storeSession } from "@seshi/pipeline";
import { archiveId, FsStore } from "@seshi/store";
import { buildFormats, INTEGRATIONS } from "seshi/integrations";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ROOT, transcript } from "../tooling/testdata";

const formats = buildFormats();
const owner = "acme";
// The fixtures are short: the session filter (X4.10) is not what these tests are about.
const filter = { enabled: false, min_chars: 0, require_user: false, require_reply: false };
const CURSOR_CAPTURE = INTEGRATIONS.find((i) => i.name === "cursor")?.capture as CaptureAgent;
const SHA = "0123456789abcdef0123456789abcdef01234567";

let dir: string;
let store: FsStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-session-scope-"));
  store = new FsStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const store_ = (upload: Omit<SessionUpload, "owner" | "format">) =>
  storeSession({ owner, format: "jsonl", ...upload }, { store, formats, filter });

async function headOf(agent: string, sessionId: string) {
  const session = await getSession(store, owner, agent, sessionId);
  const trace = session?.head
    ? await getTrace(store, owner, archiveId(owner, agent, sessionId), session.head)
    : null;
  return { session, trace };
}

describe("where a session ran", () => {
  it("records the commit, folder and client on the trace, and the repo on the session", async () => {
    await store_({
      agent: "claude-code",
      session_id: "s1",
      transcript: transcript("claude-basic.claude-code.jsonl"),
      project: "app",
      repo: "github.com/acme/app",
      commit: SHA,
      path_in_repo: "packages/api",
      client: "seshi/0.15.0 darwin-arm64",
    });
    const { session, trace } = await headOf("claude-code", "s1");
    expect(session).toMatchObject({ project: "app", repo: "github.com/acme/app" });
    expect(trace?.metadata).toMatchObject({
      commit: SHA,
      path_in_repo: "packages/api",
      client: "seshi/0.15.0 darwin-arm64",
    });
  });

  it("keeps the repo of the session's first upload when the remote changes", async () => {
    const log = transcript("claude-basic.claude-code.jsonl");
    const lines = log.split("\n").filter(Boolean);
    const head = `${lines.slice(0, 2).join("\n")}\n`;
    const first = await store_({
      agent: "claude-code",
      session_id: "s1",
      transcript: head,
      repo: "github.com/acme/app",
      commit: SHA,
    });
    expect(first.status).toBe("stored");
    const tail = `${lines.slice(2).join("\n")}\n`;
    await store_({
      agent: "claude-code",
      session_id: "s1",
      transcript: tail,
      offset: Buffer.byteLength(head),
      repo: "github.com/acme/renamed",
      commit: "f".repeat(40),
    });
    const { session, trace } = await headOf("claude-code", "s1");
    expect(session?.traces).toHaveLength(2);
    expect(session?.repo).toBe("github.com/acme/app");
    // The commit is per trace: the later upload's.
    expect(trace?.metadata.commit).toBe("f".repeat(40));
  });

  it("refuses a repo with credentials, and a folder that is not inside the repository", async () => {
    const base = {
      agent: "claude-code",
      session_id: "s1",
      transcript: transcript("claude-basic.claude-code.jsonl"),
    };
    for (const bad of [
      { repo: "user:token@github.com/acme/app" },
      { repo: "https://github.com/acme/app" },
      { path_in_repo: "/Users/me/app" },
      { path_in_repo: "../other" },
      { commit: "HEAD" },
    ]) {
      await expect(store_({ ...base, ...bad }), JSON.stringify(bad)).rejects.toBeInstanceOf(
        SessionRejected,
      );
    }
    expect((await headOf("claude-code", "s1")).session).toBeNull();
  });
});

describe("the harness's version and the models", () => {
  it("are read from a Claude Code log", async () => {
    await store_({
      agent: "claude-code",
      session_id: "s1",
      transcript: transcript("claude-basic.claude-code.jsonl"),
    });
    const { session, trace } = await headOf("claude-code", "s1");
    expect(trace?.metadata).toMatchObject({ agent_version: "2.1.326", model: "claude-x" });
    expect(session).toMatchObject({
      source: "claude-code",
      agent_version: "2.1.326",
      models: ["claude-x"],
    });
  });

  it("are read from a Codex log, listing every model the session used", async () => {
    await store_({
      agent: "codex",
      session_id: "s1",
      transcript: transcript("codex-usage.codex.jsonl"),
    });
    const { session, trace } = await headOf("codex", "s1");
    expect(trace?.metadata.agent_version).toBe("0.169.0");
    expect(session).toMatchObject({
      source: "codex",
      agent_version: "0.169.0",
      models: ["gpt-9-codex", "gpt-9-codex-mini"],
    });
  });

  it("are the log's own, whatever the uploader's hints say", async () => {
    await store_({
      agent: "claude-code",
      session_id: "s1",
      transcript: transcript("claude-basic.claude-code.jsonl"),
      harness_version: "9.9.9",
      model: "hinted-model",
    });
    const { session, trace } = await headOf("claude-code", "s1");
    expect(trace?.metadata).toMatchObject({ agent_version: "2.1.326", model: "claude-x" });
    expect(session?.models).toEqual(["claude-x"]);
  });

  it("come from Cursor's hooks for a Cursor session, whose transcript names neither", async () => {
    const recorded = join(ROOT, "integrations/cursor/testdata/hooks/session-1");
    const end = readFileSync(join(recorded, "hooks.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { event: string; payload: unknown })
      .find((h) => h.event === "sessionEnd");
    const host = { env: {}, home: dir, platform: "linux" as const };
    const capture = hookHandler(CURSOR_CAPTURE, "sessionEnd")?.parse(end?.payload, host)
      .captures[0];
    expect(capture).toMatchObject({ harness_version: "2026.11.13-eacade1", model: "auto-smart" });

    const log = readFileSync(join(recorded, "transcript.jsonl"), "utf8");
    expect(log).not.toContain("cursor_version");
    const result = await store_({
      agent: "cursor",
      session_id: capture?.session_id as string,
      transcript: log,
      ...(capture?.harness_version ? { harness_version: capture.harness_version } : {}),
      ...(capture?.model ? { model: capture.model } : {}),
    });
    expect(result.status).toBe("stored");
    const { session, trace } = await headOf("cursor", capture?.session_id as string);
    expect(trace?.metadata).toMatchObject({
      agent_version: "2026.11.13-eacade1",
      model: "auto-smart",
    });
    expect(session).toMatchObject({
      source: "cursor",
      agent_version: "2026.11.13-eacade1",
      models: ["auto-smart"],
    });
  });
});
