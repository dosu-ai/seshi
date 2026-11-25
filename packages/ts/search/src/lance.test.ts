/** What only the LanceDB index does: the query compiler and its escaping, prefixes, generations
 * built beside the live one, the scrub, the caps, read-only readers, and crash repair. The
 * behaviour it shares with SQLite is in conformance.test.ts. */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, Index, MatchQuery, makeArrowTable, Operator } from "@lancedb/lancedb";
import { BUILTIN_FORMATS, FormatRegistry } from "@seshi/formats";
import type { EventRole, Trace } from "@seshi/model";
import { StoreSeshi, tombstone } from "@seshi/pipeline";
import {
  appendChange,
  archiveId,
  FsStore,
  getBytes,
  gunzipJson,
  gzipJsonDeterministic,
  keys,
  readMetadata,
  type Store,
} from "@seshi/store";
import { Field, Schema, Utf8 } from "apache-arrow";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BackendQuery,
  type IndexedSession,
  type IndexOptions,
  type IndexStore,
  IndexUnavailable,
  type SessionUpdate,
} from "./backend";
import { COMMIT_STEPS, type CommitStep, type LanceIndexOptions, openLanceIndex } from "./lance";
import { lanceIndex } from "./lance-open";
import {
  compileMatch,
  filterSql,
  likeLiteral,
  matchesTree,
  needsCheck,
  PREFIX_MAX,
  prefixesOf,
  sqlString,
} from "./lance-query";
import { parseQuery, SearchQueryError } from "./query";
import { SearchService } from "./service";
import { LOCAL_VIEWER } from "./viewer";

const H = (n: number) => n.toString(16).padStart(64, "0");
const EVENTS: readonly EventRole[] = ["user", "assistant", "tool_call"];
const tree = (q: string) => parseQuery(q).match;

