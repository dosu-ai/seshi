/** The search index's behaviour, written once against `IndexStore` and run against every
 * backend: SQLite, LanceDB on a folder, and LanceDB on S3 when an endpoint is given (as the
 * store's live S3 test is):
 *
 *   SESHI_TEST_S3_ENDPOINT=http://127.0.0.1:9000
 *   SESHI_TEST_S3_BUCKET=seshi-test
 *   SESHI_TEST_S3_ACCESS_KEY / SESHI_TEST_S3_SECRET_KEY
 *
 * Output that only FTS5 gives (its snippets' exact text, its scores) stays in sqlite.test.ts;
 * what LanceDB alone does (generations beside the live one, the scrub, caps) is in
 * lance.test.ts. */

import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@lancedb/lancedb";
import { BUILTIN_FORMATS, FormatRegistry } from "@seshi/formats";
import type { ChangeEntry, EventRole } from "@seshi/model";
import { StoreSeshi, setVisibility, tombstone } from "@seshi/pipeline";
import type {
  BackendQuery,
  IndexedEvent,
  IndexedLlmCall,
  IndexedSession,
  IndexOptions,
  IndexStore,
  OpenIndex,
  Removal,
  SessionListQuery,
  SessionPosition,
  SessionUpdate,
} from "@seshi/search";
import {
  LOCAL_VIEWER,
  MATCH_END,
  MATCH_START,
  parseQuery,
  SearchService,
  sqliteIndex,
  type Viewer,
} from "@seshi/search";
import { FetchAzureBlobClient, FsStore, type Store } from "@seshi/store";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { lanceIndex } from "./index";

const H = (n: number) => n.toString(16).padStart(64, "0");
const EVENTS: readonly EventRole[] = ["user", "assistant", "tool_call"];
const ALL: readonly EventRole[] = [...EVENTS, "tool_result", "system", "observation", "reasoning"];

const s3 = {
  endpoint: process.env.SESHI_TEST_S3_ENDPOINT,
  bucket: process.env.SESHI_TEST_S3_BUCKET,
  key: process.env.SESHI_TEST_S3_ACCESS_KEY,
  secret: process.env.SESHI_TEST_S3_SECRET_KEY,
};
const s3Configured = Boolean(s3.endpoint && s3.bucket && s3.key && s3.secret);

function s3StorageOptions(): Record<string, string> {
  return {
    aws_endpoint: s3.endpoint as string,
    aws_access_key_id: s3.key as string,
    aws_secret_access_key: s3.secret as string,
    aws_region: "us-east-1",
    allow_http: "true",
  };
}

// Azure Blob Storage: Azurite in CI, as tests/store/azure-live.test.ts.
const azure = {
  endpoint: process.env.SESHI_TEST_AZURE_ENDPOINT,
  account: process.env.SESHI_TEST_AZURE_ACCOUNT,
  key: process.env.SESHI_TEST_AZURE_KEY,
  container: process.env.SESHI_TEST_AZURE_CONTAINER ?? "seshi-test",
};
const azureConfigured = Boolean(azure.endpoint && azure.account && azure.key);

function azureStorageOptions(): Record<string, string> {
  return {
    azure_storage_account_name: azure.account as string,
    azure_storage_account_key: azure.key as string,
    azure_storage_endpoint: azure.endpoint as string,
    ...(azure.endpoint?.startsWith("http://") ? { allow_http: "true" } : {}),
  };
}

// Google Cloud Storage: a real bucket only, with Application Default Credentials. LanceDB's
// client cannot write to fake-gcs-server, so CI's emulator does not count.
const gcsBucket = process.env.SESHI_TEST_GCS_EMULATOR
  ? undefined
  : process.env.SESHI_TEST_GCS_BUCKET;

interface Backend {
  name: string;
  skip: boolean;
  /** A fresh location for one test. */
  location(dir: string): string;
  open(location: string): OpenIndex;
  /** The live generation's rows of a table, as stored, for the columns no query returns yet
   * (`sql` will). Only for a backend on this machine. */
  rows?(location: string, table: "events" | "llm_calls"): Promise<Raw[]>;
}

type Raw = Record<string, unknown>;

/** A stored value as JavaScript: Arrow's `bigint`s and times as numbers, SQLite's 0 and 1 for
 * `ok` as booleans. */
function plain(row: Raw): Raw {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k,
      typeof v === "bigint"
        ? Number(v)
        : v instanceof Date
          ? v.getTime()
          : k === "ok" && typeof v === "number"
            ? v === 1
            : v,
    ]),
  );
}

const EVENT_COLUMNS = [
  "archive_id",
  "content_hash",
  "event_index",
  "seq",
  "role",
  "tool_call_id",
  "ok",
  "chars",
];
const CALL_COLUMNS = [
  "archive_id",
  "content_hash",
  "call_id",
  "model",
  "started_at",
  "input_tokens",
  "output_tokens",
  "error",
];

function pick(rows: Raw[], columns: readonly string[]): Raw[] {
  return rows
    .map((r) => plain(Object.fromEntries(columns.map((c) => [c, r[c] ?? null]))))
    .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
}

async function sqliteRows(path: string, table: "events" | "llm_calls"): Promise<Raw[]> {
  const db = new Database(path, { readonly: true });
  try {
    return db
      .query(`SELECT s.archive_id, t.* FROM ${table} t JOIN sessions s ON s.id = t.session`)
      .all() as Raw[];
  } finally {
    db.close();
  }
}

async function lanceRows(uri: string, table: "events" | "llm_calls"): Promise<Raw[]> {
  const root = await connect(uri);
  const meta = new Map(
    (await (await root.openTable("meta")).query().toArray()).map((r) => [
      String(r.key),
      String(r.value),
    ]),
  );
  const gen = meta.get("active") as string;
  const db = await connect(join(uri, gen));
  const name = meta.get(`${gen}.table.${table}`) ?? table;
  return (await (await db.openTable(name)).query().toArray()) as Raw[];
}

