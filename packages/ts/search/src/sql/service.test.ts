import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OwnerAliases, type Principal } from "@seshi/auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SearchStatus } from "../service";
import { SearchUnavailable } from "../service";
import { buildFixture, DAY, FIXTURE_NOW } from "./fixture";
import {
  SQL_MAX_ROWS,
  SqlFailed,
  SqlRequestError,
  SqlService,
  SqlUnavailable,
  sqlCallerFor,
  sqlViewerFor,
  sqlWindow,
} from "./service";

let dir: string;
let path: string;
const services: SqlService[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "seshi-sql-service-"));
  path = await buildFixture(dir);
});

afterAll(async () => {
  await Promise.all(services.map((s) => s.close()));
  rmSync(dir, { recursive: true, force: true });
});

function service(status: Partial<SearchStatus> = {}, settings = {}): SqlService {
  const made = new SqlService({
    search: {
      status: async () => ({
        backend: "sqlite",
        location: path,
        ready: true,
        sessions: 0,
        events: 0,
        ...status,
      }),
    },
    now: () => new Date(FIXTURE_NOW),
    settings: { workers: 1, ...settings },
  });
  services.push(made);
  return made;
}

function principal(fields: Partial<Principal>): Principal {
  return {
    kind: "session",
    owner: "alice",
    owner_basis: "verified",
    role: "member",
    scopes: new Set(["sql"]),
    credential: "session",
    credential_id: "c1",
    claims: {},
    ...fields,
  } as Principal;
}

describe("the window (sqlWindow)", () => {
  it("is the last 30 days by default, and takes times and ages", () => {
    expect(sqlWindow({}, FIXTURE_NOW)).toEqual({
      since: FIXTURE_NOW - 30 * DAY,
      until: FIXTURE_NOW,
    });
    expect(sqlWindow({ since: "7d" }, FIXTURE_NOW)).toEqual({
      since: FIXTURE_NOW - 7 * DAY,
      until: FIXTURE_NOW,
    });
    expect(sqlWindow({ since: "2026-01-01", until: "2026-02-01T00:00:00Z" }, FIXTURE_NOW)).toEqual({
      since: Date.parse("2026-01-01"),
      until: Date.parse("2026-02-01T00:00:00Z"),
    });
    // 30 days before an explicit until.
    expect(sqlWindow({ until: "2026-02-01T00:00:00Z" }, FIXTURE_NOW).since).toBe(
      Date.parse("2026-01-02T00:00:00Z"),
    );
  });

  it("is never longer than 400 days, and since comes before until", () => {
    expect(() => sqlWindow({ since: "401d" }, FIXTURE_NOW)).toThrow(/400 days/);
    expect(() => sqlWindow({ since: "400d" }, FIXTURE_NOW)).not.toThrow();
    expect(() => sqlWindow({ since: "1d", until: "2d" }, FIXTURE_NOW)).toThrow(/before until/);
    expect(() => sqlWindow({ since: "soon" }, FIXTURE_NOW)).toThrow(SqlRequestError);
  });
});

describe("who sql answers as (sqlViewerFor, sqlCallerFor)", () => {
  it("lets admins and services see everything, a member their own and the org's", () => {
    expect(sqlViewerFor(principal({ role: "admin" })).everything).toBe(true);
    expect(sqlViewerFor(principal({ role: "service" })).everything).toBe(true);
    const member = sqlViewerFor(principal({}), new OwnerAliases({ "alice@x.io": "alice" }));
    expect(member.everything).toBe(false);
    expect(member.own).toContain("alice");
    expect(member.canRead({ owner: "bob", visibility: "owner" })).toBe(false);
    expect(member.canRead({ owner: "bob", visibility: "org" })).toBe(true);
    expect(sqlCallerFor(principal({ role: "admin", owner: "ops" }))).toMatchObject({
      as: "ops",
      role: "admin",
      key: "ops",
    });
  });
});

describe("SqlService", () => {
  const admin = {
    viewer: { everything: true, own: [], canRead: () => true },
    as: "ops",
    role: "admin",
    key: "ops",
  };

  it("answers with when, who, the window and the index", async () => {
    const answer = await service({ caught_up_at: "2026-11-25T11:59:00.000Z" }).query(admin, {
      sql: "SELECT count(*) AS n FROM sessions",
      since: "7d",
    });
    expect(answer).toMatchObject({
      now: new Date(FIXTURE_NOW).toISOString(),
      scope: { as: "ops", role: "admin", since: new Date(FIXTURE_NOW - 7 * DAY).toISOString() },
      index: { backend: "sqlite", dialect: "sqlite", updated_at: "2026-11-25T11:59:00.000Z" },
      columns: [{ name: "n", type: "INTEGER" }],
      rows: [[5]],
      truncated: false,
    });
  });

  it("returns at most max_rows, and never more than the server's cap", async () => {
    const sql =
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50) SELECT i FROM n";
    const few = await service().query(admin, { sql, max_rows: 10 });
    expect(few.rows.length).toBe(10);
    expect(few.truncated).toBe(true);
    const capped = service({}, { maxRows: 20 });
    expect((await capped.query(admin, { sql, max_rows: 500 })).rows.length).toBe(20);
    expect(service({}, { maxRows: 5_000 }).settings.maxRows).toBe(SQL_MAX_ROWS);
    await expect(service().query(admin, { sql, max_rows: 0 })).rejects.toBeInstanceOf(
      SqlRequestError,
    );
    await expect(service().query(admin, { sql: " " })).rejects.toThrow(/sql is required/);
  });

  it("refuses an index it cannot read, and waits for one being built", async () => {
    await expect(
      service({ backend: "lance" }).query(admin, { sql: "SELECT 1" }),
    ).rejects.toBeInstanceOf(SqlUnavailable);
    await expect(service({ location: ":memory:" }).schema(admin)).rejects.toThrow(/in memory/);
    await expect(
      service({ ready: false }).query(admin, { sql: "SELECT 1" }),
    ).rejects.toBeInstanceOf(SearchUnavailable);
  });

  it("maps the worker's failures, hiding a runtime message from a member", async () => {
    const member = {
      ...admin,
      viewer: { everything: false, own: ["alice"], canRead: () => true },
      role: "member",
      key: "alice",
    };
    const sql = "SELECT json_extract(text, '$') FROM events WHERE role = 'user'";
    await expect(service().query(admin, { sql })).rejects.toMatchObject({
      code: "sql_runtime",
      message: "malformed JSON",
    });
    await expect(service().query(member, { sql })).rejects.toMatchObject({
      code: "sql_runtime",
      message: "the statement failed while running",
    });
    const refused = service().query(admin, { sql: "SELECT * FROM meta" });
    await expect(refused).rejects.toBeInstanceOf(SqlFailed);
    await expect(refused).rejects.toMatchObject({ code: "sql_refused", at: 14 });
  });

  it("serves the schema: dialect, DDL, examples, limits", async () => {
    const schema = await service().schema(admin, { since: "7d" });
    expect(schema.dialect).toBe("sqlite");
    expect(schema.hint).toMatch(/^SQLite:/);
    expect(schema.ddl).toContain("CREATE VIEW llm_calls (");
    expect(schema.examples).toHaveLength(3);
    expect(schema.limits).toEqual({
      max_rows: 1000,
      max_bytes: 1024 * 1024,
      timeout_ms: 15_000,
      max_sql_bytes: 16 * 1024,
    });
  });
});
