/** What `@seshi/sql`'s tests share (not product code): DuckDB's `lance` extension, and the `sql`
 * fixture built as a LanceDB index by `@seshi/lance` itself, with decoys beside it. */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { connect } from "@lancedb/lancedb";
import { lanceIndex } from "@seshi/lance";
import type { IndexStore, SqlTables } from "@seshi/search";
import {
  callsOf,
  DECOY_MARKER,
  eventsOf,
  FIXTURE_NOW,
  FIXTURE_SESSIONS,
  type FixtureSession,
  fixtureSession,
} from "@seshi/search/sql-testing";
import { DUCKDB_EXTENSIONS_ENV } from "./env";

/** Where the tests' DuckDB extensions are: `SESHI_DUCKDB_EXTENSIONS`, else a cache folder in the
 * workspace's `node_modules`, where `lanceExtensions()` installs `lance` (from
 * extensions.duckdb.org, once) when it is not there yet. */
const CACHE = resolve(import.meta.dirname, "../../../../../node_modules/.cache/seshi-duckdb");

/** The folder holding DuckDB's `lance` extension, installed into the cache on first use. */
export async function lanceExtensions(): Promise<string> {
  const dir = process.env[DUCKDB_EXTENSIONS_ENV] || CACHE;
  const instance = await DuckDBInstance.create(":memory:", { extension_directory: dir });
  try {
    const connection = await instance.connect();
    const installed = await connection.runAndReadAll(
      "SELECT installed FROM duckdb_extensions() WHERE extension_name = 'lance'",
    );
    if (installed.getRows()[0]?.[0] !== true) await connection.run("INSTALL lance");
    connection.closeSync();
  } finally {
    instance.closeSync();
  }
  return dir;
}

/** A session as the fixture writes it, its visibility changed. */
function update(s: FixtureSession, n: number, readAt: number) {
  const session = fixtureSession(s, n);
  return {
    session,
    events: eventsOf(s, n),
    llm_calls: callsOf(s, n),
    replace: true,
    read_at: readAt,
  };
}

export interface LanceFixture {
  /** The index's location: a folder, or a bucket URI. */
  uri: string;
  index: IndexStore;
  tables(): Promise<SqlTables>;
  /** Commit `archive` again, as the indexer would after its visibility changed. */
  setVisibility(archive: string, visibility: "org" | "owner"): Promise<void>;
}

/** Build the `sql` fixture as a LanceDB index at `dir/index` (or at `bucket`, a bucket URI
 * reached with its storage options), by `@seshi/lance`'s own commits (one page per owner, then
 * the removal), with the decoys in `dir`: a CSV, a fake credentials file, a SQLite file, and a
 * real Lance table, each holding the marker no answer may contain. */
export async function buildLanceFixture(
  dir: string,
  bucket?: { uri: string; storageOptions: Record<string, string> },
): Promise<LanceFixture> {
  mkdirSync(dir, { recursive: true });
  const uri = bucket?.uri ?? join(dir, "index");
  const index = await lanceIndex({
    uri,
    readConsistency: 0,
    ...(bucket ? { storageOptions: bucket.storageOptions } : {}),
  })({
    deployment: "fixture",
    events: ["user", "assistant", "tool_call", "tool_result"],
  });
  const commit = async (owner: string, updates: ReturnType<typeof update>[], removals = []) =>
    index.commit({
      generation: await index.generation(),
      owner,
      updates,
      removals,
      feed: [],
      seen: [],
      cursor: undefined,
      forgetBefore: 0,
    });
  for (const owner of ["alice", "bob"]) {
    const mine = FIXTURE_SESSIONS.map((s, i) => ({ s, n: i + 1 })).filter(
      ({ s }) => s.owner === owner,
    );
    await commit(
      owner,
      mine.map(({ s, n }) => update(s, n, 1)),
    );
    const removed = mine.filter(({ s }) => s.removed);
    if (removed.length > 0) {
      await index.commit({
        generation: await index.generation(),
        owner,
        updates: [],
        removals: removed.map(({ s }) => ({ archive: s.archive, read_at: 2, scrub: false })),
        feed: [],
        seen: [],
        cursor: undefined,
        forgetBefore: 0,
      });
    }
  }
  await index.passDone(await index.generation(), new Date(FIXTURE_NOW).toISOString());

  writeFileSync(join(dir, "decoy.csv"), `a,b\n${DECOY_MARKER},1\n`);
  writeFileSync(join(dir, "credentials.json"), JSON.stringify({ secret: DECOY_MARKER }));
  const decoy = new Database(join(dir, "decoy.sqlite"), { create: true });
  decoy.run("CREATE TABLE secrets (value TEXT)");
  decoy.run(`INSERT INTO secrets VALUES ('${DECOY_MARKER}')`);
  decoy.close();
  if (!existsSync(join(dir, "decoy.lance"))) {
    const db = await connect(dir);
    await db.createTable("decoy", [{ value: DECOY_MARKER }]);
  }

  let readAt = 10;
  return {
    uri,
    index,
    tables: async () => {
      const tables = await index.sqlTables?.();
      if (tables === undefined) throw new Error("the fixture index has no live generation");
      return tables;
    },
    setVisibility: async (archive, visibility) => {
      const i = FIXTURE_SESSIONS.findIndex((s) => s.archive === archive);
      const s = FIXTURE_SESSIONS[i] as FixtureSession;
      await commit(s.owner, [update({ ...s, visibility }, i + 1, ++readAt)]);
    },
  };
}
