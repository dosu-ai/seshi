import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IngestRejected,
  OffsetMismatch,
  SessionConflict,
  type SessionDB,
  SessionRejected,
  StoreError,
  type StoreSessionResult,
  type Trace,
} from "@seshi/model";
import { connect, StoreSessionDB } from "@seshi/pipeline";
import { FsStore } from "@seshi/store";
import { buildFormats } from "seshi/integrations";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { transcript } from "../tooling/testdata";

const formats = buildFormats();
const SMALL = transcript("claude-basic.claude-code.jsonl");
/** The greeting-sized fixture with an answer long enough to be worth a trace. */
const CLAUDE = `${SMALL.trim()}\n${JSON.stringify({
  type: "assistant",
  uuid: "a3",
  timestamp: "2026-09-01T00:00:08.000Z",
  sessionId: "sess1",
  message: {
    role: "assistant",
    model: "claude-x",
    content: [{ type: "text", text: `The auth flow: ${"details ".repeat(400)}` }],
  },
})}\n`;

/** The result of an upload that wrote a trace; the test fails on any other. */
function stored(result: StoreSessionResult): Extract<StoreSessionResult, { content_hash: string }> {
  if (!("content_hash" in result)) throw new Error(`expected a trace, got ${result.status}`);
  return result;
}

let dir: string;
let db: SessionDB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sessiondb-client-"));
  db = connect({ store: `file://${join(dir, "bucket")}`, owner: "acme", formats });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("connect", () => {
  it("opens a store from its URL, scoped to the owner", async () => {
    expect(db).toBeInstanceOf(StoreSessionDB);
    const me = await db.me();
    expect(me.owner).toBe("acme");
    expect(me.storage.url).toMatch(/^file:\/\//);
  });

  it("takes a Store instance", async () => {
    const store = new FsStore(join(dir, "other"));
    const other = connect({ store, owner: "globex", formats });
    expect((await other.me()).storage).toEqual({ url: store.url });
  });

  it("refuses a URL that is not a store", () => {
    expect(() => connect({ store: "ftp://nope", owner: "acme", formats })).toThrow(StoreError);
  });

  it("refuses an invalid owner", () => {
    expect(() => connect({ store: join(dir, "x"), owner: "no/slashes", formats })).toThrow();
  });
});

describe("over a store", () => {
  it("stores, reads back, lists, and feeds changes", async () => {
    await (db as StoreSessionDB).check();
    const result = stored(
      await db.ingest({
        agent: "claude-code",
        session_id: "sess1",
        transcript: CLAUDE,
        project: "github.com/acme/widget",
      }),
    );
    expect(result.status).toBe("stored");
    expect(result).not.toHaveProperty("raw");

    const metadata = await db.getSession("claude-code", "sess1");
    expect(metadata).toMatchObject({
      owner: "acme",
      session_id: "sess1",
      head: result.content_hash,
      project: "github.com/acme/widget",
    });

    const trace = (await db.getTrace("claude-code", "sess1")) as Trace | null;
    expect(trace?.content_hash).toBe(result.content_hash);
    expect(trace?.metadata.normalizer?.name).toBe("@dosu/sessiondb");
    expect(await db.getTrace("claude-code", "sess1", result.content_hash)).toEqual(trace);

    const page = await db.listSessions();
    expect(page.sessions.map((s) => s.session_id)).toEqual(["sess1"]);
    expect(page.truncated).toBe(false);

    const changes = await db.changes();
    expect(changes.entries).toHaveLength(1);
    expect(changes.entries[0]?.entry).toMatchObject({
      kind: "published",
      owner: "acme",
      content_hash: result.content_hash,
    });
    expect(await db.changes({ after: changes.cursor })).toMatchObject({ entries: [] });
  });

  it("answers null for what is not there", async () => {
    expect(await db.getSession("claude-code", "nope")).toBeNull();
    expect(await db.getTrace("claude-code", "nope")).toBeNull();
    expect(await db.tombstone("claude-code", "nope")).toBeNull();
  });

  it("stores nothing of a filtered session", async () => {
    const result = await db.ingest({ agent: "claude-code", session_id: "tiny", transcript: SMALL });
    expect(result).toMatchObject({ status: "filtered", bytes_total: 0 });
    expect(await db.getSession("claude-code", "tiny")).toBeNull();
    expect(await db.getTrace("claude-code", "tiny")).toBeNull();
  });

  it("refuses a whole upload that does not extend the session, and replaces it on request", async () => {
    await db.ingest({ agent: "claude-code", session_id: "sess1", transcript: CLAUDE });
    const other = CLAUDE.replace("The auth flow:", "Another answer:");
    await expect(
      db.ingest({ agent: "claude-code", session_id: "sess1", transcript: other }),
    ).rejects.toBeInstanceOf(SessionConflict);
    const replaced = await db.ingest({
      agent: "claude-code",
      session_id: "sess1",
      transcript: other,
      replace: true,
    });
    expect(replaced.status).toBe("stored");
    expect((await db.getSession("claude-code", "sess1"))?.traces).toHaveLength(1);
  });

  it("tombstones, and refuses the session after", async () => {
    await db.ingest({ agent: "claude-code", session_id: "sess1", transcript: CLAUDE });
    expect(await db.tombstone("claude-code", "sess1")).toEqual({ removed: 1 });
    expect(await db.getTrace("claude-code", "sess1")).toBeNull();
    expect(await db.getSession("claude-code", "sess1")).toMatchObject({ status: "redacted" });

    const again = db.ingest({ agent: "claude-code", session_id: "sess1", transcript: CLAUDE });
    await expect(again).rejects.toBeInstanceOf(IngestRejected);
    // One vocabulary: the store's refusals are SessionRejected too, with their code.
    await expect(again).rejects.toBeInstanceOf(SessionRejected);
    await expect(again).rejects.toMatchObject({ code: "redacted" });

    const changes = await db.changes();
    expect(changes.entries.map((e) => e.entry.kind)).toEqual(["published", "tombstone"]);
  });

  it("refuses a chunk that does not start where the log ends", async () => {
    const first = await db.ingest({
      agent: "claude-code",
      session_id: "sess1",
      transcript: CLAUDE,
    });
    const wrong = db.ingest({
      agent: "claude-code",
      session_id: "sess1",
      transcript: '{"type":"progress"}\n',
      offset: first.bytes_total + 1,
    });
    await expect(wrong).rejects.toBeInstanceOf(OffsetMismatch);
    await expect(wrong).rejects.toMatchObject({ expected: first.bytes_total });
  });

  it("refuses what the pipeline refuses, as SessionRejected", async () => {
    await expect(
      db.ingest({ agent: "claude-code", session_id: "blank", transcript: "   " }),
    ).rejects.toMatchObject({ name: "SessionRejected", code: "empty" });
  });
});
