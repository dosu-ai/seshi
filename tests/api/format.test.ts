/** The session's format is `format` everywhere (before 0.16 metadata, traces and the upload body
 * called it `agent`): a new session is stored with `format` only, a session stored before reads
 * back with it, both change feeds name it on every entry (an old entry's filled in from the
 * session), and the archive id derived from it is the one it always was. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, createApp } from "@seshi/api";
import { Auth } from "@seshi/auth";
import { HttpSeshi } from "@seshi/client";
import type { Instance } from "@seshi/instance";
import { SearchService } from "@seshi/search";
import {
  archiveId,
  decodeJson,
  FsStore,
  getBytes,
  gunzipJson,
  gzipJsonDeterministic,
  keys,
} from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testInstance } from "../tooling/instance";

const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;
function log(prompt: string): string {
  const ts = "2026-11-01T10:00:00Z";
  return (
    line({ role: "meta", source: "trajectory" }) +
    line({ role: "user", content: `${prompt} ${"context ".repeat(260)}`, timestamp: ts }) +
    line({ role: "assistant", content: "on it", timestamp: ts })
  );
}

const encoder = new TextEncoder();

let dir: string;
let store: FsStore;
let auth: Auth;
let orgKey: string;
let adminToken: string;
const instances: Instance[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "seshi-format-"));
  store = new FsStore(join(dir, "bucket"));
  auth = new Auth(
    {
      staticTokens: [],
      orgKey: true,
      admins: [],
      aliases: {},
      sessionKeys: { k1: "k".repeat(32) },
    },
    { store, deployment: "test" },
  );
  const init = await auth.initAdmin({ owner: "ops" });
  orgKey = init.org_key?.token as string;
  adminToken = init.admin?.token as string;
});

afterEach(async () => {
  for (const i of instances.splice(0)) await i.close();
  rmSync(dir, { recursive: true, force: true });
});

function server(): { instance: Instance; app: App; as: (user?: string) => HttpSeshi } {
  const instance = testInstance({
    store,
    storage: { url: store.url },
    auth,
    search: new SearchService({
      store,
      deployment: "test",
      feed: true,
      settings: { path: ":memory:", events: ["user", "assistant"] },
    }),
  });
  instances.push(instance);
  const app = createApp(instance);
  const as = (user?: string) =>
    new HttpSeshi({
      server: "http://seshi.test",
      token: user ? orgKey : adminToken,
      ...(user ? { user } : {}),
      fetch: (url, init) => app.fetch(new Request(url, init)),
    });
  return { instance, app, as };
}

async function readJson(key: string): Promise<Record<string, unknown>> {
  return decodeJson<Record<string, unknown>>((await getBytes(store, key)) as Uint8Array);
}

async function changeKeys(owner: string, archive: string): Promise<string[]> {
  const page = await store.list(keys.changes(owner), {});
  return page.keys.filter((k) => k.includes(`-${archive}-`));
}

/** Rewrite a stored session as seshi wrote it before 0.16: `agent` in its metadata and traces,
 * no `format` in its change entries. */
async function asWrittenBefore016(owner: string, archive: string): Promise<void> {
  const metadataKey = keys.metadata(owner, archive);
  const { format, ...metadata } = await readJson(metadataKey);
  await store.put(metadataKey, encoder.encode(JSON.stringify({ ...metadata, agent: format })));
  const traces = (metadata.traces as { content_hash: string }[]).map((t) => t.content_hash);
  for (const hash of traces) {
    const key = keys.trace(owner, archive, hash);
    const { format: f, ...trace } = gunzipJson<Record<string, unknown>>(
      (await getBytes(store, key)) as Uint8Array,
    );
    await store.put(key, gzipJsonDeterministic({ ...trace, agent: f }));
  }
  for (const key of await changeKeys(owner, archive)) {
    const { format: _f, ...entry } = await readJson(key);
    await store.put(key, encoder.encode(JSON.stringify(entry)));
  }
}