let run = 0;
const BACKENDS: Backend[] = [
  {
    name: "SQLite",
    skip: false,
    location: (dir) => join(dir, "index.sqlite"),
    open: (path) => sqliteIndex({ path }),
    rows: sqliteRows,
  },
  {
    name: "LanceDB on a folder",
    skip: false,
    location: (dir) => join(dir, "lance"),
    open: (uri) => lanceIndex({ uri, readConsistency: 0 }),
    rows: lanceRows,
  },
  {
    name: "LanceDB on S3",
    skip: !s3Configured,
    location: () => `s3://${s3.bucket}/conformance-${Date.now().toString(36)}-${run++}`,
    open: (uri) => lanceIndex({ uri, readConsistency: 0, storageOptions: s3StorageOptions() }),
  },
  {
    name: "LanceDB on Azure Blob Storage",
    skip: !azureConfigured,
    location: () => `az://${azure.container}/conformance-${Date.now().toString(36)}-${run++}`,
    open: (uri) => lanceIndex({ uri, readConsistency: 0, storageOptions: azureStorageOptions() }),
  },
  {
    name: "LanceDB on Google Cloud Storage",
    skip: gcsBucket === undefined,
    location: () => `gs://${gcsBucket}/conformance-${Date.now().toString(36)}-${run++}`,
    open: (uri) => lanceIndex({ uri, readConsistency: 0 }),
  },
];

beforeAll(async () => {
  if (!azureConfigured) return;
  await new FetchAzureBlobClient({
    account: azure.account as string,
    container: azure.container,
    endpoint: azure.endpoint as string,
    credentials: { accountKey: azure.key as string },
  }).createContainer();
});

const formats = new FormatRegistry(BUILTIN_FORMATS);

function session(n: number, fields: Partial<IndexedSession> = {}): IndexedSession {
  return {
    owner: "alice",
    archive_id: H(n),
    format: "claude-code",
    session_id: `s${n}`,
    visibility: "org",
    updated_at: "2026-11-14T09:00:00.000Z",
    traces: [H(100 + n)],
    event_count: 0,
    ...fields,
  };
}

function event(text: string, fields: Partial<IndexedEvent> = {}): IndexedEvent {
  const index = fields.event_index ?? 0;
  return {
    content_hash: H(100),
    event_index: index,
    seq: index,
    role: "user",
    text,
    chars: text.length,
    ...fields,
  };
}

/** A session of one trace, with these texts as its records. */
function replace(
  n: number,
  texts: string[],
  fields: Partial<IndexedSession> = {},
  read_at = 1,
): SessionUpdate {
  const s = session(n, fields);
  return {
    session: s,
    events: texts.map((text, i) =>
      event(text, { content_hash: s.traces[0] as string, event_index: i }),
    ),
    replace: true,
    read_at,
  };
}

const member = (owner: string): Viewer => ({
  everything: false,
  own: [owner],
  canRead: (s) => s.owner === owner || s.visibility !== "owner",
});

