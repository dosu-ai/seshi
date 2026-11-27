// Phase 4 of session-tools.md: how long `sql`'s DuckDB views take over a LanceDB index, on a
// folder and in a bucket. Not product code. Synthetic sessions only: never point it at an index
// holding real ones.
//
//   bun docs/seshi/session-tools-measure/sql-views.ts gen <uri> <sessions>
//   bun docs/seshi/session-tools-measure/sql-views.ts time <uri> [runs]
//
// `time` runs each statement `runs` times on a fresh worker: the first is cold, the rest warm.
// <uri> is a folder or a bucket URI LanceDB takes (gs://, s3://, az://). The worker reads it with
// what SESHI_MEASURE_STORAGE holds (Lance storage options as JSON, e.g.
// {"google_service_account_key": "<key JSON>"}), or for gs:// with Application Default
// Credentials passed as GOOGLE_APPLICATION_CREDENTIALS. Each session has 200 events and 20 model
// calls, across 20 owners; `gen` writes them as the indexer does, one commit per 100 sessions.
import { lanceIndex } from "@seshi/lance";
import type { EventRole } from "@seshi/model";
import {
  type IndexedEvent,
  type IndexedLlmCall,
  type IndexedSession,
  provideSql,
  SQL_EXAMPLES,
  SqlService,
} from "@seshi/search";
import { duckdbSql } from "@seshi/sql";
import { lanceExtensions } from "@seshi/sql/testing";

const [cmd, uri, arg] = process.argv.slice(2);
if (!cmd || !uri) throw new Error("usage: sql-views.ts gen|time <uri> [sessions|runs]");
const storage = JSON.parse(process.env.SESHI_MEASURE_STORAGE ?? "{}") as Record<string, string>;
const H = (n: number) => n.toString(16).padStart(64, "0");
const DAY = 86_400_000;
const NOW = Date.now();
const ROLES: EventRole[] = ["user", "assistant", "tool_call", "tool_result"];

function session(n: number): { s: IndexedSession; events: IndexedEvent[]; calls: IndexedLlmCall[] } {
  const owner = `owner${n % 20}`;
  const started = NOW - (n % 28) * DAY - (n % 600) * 60_000;
  const hash = H(1_000_000 + n);
  const events: IndexedEvent[] = Array.from({ length: 200 }, (_, i) => {
    const role = ROLES[i % 4] as EventRole;
    const text = `${role} ${i} of session ${n}: ${"lorem ipsum dolor ".repeat(10 + (i % 30))}`;
    return {
      content_hash: hash,
      event_index: i,
      seq: i,
      role,
      ...(role.startsWith("tool") ? { tool_name: ["Bash", "Read", "Edit"][i % 3] as string } : {}),
      ...(role === "tool_result" ? { ok: i % 7 !== 0, tool_call_id: `c${i - 1}` } : {}),
      timestamp: started + i * 5_000,
      text,
      chars: text.length,
    };
  });
  const calls: IndexedLlmCall[] = Array.from({ length: 20 }, (_, i) => ({
    content_hash: hash,
    call_id: `m${i}`,
    model: i % 3 === 0 ? "claude-haiku-5-5" : "claude-opus-5-5",
    provider: "anthropic",
    started_at: started + i * 50_000,
    ended_at: started + i * 50_000 + 3_000,
    duration_ms: 3_000,
    input_tokens: 1_000 + i,
    output_tokens: 200 + i,
    total_tokens: 1_200 + 2 * i,
  }));
  return {
    s: {
      owner,
      archive_id: H(n),
      format: "claude-code",
      session_id: `s${n}`,
      repo: `github.com/acme/repo${n % 7}`,
      branch: "main",
      models: ["claude-opus-5-5", "claude-haiku-5-5"],
      labels: { team: n % 2 ? "web" : "core" },
      visibility: n % 5 === 0 ? "owner" : "org",
      started_at: started,
      ended_at: started + 200 * 5_000,
      updated_at: new Date(started + 200 * 5_000).toISOString(),
      traces: [hash],
      event_count: 200,
    },
    events,
    calls,
  };
}

// `gen` writes with the machine's own credentials; `time` only reads, and its workers read with
// SESHI_MEASURE_STORAGE (the read-only credential under test).
const open = () =>
  lanceIndex({
    uri,
    readConsistency: 0,
    readOnly: cmd === "time",
    ...(cmd === "time" && Object.keys(storage).length ? { storageOptions: storage } : {}),
  })({
    deployment: "measure",
    events: ROLES,
  });

if (cmd === "gen") {
  const total = Number(arg ?? 500);
  const index = await open();
  const started = performance.now();
  for (let owner = 0; owner < 20; owner++) {
    const mine = Array.from({ length: total }, (_, n) => n).filter((n) => n % 20 === owner);
    for (let i = 0; i < mine.length; i += 100) {
      await index.commit({
        generation: await index.generation(),
        owner: `owner${owner}`,
        updates: mine.slice(i, i + 100).map((n) => {
          const { s, events, calls } = session(n);
          return { session: s, events, llm_calls: calls, replace: true, read_at: 1 };
        }),
        removals: [],
        feed: [],
        seen: [],
        cursor: undefined,
        forgetBefore: 0,
      });
    }
  }
  await index.passDone(await index.generation(), new Date().toISOString());
  console.log(
    JSON.stringify({ sessions: total, events: total * 200, calls: total * 20, ms: Math.round(performance.now() - started) }),
  );
  await index.close();
  process.exit(0);
}

const index = await open();
const tables = await index.sqlTables?.();
if (!tables) throw new Error("no live generation");
provideSql(duckdbSql);
const extensions = await lanceExtensions();
/** A service with one fresh worker: its first statement is cold (it starts the worker, which
 * loads DuckDB and the lance extension, with nothing of the tables cached), the rest warm (the
 * same worker, which still opens a fresh database, and the tables, for each statement). */
const fresh = () =>
  new SqlService({
    search: {
      status: async () => ({ backend: "lance", location: uri, ready: true, sessions: 0, events: 0 }),
      sqlTables: async () => tables,
    },
    workerEnv: {
      SESHI_DUCKDB_EXTENSIONS: extensions,
      SESHI_SQL_STORAGE: JSON.stringify(storage),
      ...(process.env.GOOGLE_APPLICATION_CREDENTIALS
        ? { GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS }
        : {}),
    },
    settings: { workers: 1, timeout: 300_000 },
  });
const admin = { viewer: { everything: true, own: [], canRead: () => true }, as: "ops", role: "admin", key: "ops" };
const member = {
  viewer: { everything: false, own: ["owner3"], canRead: () => true },
  as: "owner3",
  role: "member",
  key: "owner3",
};
const runs = Number(arg ?? 3);
const statements: [string, string][] = [
  ["count sessions", "SELECT count(*) FROM sessions"],
  ["count events", "SELECT count(*) FROM events"],
  ...SQL_EXAMPLES.duckdb.map((sql, i) => [`example ${i + 1}`, sql] as [string, string]),
];
for (const [as, caller] of [
  ["admin", admin],
  ["member", member],
] as const) {
  for (const [name, sql] of statements) {
    const service = fresh();
    const times: number[] = [];
    let rows = 0;
    for (let i = 0; i < runs; i++) {
      const t = performance.now();
      const result = await service.query(caller, { sql, since: "30d" });
      times.push(Math.round(performance.now() - t));
      rows = result.rows.length;
    }
    await service.close();
    console.log(JSON.stringify({ as, name, rows, cold: times[0], warm: times.slice(1) }));
  }
}
await index.close();
process.exit(0);
