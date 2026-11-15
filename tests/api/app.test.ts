import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { App } from "@seshi/api";
import type { NormalizeInput } from "@seshi/formats";
import { prefixSha256 } from "@seshi/model";
import { getTrace, normalizeTranscript as normalize, storeSession } from "@seshi/pipeline";
import { redactionRules } from "@seshi/redact";
import { archiveId, FsStore, getBytes, gunzipJson, keys, readMetadata } from "@seshi/store";
import { buildFormats } from "seshi/integrations";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testApp } from "../tooling/instance";
import { transcript } from "../tooling/testdata";

const FORMATS = buildFormats();
/** The server over an Instance with this binary's formats, as `seshi serve` builds it. */
const createApp = testApp;
const normalizeTranscript = (input: NormalizeInput) => normalize(FORMATS, input);

const TOKEN = "sdb_test-token-0123456789abcdef";
const OTHER = "sdb_other-token-0123456789abcdef";
/** The fixture is a greeting-sized session; the session filter keeps those out. */
const SMALL = transcript("claude-basic.claude-code.jsonl");
/** The same session with an answer long enough to be worth storing. */
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

/** A Claude Code session in the Datadog Trajectory daemon's on-disk format, finished. */
const STREAM_SMALL = transcript("datadog-claude-session.datadog-trajectory.jsonl");
const STREAM_SESSION = "0d6f1c2e-7b1a-4c3e-9f2d-5a8b7c6d4e3f";
/** The same stream with an answer long enough to be worth storing, before its session_end. */
const STREAM = (() => {
  const lines = STREAM_SMALL.trim().split("\n");
  const end = lines.pop() as string;
  const answer = JSON.stringify({
    sequence_number: 17,
    client_source: "claude-code",
    session_id: STREAM_SESSION,
    event_type: "agent_message",
    text: `The auth flow: ${"details ".repeat(400)}`,
    timestamp: "2026-10-29T20:27:38.000Z",
    turn_id: 2,
  });
  return `${[...lines, answer, end].join("\n")}\n`;
})();

let dir: string;
let store: FsStore;
let app: App;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sessiondb-server-"));
  store = new FsStore(`file://${join(dir, "bucket")}`);
  app = createApp({
    store,
    storage: { url: store.url },
    // Two people: acme's token and globex's. Each sees only its own folder.
    tokens: [
      { token: TOKEN, owner: "acme" },
      { token: OTHER, owner: "globex" },
    ],
    client: "sessiondb-server/test",
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function call(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    if (options.body instanceof Uint8Array) {
      body = new Uint8Array(options.body) as Uint8Array<ArrayBuffer>;
    } else {
      body = JSON.stringify(options.body);
      headers["content-type"] = "application/json";
    }
  }
  return app.fetch(new Request(`http://sessiondb.test${path}`, { method, headers, body }));
}

describe("health and routing", () => {
  it("answers /healthz without auth", async () => {
    const res = await call("GET", "/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("404s unknown paths and 405s wrong methods", async () => {
    expect((await call("GET", "/nope")).status).toBe(404);
    expect((await call("PATCH", "/healthz")).status).toBe(405);
  });
});

describe("auth", () => {
  it("accepts any configured token, and nothing else", async () => {
    expect((await call("GET", "/v1/me")).status).toBe(401);
    expect((await call("GET", "/v1/me", { token: "sdb_wrong-0123456789abcdef" })).status).toBe(401);
    expect((await call("GET", "/v1/me", { token: TOKEN.slice(0, -1) })).status).toBe(401);
    for (const [token, owner] of [
      [TOKEN, "acme"],
      [OTHER, "globex"],
    ]) {
      const res = await call("GET", "/v1/me", { token });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        owner,
        storage: { url: store.url },
        kind: "static",
        role: "member",
        owner_basis: "verified",
      });
    }
  });

  it("serves only a trace the session names, not one left in its folder", async () => {
    const stored = await call("POST", "/v1/sessions", {
      token: TOKEN,
      body: { agent: "claude-code", session_id: "mine", transcript: CLAUDE },
    });
    expect(stored.status).toBe(201);
    const archive = archiveId("acme", "claude-code", "mine");
    const head = (await readMetadata(store, "acme", archive))?.head as string;
    // An object the pointer no longer names, as a backfill or replace stopped before its
    // delete leaves behind.
    const orphan = "e".repeat(64);
    const bytes = await getBytes(store, keys.trace("acme", archive, head));
    await store.put(keys.trace("acme", archive, orphan), bytes as Uint8Array);
    const opts = { token: TOKEN };
    for (const route of ["trace", "export"]) {
      const base = `/v1/sessions/claude-code/mine/${route}`;
      expect((await call("GET", `${base}?hash=${head}`, opts)).status).toBe(200);
      expect((await call("GET", `${base}?hash=${orphan}`, opts)).status).toBe(404);
    }
  });

  it("reads its own sessions unless it names another owner", async () => {
    const stored = await call("POST", "/v1/sessions", {
      token: TOKEN,
      body: { agent: "claude-code", session_id: "mine", transcript: CLAUDE },
    });
    expect(stored.status).toBe(201);
    expect((await call("GET", "/v1/sessions/claude-code/mine", { token: TOKEN })).status).toBe(200);

    // globex, without ?owner=: its own folder, where the session is not; it cannot delete it.
    const other = { token: OTHER };
    expect((await call("GET", "/v1/sessions/claude-code/mine", other)).status).toBe(404);
    expect((await call("GET", "/v1/sessions/claude-code/mine/trace", other)).status).toBe(404);
    expect((await call("DELETE", "/v1/sessions/claude-code/mine", other)).status).toBe(404);
    expect(await (await call("GET", "/v1/sessions", other)).json()).toMatchObject({ sessions: [] });
    expect(await (await call("GET", "/v1/changes", other)).json()).toMatchObject({ entries: [] });
    // And acme still has it: globex's 404s touched nothing.
    expect((await call("GET", "/v1/sessions/claude-code/mine", { token: TOKEN })).status).toBe(200);
  });

  it("starts with no static token: the bucket's seshi tokens let callers in (X5.9)", () => {
    expect(() => createApp({ store, storage: { url: store.url }, tokens: [] })).not.toThrow();
  });
});