describe.each(BACKENDS)("the search index on $name", (backend) => {
  let dir: string;
  let where: string;
  const opened: IndexStore[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seshi-conformance-"));
    where = backend.location(dir);
  });
  afterEach(async () => {
    for (const index of opened.splice(0)) await index.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function open(options: Partial<IndexOptions> = {}): Promise<IndexStore> {
    const index = await backend.open(where)({ deployment: "d1", events: EVENTS, ...options });
    opened.push(index);
    return index;
  }

  async function page(
    index: IndexStore,
    updates: SessionUpdate[],
    removals: Removal[] = [],
    owner = "alice",
  ) {
    return index.commit({
      generation: await index.generation(),
      owner,
      updates,
      removals,
      feed: [],
      seen: [],
      cursor: undefined,
      forgetBefore: 0,
    });
  }

  /** Commit, then end a pass: what every search below runs after. */
  async function indexed(index: IndexStore, ...updates: SessionUpdate[]): Promise<void> {
    if (updates.length > 0) await page(index, updates);
    await index.passDone(await index.generation(), "2026-11-14T12:00:00.000Z");
  }

  function query(index: IndexStore, q: string, extra: Partial<BackendQuery> = {}) {
    return index.query({
      match: parseQuery(q).match,
      viewer: LOCAL_VIEWER,
      sort: "relevance",
      limit: 20,
      offset: 0,
      matches: 3,
      ...extra,
    });
  }

  const names = async (index: IndexStore, q: string, extra: Partial<BackendQuery> = {}) =>
    (await query(index, q, extra)).hits.map((h) => h.session.session_id);

  describe.skipIf(backend.skip)("", () => {
    it("finds sessions by their records, best first, with the match marked", async () => {
      const index = await open();
      await indexed(
        index,
        replace(1, ["deploy the widget service to staging", "ran the deploy again, deploy deploy"]),
        replace(2, ["unrelated chat"]),
        replace(3, ["one deploy among many other words in a long record about other things"]),
      );
      const found = await query(index, "deploy");
      expect(found.total).toBe(2);
      expect(found.hits.map((h) => h.session.session_id)).toEqual(["s1", "s3"]);
      expect(found.hits[0]?.hits).toBe(2);
      expect(found.hits[0]?.score).toBeGreaterThan(found.hits[1]?.score as number);
      expect(found.hits[0]?.matches[0]).toMatchObject({ event_index: 1, role: "user" });
      expect(found.hits[0]?.matches[0]?.marked).toContain(`${MATCH_START}deploy${MATCH_END}`);
      expect(found.hits[0]?.session).toEqual(session(1));
      const state = await index.state();
      expect(state).toMatchObject({ sessions: 3, events: 4, ready_at: "2026-11-14T12:00:00.000Z" });
    });

    it("keeps every session field it was given", async () => {
      const index = await open();
      const full = session(1, {
        origin_agent: "claude-code",
        native_session_id: "n1",
        project: "app",
        branch: "main",
        repo: "github.com/acme/app",
        harness: "claude-code",
        agent_version: "2.1.0",
        models: ["claude-opus-5-5", "claude-haiku-5-5"],
        labels: { team: "core", "dosu.project": "app" },
        source_id: "upload",
        started_at: Date.parse("2026-11-14T08:00:00.000Z"),
        ended_at: Date.parse("2026-11-14T08:30:00.000Z"),
      });
      await indexed(index, { session: full, events: [event("hello")], replace: true, read_at: 1 });
      expect((await query(index, "hello")).hits[0]?.session).toEqual(full);
      expect(
        (await index.sessions(await index.generation(), "alice", [H(1), H(2)])).get(H(1)),
      ).toEqual(full);
    });

    it("appends a continuation's records, and drops a replaced session's earlier ones", async () => {
      const index = await open();
      await indexed(index, replace(1, ["first chunk alpha"]));
      const continued = session(1, {
        traces: [H(101), H(201)],
        updated_at: "2026-11-14T10:00:00.000Z",
      });
      const result = await page(index, [
        {
          session: continued,
          events: [event("second chunk beta", { content_hash: H(201) })],
          replace: false,
          base: [H(101)],
          read_at: 2,
        },
      ]);
      expect(result).toEqual({ stale: false, refused: [], removed: 0 });
      await indexed(index);
      expect((await query(index, "alpha")).total).toBe(1);
      expect((await query(index, "beta")).hits[0]?.matches[0]?.content_hash).toBe(H(201));
      expect(
        (await index.sessions(await index.generation(), "alice", [H(1)])).get(H(1))?.traces,
      ).toEqual([H(101), H(201)]);
      await indexed(index, {
        ...replace(1, [], { traces: [H(301)] }, 3),
        events: [event("rewritten gamma", { content_hash: H(301) })],
      });
      expect((await query(index, "alpha")).total).toBe(0);
      expect((await query(index, "beta")).total).toBe(0);
      expect((await query(index, "gamma")).total).toBe(1);
      expect((await index.state()).events).toBe(1);
    });

    it("keeps each record's place, tool call id, outcome and full length, and gives its place on a match", async () => {
      const index = await open({ events: ALL });
      const s = session(1);
      const hash = s.traces[0] as string;
      await indexed(index, {
        session: { ...s, event_count: 4 },
        events: [
          event("run the suite", { content_hash: hash, event_index: 0, seq: 0 }),
          event("npm test", {
            content_hash: hash,
            event_index: 1,
            seq: 1,
            role: "tool_call",
            tool_name: "Bash",
            tool_call_id: "t1",
          }),
          // What the assistant said alongside the call: the call's index, and its own role.
          event("running it now", {
            content_hash: hash,
            event_index: 1,
            seq: 1,
            role: "assistant",
          }),
          event("suite failed loudly", {
            content_hash: hash,
            event_index: 3,
            seq: 3,
            role: "tool_result",
            tool_name: "Bash",
            tool_call_id: "t1",
            ok: false,
            chars: 9_000,
          }),
        ],
        replace: true,
        read_at: 1,
      });
      const failed = await query(index, "failed");
      expect(failed.hits[0]?.matches[0]).toMatchObject({
        seq: 3,
        event_index: 3,
        role: "tool_result",
      });
      expect((await query(index, "running")).hits[0]?.matches[0]).toMatchObject({
        seq: 1,
        role: "assistant",
      });
      expect((await query(index, "npm")).hits[0]?.matches[0]).toMatchObject({
        seq: 1,
        role: "tool_call",
      });
      expect((await index.state()).events).toBe(4);
      expect(
        (await index.sessions(await index.generation(), "alice", [H(1)])).get(H(1))?.event_count,
      ).toBe(4);
      if (!backend.rows) return;
      expect(pick(await backend.rows(where, "events"), EVENT_COLUMNS)).toEqual(
        pick(
          [
            { seq: 0, event_index: 0, role: "user", chars: 13 },
            { seq: 1, event_index: 1, role: "tool_call", tool_call_id: "t1", chars: 8 },
            { seq: 1, event_index: 1, role: "assistant", chars: 14 },
            {
              seq: 3,
              event_index: 3,
              role: "tool_result",
              tool_call_id: "t1",
              ok: false,
              chars: 9_000,
            },
          ].map((r) => ({ archive_id: H(1), content_hash: hash, ...r })),
          EVENT_COLUMNS,
        ),
      );
    });

    it("searches only the roles asked for", async () => {
      const index = await open({ events: ALL });
      await indexed(
        index,
        {
          ...replace(1, []),
          events: [
            event("deploy the api", { content_hash: H(101) }),
            event("deploy failed: quota", {
              content_hash: H(101),
              event_index: 1,
              role: "tool_result",
            }),
          ],
        },
        replace(2, ["deploy the web app"]),
      );
      expect(await names(index, "deploy")).toEqual(["s1", "s2"]);
      const output = await query(index, "deploy", { roles: ["tool_result"] });
      expect(output.total).toBe(1);
      expect(output.hits.map((h) => h.matches.map((m) => m.role))).toEqual([["tool_result"]]);
      expect(await names(index, "deploy", { roles: ["user", "observation"] })).toEqual([
        "s1",
        "s2",
      ]);
      expect(await names(index, "deploy", { roles: ["reasoning"] })).toEqual([]);
      expect(await names(index, "deploy", { roles: [] })).toEqual([]);
    });

    it("keeps a session's model calls beside its events: continued, replaced and removed with them", async () => {
      const index = await open();
      const call = (hash: string, id: string, fields: Partial<IndexedLlmCall> = {}) => ({
        content_hash: hash,
        call_id: id,
        model: "opus",
        started_at: Date.parse("2026-11-14T09:00:00.000Z"),
        input_tokens: 100,
        output_tokens: 20,
        ...fields,
      });
      await indexed(
        index,
        { ...replace(1, ["first"]), llm_calls: [call(H(101), "a"), call(H(101), "b")] },
        { ...replace(2, ["other"]), llm_calls: [call(H(102), "a", { error: "overloaded" })] },
      );
      const calls = async () =>
        backend.rows
          ? pick(await backend.rows(where, "llm_calls"), CALL_COLUMNS).map(
              (r) =>
                `${Number.parseInt(r.archive_id as string, 16)}:${Number.parseInt(r.content_hash as string, 16)}:${r.call_id}`,
            )
          : [];
      if (backend.rows) {
        expect(pick(await backend.rows(where, "llm_calls"), CALL_COLUMNS)).toContainEqual(
          plain({
            archive_id: H(2),
            content_hash: H(102),
            call_id: "a",
            model: "opus",
            started_at: Date.parse("2026-11-14T09:00:00.000Z"),
            input_tokens: 100,
            output_tokens: 20,
            error: "overloaded",
          }),
        );
        expect(await calls()).toEqual(["1:101:a", "1:101:b", "2:102:a"]);
      }
      // A continuation adds its trace's calls.
      await indexed(index, {
        session: session(1, { traces: [H(101), H(201)] }),
        events: [event("second", { content_hash: H(201) })],
        llm_calls: [call(H(201), "a")],
        replace: false,
        base: [H(101)],
        read_at: 2,
      });
      if (backend.rows) expect(await calls()).toEqual(["1:101:a", "1:101:b", "1:201:a", "2:102:a"]);
      // A replace keeps only the new traces' calls; a session's calls go with it.
      await indexed(index, {
        ...replace(1, ["third"], { traces: [H(301)] }, 3),
        llm_calls: [call(H(301), "z")],
      });
      if (backend.rows) expect(await calls()).toEqual(["1:301:z", "2:102:a"]);
      await page(index, [], [{ archive: H(2), read_at: 5, scrub: false }]);
      if (backend.rows) expect(await calls()).toEqual(["1:301:z"]);
      expect((await query(index, "third")).total).toBe(1);
    });

    it("rewrites a continued session's earlier records when its visibility changes", async () => {
      const index = await open();
      await indexed(index, replace(1, ["shared plan"]));
      await page(index, [
        {
          session: session(1, { visibility: "owner", traces: [H(101), H(201)] }),
          events: [event("more of the plan", { content_hash: H(201) })],
          replace: false,
          base: [H(101)],
          read_at: 2,
        },
      ]);
      await indexed(index);
      expect(await names(index, "plan", { viewer: member("bob") })).toEqual([]);
      expect((await query(index, "shared", { viewer: member("alice") })).total).toBe(1);
    });

    it("filters a record with no time of its own by its session's time, as the session moves on", async () => {
      const index = await open();
      await indexed(index, replace(1, ["timeless words"]));
      await page(index, [
        {
          session: session(1, {
            traces: [H(101), H(201)],
            updated_at: "2026-11-20T09:00:00.000Z",
          }),
          events: [
            event("later words", {
              content_hash: H(201),
              timestamp: Date.parse("2026-11-20T09:00:00.000Z"),
            }),
          ],
          replace: false,
          base: [H(101)],
          read_at: 2,
        },
      ]);
      await indexed(index);
      expect(
        await names(index, "timeless", { since: Date.parse("2026-11-18T00:00:00.000Z") }),
      ).toEqual(["s1"]);
      expect(
        await names(index, "timeless", { until: Date.parse("2026-11-15T00:00:00.000Z") }),
      ).toEqual([]);
    });

    it("refuses an update read before what it holds, and a continuation of other traces", async () => {
      const index = await open();
      await indexed(index, replace(1, ["newer words"], {}, 10));
      const late = await page(index, [replace(1, ["older words"], {}, 5)]);
      expect(late.refused).toEqual([H(1)]);
      const wrongBase = await page(index, [
        {
          session: session(1, { traces: [H(101), H(201)] }),
          events: [event("continued", { content_hash: H(201) })],
          replace: false,
          base: [H(999)],
          read_at: 20,
        },
      ]);
      expect(wrongBase.refused).toEqual([H(1)]);
      await indexed(index);
      expect((await query(index, "older")).total).toBe(0);
      expect((await query(index, "continued")).total).toBe(0);
      expect((await query(index, "newer")).total).toBe(1);
      // Read later: taken.
      expect((await page(index, [replace(1, ["newest words"], {}, 11)])).refused).toEqual([]);
    });

    it("removes a session, remembering the removal against late updates", async () => {
      const index = await open();
      await indexed(index, replace(1, ["doomed words"]), replace(2, ["kept words"]));
      const removed = await page(
        index,
        [],
        [
          { archive: H(1), read_at: 5, scrub: true },
          { archive: H(9), read_at: 5, scrub: false },
        ],
      );
      expect(removed).toEqual({ stale: false, refused: [], removed: 1 });
      await indexed(index);
      expect(await names(index, "words")).toEqual(["s2"]);
      expect((await index.sessions(await index.generation(), "alice", [H(1), H(9)])).size).toBe(0);
      // Read before the removal: refused, for a session never held too.
      expect((await page(index, [replace(1, ["back again"], {}, 4)])).refused).toEqual([H(1)]);
      expect((await page(index, [replace(9, ["never was"], {}, 4)])).refused).toEqual([H(9)]);
      // Read after it: indexed.
      expect((await page(index, [replace(1, ["back again"], {}, 6)])).refused).toEqual([]);
      await indexed(index);
      expect(await names(index, "back")).toEqual(["s1"]);
      expect((await index.state()).sessions).toBe(2);
    });

    it("skips records with no text", async () => {
      const index = await open();
      await indexed(index, replace(1, ["   ", "", "some text"]));
      expect((await index.state()).events).toBe(1);
    });

    it("shows a viewer only what it may see, and counts only that (F10.4, X5.10)", async () => {
      const index = await open();
      await indexed(
        index,
        replace(1, ["roadmap draft"]),
        replace(2, ["roadmap secret"], { visibility: "owner" }),
        replace(3, ["roadmap notes"], { owner: "bob" }),
        replace(4, ["roadmap bob private"], { owner: "bob", visibility: "owner" }),
      );
      expect((await names(index, "roadmap", { viewer: member("alice") })).sort()).toEqual([
        "s1",
        "s2",
        "s3",
      ]);
      expect((await query(index, "roadmap", { viewer: member("carol") })).total).toBe(2);
      const ownOnly: Viewer = { ...member("bob"), ownOnly: true };
      expect((await names(index, "roadmap", { viewer: ownOnly })).sort()).toEqual(["s3", "s4"]);
      expect(
        await names(index, "roadmap", { viewer: { ...member("x"), own: [], ownOnly: true } }),
      ).toEqual([]);
      expect((await names(index, "roadmap", { owners: ["bob"] })).sort()).toEqual(["s3", "s4"]);
      expect(await names(index, "roadmap", { owners: [] })).toEqual([]);
    });

    it("filters by agent, repo, branch, harness, version, model, labels, source and time", async () => {
      const index = await open();
      await indexed(
        index,
        replace(
          1,
          ["filter target"],
          {
            format: "claude-code",
            repo: "github.com/acme/app",
            branch: "main",
            harness: "claude-code",
            agent_version: "2.1.0",
            models: ["claude-opus-5-5", "claude-haiku-5-5"],
            labels: { team: "core", "dosu.project": "app" },
            source_id: "upload",
          },
          1,
        ),
        replace(
          2,
          ["filter target"],
          {
            format: "vcs:checkout",
            origin_agent: "codex",
            repo: "gitlab.com/other/APP",
            branch: "feat/x",
            harness: "codex",
            agent_version: "0.9",
            models: ["gpt-5.2"],
            labels: { team: "core" },
            source_id: "hook",
            updated_at: "2026-11-20T09:00:00.000Z",
          },
          1,
        ),
      );
      const only = (extra: Partial<BackendQuery>) => names(index, "filter", extra);
      expect(await only({ agent: "claude-code" })).toEqual(["s1"]);
      expect(await only({ agent: "codex" })).toEqual(["s2"]);
      expect(await only({ repo: "github.com/acme/app" })).toEqual(["s1"]);
      expect(await only({ repo: "GITHUB.com/acme/APP" })).toEqual(["s1"]);
      expect((await only({ repo: "app" })).sort()).toEqual(["s1", "s2"]);
      expect(await only({ repo: "other/app" })).toEqual(["s2"]);
      expect(await only({ repo: "pp" })).toEqual([]);
      expect(await only({ branch: "feat/x" })).toEqual(["s2"]);
      expect(await only({ harness: "codex" })).toEqual(["s2"]);
      expect(await only({ agent_version: "2.1.0" })).toEqual(["s1"]);
      expect(await only({ model: "claude-haiku-5-5" })).toEqual(["s1"]);
      expect(await only({ model: "claude" })).toEqual([]);
      expect((await only({ labels: { team: "core" } })).sort()).toEqual(["s1", "s2"]);
      expect(await only({ labels: { team: "core", "dosu.project": "app" } })).toEqual(["s1"]);
      expect(await only({ labels: { team: "cor" } })).toEqual([]);
      expect(await only({ source: "hook" })).toEqual(["s2"]);
      // A record's time is the session's when it has none.
      expect(await only({ since: Date.parse("2026-11-15T00:00:00.000Z") })).toEqual(["s2"]);
      expect(await only({ until: Date.parse("2026-11-15T00:00:00.000Z") })).toEqual(["s1"]);
    });

    it("matches hostile filter values exactly, as values", async () => {
      const hostile = [
        "it's",
        "a\\",
        "50%",
        "a_b",
        "' OR '1'='1",
        "x') OR (owner = 'bob",
        '"quoted"',
        "back\\'slash",
        "]",
        "%",
        "_",
        "\\",
      ];
      const index = await open();
      await indexed(
        index,
        ...hostile.map((value, i) =>
          replace(
            i + 1,
            ["hostile target"],
            {
              repo: `github.com/acme/${value}`,
              branch: value,
              harness: value,
              agent_version: value,
              models: [value],
              labels: { k: value },
              source_id: value,
              format: value,
            },
            1,
          ),
        ),
      );
      for (const [i, value] of hostile.entries()) {
        const one = [`s${i + 1}`];
        for (const filter of [
          { branch: value },
          { harness: value },
          { agent_version: value },
          { model: value },
          { labels: { k: value } },
          { source: value },
          { agent: value },
          { repo: `github.com/acme/${value}` },
          { repo: `acme/${value}` },
        ] as Partial<BackendQuery>[]) {
          expect({ filter, found: await names(index, "hostile", filter) }).toEqual({
            filter,
            found: one,
          });
        }
      }
      expect(await names(index, "hostile", { owners: ["x' OR '1'='1"] })).toEqual([]);
    });

    describe("listing sessions without words (list_sessions)", () => {
      const list = (index: IndexStore, extra: Partial<SessionListQuery> = {}) =>
        index.listSessions({ viewer: LOCAL_VIEWER, limit: 20, ...extra });
      const listed = async (index: IndexStore, extra: Partial<SessionListQuery> = {}) =>
        (await list(index, extra)).sessions.map((s) => s.session_id);
      const at = (iso: string) => Date.parse(iso);

      it("lists every session, newest first, with its fields, and never a removed one", async () => {
        const index = await open();
        const full = session(1, {
          repo: "github.com/acme/app",
          branch: "main",
          models: ["claude-opus-5-5"],
          labels: { team: "core" },
          started_at: at("2026-11-14T08:00:00.000Z"),
          ended_at: at("2026-11-14T08:30:00.000Z"),
          updated_at: "2026-11-14T08:30:00.000Z",
        });
        await indexed(
          index,
          { session: full, events: [event("a")], replace: true, read_at: 1 },
          replace(2, ["b"], { updated_at: "2026-11-15T09:00:00.000Z" }),
          replace(3, ["c"], { updated_at: "2026-11-13T09:00:00.000Z" }),
          // No events with text: listed all the same.
          replace(4, [], { updated_at: "2026-11-12T09:00:00.000Z" }),
        );
        expect(await listed(index)).toEqual(["s2", "s1", "s3", "s4"]);
        expect((await list(index)).sessions[1]).toEqual(full);
        await page(index, [], [{ archive: H(2), read_at: 5, scrub: false }]);
        expect(await listed(index)).toEqual(["s1", "s3", "s4"]);
      });

      it("pages newest first with no session given twice, ties broken by key", async () => {
        const index = await open();
        const same = "2026-11-14T09:00:00.000Z";
        await indexed(
          index,
          ...[1, 2, 3, 4, 5].map((n) => replace(n, ["x"], { updated_at: same })),
          replace(6, ["x"], { owner: "bob", updated_at: same }),
          replace(7, ["x"], { updated_at: "2026-11-15T09:00:00.000Z" }),
        );
        const seen: string[] = [];
        let after: SessionPosition | undefined;
        for (let i = 0; i < 10; i++) {
          const got = await list(index, { limit: 2, ...(after ? { after } : {}) });
          seen.push(...got.sessions.map((s) => `${s.owner}/${s.session_id}`));
          const last = got.sessions.at(-1);
          if (!got.more || last === undefined) break;
          after = { updated: Date.parse(last.updated_at), key: `${last.owner}/${last.archive_id}` };
        }
        expect(seen).toEqual([
          "alice/s7",
          "bob/s6",
          "alice/s5",
          "alice/s4",
          "alice/s3",
          "alice/s2",
          "alice/s1",
        ]);
      });

      it("lists the sessions that overlap the window", async () => {
        const index = await open();
        await indexed(
          index,
          // 08:00–10:00 on the 14th.
          replace(1, ["x"], {
            started_at: at("2026-11-14T08:00:00.000Z"),
            ended_at: at("2026-11-14T10:00:00.000Z"),
            updated_at: "2026-11-14T10:00:00.000Z",
          }),
          // No event times: its last update stands for both ends.
          replace(2, ["x"], { updated_at: "2026-11-16T09:00:00.000Z" }),
          // Started, not ended.
          replace(3, ["x"], {
            started_at: at("2026-11-10T08:00:00.000Z"),
            updated_at: "2026-11-11T09:00:00.000Z",
          }),
        );
        const window = (since: string, until?: string) =>
          listed(index, { since: at(since), ...(until ? { until: at(until) } : {}) });
        expect(await window("2026-11-14T09:00:00.000Z", "2026-11-14T09:30:00.000Z")).toEqual([
          "s1",
        ]);
        expect(await window("2026-11-14T10:00:00.000Z")).toEqual(["s2", "s1"]);
        expect(await window("2026-11-14T10:00:01.000Z")).toEqual(["s2"]);
        expect(await window("2026-11-01T00:00:00.000Z", "2026-11-14T07:59:59.000Z")).toEqual([
          "s3",
        ]);
        expect(await window("2026-11-11T09:00:00.000Z", "2026-11-11T09:00:00.000Z")).toEqual([
          "s3",
        ]);
      });

      it("shows a viewer only what it may see, and filters as search does", async () => {
        const index = await open();
        await indexed(
          index,
          replace(1, ["x"], {
            repo: "github.com/acme/app",
            branch: "main",
            harness: "claude-code",
            agent_version: "2.1.0",
            models: ["claude-opus-5-5", "claude-haiku-5-5"],
            labels: { team: "core", "dosu.project": "app" },
            source_id: "upload",
          }),
          replace(2, ["x"], {
            visibility: "owner",
            format: "vcs:checkout",
            origin_agent: "codex",
            repo: "gitlab.com/other/APP",
            labels: { team: "core" },
          }),
          replace(3, ["x"], { owner: "bob", labels: { note: 'a "quoted": "x" 50%_\\' } }),
          replace(4, ["x"], { owner: "bob", visibility: "owner" }),
        );
        const sorted = async (extra: Partial<SessionListQuery>) =>
          (await listed(index, extra)).sort();
        expect(await sorted({ viewer: member("alice") })).toEqual(["s1", "s2", "s3"]);
        expect(await sorted({ viewer: member("carol") })).toEqual(["s1", "s3"]);
        expect(await sorted({ viewer: { ...member("bob"), ownOnly: true } })).toEqual(["s3", "s4"]);
        expect(await sorted({ viewer: { ...member("x"), own: [], ownOnly: true } })).toEqual([]);
        expect(await sorted({ owners: ["bob"] })).toEqual(["s3", "s4"]);
        expect(await sorted({ owners: [] })).toEqual([]);
        expect(await sorted({ agent: "codex" })).toEqual(["s2"]);
        expect(await sorted({ repo: "app" })).toEqual(["s1", "s2"]);
        expect(await sorted({ repo: "acme/app" })).toEqual(["s1"]);
        expect(await sorted({ branch: "main" })).toEqual(["s1"]);
        expect(await sorted({ harness: "claude-code" })).toEqual(["s1"]);
        expect(await sorted({ agent_version: "2.1.0" })).toEqual(["s1"]);
        expect(await sorted({ model: "claude-haiku-5-5" })).toEqual(["s1"]);
        expect(await sorted({ source: "upload" })).toEqual(["s1"]);
        expect(await sorted({ labels: { team: "core" } })).toEqual(["s1", "s2"]);
        expect(await sorted({ labels: { team: "core", "dosu.project": "app" } })).toEqual(["s1"]);
        expect(await sorted({ labels: { team: "cor" } })).toEqual([]);
        expect(await sorted({ labels: { note: 'a "quoted": "x" 50%_\\' } })).toEqual(["s3"]);
        expect(await sorted({ labels: { note: "a" } })).toEqual([]);
        expect(await sorted({ labels: { quoted: "x" } })).toEqual([]);
        expect(await sorted({ owners: ["x' OR '1'='1"] })).toEqual([]);
      });
    });

    it("finds phrases, words split by punctuation, and either word of an OR", async () => {
      const index = await open();
      await indexed(
        index,
        replace(1, ["the flaky checkout test failed again"]),
        replace(2, ["checkout is flaky, the test passed"]),
        replace(3, ["edit src/app.ts and run it"]),
        replace(4, ["rollback the release"]),
        replace(5, ["a deployer job"]),
      );
      expect(await names(index, '"flaky checkout test"')).toEqual(["s1"]);
      expect((await names(index, "flaky checkout test")).sort()).toEqual(["s1", "s2"]);
      expect(await names(index, "src/app.ts")).toEqual(["s3"]);
      expect((await names(index, "rollback OR deployer")).sort()).toEqual(["s4", "s5"]);
      expect(await names(index, "flaky (checkout) passed")).toEqual(["s2"]);
    });

    it("leaves out records holding a NOT word", async () => {
      const index = await open();
      await indexed(
        index,
        replace(1, ["deploy to staging"]),
        replace(2, ["deploy to production"]),
        replace(3, ["deploy and then a staging check"]),
      );
      expect(await names(index, "deploy -staging")).toEqual(["s2"]);
      expect(await names(index, "deploy NOT staging")).toEqual(["s2"]);
      expect(await names(index, 'deploy -"to staging"')).toEqual(
        expect.arrayContaining(["s2", "s3"]),
      );
    });

    it("finds a prefix anywhere in a record, and only real prefixes", async () => {
      const index = await open();
      await indexed(
        index,
        replace(1, ["we will deploy the service tomorrow"]),
        replace(2, ["delta pepper and nothing else"]),
        replace(3, ["Déploiement réussi"]),
        replace(4, ["the deployment pipeline runs the checks"]),
        replace(5, ["run the deployer"]),
      );
      expect((await names(index, "deplo*")).sort()).toEqual(["s1", "s3", "s4", "s5"]);
      expect((await names(index, "dep*")).sort()).toEqual(["s1", "s3", "s4", "s5"]);
      // Longer than the prefixes the index holds: the rest is checked.
      expect(await names(index, "deploymen*")).toEqual(["s4"]);
      expect((await names(index, "deplo* -deployer")).sort()).toEqual(["s1", "s3", "s4"]);
      expect((await names(index, "the -deploy*")).sort()).toEqual([]);
      expect((await names(index, '"the deploy"*')).sort()).toEqual(["s4", "s5"]);
      expect((await names(index, "pepper OR deplo*")).sort()).toEqual([
        "s1",
        "s2",
        "s3",
        "s4",
        "s5",
      ]);
      const marked = (await query(index, "deployme*")).hits[0]?.matches[0]?.marked;
      expect(marked).toContain(`${MATCH_START}deployment${MATCH_END}`);
    });

    it("folds case and accents", async () => {
      const index = await open();
      await indexed(index, replace(1, ["Le Café est OUVERT"]));
      expect(await names(index, "cafe ouvert")).toEqual(["s1"]);
      expect(await names(index, "CAFÉ")).toEqual(["s1"]);
    });

    it("sorts by relevance or recency, and pages, with up to `matches` records each", async () => {
      const index = await open();
      await indexed(
        index,
        replace(1, ["sortword"], { updated_at: "2026-11-14T09:00:00.000Z" }),
        replace(2, ["sortword sortword sortword", "sortword again", "sortword third"], {
          updated_at: "2026-11-10T09:00:00.000Z",
        }),
        replace(3, ["sortword and many other words to make this record longer"], {
          updated_at: "2026-11-12T09:00:00.000Z",
        }),
      );
      expect(await names(index, "sortword", { sort: "recent" })).toEqual(["s1", "s3", "s2"]);
      expect((await names(index, "sortword"))[0]).toBe("s2");
      const second = await query(index, "sortword", { sort: "recent", limit: 2, offset: 1 });
      expect(second.total).toBe(3);
      expect(second.hits.map((h) => h.session.session_id)).toEqual(["s3", "s2"]);
      expect((await query(index, "sortword", { matches: 2 })).hits[0]?.matches).toHaveLength(2);
      expect((await query(index, "sortword", { matches: 0 })).hits[0]?.matches).toEqual([]);
      expect((await query(index, "sortword", { offset: 5 })).hits).toEqual([]);
    });

    it("keeps a cursor per owner that only moves forward, and the keys seen in the window", async () => {
      const index = await open();
      const gen = await index.generation();
      const move = (cursor: string | undefined, seen: { key: string; at: number }[], forget = 0) =>
        index.commit({
          generation: gen,
          owner: "alice",
          updates: [],
          removals: [],
          feed: [],
          seen,
          cursor,
          forgetBefore: forget,
        });
      await move("c2", [
        { key: "k1", at: 100 },
        { key: "k2", at: 200 },
      ]);
      await move("c1", []);
      expect((await index.cursors(gen)).get("alice")).toBe("c2");
      expect([...(await index.seen(gen, "alice", ["k1", "k2", "k3"]))].sort()).toEqual([
        "k1",
        "k2",
      ]);
      expect((await index.seen(gen, "bob", ["k1"])).size).toBe(0);
      await move("c3", [{ key: "k3", at: 300 }], 150);
      expect((await index.cursors(gen, ["alice", "bob"])).get("alice")).toBe("c3");
      expect([...(await index.seen(gen, "alice", ["k1", "k2", "k3"]))].sort()).toEqual([
        "k2",
        "k3",
      ]);
    });

    it("keeps a copy of the feed, in order, served up to where every feed was read", async () => {
      const index = await open({ feed: true });
      const gen = await index.generation();
      const entry = (owner: string, n: number): ChangeEntry =>
        ({ kind: "published", owner, archive_id: H(n), session_id: `s${n}` }) as ChangeEntry;
      const name = (stamp: string, n: number) => `${stamp}-${H(n).slice(0, 8)}.json`;
      for (const [owner, rows] of [
        ["bob", [["20261114T090000.000Z", 1]]],
        [
          "alice",
          [
            ["20261114T090000.000Z", 2],
            ["20261114T100000.000Z", 3],
          ],
        ],
      ] as const) {
        const feed = rows.map(([stamp, n]) => ({ name: name(stamp, n), entry: entry(owner, n) }));
        for (let twice = 0; twice < 2; twice++) {
          await index.commit({
            generation: gen,
            owner,
            updates: [],
            removals: [],
            feed,
            seen: [],
            cursor: undefined,
            forgetBefore: 0,
          });
        }
      }
      expect(await index.feed(undefined, 10)).toBeNull();
      await index.readThrough(gen, "2026-11-14T09:30:00.000Z");
      await index.readThrough(gen, "2026-11-14T09:00:00.000Z");
      const first = await index.feed(undefined, 1);
      expect(first?.through).toBe("2026-11-14T09:30:00.000Z");
      expect(first?.entries.map((e) => `${e.owner}/${e.entry.session_id}`)).toEqual(["alice/s2"]);
      expect(first?.more).toBe(true);
      const rest = await index.feed(first?.entries[0], 10);
      expect(rest?.entries.map((e) => `${e.owner}/${e.entry.session_id}`)).toEqual(["bob/s1"]);
      expect(rest?.more).toBe(false);
      await index.readThrough(gen, "2026-11-14T11:00:00.000Z");
      expect((await index.feed(undefined, 10))?.entries).toHaveLength(3);
    });

    it("is ready after the first full pass, and writes nothing for a generation a reset replaced", async () => {
      const index = await open();
      expect((await index.state()).ready_at).toBeUndefined();
      const old = await index.generation();
      await indexed(index, replace(1, ["before reset"]));
      expect((await index.state()).ready_at).toBeDefined();
      const gen = await index.reset();
      expect(gen).not.toBe(old);
      expect(await index.generation()).toBe(gen);
      const stale = await index.commit({
        generation: old,
        owner: "alice",
        updates: [replace(2, ["from an old run"])],
        removals: [],
        feed: [],
        seen: [{ key: "k", at: 1 }],
        cursor: "c9",
        forgetBefore: 0,
      });
      expect(stale).toEqual({ stale: true, refused: [], removed: 0 });
      expect(await index.passDone(old, "2026-11-14T13:00:00.000Z")).toBe(false);
      expect((await index.cursors(old)).size).toBe(0);
      await indexed(index, replace(3, ["after reset"]));
      expect((await index.state()).generation).toBe(gen);
      expect(await names(index, "reset")).toEqual(["s3"]);
      expect(await names(index, "old")).toEqual([]);
      expect((await index.state()).ready_at).toBeDefined();
    });

    it("keeps its contents across opens, and another open sees a commit", async () => {
      const first = await open();
      await indexed(first, replace(1, ["persistent words"]));
      const second = await open();
      expect(await names(second, "persistent")).toEqual(["s1"]);
      await indexed(first, replace(2, ["persistent too"]));
      expect((await names(second, "persistent")).sort()).toEqual(["s1", "s2"]);
      expect(second.location()).toBe(where);
    });

    describe("behind SearchService", () => {
      let store: Store;
      const services: SearchService[] = [];
      beforeEach(() => {
        store = new FsStore(join(dir, "bucket"));
      });
      afterEach(async () => {
        for (const s of services.splice(0)) await s.close();
      });

      function service(feed = false): SearchService {
        const s = new SearchService({
          store,
          deployment: "d",
          settings: { events: EVENTS },
          open: backend.open(where),
          ...(feed ? { feed: true } : {}),
        });
        services.push(s);
        return s;
      }

      async function write(owner: string, id: string, text: string, visibility?: "owner") {
        const line = (r: Record<string, unknown>) => `${JSON.stringify(r)}\n`;
        await new StoreSeshi({ store, owner, formats }).ingest({
          format: "trajectory",
          session_id: id,
          transcript:
            line({ role: "meta", source: "trajectory" }) +
            line({
              role: "user",
              content: `${text} ${"context ".repeat(260)}`,
              timestamp: "2026-11-01T10:00:00Z",
            }) +
            line({ role: "assistant", content: "done", timestamp: "2026-11-01T10:00:00Z" }),
          ...(visibility ? { visibility } : {}),
        });
      }
      const ids = (r: { results: { owner: string; session_id: string }[] }) =>
        r.results.map((x) => `${x.owner}/${x.session_id}`).sort();

      it("indexes the feeds, follows retractions and visibility, and rebuilds", async () => {
        await write("alice", "pub", "roadmap draft");
        await write("alice", "priv", "roadmap secret", "owner");
        await write("bob", "b1", "roadmap notes");
        const search = service();
        expect(await search.ready()).toBe(false);
        await search.catchUp();
        expect(ids(await search.search(member("bob"), { q: "roadmap" }))).toEqual([
          "alice/pub",
          "bob/b1",
        ]);
        await tombstone({ store, owner: "alice", format: "trajectory", session_id: "pub" });
        await setVisibility({
          store,
          owner: "alice",
          format: "trajectory",
          session_id: "priv",
          visibility: "org",
        });
        await search.catchUp();
        const after = await search.search(member("bob"), { q: "roadmap" });
        expect(ids(after)).toEqual(["alice/priv", "bob/b1"]);
        expect(after.total).toBe(2);
        expect(await search.status()).toMatchObject({ ready: true, sessions: 2, location: where });
        const rebuilt = await search.rebuild();
        expect(rebuilt).toMatchObject({ caught_up: true });
        expect(ids(await search.search(LOCAL_VIEWER, { q: "roadmap" }))).toEqual([
          "alice/priv",
          "bob/b1",
        ]);
      });

      it("serves every owner's feed from its copy", async () => {
        await write("alice", "a1", "one");
        await write("bob", "b1", "two");
        const search = service(true);
        await search.catchUp();
        const page = await search.changes({ limit: 10 });
        expect(page.entries.map((e) => e.entry.session_id).sort()).toEqual(["a1", "b1"]);
      });
    });
  });
});
