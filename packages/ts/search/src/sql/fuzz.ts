/** The `sql` fuzzer (docs/seshi/session-tools.md, "The hostile-statement suite"): statements
 * made by mutating the hostile corpus (a table swapped for a path, wrapped in a CTE, a join
 * added, a second statement added, names quoted or qualified, comments slipped in) and statements
 * generated to probe scope (joins, subqueries, set operations, window functions and predicates
 * over another member's owner-only session, the removed one and the one outside the window).
 * Not product code: `bun run test:sql-fuzz` runs it nightly, on each engine.
 *
 * Each statement is held to the corpus's two checks and to one more:
 *
 * - **The check and the engine agree.** A statement the check accepts must not fail to parse
 *   (a bind error is fine: a mutation may name a column twice).
 * - **Every pair is visible.** Every `owner`/`archive_id` pair an answer returns is one the
 *   caller may see, and no decoy's marker (nor, for a member, the other member's private text)
 *   appears anywhere in the answer.
 * - **The answer is the one over what the caller may see.** The same statement is run as the
 *   caller over the fixture index and as an admin over a reference index built from only the
 *   sessions the caller may see (the same rows, nothing else). The answers must be the same: a
 *   count, a sum, a `NOT IN` or a window function that took a hidden row in would differ. */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SqlDialect, SqlResult } from "@seshi/model";
import { DECOY_MARKER, type FixtureSession, SECRET_MARKER, visiblePairs } from "./fixture";
import { HOSTILE_ADMIN, HOSTILE_ALICE, hostileCases } from "./hostile";
import { type SqlCaller, SqlFailed, type SqlService, sqlWindow } from "./service";