describe("sessions", () => {
  it("needs a token", async () => {
    expect((await call("POST", "/v1/sessions", { body: {} })).status).toBe(401);
  });

  it("normalizes, redacts and stores a transcript as its trace, and nothing else of it", async () => {
    const token = TOKEN;
    const res = await call("POST", "/v1/sessions", {
      token,
      body: {
        agent: "claude-code",
        session_id: "sess1",
        project: "github.com/acme/widget",
        branch: "main",
        transcript: CLAUDE,
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      status: string;
      archive_id: string;
      content_hash: string;
      records: number;
    };
    expect(body.status).toBe("stored");
    expect(body).not.toHaveProperty("raw");

    const archive = archiveId("acme", "claude-code", "sess1");
    expect(body.archive_id).toBe(archive);
    const metadata = await readMetadata(store, "acme", archive);
    expect(metadata).toMatchObject({
      agent: "claude-code",
      session_id: "sess1",
      project: "github.com/acme/widget",
      branch: "main",
      status: "stored",
      head: body.content_hash,
    });
    // No raw part (X6.3): the session is its pointer and its trace.
    expect((await store.list(keys.session("acme", archive))).keys).toEqual([
      keys.metadata("acme", archive),
      keys.trace("acme", archive, body.content_hash),
    ]);

    // Nothing unredacted reached the bucket.
    const trace = gunzipJson<{ records: unknown[]; metadata: { normalizer?: unknown } }>(
      (await getBytes(store, keys.trace("acme", archive, body.content_hash))) as Uint8Array,
    );
    // The trace says what normalized it, so a later pass can pick out what to redo.
    expect(trace.metadata.normalizer).toEqual({
      name: "@dosu/sessiondb",
      version: expect.stringMatching(/^\d+\.\d+\.\d+\+trajectory\.\d+\.\d+\.\d+$/),
    });
    const traceText = JSON.stringify(trace);
    expect(traceText).not.toContain("hunter2secretvalue42");
    expect(traceText).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz012345");

    // The same upload again is answered as the first time (X4.7), not stored twice.
    const again = await call("POST", "/v1/sessions", {
      token,
      body: { agent: "claude-code", session_id: "sess1", transcript: CLAUDE },
    });
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual(body);

    // The change feed has the one publish.
    const changes = await call("GET", "/v1/changes", { token });
    const feed = (await changes.json()) as { entries: { entry: { kind: string } }[] };
    expect(feed.entries.map((e) => e.entry.kind)).toEqual(["published"]);
  });

  it("applies the operator's redaction to every session it stores", async () => {
    app = createApp({
      store,
      storage: { url: store.url },
      tokens: [{ token: TOKEN, owner: "acme" }],
      redaction: redactionRules({ patterns: ["The auth (?<secret>flow)"] }),
    });
    const res = await call("POST", "/v1/sessions", {
      token: TOKEN,
      body: { agent: "claude-code", session_id: "sess-own", transcript: CLAUDE },
    });
    expect(res.status).toBe(201);
    const { content_hash } = (await res.json()) as { content_hash: string };
    const archive = archiveId("acme", "claude-code", "sess-own");
    const trace = gunzipSync(
      (await getBytes(store, keys.trace("acme", archive, content_hash))) as Uint8Array,
    );
    const text = new TextDecoder().decode(trace);
    expect(text).toContain("The auth [redacted:custom-pattern]");
    expect(text).not.toContain("The auth flow");
  });

  it("accepts a gzipped body", async () => {
    const token = TOKEN;
    const payload = JSON.stringify({
      agent: "claude-code",
      session_id: "sess2",
      transcript: CLAUDE,
    });
    const res = await call("POST", "/v1/sessions", {
      token,
      body: Bun.gzipSync(new TextEncoder().encode(payload)),
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
    });
    expect(res.status).toBe(201);
    const metadata = await readMetadata(store, "acme", archiveId("acme", "claude-code", "sess2"));
    expect(metadata?.traces).toHaveLength(1);
  });

  it("refuses a body that inflates past what an upload can need (413)", async () => {
    app = createApp({
      store,
      storage: { url: store.url },
      tokens: [{ token: TOKEN, owner: "acme" }],
      limits: { max_records: 50_000, max_records_bytes: 32 << 20, max_upload_bytes: 1024 },
    });
    // A few KiB of gzip that would inflate to 8 MiB.
    const bomb = Bun.gzipSync(new Uint8Array(8 << 20).fill(32));
    const res = await call("POST", "/v1/sessions", {
      token: TOKEN,
      body: bomb,
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
    });
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("too_large");
  });

  it("ships a resumed session's tail as a continuation", async () => {
    const token = TOKEN;
    const first = await call("POST", "/v1/sessions", {
      token,
      body: { agent: "claude-code", session_id: "sess3", transcript: CLAUDE },
    });
    expect(first.status).toBe(201);
    const shipped = (await first.json()) as {
      records: number;
      records_total: number;
      prefix_sha256: string;
    };

    // The session continues: another turn lands in the same log.
    const resumed = `${CLAUDE.trim()}\n${JSON.stringify({
      type: "user",
      uuid: "u2",
      timestamp: "2026-09-01T00:10:00.000Z",
      sessionId: "sess1",
      message: { role: "user", content: "and the tests?" },
    })}\n${JSON.stringify({
      type: "assistant",
      uuid: "a9",
      timestamp: "2026-09-01T00:10:05.000Z",
      sessionId: "sess1",
      message: {
        role: "assistant",
        model: "claude-x",
        content: [{ type: "text", text: `Green. ${"All of them pass. ".repeat(150)}` }],
      },
    })}\n`;

    // The server knows what it stored, so it writes only the tail; a client need not send
    // `shipped`.
    const second = await call("POST", "/v1/sessions", {
      token,
      body: { agent: "claude-code", session_id: "sess3", transcript: resumed },
    });
    expect(second.status).toBe(201);
    const tail = (await second.json()) as {
      records: number;
      records_total: number;
      prefix_sha256: string;
    };
    expect(tail.records_total).toBe(shipped.records_total + 2);
    expect(tail.prefix_sha256).not.toBe(shipped.prefix_sha256);
    // Meta record plus the two new ones went, not the whole session again.
    expect(tail.records).toBe(3);
    const metadata = await readMetadata(store, "acme", archiveId("acme", "claude-code", "sess3"));
    expect(metadata?.traces).toHaveLength(2);
    expect(metadata?.traces[1]?.continuation).toEqual({
      from_record: shipped.records_total,
      prefix_sha256: shipped.prefix_sha256,
    });
  });

  it("refuses a whole upload that does not extend the session (409), and replaces it for its writer", async () => {
    const token = TOKEN;
    const first = await call("POST", "/v1/sessions", {
      token,
      body: { agent: "claude-code", session_id: "sess4", transcript: CLAUDE },
    });
    expect(first.status).toBe(201);
    const rewritten = CLAUDE.replace("The auth flow:", "A different answer:");
    const conflict = await call("POST", "/v1/sessions", {
      token,
      body: { agent: "claude-code", session_id: "sess4", transcript: rewritten },
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: "conflict" } });
    const bad = await call("POST", "/v1/sessions", {
      token,
      body: { agent: "claude-code", session_id: "sess4", transcript: rewritten, replace: "yes" },
    });
    expect(bad.status).toBe(400);
    const replaced = await call("POST", "/v1/sessions", {
      token,
      body: { agent: "claude-code", session_id: "sess4", transcript: rewritten, replace: true },
    });
    expect(replaced.status).toBe(201);
    const archive = archiveId("acme", "claude-code", "sess4");
    expect((await readMetadata(store, "acme", archive))?.traces).toHaveLength(1);
  });

  it("forbids replacing a session another writer wrote (403)", async () => {
    // The same owner through a different kind of token is the same writer; a session written
    // through local mode (another principal's writer) is not.
    await storeSession(
      {
        owner: "acme",
        agent: "claude-code",
        session_id: "sess5",
        transcript: CLAUDE,
        format: "jsonl",
      },
      {
        store,
        formats: FORMATS,
        context: { writer: { kind: "service", principal: "svc-import", source_id: "upload" } },
      },
    );
    const res = await call("POST", "/v1/sessions", {
      token: TOKEN,
      body: {
        agent: "claude-code",
        session_id: "sess5",
        transcript: CLAUDE.replace("The auth flow:", "Mine now:"),
        replace: true,
      },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "forbidden" } });
  });

  it("takes an idempotency key from the header or the body", async () => {
    const token = TOKEN;
    const post = (transcript: string, headers: Record<string, string>, extra = {}) =>
      call("POST", "/v1/sessions", {
        token,
        headers,
        body: { agent: "claude-code", session_id: "sess6", transcript, ...extra },
      });
    const first = await post(CLAUDE, { "idempotency-key": "upload-1" });
    expect(first.status).toBe(201);
    // Same key, other bytes: the same envelope as far as the server can tell.
    const again = await post(`${CLAUDE}\n`, { "idempotency-key": "upload-1" });
    expect(await again.json()).toEqual(await first.json());
    const metadata = await readMetadata(store, "acme", archiveId("acme", "claude-code", "sess6"));
    expect(metadata?.applied?.map((a) => a.idempotency_key)).toEqual(["upload-1"]);
    const viaBody = await post(`${CLAUDE}\n\n`, {}, { idempotency_key: "upload-2" });
    expect(viaBody.status).toBe(200);
    expect((await viaBody.json()).status).toBe("unchanged");
    const empty = await post(CLAUDE, { "idempotency-key": "" });
    expect(empty.status).toBe(400);
    // Kept in metadata.json with the session's last answers, so a key is bounded.
    const long = await post(CLAUDE, {}, { idempotency_key: "k".repeat(2049) });
    expect(long.status).toBe(400);
  });

  describe("chunks", () => {
    const token = TOKEN;
    const line = (row: Record<string, unknown>) => `${JSON.stringify(row)}\n`;
    const turn = (n: number, text: string) =>
      line({
        type: "user",
        uuid: `u${n}`,
        timestamp: `2026-09-01T00:${String(n).padStart(2, "0")}:00.000Z`,
        sessionId: "sess1",
        message: { role: "user", content: `question ${n}` },
      }) +
      line({
        type: "assistant",
        uuid: `a${n}`,
        timestamp: `2026-09-01T00:${String(n).padStart(2, "0")}:05.000Z`,
        sessionId: "sess1",
        message: { role: "assistant", model: "claude-x", content: [{ type: "text", text }] },
      });
    /** A progress row the adapter drops: a chunk of it alone has no records. */
    const noise = line({ type: "progress", uuid: "p1", sessionId: "sess1", data: {} });
    const bytes = (s: string) => Buffer.byteLength(s);

    type Answer = {
      status: string;
      records?: number;
      records_total: number;
      prefix_sha256: string;
      bytes_total: number;
    };
    const post = async (body: Record<string, unknown>) => {
      const res = await call("POST", "/v1/sessions", {
        token,
        body: { agent: "claude-code", session_id: "chunked", ...body },
      });
      return [res.status, (await res.json()) as Answer] as const;
    };

    it("takes a log in chunks, each a continuation of the last, and the chunks stitch to the whole", async () => {
      const chunk2 = turn(10, `Second. ${"More. ".repeat(100)}`);
      const chunk3 = noise + turn(11, `Third. ${"Yet more. ".repeat(100)}`);
      const whole = CLAUDE + chunk2 + chunk3;

      const [s1, first] = await post({ transcript: CLAUDE });
      expect(s1).toBe(201);
      expect(first.bytes_total).toBe(bytes(CLAUDE));

      const [s2, second] = await post({ transcript: chunk2, offset: first.bytes_total });
      expect(s2).toBe(201);
      expect(second).toMatchObject({
        status: "stored",
        // Meta plus the chunk's two records went.
        records: 3,
        records_total: first.records_total + 2,
        bytes_total: bytes(CLAUDE) + bytes(chunk2),
      });

      const [s3, third] = await post({ transcript: chunk3, offset: second.bytes_total });
      expect(s3).toBe(201);
      expect(third.records_total).toBe(second.records_total + 2);
      expect(third.bytes_total).toBe(bytes(whole));

      // Nothing of the chunks is kept but their traces: the head and two continuations, and
      // the small state the next chunk continues from.
      const archive = archiveId("acme", "claude-code", "chunked");
      const metadata = await readMetadata(store, "acme", archive);
      expect(
        (await store.list(keys.session("acme", archive))).keys.filter(
          (k) => !k.includes("/trace."),
        ),
      ).toEqual([keys.metadata("acme", archive)]);
      expect(metadata?.normalized).toMatchObject({
        bytes: bytes(whole),
        records: third.records_total,
        prefix_sha256: third.prefix_sha256,
      });
      expect(metadata?.traces.map((t) => t.continuation?.from_record)).toEqual([
        undefined,
        first.records_total,
        second.records_total,
      ]);

      // Stitched, the traces hold exactly what the whole log normalizes to, and the answer's
      // prefix hash is the whole's.
      const stitched = [];
      for (const ref of metadata?.traces ?? []) {
        const trace = await getTrace(store, "acme", archive, ref.content_hash);
        stitched.push(...(trace?.records ?? []).slice(ref.continuation ? 1 : 0));
      }
      const expected = normalizeTranscript({ source: "claude-code", transcript: whole }).records;
      expect(stitched).toEqual(expected);
      expect(third.prefix_sha256).toBe(prefixSha256(expected, expected.length));

      // So a client can go back to whole uploads and still be continued.
      const chunk4 = turn(12, `Fourth. ${"And more. ".repeat(300)}`);
      const [s4, fourth] = await post({ transcript: whole + chunk4 });
      expect(s4).toBe(201);
      expect(fourth).toMatchObject({ records: 3, records_total: third.records_total + 2 });
      const after = await readMetadata(store, "acme", archive);
      expect(after?.traces.at(-1)?.continuation).toEqual({
        from_record: third.records_total,
        prefix_sha256: third.prefix_sha256,
      });
      // The chunk state is the whole's.
      expect(after?.normalized?.bytes).toBe(bytes(whole + chunk4));
    });

    it("moves the log on past a chunk with nothing in it, shipping nothing", async () => {
      const [, first] = await post({ transcript: CLAUDE });
      const [status, answer] = await post({ transcript: noise, offset: first.bytes_total });
      expect(status).toBe(200);
      expect(answer).toMatchObject({
        status: "unchanged",
        records_total: first.records_total,
        prefix_sha256: first.prefix_sha256,
        bytes_total: bytes(CLAUDE) + bytes(noise),
      });
      const [s2, second] = await post({
        transcript: turn(10, `Second. ${"More. ".repeat(100)}`),
        offset: answer.bytes_total,
      });
      expect(s2).toBe(201);
      expect(second.records_total).toBe(first.records_total + 2);
    });

    /** The agent working: a tool call and its result, no user turn. What most chunks of a
     * running session are. */
    const toolTurn = (n: number, command: string, output: string) =>
      line({
        type: "assistant",
        uuid: `a${n}`,
        timestamp: `2026-09-01T00:${String(n).padStart(2, "0")}:05.000Z`,
        sessionId: "sess1",
        message: {
          role: "assistant",
          model: "claude-x",
          content: [{ type: "tool_use", id: `toolu_${n}`, name: "Bash", input: { command } }],
        },
      }) +
      line({
        type: "user",
        uuid: `t${n}`,
        timestamp: `2026-09-01T00:${String(n).padStart(2, "0")}:06.000Z`,
        sessionId: "sess1",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: `toolu_${n}`, content: output }],
        },
      });

    it("ships a chunk that is all tool traffic: a tail is not judged as a conversation", async () => {
      const [, first] = await post({ transcript: CLAUDE });
      const [status, answer] = await post({
        transcript: toolTurn(10, "git status", "clean"),
        offset: first.bytes_total,
      });
      expect(status).toBe(201);
      expect(answer).toMatchObject({ status: "stored", records: 3 });
    });

    it("keeps two chunks that say the same thing apart: they are two places in the session", async () => {
      // The same exchange twice (the user asks again, the agent answers the same); only the
      // ids and timestamps differ, and those are outside the hash.
      const again = (n: number) =>
        line({
          type: "user",
          uuid: `u${n}`,
          timestamp: `2026-09-01T00:${String(n).padStart(2, "0")}:00.000Z`,
          sessionId: "sess1",
          message: { role: "user", content: "again?" },
        }) + toolTurn(n, "ls", `a.ts ${"b.ts ".repeat(500)}`);
      const [, first] = await post({ transcript: CLAUDE });
      const [s2, second] = await post({ transcript: again(10), offset: first.bytes_total });
      const [s3, third] = await post({ transcript: again(11), offset: second.bytes_total });
      expect([s2, s3]).toEqual([201, 201]);
      expect(third.status).toBe("stored");
      const archive = archiveId("acme", "claude-code", "chunked");
      const metadata = await readMetadata(store, "acme", archive);
      expect(metadata?.traces).toHaveLength(3);
      expect(metadata?.traces.map((t) => t.continuation?.from_record)).toEqual([
        undefined,
        first.records_total,
        second.records_total,
      ]);
      // Sent again whole, nothing past what is stored: nothing to write.
      const [s4, fourth] = await post({ transcript: CLAUDE + again(10) + again(11) });
      expect(s4).toBe(200);
      expect(fourth).toMatchObject({ status: "unchanged", records_total: third.records_total });
      expect((await readMetadata(store, "acme", archive))?.traces).toHaveLength(3);
    });

    it("stores nothing until the session passes the filter: chunks wait for the whole log", async () => {
      // The greeting-sized log is filtered, and nothing of it is kept, so the answer tells the
      // client to send the whole log next time (X6.3).
      const [s1, first] = await post({ transcript: SMALL });
      expect(s1).toBe(200);
      expect(first).toMatchObject({ status: "filtered", bytes_total: 0, records_total: 0 });
      const archive = archiveId("acme", "claude-code", "chunked");
      expect(await readMetadata(store, "acme", archive)).toBeNull();
      // A client that sends a chunk anyway is told to start from 0.
      const chunk2 = turn(10, "Short.");
      const [s2, second] = await post({ transcript: chunk2, offset: bytes(SMALL) });
      expect(s2).toBe(409);
      expect(second).toMatchObject({ error: { code: "offset_mismatch", expected: 0 } });
      // The whole log once it has grown: judged whole, stored as one trace.
      const chunk3 = turn(11, `Long. ${"Detail. ".repeat(300)}`);
      const [s3, third] = await post({ transcript: SMALL + chunk2 + chunk3 });
      expect(s3).toBe(201);
      const metadata = await readMetadata(store, "acme", archive);
      expect(metadata?.traces).toHaveLength(1);
      expect(metadata?.traces[0].continuation).toBeUndefined();
      const whole = normalizeTranscript({
        source: "claude-code",
        transcript: SMALL + chunk2 + chunk3,
      }).records;
      expect(third.records_total).toBe(whole.length);
      const trace = await getTrace(store, "acme", archive, metadata?.head ?? "");
      expect(trace?.records).toEqual(whole);
    });

    it("refuses a chunk that does not start where the log ends, saying where it does", async () => {
      // No session yet: the client sends the whole log.
      let [status, body] = await post({ transcript: turn(1, "x"), offset: 100 });
      expect(status).toBe(409);
      expect(body).toMatchObject({ error: { code: "offset_mismatch", expected: 0 } });

      const [, first] = await post({ transcript: CLAUDE });
      [status, body] = await post({ transcript: turn(2, "x"), offset: first.bytes_total + 1 });
      expect(status).toBe(409);
      expect(body).toMatchObject({ error: { expected: first.bytes_total } });
      // Nothing was stored for it.
      const metadata = await readMetadata(
        store,
        "acme",
        archiveId("acme", "claude-code", "chunked"),
      );
      expect(metadata?.traces).toHaveLength(1);
      expect(metadata?.normalized?.bytes).toBe(first.bytes_total);

      // A chunk must be whole lines of a jsonl log.
      [status, body] = await post({ transcript: '{"type":"user"', offset: first.bytes_total });
      expect(status).toBe(422);
      expect(body).toMatchObject({ error: { code: "bad_chunk" } });
      [status, body] = await post({
        transcript: "{}\n",
        offset: first.bytes_total,
        format: "json",
      });
      expect(status).toBe(422);
      expect(body).toMatchObject({ error: { code: "bad_chunk" } });
      [status, body] = await post({ transcript: "{}\n", offset: -1 });
      expect(status).toBe(400);
      [status, body] = await post({ transcript: "{}\n", offset: "later" });
      expect(status).toBe(400);
    });
  });

  it("rejects what cannot be stored with 422 and a code", async () => {
    const token = TOKEN;
    const code = async (body: unknown) =>
      (
        (await (await call("POST", "/v1/sessions", { token, body })).json()) as {
          error: { code: string };
        }
      ).error.code;
    expect(await code({ agent: "vim", session_id: "s", transcript: "x" })).toBe(
      "unsupported_agent",
    );
    // The source name is the only spelling: a harness alias would make a second archive.
    expect(await code({ agent: "claude", session_id: "s", transcript: CLAUDE })).toBe(
      "unsupported_agent",
    );
    expect(await code({ agent: "claude-code", session_id: "s", transcript: "   " })).toBe("empty");
    expect(
      await code({ agent: "claude-code", session_id: "s", transcript: CLAUDE, format: "xml" }),
    ).toBe("bad_field");
    expect(await code({ agent: "claude-code", session_id: "s" })).toBe("missing_field");
    expect(
      await code({
        agent: "claude-code",
        session_id: "s",
        transcript: CLAUDE,
        shipped: { x: 1 },
      }),
    ).toBe("bad_field");
  });

  it("reads back metadata, the trace and the list, and tombstones", async () => {
    const token = TOKEN;
    await call("POST", "/v1/sessions", {
      token,
      body: { agent: "claude-code", session_id: "sess4", transcript: CLAUDE },
    });

    const meta = await call("GET", "/v1/sessions/claude-code/sess4", { token });
    expect(meta.status).toBe(200);
    const metadata = (await meta.json()) as { head: string };

    const trace = await call("GET", "/v1/sessions/claude-code/sess4/trace", { token });
    expect(trace.status).toBe(200);
    expect(await trace.json()).toMatchObject({ content_hash: metadata.head });

    const list = await call("GET", "/v1/sessions?limit=10", { token });
    expect((await list.json()).sessions).toHaveLength(1);

    const gone = await call("DELETE", "/v1/sessions/claude-code/sess4", { token });
    expect(gone.status).toBe(200);
    expect((await gone.json()).removed).toBeGreaterThan(0);
    expect((await call("GET", "/v1/sessions/claude-code/sess4/trace", { token })).status).toBe(410);
    const archive = archiveId("acme", "claude-code", "sess4");
    expect(await getBytes(store, keys.trace("acme", archive, metadata.head))).toBeNull();
    expect((await call("DELETE", "/v1/sessions/claude-code/nope", { token })).status).toBe(404);

    // A redacted session cannot come back.
    const retry = await call("POST", "/v1/sessions", {
      token,
      body: { agent: "claude-code", session_id: "sess4", transcript: CLAUDE },
    });
    expect(retry.status).toBe(422);
    expect((await retry.json()).error.code).toBe("redacted");
  });

  it("judges sessions by the filter and limits it was given (config [filter], [limits])", async () => {
    const lenient = createApp({
      store,
      storage: { url: store.url },
      tokens: [{ token: TOKEN, owner: "acme" }],
      filter: { enabled: true, min_chars: 10, require_user: true, require_reply: true },
      limits: { max_records: 50_000, max_records_bytes: 32 << 20, max_upload_bytes: 64 << 20 },
    });
    const stored = await lenient.fetch(
      new Request("http://test/v1/sessions", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ agent: "claude-code", session_id: "tiny", transcript: SMALL }),
      }),
    );
    expect(stored.status).toBe(201);
    expect((await stored.json()).status).toBe("stored");

    const tight = createApp({
      store,
      storage: { url: store.url },
      tokens: [{ token: TOKEN, owner: "acme" }],
      limits: { max_records: 50_000, max_records_bytes: 32 << 20, max_upload_bytes: 16 },
    });
    const refused = await tight.fetch(
      new Request("http://test/v1/sessions", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ agent: "claude-code", session_id: "big", transcript: CLAUDE }),
      }),
    );
    expect(refused.status).toBe(422);
    expect((await refused.json()).error.code).toBe("too_large");
  });

  it("filters a greeting-sized session: nothing stored, no change entry", async () => {
    const token = TOKEN;
    const res = await call("POST", "/v1/sessions", {
      token,
      body: { agent: "claude-code", session_id: "tiny", transcript: SMALL },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "filtered",
      records_total: 0,
      prefix_sha256: prefixSha256([], 0),
      bytes_total: 0,
    });
    expect(await readMetadata(store, "acme", archiveId("acme", "claude-code", "tiny"))).toBeNull();
    expect(await (await call("GET", "/v1/changes", { token })).json()).toMatchObject({
      entries: [],
    });
    const trace = await call("GET", "/v1/sessions/claude-code/tiny/trace", { token });
    expect(trace.status).toBe(404);
    expect((await trace.json()).error.code).toBe("not_found");
  });

  it("prefers the branch the transcript recorded over the client's", async () => {
    const token = TOKEN;
    await call("POST", "/v1/sessions", {
      token,
      body: { agent: "claude-code", session_id: "b1", transcript: CLAUDE, branch: "from-client" },
    });
    // The fixture's first record carries gitBranch: main.
    const metadata = await readMetadata(store, "acme", archiveId("acme", "claude-code", "b1"));
    expect(metadata?.branch).toBe("main");
  });

  it("writes only what a fork added past the history it copied from its parent", async () => {
    const token = TOKEN;
    const parent = await call("POST", "/v1/sessions", {
      token,
      body: { agent: "claude-code", session_id: "parent", transcript: CLAUDE },
    });
    expect(parent.status).toBe(201);
    const parentBody = (await parent.json()) as { records_total: number };

    // The fork's log is the parent's whole log plus its own turn.
    const forkLog = `${CLAUDE.trim()}\n${JSON.stringify({
      type: "user",
      uuid: "f1",
      timestamp: "2026-09-01T01:00:00.000Z",
      sessionId: "fork",
      message: { role: "user", content: "now the fork's own question" },
    })}\n${JSON.stringify({
      type: "assistant",
      uuid: "f2",
      timestamp: "2026-09-01T01:00:05.000Z",
      sessionId: "fork",
      message: {
        role: "assistant",
        model: "claude-x",
        content: [{ type: "text", text: `Its own answer. ${"More. ".repeat(400)}` }],
      },
    })}\n`;
    const fork = await call("POST", "/v1/sessions", {
      token,
      body: {
        agent: "claude-code",
        session_id: "fork",
        transcript: forkLog,
        parent_session_id: "parent",
        fork_of: "parent",
      },
    });
    expect(fork.status).toBe(201);
    const forkBody = (await fork.json()) as { records: number; records_total: number };
    expect(forkBody.records_total).toBe(parentBody.records_total + 2);
    // Meta plus the fork's two own records; the copied history was the parent's to ship.
    expect(forkBody.records).toBe(3);
    const metadata = await readMetadata(store, "acme", archiveId("acme", "claude-code", "fork"));
    expect(metadata?.parent_session_id).toBe("parent");
    expect(metadata?.traces[0]?.continuation).toEqual({
      from_record: parentBody.records_total,
      prefix_sha256: expect.any(String),
    });

    // A fork whose parent was never stored ships in full.
    const orphan = await call("POST", "/v1/sessions", {
      token,
      body: { agent: "claude-code", session_id: "orphan", transcript: forkLog, fork_of: "nope" },
    });
    expect(((await orphan.json()) as { records: number }).records).toBe(
      parentBody.records_total + 2,
    );
  });
});

