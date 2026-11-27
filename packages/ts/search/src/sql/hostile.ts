/** The hostile-statement suite's harness (docs/seshi/session-tools.md, "The hostile-statement
 * suite"), shared by its two runs: SQLite here (`sql-hostile.test.ts`) and DuckDB over a Lance
 * index in `@seshi/sql`. Not product code. The corpus is `sql-hostile.jsonl`, each case tagged
 * with the engines it applies to and, where an engine answers otherwise, that engine's own
 * outcome (`"duckdb": {"expect": "error"}`). */

import { readFileSync } from "node:fs";
import type { SqlDialect, SqlResult } from "@seshi/model";
import { expect } from "vitest";
import { DECOY_MARKER, FIXTURE_NOW, SECRET_MARKER, visiblePairs } from "./fixture";
import { type SqlCaller, SqlFailed, SqlRequestError, type SqlService, sqlWindow } from "./service";

export type HostileExpect =
  | "ok"
  | "truncated"
  | "refused"
  | "error"
  | "runtime"
  | "timeout"
  | "memory"
  | "bad_request"
  | "no_leak";

interface Outcome {
  expect: HostileExpect;
  rows?: number;
  value?: unknown;
  match?: string;
}

export interface HostileCase extends Outcome {
  id: string;
  family: string;
  engines: SqlDialect[];
  sql: string;
  as?: "admin" | "member";
  since?: string;
  until?: string;
  /** Where DuckDB answers otherwise than SQLite (a parser that reads `[a]` as a list, say). */
  duckdb?: Partial<Outcome>;
  /** Why a case expects what it does, where that is a known weakness written down rather than
   * fixed (a finding of the fuzzer, say). */
  why?: string;
}

/** Every case of the corpus. */
export const HOSTILE_CORPUS: readonly HostileCase[] = readFileSync(
  new URL("./sql-hostile.jsonl", import.meta.url),
  "utf8",
)
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as HostileCase);

/** The cases for `dialect`, each with that engine's expected outcome. */
export function hostileCases(dialect: SqlDialect): HostileCase[] {
  return HOSTILE_CORPUS.filter((c) => c.engines.includes(dialect)).map((c) =>
    dialect === "duckdb" && c.duckdb ? { ...c, ...c.duckdb } : c,
  );
}

/** The families the design lists: each has cases on each engine. */
export const HOSTILE_FAMILIES = [
  "statement",
  "multiple",
  "tables",
  "table-functions",
  "functions",
  "scope-admin",
  "scope-member",
  "errors",
  "resources",
] as const;

export const HOSTILE_ADMIN: SqlCaller = {
  viewer: { everything: true, own: [], canRead: () => true },
  as: "ops",
  role: "admin",
  key: "ops",
};

/** alice, as a member would see: her sessions and the org's. */
export const HOSTILE_ALICE: SqlCaller = {
  viewer: {
    everything: false,
    own: ["alice"],
    canRead: (s) => s.owner === "alice" || s.visibility !== "owner",
  },
  as: "alice",
  role: "member",
  key: "alice",
};

export type HostileOutcome = { result: SqlResult } | { error: unknown };

export function callerOf(c: HostileCase): SqlCaller {
  return c.as === "member" ? HOSTILE_ALICE : HOSTILE_ADMIN;
}

export async function runCase(service: SqlService, c: HostileCase): Promise<HostileOutcome> {
  try {
    return {
      result: await service.query(callerOf(c), {
        sql: c.sql,
        since: c.since ?? null,
        until: c.until ?? null,
      }),
    };
  } catch (error) {
    return { error };
  }
}

export function describeOutcome(outcome: HostileOutcome): string {
  if ("result" in outcome) return JSON.stringify(outcome.result);
  const error = outcome.error as Error & { code?: string; at?: number };
  return JSON.stringify({
    name: error.name,
    code: error.code,
    message: error.message,
    at: error.at,
  });
}

/** Assert what a case must hold, on any engine: no decoy's marker (and, for a member, no other
 * member's private text) anywhere in the answer; every session it names one the caller may see
 * in its window; and the case's own outcome. */
export function expectOutcome(c: HostileCase, outcome: HostileOutcome): void {
  const text = describeOutcome(outcome);
  expect(text).not.toContain(DECOY_MARKER);
  if (c.as === "member") expect(text).not.toContain(SECRET_MARKER);
  const caller = callerOf(c);

  if ("result" in outcome) {
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
      if (failed instanceof SqlFailed && failed.kind === "runtime" && c.as === "member") {
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
}