/** A small seeded PRNG (mulberry32): the same seed makes the same statements. */
export function fuzzRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rand = () => number;
const pick = <T>(r: Rand, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
const chance = (r: Rand, p: number) => r() < p;

const H = (n: number) => n.toString(16).padStart(64, "0");
/** bob's owner-only session, the removed one and the one outside the default window. */
const HIDDEN = { owner: H(5), removed: H(6), old: H(7) } as const;

export type FuzzCallerName = "member" | "admin";
export const FUZZ_CALLERS: Readonly<Record<FuzzCallerName, SqlCaller>> = {
  member: HOSTILE_ALICE,
  admin: HOSTILE_ADMIN,
};

/** Which fixture sessions a reference index holds for `caller`: exactly those the caller sees in
 * the default window. */
export function fuzzReferenceSessions(
  caller: FuzzCallerName,
  now: number,
): (s: FixtureSession) => boolean {
  const visible = visiblePairs(
    FUZZ_CALLERS[caller].viewer,
    sqlWindow({ since: null, until: null }, now),
  );
  return (s) => visible.has(`${s.owner}/${s.archive}`);
}

// --- Mutations of the corpus ---------------------------------------------------------------

const VIEWS = ["sessions", "events", "llm_calls"] as const;
const VIEW_RE = /\b(sessions|events|llm_calls)\b/gi;

/** Names a statement must never reach, beside the paths the engine gives. */
const HIDDEN_TABLES: Readonly<Record<SqlDialect, readonly string[]>> = {
  sqlite: [
    "main.events",
    "main.sessions",
    "temp.sessions",
    "meta",
    "seen",
    "changes",
    "feeds",
    "events_text",
    "events_text_content",
    "sqlite_master",
    "sqlite_temp_master",
    "pragma_table_list",
    "pragma_database_list",
  ],
  duckdb: [
    "main.events",
    "memory.main.sessions",
    "temp.main.events",
    "duckdb_views()",
    "duckdb_tables",
    "duckdb_settings()",
    "information_schema.tables",
    "pg_catalog.pg_views",
    "system.main.duckdb_settings",
    "sqlite_master",
  ],
};

/** Table functions a mutation may add (each must be refused, or see nothing out of scope). */
const TABLE_FUNCTIONS: Readonly<Record<SqlDialect, readonly ((path: string) => string)[]>> = {
  sqlite: [
    (p) => `json_each(readfile(${q(p)}))`,
    () => "pragma_table_info('events')",
    () => "fts5vocab('events_text', 'row')",
    () => "generate_series(1, 3)",
    () => "json_each('[1,2]')",
  ],
  duckdb: [
    (p) => `read_csv(${q(p)})`,
    (p) => `read_text(${q(p)})`,
    (p) => `read_blob(${q(p)})`,
    (p) => `glob(${q(p)})`,
    (p) => `__lance_scan(${q(p)})`,
    (p) => `lance_fts(${q(p)}, 'text', 'SECRET')`,
    (p) => `query_table(${q(p)})`,
    () => "query('SELECT * FROM main.events')",
    () => "range(3)",
    () => "unnest([1, 2])",
  ],
};

const q = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** A second statement after the first, and the ways to separate it. */
const SECOND = [
  "DROP VIEW events",
  "SELECT * FROM main.events",
  "ATTACH 'decoy.sqlite' AS d",
  "PRAGMA query_only = 0",
  "SET enable_external_access = true",
  "SELECT 1",
];
const SEPARATORS = [";", "; ", ";\n", "\n;", "; -- x\n", "/* ; */;", ";;", "；", ";"];

/** Rename a view as a quoted, qualified or re-cased name: some name the view, some the index's
 * own table, none anything else. */
function renameView(r: Rand, view: string, dialect: SqlDialect): string {
  const forms = [
    `"${view}"`,
    `"${view.toUpperCase()}"`,
    view.toUpperCase(),
    `\`${view}\``,
    `main.${view}`,
    `"main"."${view}"`,
    `temp.${view}`,
    `main . ${view}`,
    dialect === "sqlite" ? `[${view}]` : `memory.main.${view}`,
    dialect === "sqlite" ? `temp."${view}"` : `memory.${view}`,
  ];
  return pick(r, forms);
}

/** Replace one occurrence (the `which`th) of a view's name. */
function replaceView(sql: string, r: Rand, by: (view: string) => string): string | undefined {
  const matches = [...sql.matchAll(VIEW_RE)];
  if (matches.length === 0) return undefined;
  const m = pick(r, matches);
  const at = m.index as number;
  return sql.slice(0, at) + by(m[0]) + sql.slice(at + m[0].length);
}

/** Slip a comment or whitespace in at a token boundary. */
function slipComment(sql: string, r: Rand): string {
  const spaces = [...sql.matchAll(/\s+/g)];
  if (spaces.length === 0) return `/**/${sql}`;
  const m = pick(r, spaces);
  const at = m.index as number;
  const by = pick(r, ["/**/", " /* ; */ ", " --\n", "\n", "\t", " /* */ "]);
  return sql.slice(0, at) + by + sql.slice(at + m[0].length);
}

/** Drop a trailing `;` and whitespace so the statement can be wrapped. */
const bare = (sql: string) => sql.replace(/[\s;]+$/u, "");

export interface FuzzMutation {
  /** The mutators applied, in order. */
  how: string[];
  /** The corpus case mutated, or `generated`. */
  from: string;
  sql: string;
}

type Mutator = (sql: string, r: Rand, ctx: MutationContext) => string | undefined;

interface MutationContext {
  dialect: SqlDialect;
  paths: readonly string[];
}

const MUTATORS: Readonly<Record<string, Mutator>> = {
  "path-for-table": (sql, r, { paths }) => replaceView(sql, r, () => q(pick(r, paths))),
  "hidden-for-table": (sql, r, { dialect }) =>
    replaceView(sql, r, () => pick(r, HIDDEN_TABLES[dialect])),
  "rename-view": (sql, r, { dialect }) => replaceView(sql, r, (v) => renameView(r, v, dialect)),
  "function-for-table": (sql, r, { dialect, paths }) =>
    replaceView(sql, r, () => pick(r, TABLE_FUNCTIONS[dialect])(pick(r, paths))),
  "wrap-cte": (sql, r, { dialect }) => {
    const name = pick(r, [
      ...VIEWS,
      "x",
      "meta",
      "changes",
      ...(dialect === "duckdb" ? ["duckdb_views"] : []),
    ]);
    return `WITH ${name} AS (${bare(sql)}) SELECT * FROM ${name}`;
  },
  "shadow-cte": (sql, r, { dialect, paths }) => {
    const view = pick(r, VIEWS);
    const source = chance(r, 0.5) ? q(pick(r, paths)) : pick(r, HIDDEN_TABLES[dialect]);
    return `WITH ${view} AS (SELECT * FROM ${source}) ${bare(sql)}`;
  },
  "add-join": (sql, r, { dialect, paths }) => {
    const source = pick(r, [
      ...VIEWS,
      q(pick(r, paths)),
      pick(r, HIDDEN_TABLES[dialect]),
      pick(r, TABLE_FUNCTIONS[dialect])(pick(r, paths)),
    ]);
    const kind = pick(r, ["JOIN", "LEFT JOIN", "CROSS JOIN", ","]);
    const on = kind === "CROSS JOIN" || kind === "," ? "" : " ON true";
    return `SELECT * FROM (${bare(sql)}) fz_q ${kind} ${source} fz_j${on}`;
  },
  "add-statement": (sql, r) => `${bare(sql)}${pick(r, SEPARATORS)}${pick(r, SECOND)}`,
  "slip-comment": (sql, r) => slipComment(sql, r),
  "union-probe": (sql, r) => {
    const view = pick(r, VIEWS);
    return `SELECT owner, archive_id FROM (${bare(sql)}) fz_q UNION ALL SELECT owner, archive_id FROM ${view} WHERE archive_id = '${pick(r, Object.values(HIDDEN))}'`;
  },
  "subquery-scope": (sql, r) => {
    const view = pick(r, VIEWS);
    return `SELECT * FROM ${view} WHERE archive_id ${pick(r, ["IN", "NOT IN"])} (SELECT archive_id FROM (${bare(sql)}) fz_q)`;
  },
};

/** One mutation of a corpus statement: one to three mutators, applied in turn. */
export function mutateCorpus(
  r: Rand,
  dialect: SqlDialect,
  paths: readonly string[],
  corpus: readonly { id: string; sql: string }[],
): FuzzMutation {
  const seed = pick(r, corpus);
  const names = Object.keys(MUTATORS);
  let sql = seed.sql;
  const how: string[] = [];
  const n = 1 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) {
    const name = pick(r, names);
    const next = (MUTATORS[name] as Mutator)(sql, r, { dialect, paths });
    if (next === undefined) continue;
    sql = next;
    how.push(name);
  }
  return { how, from: seed.id, sql };
}

