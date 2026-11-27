/** The hostile-statement suite (docs/seshi/session-tools.md, "The hostile-statement suite"):
 * the corpus in `sql-hostile.jsonl`, each case tagged with the engines it applies to, run by
 * real workers against the fixture index, with decoy files beside it. Every case asserts its
 * outcome and that no decoy's marker (and, for a member, no other member's private text) appears
 * anywhere in the answer. Two checks run over the whole corpus as well: every statement the
 * check accepts also prepares, and every `owner`/`archive_id` pair an answer returns is one the
 * caller may see. DuckDB's cases run with the LanceDB engine. */

import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SqlResult } from "@seshi/model";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkSqlite, MAX_SQL_BYTES, SqlRefused } from "./check-sqlite";
import { buildFixture, DECOY_MARKER, FIXTURE_NOW, SECRET_MARKER, visiblePairs } from "./fixture";
import { type SqlCaller, SqlFailed, SqlRequestError, SqlService, sqlWindow } from "./service";
import { sqlViews } from "./views";

type Expect =
  | "ok"
  | "truncated"
  | "refused"
  | "error"
  | "runtime"
  | "timeout"
  | "memory"
  | "bad_request"
  | "no_leak";

interface Case {
  id: string;
  family: string;
  engines: ("sqlite" | "duckdb")[];
  sql: string;
  expect: Expect;
  as?: "admin" | "member";
  rows?: number;
  value?: unknown;
  since?: string;
  until?: string;
  match?: string;
}

const CORPUS: Case[] = readFileSync(new URL("./sql-hostile.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as Case);
const CASES = CORPUS.filter((c) => c.engines.includes("sqlite"));

const ADMIN: SqlCaller = {
  viewer: { everything: true, own: [], canRead: () => true },
  as: "ops",
  role: "admin",
  key: "ops",
};
/** alice, as a member would see: her sessions and the org's. Members never get `sql` on SQLite
 * (T11); the views still carry the rule, which this checks. */
const ALICE: SqlCaller = {
  viewer: {
    everything: false,
    own: ["alice"],
    canRead: (s) => s.owner === "alice" || s.visibility !== "owner",
  },
  as: "alice",
  role: "member",
  key: "alice",
};

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

type Outcome = { result: SqlResult } | { error: unknown };

async function run(c: Case): Promise<Outcome> {
  const caller = c.as === "member" ? ALICE : ADMIN;
  try {
    return {
      result: await service.query(caller, {
        sql: c.sql,
        since: c.since ?? null,
        until: c.until ?? null,
      }),
    };
  } catch (error) {
    return { error };
  }
}

function describeOutcome(outcome: Outcome): string {
  if ("result" in outcome) return JSON.stringify(outcome.result);
  const error = outcome.error as Error & { code?: string; at?: number };
  return JSON.stringify({
    name: error.name,
    code: error.code,
    message: error.message,
    at: error.at,
  });
}

describe("the hostile-statement suite on SQLite", () => {
  it("has cases for every family the design lists, each with a known outcome", () => {
    const families = new Set(CASES.map((c) => c.family));
    for (const family of [
      "statement",
      "multiple",
      "tables",
      "table-functions",
      "functions",
      "scope-admin",
      "scope-member",
      "errors",
      "resources",
      "lexing",
    ]) {
      expect(families, family).toContain(family);
    }
    expect(new Set(CORPUS.map((c) => c.id)).size).toBe(CORPUS.length);
  });

  for (const c of CASES) {
    it(`${c.id} (${c.expect}${c.as === "member" ? ", as a member" : ""}): ${JSON.stringify(c.sql).slice(0, 70)}`, async () => {
      const outcome = await run(c);
      const text = describeOutcome(outcome);
      expect(text).not.toContain(DECOY_MARKER);
      if (c.as === "member") expect(text).not.toContain(SECRET_MARKER);
      const caller = c.as === "member" ? ALICE : ADMIN;

      if ("result" in outcome) {
        // Every session an answer names is one the caller may see in its window.
        const { result } = outcome;
        const owner = result.columns.findIndex((col) => col.name === "owner");
        const archive = result.columns.findIndex((col) => col.name === "archive_id");
        if (owner !== -1 && archive !== -1) {
          const visible = visiblePairs(caller.viewer, sqlWindow(c, FIXTURE_NOW));
          for (const row of result.rows) {
            expect(visible, text).toContain(`${row[owner]}/${row[archive]}`);
          }
        }
      }

      const failed = "error" in outcome ? outcome.error : undefined;
      switch (c.expect) {
        case "ok":
        case "truncated": {
          expect(failed, text).toBeUndefined();
          const { result } = outcome as { result: SqlResult };
          expect(result.truncated, text).toBe(c.expect === "truncated");
          if (c.rows !== undefined) expect(result.rows.length, text).toBe(c.rows);
          if (c.value !== undefined) expect(result.rows[0]?.[0], text).toBe(c.value);
          expect(JSON.stringify(result.rows).length).toBeLessThanOrEqual(1024 * 1024);
          break;
        }
        case "bad_request":
          expect(failed, text).toBeInstanceOf(SqlRequestError);
          break;
        case "no_leak":
          // Whatever happens, nothing out of scope shows; a member's runtime error says nothing.
          if (failed instanceof SqlFailed && failed.kind === "runtime") {
            expect(failed.message).toBe("the statement failed while running");
          }
          break;
        default: {
          const kind = c.expect === "error" ? "bind" : c.expect;
          expect(failed, text).toBeInstanceOf(SqlFailed);
          expect((failed as SqlFailed).kind, text).toBe(kind);
          if (c.match !== undefined) expect((failed as SqlFailed).message).toContain(c.match);
          if (kind === "runtime" && c.as === "member") {
            expect((failed as SqlFailed).message).toBe("the statement failed while running");
          }
          if (kind === "refused") {
            const at = (failed as SqlFailed).at;
            if (at !== undefined) expect(at).toBeLessThanOrEqual(c.sql.length);
          }
        }
      }
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
