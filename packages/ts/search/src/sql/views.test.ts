import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LOCAL_VIEWER, type Viewer } from "../viewer";
import { expectExample } from "./conformance";
import { buildFixture, FIXTURE_NOW } from "./fixture";
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

  it("write DuckDB's over the Lance tables, the scope in sessions and each row of events", () => {
    const member: Viewer = { everything: false, own: ["alice"], canRead: () => true };
    const tables = {
      sessions: "gs://b/search/d/g1/sessions.lance",
      events: "gs://b/search/d/g1/events.lance",
      llm_calls: "gs://b/search/d/g1/llm_calls.lance",
    };
    const [sessions, events, calls] = sqlViews(
      "duckdb",
      member,
      { since: 1000, until: 2000 },
      tables,
    );
    expect(sessions).toContain("CREATE VIEW sessions AS");
    expect(sessions).toContain("FROM 'gs://b/search/d/g1/sessions.lance' s");
    expect(sessions).toContain("NOT s.removed");
    expect(sessions).toContain("(s.visibility = 'org' OR s.owner IN ('alice'))");
    expect(sessions).toContain("coalesce(s.started_at, epoch_ms(s.updated_ms)) < epoch_ms(2000)");
    expect(sessions).toContain(
      "coalesce(s.ended_at, s.started_at, epoch_ms(s.updated_ms)) >= epoch_ms(1000)",
    );
    // events: its own row's visibility, and a semi-join on the sessions the scope admits.
    expect(events).toContain("FROM 'gs://b/search/d/g1/events.lance' e");
    expect(events).toContain("(e.visibility = 'org' OR e.owner IN ('alice'))");
    expect(events).toContain("s.owner = e.owner AND s.archive_id = e.archive_id");
    expect(events).toContain("FROM 'gs://b/search/d/g1/sessions.lance' s");
    expect(calls).toContain("s.owner = c.owner AND s.archive_id = c.archive_id");
    expect(calls).not.toContain("c.visibility");
    const admin = sqlViews("duckdb", LOCAL_VIEWER, { since: 1000, until: 2000 }, tables).join("\n");
    expect(admin).not.toContain("visibility = 'org'");
    expect(admin).toContain("NOT s.removed");
    // Locations come from meta; one that is not a Lance table is refused all the same.
    expect(() =>
      sqlViews("duckdb", member, { since: 0, until: 1 }, { ...tables, events: "x.csv" }),
    ).toThrow(/not a Lance table/);
    expect(
      sqlViews("duckdb", member, { since: 0, until: 1 }, { ...tables, events: "/a'b/e.lance" })[1],
    ).toContain("FROM '/a''b/e.lance' e");
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
  it("are served for SQLite as the schema endpoint gives them", async () => {
    const schema = await service.schema(ADMIN);
    expect(schema.examples).toEqual([...SQL_EXAMPLES.sqlite]);
    expect(schema.dialect).toBe("sqlite");
    expect(schema.ddl).toBe(sqlSchema("sqlite"));
  });

  it("1. tokens per person and model", async () => {
    await expectExample(service, ADMIN, "sqlite", 0);
  });

  it("2. tools that fail most, by repo", async () => {
    await expectExample(service, ADMIN, "sqlite", 1);
  });

  it("3. sessions with many prompts and few tool calls", async () => {
    await expectExample(service, ADMIN, "sqlite", 2);
  });
});