/** The corpus cases a mutation starts from: the families whose statements are worth mutating
 * (not the resource cases, which only time out, nor the bad requests, which never run). */
export function fuzzCorpus(dialect: SqlDialect): { id: string; sql: string }[] {
  return hostileCases(dialect)
    .filter((c) => c.family !== "resources" && c.expect !== "bad_request")
    .map((c) => ({ id: c.id, sql: c.sql }));
}

// --- Generated scope probes ----------------------------------------------------------------

interface ViewShape {
  alias: string;
  columns: readonly string[];
  /** Predicates over this view alone, `$` for its alias. */
  preds: readonly string[];
}

const SHAPES: Readonly<Record<(typeof VIEWS)[number], ViewShape>> = {
  sessions: {
    alias: "s",
    columns: ["repo", "visibility", "session_id", "branch", "agent", "started_at"],
    preds: [
      "$.visibility = 'owner'",
      "$.visibility = 'org'",
      "$.repo = 'github.com/acme/secret'",
      "$.repo LIKE '%acme%'",
      "$.session_id IN ('s5', 's6', 's7')",
      "$.branch = 'main'",
    ],
  },
  events: {
    alias: "e",
    columns: ["role", "text", "seq", "tool_name", "content_hash", "chars"],
    preds: [
      "$.text LIKE '%SECRET%'",
      "$.text LIKE '%private%'",
      "$.role = 'assistant'",
      "$.role = 'tool_result'",
      "$.seq > 20",
      "$.chars > 10",
      "$.tool_name = 'Bash'",
    ],
  },
  llm_calls: {
    alias: "c",
    columns: ["model", "input_tokens", "total_tokens", "provider", "id"],
    preds: [
      "$.input_tokens >= 500",
      "$.model = 'claude-opus-5-5'",
      "$.total_tokens > 100",
      "$.id = 'm1'",
    ],
  },
};

