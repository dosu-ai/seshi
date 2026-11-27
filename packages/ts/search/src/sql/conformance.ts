/** The example conformance test's answers (docs/seshi/session-tools.md, "The views"): each of
 * `SQL_EXAMPLES`' questions, worked out from the fixture without SQL, which both engines must
 * give in their own dialect. Not product code. */

import type { SqlDialect, SqlResult } from "@seshi/model";
import { expect } from "vitest";
import { callsOf, eventsOf, FIXTURE_NOW, FIXTURE_SESSIONS } from "./fixture";
import type { SqlCaller, SqlService } from "./service";
import { SQL_EXAMPLES } from "./views";

/** Sessions not removed, started within 30 days: the default window and example 1's predicate
 * agree on the fixture. */
const live = () =>
  FIXTURE_SESSIONS.map((s, i) => ({ s, n: i + 1 })).filter(
    ({ s }) => !s.removed && s.started > FIXTURE_NOW - 30 * 86_400_000,
  );

/** 1. Tokens per person and model: `owner\tmodel` to tokens. */
export function tokensPerPersonAndModel(): Map<string, number> {
  const want = new Map<string, number>();
  for (const { s, n } of live()) {
    for (const call of callsOf(s, n)) {
      const key = `${s.owner}\t${call.model}`;
      want.set(key, (want.get(key) ?? 0) + (call.input_tokens ?? 0) + (call.output_tokens ?? 0));
    }
  }
  return want;
}

/** 2. Tools that fail most, by repo: `[repo, tool, failed, calls]`, most failed first. */
export function toolsThatFailMost(): unknown[][] {
  const byRepo = new Map<string, { failed: number; calls: number }>();
  for (const { s, n } of live()) {
    for (const e of eventsOf(s, n)) {
      if (e.role !== "tool_result") continue;
      const key = `${s.repo}\t${e.tool_name}`;
      const seen = byRepo.get(key) ?? { failed: 0, calls: 0 };
      seen.calls++;
      if (e.ok === false) seen.failed++;
      byRepo.set(key, seen);
    }
  }
  return [...byRepo]
    .filter(([, v]) => v.calls > 20)
    .sort((a, b) => b[1].failed - a[1].failed)
    .map(([k, v]) => [...k.split("\t"), v.failed, v.calls]);
}

/** 3. Sessions with many prompts and few tool calls: `[owner, archive, prompts, calls]`. */
export function manyPromptsFewCalls(): unknown[][] {
  return live()
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
}

/** Run example `n` (0-based) in `dialect` as `caller` and expect the fixture's answer. */
export async function expectExample(
  service: SqlService,
  caller: SqlCaller,
  dialect: SqlDialect,
  n: 0 | 1 | 2,
): Promise<SqlResult> {
  const result = await service.query(caller, { sql: SQL_EXAMPLES[dialect][n] as string });
  if (n === 0) {
    expect(result.columns.map((c) => c.name)).toEqual(["owner", "model", "tokens"]);
    const got = result.rows.map((r) => [`${r[0]}\t${r[1]}`, r[2]]);
    expect(new Map(got as [string, number][])).toEqual(tokensPerPersonAndModel());
    const tokens = result.rows.map((r) => r[2] as number);
    expect(tokens).toEqual([...tokens].sort((a, b) => b - a));
  } else {
    const want = n === 1 ? toolsThatFailMost() : manyPromptsFewCalls();
    expect(want.length).toBeGreaterThan(0);
    expect(result.rows).toEqual(want);
  }
  return result;
}