describe("Datadog Trajectory format", () => {
  // A session file in the Datadog Trajectory daemon's on-disk format, posted like any other
  // transcript. The format is one more input the normalizer turns into trajectory-v1.
  const post = (transcript: string, sessionId = STREAM_SESSION) =>
    call("POST", "/v1/sessions", {
      token: TOKEN,
      body: { agent: "datadog-trajectory", session_id: sessionId, transcript },
    });

  it("stores the session under datadog-trajectory", async () => {
    const res = await post(STREAM);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      status: string;
      archive_id: string;
      content_hash: string;
    };
    expect(body.status).toBe("stored");

    const archive = archiveId("acme", "datadog-trajectory", STREAM_SESSION);
    expect(body.archive_id).toBe(archive);
    const metadata = await readMetadata(store, "acme", archive);
    expect(metadata).toMatchObject({
      agent: "datadog-trajectory",
      source: "datadog-trajectory:claude-code",
      session_id: STREAM_SESSION,
      branch: "feature/auth",
      status: "stored",
      head: body.content_hash,
    });
    expect(metadata?.parent_session_id).toBeUndefined();

    const trace = gunzipJson<{ events: { role: string }[] }>(
      (await getBytes(store, keys.trace("acme", archive, body.content_hash))) as Uint8Array,
    );
    expect(trace.events.map((e) => e.role)).toContain("tool_call");
    expect(JSON.stringify(trace)).not.toContain("hunter2secretvalue42");
    expect(JSON.stringify(trace)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz012345");

    // The same file again changes nothing: the same answer, no second trace.
    const again = await post(STREAM);
    expect(await again.json()).toEqual(body);
    expect((await readMetadata(store, "acme", archive))?.traces).toHaveLength(1);

    // And the session reads back through the ordinary routes.
    const read = await call("GET", `/v1/sessions/datadog-trajectory/${STREAM_SESSION}/trace`, {
      token: TOKEN,
    });
    expect(read.status).toBe(200);
  });

  it("filters a greeting-sized session", async () => {
    const res = await post(STREAM_SMALL);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("filtered");
  });

  it("rejects a file that is not a session stream, storing nothing", async () => {
    const res = await post('{"event_type":"user_prompt","prompt":"hi"}\n', "junk");
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("normalize_missing_session_start");
    expect(
      await readMetadata(store, "acme", archiveId("acme", "datadog-trajectory", "junk")),
    ).toBeNull();
  });
});