const KEY_PREDS = [
  "$.owner = 'bob'",
  "$.owner <> 'alice'",
  `$.archive_id = '${HIDDEN.owner}'`,
  `$.archive_id = '${HIDDEN.removed}'`,
  `$.archive_id = '${HIDDEN.old}'`,
  `$.archive_id IN ('${HIDDEN.owner}', '${HIDDEN.removed}', '${HIDDEN.old}')`,
  `$.archive_id > '${H(4)}'`,
];

function pred(r: Rand, view: (typeof VIEWS)[number], alias: string): string {
  const one = () => {
    const p = chance(r, 0.5) ? pick(r, KEY_PREDS) : pick(r, SHAPES[view].preds);
    return p.replaceAll("$", alias);
  };
  const p = one();
  const roll = r();
  if (roll < 0.2) return `(${p} OR ${one()})`;
  if (roll < 0.35) return `(${p} AND ${one()})`;
  if (roll < 0.45) return `NOT (${p})`;
  return p;
}

/** An expression that fails at run time only on a row that matches `cond`: the corpus's
 * `errors` family, generated. */
function failingOn(r: Rand, dialect: SqlDialect, cond: string): string {
  const fail = pick(r, [
    "CAST(text AS INTEGER) = 1",
    dialect === "duckdb"
      ? "CAST(owner AS DATE) IS NOT NULL"
      : "json_extract(text, '$') IS NOT NULL",
    dialect === "duckdb" ? "error('fz') IS NULL" : "abs(-9223372036854775807 - 1) = 0",
  ]);
  return `CASE WHEN ${cond} THEN ${fail} END`;
}