describe("the session's format", () => {
  it("is stored as `format` only: metadata, trace and change entry", async () => {
    const { as } = server();
    const stored = await as("alice").ingest({
      format: "trajectory",
      session_id: "new",
      transcript: log("deploy"),
    });
    const archive = archiveId("alice", "trajectory", "new");
    expect(stored).toMatchObject({ status: "stored", archive_id: archive });
    const metadata = await readJson(keys.metadata("alice", archive));
    expect(metadata.format).toBe("trajectory");
    expect(metadata).not.toHaveProperty("agent");
    const head = metadata.head as string;
    const trace = gunzipJson<Record<string, unknown>>(
      (await getBytes(store, keys.trace("alice", archive, head))) as Uint8Array,
    );
    expect(trace.format).toBe("trajectory");
    expect(trace).not.toHaveProperty("agent");
    const [entryKey] = await changeKeys("alice", archive);
    expect(await readJson(entryKey as string)).toMatchObject({ format: "trajectory" });
  });

  it("is still read from an upload body that names it `agent` (and its encoding `format`)", async () => {
    const { app } = server();
    const res = await app.fetch(
      new Request("http://seshi.test/v1/sessions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${orgKey}`,
          "x-seshi-user": "alice",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          agent: "trajectory",
          format: "jsonl",
          session_id: "old-client",
          transcript: log("deploy"),
        }),
      }),
    );
    expect(res.status).toBe(201);
    const archive = archiveId("alice", "trajectory", "old-client");
    expect(await readJson(keys.metadata("alice", archive))).toMatchObject({
      format: "trajectory",
    });
  });

  it("takes the render format as `render`, and still as `format`", async () => {
    const { app, as } = server();
    await as("alice").ingest({ format: "trajectory", session_id: "r", transcript: log("ship") });
    const get = (query: string) =>
      app.fetch(
        new Request(`http://seshi.test/v1/sessions/trajectory/r/trace?${query}`, {
          headers: { authorization: `Bearer ${orgKey}`, "x-seshi-user": "alice" },
        }),
      );
    for (const query of ["render=otlp", "format=otlp"]) {
      const res = await get(query);
      expect(res.status, query).toBe(200);
      expect(await res.json(), query).toHaveProperty("resourceSpans");
    }
    expect((await get("render=nope")).status).toBe(400);
  });

  it("is never missing from a feed: an old entry whose session has no metadata is left out", async () => {
    const { instance, as } = server();
    await as("alice").ingest({ format: "trajectory", session_id: "kept", transcript: log("ship") });
    const kept = archiveId("alice", "trajectory", "kept");
    await asWrittenBefore016("alice", kept);
    // An entry for a first write whose pointer never landed: its session has no metadata.
    const orphan = archiveId("alice", "trajectory", "never-landed");
    const [entryKey] = await changeKeys("alice", kept);
    const entry = await readJson(entryKey as string);
    await store.put(
      (entryKey as string).replace(kept, orphan),
      encoder.encode(JSON.stringify({ ...entry, archive_id: orphan, session_id: "never-landed" })),
    );
    expect(await changeKeys("alice", orphan)).toHaveLength(1);

    const own = await as("alice").changes();
    expect(own.entries.map((e) => [e.entry.session_id, e.entry.format])).toEqual([
      ["kept", "trajectory"],
    ]);
    await instance.search?.catchUp();
    const all = await as().allChanges();
    expect(all.entries.map((e) => [e.entry.session_id, e.entry.format])).toEqual([
      ["kept", "trajectory"],
    ]);
  });

  it("derives the archive id it always did", () => {
    // spec/testdata/objects/change.published.json, written before the rename.
    expect(archiveId("alice", "claude-code", "0b1c7e9a-5f2d-4b8e-9a61-3c0f5e2d7a14")).toBe(
      "22e85bf4ed59ee51d9b2f7937ae00e91ef0e9c433f524c847402ea459d2d4779",
    );
  });
});

describe("a session stored before 0.16", () => {
  it("reads back with `format`, its entries named in both feeds, and is rewritten with `format` only", async () => {
    const { instance, as } = server();
    await as("alice").ingest({ format: "trajectory", session_id: "old", transcript: log("ship") });
    const archive = archiveId("alice", "trajectory", "old");
    await asWrittenBefore016("alice", archive);
    expect(await readJson(keys.metadata("alice", archive))).toMatchObject({ agent: "trajectory" });

    const alice = as("alice");
    const metadata = await alice.getSession("trajectory", "old");
    expect(metadata).toMatchObject({ format: "trajectory", archive_id: archive });
    expect(metadata).not.toHaveProperty("agent");
    const trace = await alice.getTrace("trajectory", "old");
    expect(trace).toMatchObject({ format: "trajectory" });
    expect(trace).not.toHaveProperty("agent");

    const own = await alice.changes();
    expect(own.entries.map((e) => e.entry.format)).toEqual(["trajectory"]);
    await instance.search?.catchUp();
    const all = await as().allChanges();
    expect(all.entries.map((e) => [e.entry.session_id, e.entry.format])).toEqual([
      ["old", "trajectory"],
    ]);

    // By the owner and archive id an entry names: the same session, without its format.
    const [entry] = all.entries;
    const reader = as();
    expect(await reader.getSessionByArchive(entry?.owner as string, archive)).toEqual(metadata);
    expect(await reader.getTraceByArchive("alice", archive)).toEqual(trace);
    expect(await reader.getTraceByArchive("alice", archive, undefined, "otlp")).toHaveProperty(
      "resourceSpans",
    );
    expect(await reader.reviewsByArchive("alice", archive)).toEqual([]);
    expect(await reader.getSessionByArchive("bob", archive)).toBeNull();

    // A write moves it to the new shape: the metadata names `format` only, the new entry too.
    await alice.setVisibility("trajectory", "old", "owner");
    const rewritten = await readJson(keys.metadata("alice", archive));
    expect(rewritten).toMatchObject({ format: "trajectory", visibility: "owner" });
    expect(rewritten).not.toHaveProperty("agent");
    const entries = await Promise.all((await changeKeys("alice", archive)).map(readJson));
    expect(entries.map((e) => [e.kind, e.format])).toEqual([
      ["published", undefined],
      ["visibility_changed", "trajectory"],
    ]);
  });
});