describe("ATIF documents", () => {
  // One JSON document per session, from any harness (Decant exports them). Filed under
  // `agent: "atif"`; the trace's source is the harness the document names.
  const ATIF_SMALL = transcript("atif-claude-session.atif.json");
  const ATIF_SESSION = "atif-sess1";
  /** The same document with a final answer long enough to be worth storing. */
  const atifDocument = (change: (doc: { schema_version: string; steps: unknown[] }) => void) => {
    const doc = JSON.parse(ATIF_SMALL);
    doc.steps.push({
      step_id: doc.steps.length + 1,
      timestamp: "2026-11-01T09:00:40.000Z",
      source: "agent",
      message: `The auth flow: ${"details ".repeat(400)}`,
    });
    change(doc);
    return JSON.stringify(doc);
  };
  const ATIF_DOC = atifDocument(() => {});
  const post = (body: Record<string, unknown>) =>
    call("POST", "/v1/sessions", {
      token: TOKEN,
      body: { agent: "atif", session_id: ATIF_SESSION, format: "json", ...body },
    });

  it("stores a whole document under atif, its source the harness it names", async () => {
    const res = await post({ transcript: ATIF_DOC });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { status: string; archive_id: string; content_hash: string };
    expect(body.status).toBe("stored");

    const archive = archiveId("acme", "atif", ATIF_SESSION);
    expect(body.archive_id).toBe(archive);
    expect(await readMetadata(store, "acme", archive)).toMatchObject({
      agent: "atif",
      source: "claude-code",
      head: body.content_hash,
    });
    const trace = (await getTrace(store, "acme", archive, body.content_hash)) as {
      source: string;
      agent: string;
      events: { role: string; tool_name?: string; ok?: boolean }[];
    };
    expect(trace).toMatchObject({ source: "claude-code", agent: "atif" });
    expect(trace.events.filter((e) => e.role === "tool_result")).toMatchObject([
      { tool_name: "Read", ok: true },
      { tool_name: "Bash", ok: false },
      { tool_name: "Task" },
    ]);
    expect(JSON.stringify(trace)).not.toContain("hunter2secretvalue42");

    const again = await post({ transcript: ATIF_DOC });
    expect(await again.json()).toEqual(body);
    // The same document re-serialized is another envelope, but nothing new.
    const reformatted = await post({ transcript: `${ATIF_DOC}\n` });
    expect(reformatted.status).toBe(200);
    expect((await reformatted.json()).status).toBe("unchanged");
  });

  it("refuses a document sent in chunks, whatever the format says", async () => {
    const first = (await (await post({ transcript: ATIF_DOC })).json()) as { bytes_total: number };
    for (const format of ["json", "jsonl"]) {
      const res = await post({ transcript: '{"steps":[]}\n', offset: first.bytes_total, format });
      expect(res.status).toBe(422);
      expect((await res.json()).error.code).toBe("bad_chunk");
    }
    // Nothing was stored for them.
    const metadata = await readMetadata(store, "acme", archiveId("acme", "atif", ATIF_SESSION));
    expect(metadata?.traces).toHaveLength(1);
  });

  it("refuses ATIF-v1.9 by name, storing nothing", async () => {
    const res = await post({
      transcript: atifDocument((doc) => {
        doc.schema_version = "ATIF-v1.9";
      }),
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toEqual({
      code: "normalize_invalid_input",
      message: "ATIF-v1.9 is not supported: this normalizer reads ATIF-v1.0 through ATIF-v1.8",
    });
    expect(await readMetadata(store, "acme", archiveId("acme", "atif", ATIF_SESSION))).toBeNull();
  });
});