/** One generated statement, over one or two views, that a hidden row would change. */
export function generateProbe(r: Rand, dialect: SqlDialect): FuzzMutation {
  const v1 = pick(r, VIEWS);
  const v2 = pick(r, VIEWS);
  const a = SHAPES[v1].alias;
  const b = `${SHAPES[v2].alias}2`;
  const where = (view: (typeof VIEWS)[number], alias: string) =>
    chance(r, 0.7) ? ` WHERE ${pred(r, view, alias)}` : "";
  const col = (view: (typeof VIEWS)[number], alias: string) =>
    `${alias}.${pick(r, SHAPES[view].columns)}`;
  const group = dialect === "duckdb" && chance(r, 0.5) ? "GROUP BY ALL" : "GROUP BY 1, 2";

  const forms: Record<string, () => string> = {
    pairs: () => `SELECT ${a}.owner, ${a}.archive_id, ${col(v1, a)} FROM ${v1} ${a}${where(v1, a)}`,
    "pairs-grouped": () =>
      `SELECT ${a}.owner, ${a}.archive_id, count(*) AS n FROM ${v1} ${a}${where(v1, a)} ${group}`,
    aggregate: () =>
      `SELECT count(*) AS n, count(DISTINCT ${a}.archive_id) AS sessions, min(${a}.archive_id) AS lo, max(${a}.owner) AS hi FROM ${v1} ${a}${where(v1, a)}`,
    join: () =>
      `SELECT ${a}.owner, ${a}.archive_id, ${col(v2, b)} FROM ${v1} ${a} ${pick(r, ["JOIN", "LEFT JOIN"])} ${v2} ${b} ON ${b}.owner = ${a}.owner AND ${b}.archive_id = ${a}.archive_id${where(v2, b)}`,
    "join-using": () =>
      `SELECT owner, archive_id, count(*) AS n FROM ${v1} ${a} JOIN ${v2} ${b} USING (owner, archive_id)${where(v1, a)} GROUP BY owner, archive_id`,
    "join-off-key": () =>
      `SELECT count(*) AS n FROM ${v1} ${a} JOIN ${v2} ${b} ON ${b}.owner <> ${a}.owner${where(v2, b)}`,
    "in-subquery": () =>
      `SELECT ${a}.owner, ${a}.archive_id FROM ${v1} ${a} WHERE ${a}.archive_id ${pick(r, ["IN", "NOT IN"])} (SELECT ${b}.archive_id FROM ${v2} ${b}${where(v2, b)})`,
    exists: () =>
      `SELECT ${a}.owner, ${a}.archive_id FROM ${v1} ${a} WHERE ${pick(r, ["", "NOT "])}EXISTS (SELECT 1 FROM ${v2} ${b} WHERE ${b}.archive_id = ${a}.archive_id AND ${pred(r, v2, b)})`,
    scalar: () =>
      `SELECT ${a}.owner, ${a}.archive_id, (SELECT count(*) FROM ${v2} ${b}${where(v2, b)}) AS n FROM ${v1} ${a}`,
    "set-op": () => {
      const op = pick(r, ["UNION", "UNION ALL", "EXCEPT", "INTERSECT"]);
      return `SELECT ${a}.owner, ${a}.archive_id FROM ${v1} ${a}${where(v1, a)} ${op} SELECT ${b}.owner, ${b}.archive_id FROM ${v2} ${b}${where(v2, b)}`;
    },
    cte: () => {
      const name = pick(r, ["x", "sessions", "events", "llm_calls"]);
      return `WITH ${name} AS (SELECT ${a}.owner, ${a}.archive_id FROM ${v1} ${a}${where(v1, a)}) SELECT owner, archive_id, count(*) AS n FROM ${name} GROUP BY owner, archive_id`;
    },
    window: () =>
      `SELECT ${a}.owner, ${a}.archive_id, count(*) OVER () AS total, row_number() OVER (ORDER BY ${a}.archive_id) AS rn FROM ${v1} ${a}${where(v1, a)}`,
    "error-on-hidden": () =>
      `SELECT count(*) AS n FROM ${v1} WHERE ${failingOn(r, dialect, pred(r, v1, v1))}`,
    having: () =>
      `SELECT ${a}.owner, count(*) AS n FROM ${v1} ${a} GROUP BY ${a}.owner HAVING count(*) > ${Math.floor(r() * 40)}`,
    "dialect-list": () =>
      dialect === "duckdb"
        ? `SELECT owner, archive_id, unnest(models) AS m FROM sessions${where("sessions", "sessions")}`
        : `SELECT s.owner, s.archive_id, j.value AS m FROM sessions s, json_each(s.models) j${where("sessions", "s")}`,
  };
  const name = pick(r, Object.keys(forms));
  return { how: [name], from: "generated", sql: (forms[name] as () => string)() };
}

// --- Running and judging -------------------------------------------------------------------

export type FuzzOutcome = { result: SqlResult } | { error: unknown };

export async function runFuzz(
  service: SqlService,
  caller: SqlCaller,
  sql: string,
): Promise<FuzzOutcome> {
  try {
    return { result: await service.query(caller, { sql }) };
  } catch (error) {
    return { error };
  }
}

