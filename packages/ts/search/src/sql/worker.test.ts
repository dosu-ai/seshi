import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LOCAL_VIEWER } from "../viewer";
import { buildFixture, FIXTURE_NOW } from "./fixture";
import { sqlViews } from "./views";
import { runSqliteQuery } from "./worker";

let dir: string;
let index: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "seshi-sql-worker-"));
  index = await buildFixture(dir);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("a worker's query (runSqliteQuery)", () => {
  it("counts max_bytes in UTF-8 bytes, so wide characters cut sooner", () => {
    // 100 rows of 1,000 CJK characters: about 3,000 bytes each in UTF-8, 1,000 UTF-16 units.
    const sql =
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100) " +
      "SELECT replace(printf('%1000s', ''), ' ', '界') AS wide FROM n";
    const answer = runSqliteQuery({
      id: "q1",
      engine: "sqlite",
      setup: {
        file: index,
        views: sqlViews("sqlite", LOCAL_VIEWER, { since: 0, until: FIXTURE_NOW }),
      },
      sql,
      limits: { timeout_ms: 5_000, max_rows: 1_000, max_bytes: 10_000 },
    });
    if (!answer.ok) throw new Error(answer.error.message);
    expect(answer.truncated).toBe(true);
    expect(answer.rows).toHaveLength(3);
    expect(Buffer.byteLength(JSON.stringify(answer.rows), "utf8")).toBeLessThanOrEqual(10_000);
  });
});
