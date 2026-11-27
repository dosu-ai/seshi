/** The hostile-statement suite (docs/seshi/session-tools.md, "The hostile-statement suite"):
 * the corpus in `sql-hostile.jsonl`, each case tagged with the engines it applies to, run by
 * real workers against the fixture index, with decoy files beside it. Every case asserts its
 * outcome and that no decoy's marker (and, for a member, no other member's private text) appears
 * anywhere in the answer. Two checks run over the whole corpus as well: every statement the
 * check accepts also prepares, and every `owner`/`archive_id` pair an answer returns is one the
 * caller may see. DuckDB's cases run with the LanceDB engine. */

import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkSqlite, MAX_SQL_BYTES, SqlRefused } from "./check-sqlite";
import { buildFixture, FIXTURE_NOW } from "./fixture";
import {
  HOSTILE_ADMIN as ADMIN,
  HOSTILE_CORPUS as CORPUS,
  expectOutcome,
  HOSTILE_FAMILIES,
  hostileCases,
  runCase,
} from "./hostile";
import { SqlService } from "./service";
import { sqlViews } from "./views";

const CASES = hostileCases("sqlite");

const TIMEOUT_MS = 2_000;

let dir: string;
let path: string;
let service: SqlService;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "seshi-sql-hostile-"));
  path = await buildFixture(dir);
  service = new SqlService({
    search: {
      status: async () => ({
        backend: "sqlite",
        location: path,
        ready: true,
        sessions: 0,
        events: 0,
        caught_up_at: new Date(FIXTURE_NOW).toISOString(),
      }),
    },
    now: () => new Date(FIXTURE_NOW),
    settings: {
      workers: 2,
      timeout: TIMEOUT_MS,
      // Bun's SQLite holds this on Linux; on macOS the watchdog's limit stops the same query.
      memory: 64 * 1024 ** 2,
      workerMemory: 256 * 1024 ** 2,
    },
  });
});

afterAll(async () => {
  await service?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the hostile-statement suite on SQLite", () => {
  it("has cases for every family the design lists, each with a known outcome", () => {
    const families = new Set(CASES.map((c) => c.family));
    for (const family of [...HOSTILE_FAMILIES, "lexing"])
      expect(families, family).toContain(family);
    expect(new Set(CORPUS.map((c) => c.id)).size).toBe(CORPUS.length);
  });

  for (const c of CASES) {
    it(`${c.id} (${c.expect}${c.as === "member" ? ", as a member" : ""}): ${JSON.stringify(c.sql).slice(0, 70)}`, async () => {
      expectOutcome(c, await runCase(service, c));
    }, 30_000);
  }

  it("answers after a statement it killed for time", async () => {
    const result = await service.query(ADMIN, { sql: "SELECT count(*) FROM sessions" });
    expect(result.rows).toEqual([[5]]);
  });

  it("refuses a statement past 16 KiB and one nested past the parser's limit", async () => {
    const pad = (n: number) => `SELECT 1 AS x${" ".repeat(n - "SELECT 1 AS x".length)}`;
    expect(() => checkSqlite(pad(MAX_SQL_BYTES))).not.toThrow();
    expect(() => checkSqlite(pad(MAX_SQL_BYTES + 1))).toThrow(/longer than 16384 bytes/);
    const deep = (n: number) => `SELECT ${"(".repeat(n)}1${")".repeat(n)}`;
    expect(() => checkSqlite(deep(10))).not.toThrow();
    expect(() => checkSqlite(deep(10_000))).toThrow(SqlRefused);
    expect(() => checkSqlite(deep(5_000))).toThrow(/nested too deeply/);
    // A multi-byte statement counts its UTF-8 bytes.
    expect(() => checkSqlite(`SELECT '${"é".repeat(MAX_SQL_BYTES / 2)}'`)).toThrow(/longer/);
  });

  it("prepares every statement the check accepts (unless SQLite's binder refuses it)", () => {
    const db = new Database(path, { readonly: true });
    try {
      for (const view of sqlViews("sqlite", ADMIN.viewer, { since: 0, until: FIXTURE_NOW })) {
        db.run(view);
      }
      db.run("PRAGMA query_only = 1");
      for (const c of CASES) {
        let body: string;
        try {
          body = checkSqlite(c.sql).body;
        } catch (err) {
          expect(err, c.id).toBeInstanceOf(SqlRefused);
          expect(c.expect, `${c.id} was refused by the check`).toBe("refused");
          continue;
        }
        expect(c.expect, `${c.id} was accepted`).not.toBe("refused");
        let prepared = true;
        try {
          db.prepare(body).finalize();
        } catch {
          prepared = false;
        }
        expect(prepared || c.expect === "error", `${c.id} does not prepare`).toBe(true);
        if (c.expect === "error") expect(prepared, `${c.id} prepares`).toBe(false);
      }
    } finally {
      db.close();
    }
  });
});