function json(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

/** An outcome as text, everything in it: what no marker may appear in. */
export function outcomeText(outcome: FuzzOutcome): string {
  if ("result" in outcome) return json(outcome.result);
  const e = outcome.error as Error & { kind?: string; code?: string };
  return json({ name: e?.name, kind: e?.kind, code: e?.code, message: e?.message });
}

/** An outcome's class: `ok`, or the error's kind (`refused`, `bind`, `runtime`, `timeout`…). */
export function outcomeClass(outcome: FuzzOutcome): string {
  if ("result" in outcome) return "ok";
  return outcome.error instanceof SqlFailed
    ? outcome.error.kind
    : `${(outcome.error as Error)?.name ?? "error"}`;
}

/** A row, with floats rounded: DuckDB's parallel sums need not add in the same order twice. */
function normalRow(row: readonly unknown[]): string {
  return json(
    row.map((v) => (typeof v === "number" && !Number.isInteger(v) ? Number(v.toPrecision(9)) : v)),
  );
}

/** The rows as a multiset: order does not count unless the statement fixes it. */
function rowBag(result: SqlResult): string[] {
  return result.rows.map(normalRow).sort();
}

/** Statements whose answer the reference need not repeat: sampled, random, or cut by a
 * `LIMIT` that may keep other rows of a tie. */
const NONDETERMINISTIC =
  /\b(limit|sample|tablesample|random|randomblob|uuid|gen_random_uuid|setseed|current_timestamp|now|any_value|arbitrary|first|last|string_agg|group_concat|list|array_agg|json_group_array|rowid|_rowid|offset)\b/i;

export type FuzzFindingKind =
  /** A decoy's marker, or the other member's private text, in an answer. */
  | "marker"
  /** An `owner`/`archive_id` pair the caller may not see. */
  | "pair"
  /** The answer differs from the one over only what the caller may see. */
  | "rows"
  /** One run failed and the other answered: an error raised by a row the caller may not see,
   * or a statement the views treat otherwise than the reference's. */
  | "outcome"
  /** The check accepted a statement the engine cannot parse. */
  | "parse";

export interface FuzzFinding extends FuzzMutation {
  kind: FuzzFindingKind;
  engine: SqlDialect;
  caller: FuzzCallerName;
  /** The run (`seed`, `iteration`) that made the statement. */
  seed: number;
  iteration: number;
  detail: string;
}

/** What the check and a `prepare` make of a statement. */
export type FuzzCheckVerdict = "refused" | "prepared" | "bind" | { parse: string };

export interface FuzzEngine {
  dialect: SqlDialect;
  /** Paths a mutation may swap in for a table: the decoys and the index's own files. */
  paths: readonly string[];
  /** The fixture index, and the reference indexes holding only what each caller sees. */
  full: SqlService;
  reference: Readonly<Record<FuzzCallerName, SqlService>>;
  /** The engine's statement check, then a `prepare` of what it accepted. */
  checkThenPrepare(sql: string): Promise<FuzzCheckVerdict>;
  /** The fixture's "now", which the default window ends at. */
  now: number;
}

export interface FuzzOptions {
  seed: number;
  /** Statements per stream (corpus mutations, generated probes). */
  count: number;
  log?: (line: string) => void;
}

export interface FuzzSummary {
  statements: number;
  /** Outcome classes over the fixture index, by caller: how much of what was made ran. */
  classes: Record<string, number>;
  findings: FuzzFinding[];
}

/** Statements run at once: two, as a pool takes two queries per caller at a time. */
const FUZZ_PARALLEL = 2;

type FuzzBase = Pick<FuzzFinding, "engine" | "seed" | "iteration">;

/** Judge one statement as one caller; push what it finds. */
async function judge(
  engine: FuzzEngine,
  m: FuzzMutation,
  callerName: FuzzCallerName,
  base: FuzzBase,
  classes: Record<string, number>,
  findings: FuzzFinding[],
): Promise<void> {
  const caller = FUZZ_CALLERS[callerName];
  const found = (kind: FuzzFindingKind, detail: string) =>
    findings.push({ ...base, ...m, caller: callerName, kind, detail });

  const full = await runFuzz(engine.full, caller, m.sql);
  const cls = outcomeClass(full);
  classes[`${callerName}:${cls}`] = (classes[`${callerName}:${cls}`] ?? 0) + 1;
  const text = outcomeText(full);
  if (text.includes(DECOY_MARKER)) found("marker", `a decoy's marker: ${text.slice(0, 500)}`);
  if (callerName === "member" && text.includes(SECRET_MARKER)) {
    found("marker", `bob's private text: ${text.slice(0, 500)}`);
  }

  if ("result" in full) {
    const { result } = full;
    const owner = result.columns.findIndex((c) => c.name === "owner");
    const archive = result.columns.findIndex((c) => c.name === "archive_id");
    if (owner !== -1 && archive !== -1) {
      const visible = visiblePairs(
        caller.viewer,
        sqlWindow({ since: null, until: null }, engine.now),
      );
      const out = result.rows
        .map((row) => `${row[owner]}/${row[archive]}`)
        .filter((pair) => pair !== "null/null" && !visible.has(pair));
      if (out.length > 0) found("pair", `out of scope: ${[...new Set(out)].join(", ")}`);
    }
  }

  // Refused and unparsed statements answer the same anywhere; only what ran is compared.
  if (cls === "refused" || cls === "bind") return;
  const reference = await runFuzz(engine.reference[callerName], HOSTILE_ADMIN, m.sql);
  const refCls = outcomeClass(reference);
  const resource = new Set(["timeout", "memory", "internal", "SqlBusy"]);
  if (resource.has(cls) || resource.has(refCls)) return;
  if (cls !== refCls) {
    found(
      "outcome",
      `fixture: ${text.slice(0, 300)}; reference: ${outcomeText(reference).slice(0, 300)}`,
    );
    return;
  }
  if (!("result" in full) || !("result" in reference)) return;
  if (full.result.truncated || reference.result.truncated) return;
  if (NONDETERMINISTIC.test(m.sql)) return;
  const got = rowBag(full.result);
  const want = rowBag(reference.result);
  if (json(got) !== json(want)) {
    const extra = got.filter((row) => !want.includes(row)).slice(0, 5);
    const missing = want.filter((row) => !got.includes(row)).slice(0, 5);
    found(
      "rows",
      `${got.length} rows, the reference ${want.length}; only in the answer: ${extra.join(" ")}; only in the reference: ${missing.join(" ")}`.slice(
        0,
        1000,
      ),
    );
  }
}

/** Run the fuzzer: `count` corpus mutations and `count` generated probes, each as a member and
 * as an admin, held to the checks above. */
export async function fuzzSql(engine: FuzzEngine, options: FuzzOptions): Promise<FuzzSummary> {
  const r = fuzzRandom(options.seed);
  const corpus = fuzzCorpus(engine.dialect);
  const findings: FuzzFinding[] = [];
  const classes: Record<string, number> = {};
  const total = options.count * 2;
  for (let i = 0; i < total; i += FUZZ_PARALLEL) {
    // Made in order, so a seed makes the same statements; run FUZZ_PARALLEL at a time, each as
    // both callers at once (a pool takes two queries per caller).
    const batch: { m: FuzzMutation; base: FuzzBase }[] = [];
    for (let j = i; j < Math.min(i + FUZZ_PARALLEL, total); j++) {
      const m =
        j % 2 === 0
          ? mutateCorpus(r, engine.dialect, engine.paths, corpus)
          : generateProbe(r, engine.dialect);
      batch.push({ m, base: { engine: engine.dialect, seed: options.seed, iteration: j } });
    }
    for (const { m, base } of batch) {
      const verdict = await engine.checkThenPrepare(m.sql);
      if (typeof verdict === "object") {
        findings.push({ ...base, ...m, caller: "admin", kind: "parse", detail: verdict.parse });
      }
    }
    await Promise.all(
      batch.flatMap(({ m, base }) =>
        (["member", "admin"] as const).map((caller) =>
          judge(engine, m, caller, base, classes, findings),
        ),
      ),
    );
    if (options.log && Math.floor((i + batch.length) / 500) > Math.floor(i / 500)) {
      options.log(`${engine.dialect}: ${i + batch.length} statements, ${findings.length} findings`);
    }
  }
  return { statements: total, classes, findings };
}

/** Read `SESHI_SQL_FUZZ_SEED` and `SESHI_SQL_FUZZ_COUNT` (statements per stream; a fresh seed
 * and the engine's `count` by default). The seed is in every finding, so a run can be repeated. */
export function fuzzOptionsFromEnv(
  count: number,
  env: Record<string, string | undefined> = process.env,
): FuzzOptions {
  const options = {
    seed: env.SESHI_SQL_FUZZ_SEED
      ? Number(env.SESHI_SQL_FUZZ_SEED)
      : Math.floor(Math.random() * 2 ** 31),
    count: env.SESHI_SQL_FUZZ_COUNT ? Number(env.SESHI_SQL_FUZZ_COUNT) : count,
  };
  if (
    !Number.isSafeInteger(options.seed) ||
    !Number.isSafeInteger(options.count) ||
    options.count < 0
  ) {
    throw new Error("SESHI_SQL_FUZZ_SEED and SESHI_SQL_FUZZ_COUNT are whole numbers");
  }
  return options;
}

/** Whether `bun run test:sql-fuzz` asked for the fuzzer: it never runs in `bun run test`. */
export const FUZZ_ENABLED = process.env.SESHI_SQL_FUZZ === "1";

const COMMENT = "(?:/\\*[\\s\\S]*?\\*/|--[^\\n]*\\n)";
/** Words in order with only whitespace and comments between them, any case. */
const gapped = (...words: string[]) => new RegExp(words.join(`(?:\\s|${COMMENT})*`), "i");

/** A finding the fuzzer makes and that is written down rather than fixed: the class of
 * statement (`sql` and `detail` match it) and the hostile-corpus case that pins it, whose `why`
 * says why it stands. */
export interface KnownFinding {
  kind: FuzzFindingKind;
  engine?: SqlDialect;
  caller?: FuzzCallerName;
  sql: RegExp;
  detail?: RegExp;
  /** The corpus case that pins it (`sql-hostile.jsonl`). */
  pinned: string;
}

/** What the fuzzer finds that is known and written down. */
export const FUZZ_KNOWN: readonly KnownFinding[] = [
  // SQLite tests the statement's WHERE before the views' scope: an error only a hidden row
  // raises reaches a member. Members are refused on SQLite (T11).
  {
    kind: "outcome",
    engine: "sqlite",
    caller: "member",
    sql: /[\s\S]/,
    detail: /^fixture: \{"name":"SqlFailed","kind":"runtime"/,
    pinned: "errors-8",
  },
  // The check's parser takes what SQLite cannot parse: refused by SQLite, the safe way round.
  { kind: "parse", engine: "sqlite", sql: gapped("\\bGROUP", "BY", "ALL\\b"), pinned: "errors-6" },
  { kind: "parse", engine: "sqlite", sql: /\w\([^()]*\)\.\w/, pinned: "errors-9" },
  // A comment where SQLite looks ahead to tell WINDOW, OVER and FILTER from identifiers.
  {
    kind: "parse",
    engine: "sqlite",
    sql: gapped("\\bWINDOW\\s+\\w+", COMMENT),
    pinned: "lexing-15",
  },
  { kind: "parse", engine: "sqlite", sql: gapped("\\bFILTER", COMMENT), pinned: "lexing-16" },
  { kind: "parse", engine: "sqlite", sql: gapped("\\bOVER", COMMENT), pinned: "lexing-17" },
];

/** The findings no known one explains: what fails the run. */
export function unexplainedFindings(findings: readonly FuzzFinding[]): FuzzFinding[] {
  return findings.filter(
    (f) =>
      !FUZZ_KNOWN.some(
        (k) =>
          k.kind === f.kind &&
          (k.engine === undefined || k.engine === f.engine) &&
          (k.caller === undefined || k.caller === f.caller) &&
          k.sql.test(f.sql) &&
          (k.detail === undefined || k.detail.test(f.detail)),
      ),
  );
}

/** Say what a run did, and write every finding to `$SESHI_SQL_FUZZ_REPORT/sql-fuzz-<engine>.jsonl`
 * when that folder is set (the nightly job keeps it). */
export function reportFuzz(
  dialect: SqlDialect,
  options: { seed: number; count: number },
  summary: FuzzSummary,
): void {
  const byKind: Record<string, number> = {};
  for (const f of summary.findings) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
  const known = summary.findings.length - unexplainedFindings(summary.findings).length;
  console.log(
    `sql fuzz on ${dialect}: seed ${options.seed}, ${summary.statements} statements; outcomes ${json(summary.classes)}; findings ${json(byKind)} (${known} known)`,
  );
  const folder = process.env.SESHI_SQL_FUZZ_REPORT;
  if (folder) {
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, `sql-fuzz-${dialect}.jsonl`),
      summary.findings.map((f) => json(f)).join("\n") + (summary.findings.length ? "\n" : ""),
    );
    writeFileSync(
      join(folder, `sql-fuzz-${dialect}.summary.json`),
      `${JSON.stringify({ ...options, statements: summary.statements, outcomes: summary.classes, findings: byKind, known }, null, 2)}\n`,
    );
  }
}
