/** An Instance on a temporary folder store, served over real HTTP, driven by `@seshi/client`
 * (X3.6): the whole path a team setup takes, from the client's call through the API and the
 * pipeline to the bucket and back. */

import { createApp } from "@seshi/api";
import { HttpSessionDB, ServerError } from "@seshi/client";
import type { Instance } from "@seshi/instance";
import {
  OffsetMismatch,
  SessionConflict,
  type StoreSessionResult,
  type Trace,
  VERSION,
} from "@seshi/model";
import { readMetadata } from "@seshi/store";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootInstance } from "../tooling/instance";
import { transcript } from "../tooling/testdata";

const TOKEN = "acme-token-0123456789abcdef";
const OTHER = "globex-token-0123456789abcdef";
const SMALL = transcript("claude-basic.claude-code.jsonl");
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

function stored(result: StoreSessionResult): Extract<StoreSessionResult, { content_hash: string }> {
  if (!("content_hash" in result)) throw new Error(`expected a trace, got ${result.status}`);
  return result;
}

let booted: Awaited<ReturnType<typeof bootInstance>>;
let instance: Instance;
let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeEach(async () => {
  booted = await bootInstance(`[auth.tokens]\nacme = "${TOKEN}"\nglobex = "${OTHER}"\n`, {
    newDeploymentId: () => "e2e",
  });
  instance = booted.instance;
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createApp(instance).fetch });
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  server.stop(true);
  await booted.cleanup();
});

const client = (token = TOKEN) => new HttpSessionDB({ server: base, token });

describe("a team setup end to end", () => {
  it("stores, reads, lists, renders, feeds changes and deletes through the client", async () => {
    const db = client();
    expect(await db.me()).toMatchObject({
      owner: "acme",
      kind: "static",
      storage: { url: booted.store.url },
    });
    const result = stored(
      await db.ingest({ agent: "claude-code", session_id: "sess1", transcript: CLAUDE }),
    );
    expect(result.status).toBe("stored");

    // What the client got is what the bucket holds.
    const metadata = await readMetadata(booted.store, "acme", result.archive_id);
    expect(metadata).toMatchObject({ head: result.content_hash, writer: { kind: "static" } });
    expect(await db.getSession("claude-code", "sess1")).toEqual(metadata);

    const trace = (await db.getTrace("claude-code", "sess1")) as Trace;
    expect(trace.content_hash).toBe(result.content_hash);
    expect(await db.getTrace("claude-code", "sess1", undefined, "letta")).toMatchObject({
      schema: "sessionstorage/trace/1",
    });
    expect((await db.listSessions()).sessions.map((s) => s.session_id)).toEqual(["sess1"]);
    expect((await db.changes()).entries.map((e) => e.entry.kind)).toEqual(["published"]);

    // The export route serves the same trace as a download.
    const exported = await fetch(`${base}/v1/sessions/claude-code/sess1/export?format=otlp`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-disposition")).toContain(".otlp.json");

    expect(await db.tombstone("claude-code", "sess1")).toEqual({ removed: 1 });
    expect(await db.getTrace("claude-code", "sess1")).toBeNull();
  });

  it("maps the pipeline's refusals back to the same errors", async () => {
    const db = client();
    const first = stored(
      await db.ingest({ agent: "claude-code", session_id: "sess1", transcript: CLAUDE }),
    );
    await expect(
      db.ingest({
        agent: "claude-code",
        session_id: "sess1",
        transcript: '{"type":"progress"}\n',
        offset: first.bytes_total + 7,
      }),
    ).rejects.toBeInstanceOf(OffsetMismatch);
    await expect(
      db.ingest({
        agent: "claude-code",
        session_id: "sess1",
        transcript: CLAUDE.replace("The auth flow:", "Another:"),
      }),
    ).rejects.toBeInstanceOf(SessionConflict);
    await expect(client("not-a-token-0123456789").me()).rejects.toBeInstanceOf(ServerError);
  });

  it("keeps each owner to their own folder", async () => {
    await client().ingest({ agent: "claude-code", session_id: "mine", transcript: CLAUDE });
    expect(await client(OTHER).getSession("claude-code", "mine")).toBeNull();
    expect((await client(OTHER).listSessions()).sessions).toEqual([]);
  });

  it("answers /healthz with the release and serves job status to admins only", async () => {
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ ok: true, version: VERSION });
    const denied = await fetch(`${base}/v1/admin/jobs`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(denied.status).toBe(403);
    const { admin } = await instance.auth.initAdmin({ owner: "ops" });
    const jobs = await fetch(`${base}/v1/admin/jobs`, {
      headers: { authorization: `Bearer ${admin?.token}` },
    });
    expect(jobs.status).toBe(200);
    expect(await jobs.json()).toMatchObject({
      deployment: "e2e",
      worker: { state: "never" },
      jobs: [{ name: "heartbeat" }, { name: "retention" }],
    });
  });
});

describe("many instances in one process (X1.2)", () => {
  const extra: Awaited<ReturnType<typeof bootInstance>>[] = [];
  beforeAll(async () => {
    extra.push(
      ...(await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          bootInstance(`[auth.tokens]\nowner${i} = "token-${i}-0123456789abcdef"\n`, {
            newDeploymentId: () => `dep-${i}`,
          }),
        ),
      )),
    );
  });
  afterAll(async () => {
    await Promise.all(extra.map((b) => b.cleanup()));
  });

  it("each has its own bucket, deployment and tokens, and none sees another's", async () => {
    const apps = extra.map((b) => createApp(b.instance));
    await Promise.all(
      apps.map(async (app, i) => {
        const res = await app.fetch(
          new Request("http://seshi.test/v1/sessions", {
            method: "POST",
            headers: {
              authorization: `Bearer token-${i}-0123456789abcdef`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ agent: "claude-code", session_id: `s${i}`, transcript: CLAUDE }),
          }),
        );
        expect(res.status).toBe(201);
      }),
    );
    for (const [i, app] of apps.entries()) {
      expect(extra[i]?.instance.deployment).toBe(`dep-${i}`);
      const other = (i + 1) % apps.length;
      const foreign = await app.fetch(
        new Request("http://seshi.test/v1/me", {
          headers: { authorization: `Bearer token-${other}-0123456789abcdef` },
        }),
      );
      expect(foreign.status).toBe(401);
      const listed = await app.fetch(
        new Request("http://seshi.test/v1/sessions", {
          headers: { authorization: `Bearer token-${i}-0123456789abcdef` },
        }),
      );
      expect(
        (await listed.json()).sessions.map((s: { session_id: string }) => s.session_id),
      ).toEqual([`s${i}`]);
    }
  });
});

describe("an instance without the api role", () => {
  it("answers /healthz and nothing else", async () => {
    const worker = await bootInstance(`[auth.tokens]\nacme = "${TOKEN}"\n`, { roles: ["worker"] });
    try {
      const app = createApp(worker.instance);
      expect((await app.fetch(new Request("http://seshi.test/healthz"))).status).toBe(200);
      const me = await app.fetch(
        new Request("http://seshi.test/v1/me", { headers: { authorization: `Bearer ${TOKEN}` } }),
      );
      expect(me.status).toBe(404);
    } finally {
      await worker.cleanup();
    }
  });
});