describe("the LanceDB query compiler", () => {
  it("quotes every filter value, and refuses control characters", () => {
    expect(sqlString("it's")).toBe("'it''s'");
    expect(sqlString("a\\")).toBe("'a\\'");
    expect(sqlString("' OR '1'='1")).toBe("''' OR ''1''=''1'");
    expect(likeLiteral("50%_a\\b")).toBe("50\\%\\_a\\\\b");
    for (const bad of ["a\nb", "a\u0000", "\u007f", "tab\there"]) {
      expect(() => sqlString(bad)).toThrow(SearchQueryError);
    }
    const where = filterSql({
      viewer: { everything: false, own: ["o'brien"], canRead: () => true },
      repo: "x%'",
      labels: { k: "v'" },
      since: 5,
    });
    expect(where).toBe(
      "(visibility = 'org' OR owner IN ('o''brien')) AND (lower(repo) = lower('x%''') OR lower(repo) LIKE lower('%/x\\%''') ESCAPE '\\') AND array_has_all(labels, ['k=v''']) AND coalesce(ts, session_updated) >= to_timestamp_millis(5)",
    );
    expect(() => filterSql({ viewer: LOCAL_VIEWER, since: 1.5 })).toThrow(SearchQueryError);
    expect(filterSql({ viewer: LOCAL_VIEWER, owners: [] })).toBeNull();
    expect(
      filterSql({ viewer: { ...LOCAL_VIEWER, everything: false, own: [], ownOnly: true } }),
    ).toBeNull();
  });

  it("puts plain words in one AND match, and uses a boolean query only for more", () => {
    expect(compileMatch(tree("error test"))).toEqual({
      match: "error test",
      column: "text",
      and: true,
    });
    expect(compileMatch(tree('"flaky checkout"'))).toEqual({
      phrase: "flaky checkout",
      column: "text",
    });
    expect(compileMatch(tree("deploy rollback OR revert -staging src/app.ts"))).toEqual({
      bool: [
        ["must", { match: "deploy", column: "text", and: true }],
        [
          "must",
          {
            bool: [
              ["should", { match: "rollback", column: "text" }],
              ["should", { match: "revert", column: "text" }],
            ],
          },
        ],
        ["must", { phrase: "src app ts", column: "text" }],
        ["must_not", { match: "staging", column: "text" }],
      ],
    });
  });

  it("finds a prefix's candidates by its first letters, and leaves a negated one to the check", () => {
    expect(compileMatch(tree("Déplo*"))).toEqual({ match: "deplo", column: "text_prefix" });
    expect(compileMatch(tree("deploymentpipeline*"))).toEqual({
      match: "deploymentpipeline".slice(0, PREFIX_MAX),
      column: "text_prefix",
    });
    expect(compileMatch(tree('"run the dep"*'))).toEqual({
      bool: [
        ["must", { phrase: "run the", column: "text" }],
        ["must", { match: "dep", column: "text_prefix" }],
      ],
    });
    expect(compileMatch(tree("the -dep*"))).toEqual({ match: "the", column: "text", and: true });
    expect(needsCheck(tree("the -dep*"))).toBe(true);
    expect(needsCheck(tree("the -dep"))).toBe(false);
    expect(() => compileMatch(tree("d*"))).toThrow(SearchQueryError);
  });

  it("checks a record against the whole tree, word by word after folding", () => {
    expect(matchesTree("we will Déploy it", tree("deplo*"))).toBe(true);
    expect(matchesTree("delta pepper", tree("dep*"))).toBe(false);
    expect(matchesTree("the deployer", tree('"the deploy"*'))).toBe(true);
    expect(matchesTree("deploy the", tree('"the deploy"*'))).toBe(false);
    expect(matchesTree("deploy staging", tree("deplo* -stag*"))).toBe(false);
    expect(matchesTree("pepper", tree("pepper OR deplo*"))).toBe(true);
  });

  it("writes out each word's prefixes, folded", () => {
    expect(prefixesOf("Déploy it, déploy x")).toBe("de dep depl deplo deploy it");
    expect(prefixesOf("abcdefghijkl").split(" ").at(-1)).toBe("abcdefghijkl".slice(0, PREFIX_MAX));
  });

  it("does not rely on the ngram tokenizer, which on 0.41.0 indexes only a value's first word", async () => {
    // If this starts failing, LanceDB indexes every word's prefixes itself, and text_prefix
    // could go back to the ngram index the design first chose.
    const dir = mkdtempSync(join(tmpdir(), "seshi-lance-ngram-"));
    try {
      const db = await connect(dir);
      const schema = new Schema([
        new Field("id", new Utf8(), false),
        new Field("p", new Utf8(), false),
      ]);
      const table = await db.createEmptyTable("t", schema);
      await table.add(makeArrowTable([{ id: "1", p: "hello deploy" }], { schema }));
      await table.createIndex("p", {
        config: Index.fts({
          baseTokenizer: "ngram",
          ngramMinLength: 2,
          ngramMaxLength: 12,
          prefixOnly: true,
        }),
      });
      const find = async (q: string) =>
        (
          await table
            .query()
            .fullTextSearch(new MatchQuery(q, "p", { operator: Operator.And }))
            .toArray()
        ).length;
      expect(await find("hel")).toBe(1);
      expect(await find("dep")).toBe(0);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function session(n: number, fields: Partial<IndexedSession> = {}): IndexedSession {
  return {
    owner: "alice",
    archive_id: H(n),
    format: "claude-code",
    session_id: `s${n}`,
    visibility: "org",
    updated_at: "2026-11-14T09:00:00.000Z",
    traces: [H(100 + n)],
    ...fields,
  };
}

function replace(n: number, texts: string[], fields: Partial<IndexedSession> = {}): SessionUpdate {
  const s = session(n, fields);
  return {
    session: s,
    events: texts.map((text, i) => ({
      content_hash: s.traces[0] as string,
      event_index: i,
      role: "user",
      text,
    })),
    replace: true,
    read_at: 1,
  };
}

/** Every file under `dir` that holds `needle`. */
function filesHolding(dir: string, needle: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (readFileSync(path).includes(needle)) out.push(path);
    }
  };
  walk(dir);
  return out;
}

describe("LanceIndex", () => {
  let dir: string;
  let uri: string;
  let clock: number;
  const opened: IndexStore[] = [];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seshi-lance-"));
    uri = join(dir, "index");
    clock = Date.parse("2026-11-14T12:00:00.000Z");
  });
  afterEach(async () => {
    for (const index of opened.splice(0)) await index.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function open(
    options: Partial<LanceIndexOptions> = {},
    index: Partial<IndexOptions> = {},
  ): Promise<IndexStore & { scrub(signal: AbortSignal): Promise<void> }> {
    const opening = await openLanceIndex(
      { uri, readConsistency: 0, now: () => clock, ...options },
      { deployment: "d1", events: EVENTS, ...index },
    );
    opened.push(opening);
    return opening;
  }

  async function commit(
    index: IndexStore,
    updates: SessionUpdate[],
    removals = [] as {
      archive: string;
      read_at: number;
      scrub: boolean;
    }[],
  ) {
    return index.commit({
      generation: await index.generation(),
      owner: "alice",
      updates,
      removals,
      feed: [],
      seen: [],
      cursor: undefined,
      forgetBefore: 0,
    });
  }

  async function pass(index: IndexStore) {
    return index.passDone(await index.generation(), new Date(clock).toISOString());
  }

  const names = async (index: IndexStore, q: string, extra: Partial<BackendQuery> = {}) =>
    (
      await index.query({
        match: tree(q),
        viewer: LOCAL_VIEWER,
        sort: "relevance",
        limit: 20,
        offset: 0,
        matches: 1,
        ...extra,
      })
    ).hits.map((h) => h.session.session_id);

  it("builds a new generation beside the live one, which answers until it has caught up", async () => {
    const index = await open();
    await commit(index, [replace(1, ["old words"])]);
    await pass(index);
    const live = (await index.state()).generation;
    const gen = await index.reset();
    expect(await index.state()).toMatchObject({
      generation: live,
      ready_at: "2026-11-14T12:00:00.000Z",
      building: { generation: gen },
    });
    await commit(index, [replace(2, ["new words"])]);
    await index.readThrough(gen, "2026-11-14T11:00:00.000Z");
    // Still the old generation's answers.
    expect(await names(index, "words")).toEqual(["s1"]);
    expect((await index.state()).building?.read_through).toBe("2026-11-14T11:00:00.000Z");
    expect(await pass(index)).toBe(true);
    expect(await index.state()).toMatchObject({ generation: gen, sessions: 1, events: 1 });
    expect((await index.state()).building).toBeUndefined();
    expect(await names(index, "words")).toEqual(["s2"]);
    // The old generation stays for readers still on it, then goes.
    expect(existsSync(join(uri, live))).toBe(true);
    await index.maintain(new AbortController().signal);
    expect(filesHolding(uri, "old words")).not.toEqual([]);
    clock += 16 * 60_000;
    await index.maintain(new AbortController().signal);
    expect(filesHolding(uri, "old words")).toEqual([]);
  });

  it("rebuilds beside the live generation for a new role, and stops answering for a dropped one", async () => {
    const reopen = async (events: readonly EventRole[]) => {
      for (const index of opened.splice(0)) await index.close();
      return open({}, { events });
    };
    const first = await open();
    await commit(first, [replace(1, ["kept words"])]);
    await pass(first);
    const live = (await first.state()).generation;
    // More roles: the live generation holds nothing it should not, and keeps answering.
    const wider = await reopen([...EVENTS, "reasoning"]);
    expect(await wider.state()).toMatchObject({ generation: live, building: {} });
    expect(await names(wider, "kept")).toEqual(["s1"]);
    // Fewer: it holds records no longer indexed, so searches wait for the new one, as for a
    // first build, and the old one is dropped after the grace.
    const narrower = await reopen(["user"]);
    const state = await narrower.state();
    expect(state.generation).not.toBe(live);
    expect(state.ready_at).toBeUndefined();
    expect(state.building).toBeUndefined();
    expect(await names(narrower, "kept")).toEqual([]);
    clock += 16 * 60_000;
    await narrower.maintain(new AbortController().signal);
    expect(filesHolding(uri, "kept words")).toEqual([]);
    await expect(open({}, { deployment: "d2", events: ["user"] })).rejects.toThrow(
      /belongs to deployment d1/,
    );
  });

  it("starts answering from another scope only once it has caught up", async () => {
    const first = await open({}, { scope: "alice" });
    await commit(first, [replace(1, ["scoped words"])]);
    await pass(first);
    await first.close();
    opened.length = 0;
    const other = await open({}, { scope: "bob" });
    expect((await other.state()).ready_at).toBeUndefined();
    expect(await names(other, "scoped")).toEqual([]);
  });

  it("lets a read-only instance read, and never write", async () => {
    const reader = await open({ readOnly: true });
    expect(await reader.state()).toMatchObject({ sessions: 0, generation: "" });
    expect(existsSync(join(uri, "meta.lance"))).toBe(false);
    const writer = await open();
    await commit(writer, [replace(1, ["shared words"])]);
    await pass(writer);
    expect(await names(reader, "shared")).toEqual(["s1"]);
    expect((await reader.state()).ready_at).toBeDefined();
    await reader.maintain(new AbortController().signal);
  });

  it("caps the records it scores, says so, and looks back from now for a recent page", async () => {
    const index = await open({ maxScoredRows: 3, maxRecentRows: 3 });
    const day = 86_400_000;
    await commit(index, [
      replace(1, ["capword one"], { updated_at: new Date(clock - 40 * day).toISOString() }),
      replace(2, ["capword two"], { updated_at: new Date(clock - 20 * day).toISOString() }),
      replace(3, ["capword three"], { updated_at: new Date(clock - 3 * day).toISOString() }),
      replace(4, ["capword four"], { updated_at: new Date(clock - 2 * 3600_000).toISOString() }),
      replace(5, ["capword five"], { updated_at: new Date(clock - 3600_000).toISOString() }),
    ]);
    await pass(index);
    const capped = await index.query({
      match: tree("capword"),
      viewer: LOCAL_VIEWER,
      sort: "relevance",
      limit: 20,
      offset: 0,
      matches: 0,
    });
    expect(capped).toMatchObject({ total: 3, capped: true });
    const recent = await index.query({
      match: tree("capword"),
      viewer: LOCAL_VIEWER,
      sort: "recent",
      limit: 2,
      offset: 0,
      matches: 0,
    });
    expect(recent.hits.map((h) => h.session.session_id)).toEqual(["s5", "s4"]);
    // The window's count stands in for a capped search: still a lower bound.
    expect(recent).toMatchObject({ total: 2, capped: true });
  });

  it("fills a recent page from before the largest window that did not reach the cap", async () => {
    const index = await open({ maxRecentRows: 3 });
    const day = 86_400_000;
    const ago = (ms: number) => new Date(clock - ms).toISOString();
    await commit(index, [
      replace(1, ["fillword"], { updated_at: ago(3600_000) }),
      replace(2, ["fillword"], { updated_at: ago(3 * day) }),
      // Older, and better scored: the capped search alone would hold only these.
      replace(3, ["fillword fillword fillword"], { updated_at: ago(45 * day) }),
      replace(4, ["fillword fillword fillword"], { updated_at: ago(50 * day) }),
      replace(5, ["fillword fillword fillword"], { updated_at: ago(60 * day) }),
      replace(6, ["fillword fillword fillword"], { updated_at: ago(70 * day) }),
    ]);
    await pass(index);
    const page = await index.query({
      match: tree("fillword"),
      viewer: LOCAL_VIEWER,
      sort: "recent",
      limit: 4,
      offset: 0,
      matches: 0,
    });
    const found = page.hits.map((h) => h.session.session_id);
    expect(found.slice(0, 2)).toEqual(["s1", "s2"]);
    expect(found).toHaveLength(4);
    expect(page.capped).toBe(true);
  });

  it("keeps a build's scalar indexes current before its text is indexed", async () => {
    const index = await open({ buildOptimizeRows: 2 });
    await commit(index, [replace(1, ["one"]), replace(2, ["two"]), replace(3, ["three"])]);
    const events = await (await connect(join(uri, await index.generation()))).openTable("events");
    expect((await events.indexStats("id_idx"))?.numUnindexedRows).toBe(0);
    expect(await events.indexStats("text_idx")).toBeUndefined();
    events.close();
  });

  it("scrubs removed text out of its files, and keeps answering", async () => {
    const index = await open({ scrubEvery: 0, grace: 0 });
    await commit(index, [replace(1, ["zebrasecret leaked"]), replace(2, ["zebra keeper"])]);
    await pass(index);
    await commit(index, [], [{ archive: H(1), read_at: 5, scrub: true }]);
    await pass(index);
    expect(await names(index, "zebrasecret")).toEqual([]);
    // Deleted, but still in the files.
    expect(filesHolding(uri, "zebrasecret")).not.toEqual([]);
    await index.maintain(new AbortController().signal);
    expect(await names(index, "zebra")).toEqual(["s2"]);
    expect(await names(index, "kee*")).toEqual(["s2"]);
    // The copy is indexed as a whole, not row by row at the next optimize().
    const db = await connect(join(uri, await index.generation()));
    const copy = (await db.tableNames([])).find((n) => n.startsWith("events_")) as string;
    const events = await db.openTable(copy);
    for (const name of ["id_idx", "archive_id_idx", "text_idx", "text_prefix_idx"]) {
      expect({ name, unindexed: (await events.indexStats(name))?.numUnindexedRows }).toEqual({
        name,
        unindexed: 0,
      });
    }
    events.close();
    // The old tables go once the grace has passed.
    clock += 1;
    await index.maintain(new AbortController().signal);
    expect(filesHolding(uri, "zebrasecret")).toEqual([]);
    expect(await names(index, "zebra")).toEqual(["s2"]);
  });

  it("optimizes after a commit, at most every so often", async () => {
    const index = await open({ optimizeEvery: 60_000 });
    await commit(index, [replace(1, ["first"])]);
    await pass(index);
    await commit(index, [replace(2, ["second unindexed"])]);
    const gen = await index.generation();
    const events = await (await connect(join(uri, gen))).openTable("events");
    const unindexed = async () => (await events.indexStats("text_idx"))?.numUnindexedRows;
    expect(await unindexed()).toBe(1);
    await index.maintain(new AbortController().signal);
    await events.checkoutLatest();
    expect(await unindexed()).toBe(0);
    const version = await events.version();
    clock += 120_000;
    await index.maintain(new AbortController().signal);
    await events.checkoutLatest();
    expect(await events.version()).toBe(version);
    expect(await names(index, "second")).toEqual(["s2"]);
    events.close();
  });

  it("answers IndexUnavailable when its storage cannot be read", async () => {
    const index = await open();
    await commit(index, [replace(1, ["vanishing"])]);
    await pass(index);
    rmSync(uri, { recursive: true, force: true });
    const reader = await open({ readOnly: true });
    await expect(names(index, "vanishing")).rejects.toBeInstanceOf(IndexUnavailable);
    expect((await reader.state()).ready_at).toBeUndefined();
  });

  describe("behind the indexer", () => {
    const formats = new FormatRegistry(BUILTIN_FORMATS);
    const line = (r: Record<string, unknown>) => `${JSON.stringify(r)}\n`;
    const PAD = ` ${"context ".repeat(260)}`;
    let store: Store;
    const services: SearchService[] = [];
    beforeEach(() => {
      store = new FsStore(join(dir, "bucket"));
    });
    afterEach(async () => {
      for (const s of services.splice(0)) await s.close();
    });

    const writer = (owner = "alice") => new StoreSeshi({ store, owner, formats });
    const log = (text: string) =>
      line({ role: "meta", source: "trajectory" }) +
      line({ role: "user", content: `${text}${PAD}`, timestamp: "2026-11-01T10:00:00Z" }) +
      line({ role: "assistant", content: "done", timestamp: "2026-11-01T10:00:00Z" });

    it("scrubs the text a redaction backfill replaced out of its files", async () => {
      await writer().ingest({
        format: "trajectory",
        session_id: "s1",
        transcript: log("hunter2secret leaked"),
      });
      const location = join(dir, "redact");
      const s = new SearchService({
        store,
        deployment: "d",
        settings: { events: EVENTS },
        open: lanceIndex({ uri: location, readConsistency: 0, scrubEvery: 0, grace: 0 }),
      });
      services.push(s);
      await s.catchUp();
      expect(filesHolding(location, "hunter2secret")).not.toEqual([]);
      // The backfill rewrites the trace in place, under the same hash (F2.5): the index deletes
      // nothing, it updates the same rows, and only the entry's reason says the old text must go.
      const archive = archiveId("alice", "trajectory", "s1");
      const hash = (await readMetadata(store, "alice", archive))?.head as string;
      const key = keys.trace("alice", archive, hash);
      const trace = gunzipJson<Trace>((await getBytes(store, key)) as Uint8Array);
      trace.events = trace.events.map((e) =>
        e.role === "user" ? { ...e, text: "[redacted] leaked" } : e,
      );
      await store.put(key, gzipJsonDeterministic(trace));
      await appendChange(store, {
        kind: "published",
        at: new Date().toISOString(),
        owner: "alice",
        archive_id: archive,
        session_id: "s1",
        format: "trajectory",
        content_hash: hash,
        writer: { kind: "admin", principal: "admin", source_id: "redaction" },
        owner_basis: "verified",
        replace: true,
        reason: "redacted",
      });
      await s.catchUp();
      expect((await s.search(LOCAL_VIEWER, { q: "hunter2secret" })).total).toBe(0);
      expect((await s.search(LOCAL_VIEWER, { q: "leaked" })).total).toBe(1);
      // The pass after the scrub drops the tables it replaced.
      await s.catchUp();
      expect(filesHolding(location, "hunter2secret")).toEqual([]);
      expect((await s.search(LOCAL_VIEWER, { q: "leaked" })).total).toBe(1);
    });

    /** A service whose index fails once before `crashAt`, after `arm()`. */
    function service(location: string, crashAt?: CommitStep) {
      let armed = false;
      const s = new SearchService({
        store,
        deployment: "d",
        settings: { events: EVENTS },
        feed: true,
        open: lanceIndex({
          uri: location,
          readConsistency: 0,
          beforeStep: (step) => {
            if (armed && step === crashAt) {
              armed = false;
              throw new Error(`crash before ${step}`);
            }
          },
        }),
      });
      services.push(s);
      return { s, arm: () => (armed = crashAt !== undefined) };
    }

    /** What a search, the status and the feed copy show. */
    async function snapshot(s: SearchService) {
      const found: Record<string, string[]> = {};
      for (const q of ["alpha", "beta", "gamma", "delta", "context", "epsil*"]) {
        found[q] = (await s.search(LOCAL_VIEWER, { q, matches: 3 })).results
          .map((r) => `${r.owner}/${r.session_id}:${r.hits}:${r.matches.length}`)
          .sort();
      }
      const { sessions, events } = await s.status();
      const feed = (await s.changes({ limit: 1000 })).entries.map(
        // Keys hold the time they were written: compare what they say.
        (e) => `${e.entry.owner}/${e.entry.session_id}:${e.entry.kind}`,
      );
      return { found, sessions, events, feed };
    }

    async function scenario({ s, arm }: ReturnType<typeof service>, crash: boolean) {
      const first = await writer().ingest({
        format: "trajectory",
        session_id: "c1",
        transcript: log("alpha start"),
      });
      await writer().ingest({
        format: "trajectory",
        session_id: "r1",
        transcript: log("beta before"),
      });
      await writer().ingest({
        format: "trajectory",
        session_id: "t1",
        transcript: log("gamma doomed"),
      });
      await writer("bob").ingest({
        format: "trajectory",
        session_id: "b1",
        transcript: log("delta bob"),
      });
      await s.catchUp();
      // A continuation, a replace, a tombstone and a new session, in one page.
      await writer().ingest({
        format: "trajectory",
        session_id: "c1",
        transcript: line({
          role: "user",
          content: "epsilon continued",
          timestamp: "2026-11-01T10:00:01Z",
        }),
        offset: first.bytes_total,
      });
      await writer().ingest({
        format: "trajectory",
        session_id: "r1",
        transcript: log("beta rewritten epsilonic"),
        replace: true,
      });
      await tombstone({ store, owner: "alice", format: "trajectory", session_id: "t1" });
      await writer().ingest({
        format: "trajectory",
        session_id: "n1",
        transcript: log("alpha new"),
      });
      if (crash) {
        arm();
        await expect(s.catchUp()).rejects.toThrow(/crash before/);
      }
      await s.catchUp();
      return snapshot(s);
    }

    it("is repaired by reading the page again, whichever step it stopped before", async () => {
      const clean = await scenario(service(join(dir, "clean")), false);
      expect(clean.found.gamma).toEqual([]);
      expect(clean.found.alpha).toHaveLength(2);
      expect(clean.found["epsil*"].length).toBeGreaterThan(0);
      for (const step of COMMIT_STEPS) {
        for (const s of services.splice(0)) await s.close();
        rmSync(join(dir, "bucket"), { recursive: true, force: true });
        const crashed = await scenario(service(join(dir, `crash-${step}`), step), true);
        expect({ step, ...crashed }).toEqual({ step, ...clean });
      }
    });
  });
});
