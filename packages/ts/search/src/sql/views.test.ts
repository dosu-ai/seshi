import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LOCAL_VIEWER, type Viewer } from "../viewer";
import { buildFixture, callsOf, eventsOf, FIXTURE_NOW, FIXTURE_SESSIONS } from "./fixture";
import { SqlService } from "./service";
import { SQL_EXAMPLES, SQL_VIEWS, sqlSchema, sqlViews } from "./views";

let dir: string;
let path: string;
let service: SqlService;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "seshi-sql-views-"));
  path = await buildFixture(dir);
  service = new SqlService({
    search: {
      status: async () => ({
        backend: "sqlite",
        location: path,
        ready: true,
        sessions: 0,
        events: 0,
      }),
    },
    now: () => new Date(FIXTURE_NOW),
    settings: { workers: 1 },
  });
});

afterAll(async () => {
  await service?.close();
  rmSync(dir, { recursive: true, force: true });
});

const ADMIN = { viewer: LOCAL_VIEWER, as: "ops", role: "admin", key: "ops" };

/** The columns the DDL gives each view, with their types. */
function ddlColumns(ddl: string): Map<string, [string, string][]> {
  const views = new Map<string, [string, string][]>();
  for (const block of ddl.split(/\n\n/)) {
    const name = /CREATE VIEW (\w+) \(/.exec(block)?.[1] as string;
    const columns = [...block.matchAll(/^ {2}(\w+)\s+([A-Z][A-Z[\]]*),?/gm)].map(
      (m) => [m[1], m[2]] as [string, string],
    );
    views.set(name, columns);
  }
  return views;
}

describe("the views (SQL_VIEWS)", () => {
  it("name exactly the columns SQLite reports, with the types the DDL gives", () => {
    const db = new Database(path, { readonly: true });
    try {
      for (const view of sqlViews("sqlite", LOCAL_VIEWER, { since: 0, until: FIXTURE_NOW })) {
        db.run(view);
      }
      const ddl = ddlColumns(sqlSchema("sqlite"));
      expect([...ddl.keys()]).toEqual(["sessions", "events", "llm_calls"]);
      for (const [view, columns] of ddl) {
        const reported = (
          db.query(`SELECT name, type FROM pragma_table_info('${view}')`).all() as {
            name: string;
            type: string;
          }[]
        ).map((c) => [c.name, c.type]);
        expect(reported, view).toEqual(columns);
      }
    } finally {
      db.close();
    }
  });

  it("give DuckDB the same column names with its own types", () => {
    const sqlite = ddlColumns(sqlSchema("sqlite"));
    const duckdb = ddlColumns(sqlSchema("duckdb"));
    for (const [view, columns] of sqlite) {
      expect(
        duckdb.get(view)?.map(([name]) => name),
        view,
      ).toEqual(columns.map(([n]) => n));
    }
    expect(duckdb.get("sessions")).toContainEqual(["models", "VARCHAR[]"]);
    expect(duckdb.get("events")).toContainEqual(["ok", "BOOLEAN"]);
    expect(duckdb.get("events")).toContainEqual(["ts", "TIMESTAMPTZ"]);
  });

  it("keep the index's internal columns out", () => {
    const names = SQL_VIEWS.flatMap((v) => v.columns.map((c) => c.name));
    for (const internal of ["traces", "read_ms", "removed", "updated_ms", "session", "format"]) {
      expect(names).not.toContain(internal);
    }
  });

  it("write the caller's scope and the window in as literals, never anything else", () => {
    const member: Viewer = { everything: false, own: ["alice", "a@x.io"], canRead: () => true };
    const [sessions] = sqlViews("sqlite", member, { since: 1000, until: 2000 });
    expect(sessions).toContain("CREATE TEMP VIEW sessions AS");
    expect(sessions).toContain("s.removed = 0");
    expect(sessions).toContain("(s.visibility = 'org' OR s.owner IN ('alice', 'a@x.io'))");
    expect(sessions).toContain("coalesce(s.started_at, s.updated_ms) < 2000");
    expect(sessions).toContain("coalesce(s.ended_at, s.started_at, s.updated_ms) >= 1000");
    const admin = sqlViews("sqlite", LOCAL_VIEWER, { since: 1000, until: 2000 }).join("\n");
    expect(admin).not.toContain("visibility = 'org'");
    expect(() =>
      sqlViews("sqlite", { ...member, own: ["x' OR 1=1 --"] }, { since: 0, until: 1 }),
    ).toThrow(/not an owner id/);
    expect(() => sqlViews("sqlite", member, { since: 0.5, until: 1 })).toThrow(/whole number/);
    expect(() => sqlViews("duckdb", member, { since: 0, until: 1 })).toThrow(/LanceDB/);
  });

  it("answer times as SQLite's own UTC text, so datetime() compares with them", async () => {
    const result = await service.query(ADMIN, {
      sql: "SELECT ts, ts > datetime('now', '-30 days') AS recent FROM events ORDER BY ts LIMIT 1",
    });
    expect(result.rows[0]?.[0]).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}$/);
    expect(result.rows[0]?.[1]).toBe(1);
  });
});

describe("the examples (conformance)", () => {
  /** What the fixture holds, worked out without SQL: sessions not removed, started within 30
   * days (the default window and example 1's predicate agree on the fixture). */
  const live = FIXTURE_SESSIONS.map((s, i) => ({ s, n: i + 1 })).filter(
    ({ s }) => !s.removed && s.started > FIXTURE_NOW - 30 * 86_400_000,
  );

  it("are served for SQLite as the schema endpoint gives them", async () => {
    const schema = await service.schema(ADMIN);
    expect(schema.examples).toEqual([...SQL_EXAMPLES.sqlite]);
    expect(schema.dialect).toBe("sqlite");
    expect(schema.ddl).toBe(sqlSchema("sqlite"));
  });

  it("1. tokens per person and model", async () => {
    const want = new Map<string, number>();
    for (const { s, n } of live) {
      for (const call of callsOf(s, n)) {
        const key = `${s.owner}\t${call.model}`;
        want.set(key, (want.get(key) ?? 0) + (call.input_tokens ?? 0) + (call.output_tokens ?? 0));
      }
    }
    const result = await service.query(ADMIN, { sql: SQL_EXAMPLES.sqlite[0] as string });
    expect(result.columns.map((c) => c.name)).toEqual(["owner", "model", "tokens"]);
    const got = result.rows.map((r) => [`${r[0]}\t${r[1]}`, r[2]]);
    expect(new Map(got as [string, number][])).toEqual(want);
    const tokens = result.rows.map((r) => r[2] as number);
    expect(tokens).toEqual([...tokens].sort((a, b) => b - a));
  });

  it("2. tools that fail most, by repo", async () => {
    const byRepo = new Map<string, { failed: number; calls: number }>();
    for (const { s, n } of live) {
      for (const e of eventsOf(s, n)) {
        if (e.role !== "tool_result") continue;
        const key = `${s.repo}\t${e.tool_name}`;
        const seen = byRepo.get(key) ?? { failed: 0, calls: 0 };
        seen.calls++;
        if (e.ok === false) seen.failed++;
        byRepo.set(key, seen);
      }
    }
    const want = [...byRepo]
      .filter(([, v]) => v.calls > 20)
      .sort((a, b) => b[1].failed - a[1].failed)
      .map(([k, v]) => [...k.split("\t"), v.failed, v.calls]);
    expect(want.length).toBeGreaterThan(0);
    const result = await service.query(ADMIN, { sql: SQL_EXAMPLES.sqlite[1] as string });
    expect(result.rows).toEqual(want);
  });

  it("3. sessions with many prompts and few tool calls", async () => {
    const want = live
      .map(({ s, n }) => {
        const events = eventsOf(s, n);
        return [
          s.owner,
          s.archive,
          events.filter((e) => e.role === "user").length,
          events.filter((e) => e.role === "tool_call").length,
        ];
      })
      .filter(([, , prompts, calls]) => (prompts as number) > 10 && (calls as number) < 5);
    expect(want.length).toBeGreaterThan(0);
    const result = await service.query(ADMIN, { sql: SQL_EXAMPLES.sqlite[2] as string });
    expect(result.rows).toEqual(want);
  });
});
