import { randomBytes } from "node:crypto";
import type { ServerConfig } from "@seshi/config";
import { type Instance, sqlCredentialAccess } from "@seshi/instance";
import {
  LOCAL_VIEWER,
  SearchUnavailable,
  type SqlCaller,
  SqlFailed,
  type SqlPoolStatus,
  SqlUnavailable,
} from "@seshi/search";
import { sqlBackend } from "@seshi/search/backends";
import { AccessDenied, openStore, type Store } from "@seshi/store";
import { poolLine, type ServerPool, serverPoolText } from "./pool";
import type { CheckResult } from "./types";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The statement `seshi doctor` runs: it starts a worker, which loads DuckDB's `lance`
 * extension and reads the index with the workers' credential. */
export const SQL_PROBE = "SELECT count(*) AS sessions FROM sessions";

/** Opening the Lance tables over a wide-area network takes seconds (docs/seshi/
 * session-tools-measure); a worker that never answers takes this long to say so. */
const PROBE_TIMEOUT_MS = 60_000;

const DOCTOR: SqlCaller = {
  viewer: LOCAL_VIEWER,
  as: "seshi doctor",
  role: "local",
  key: "doctor",
};

export interface SqlCheckOptions {
  env: Readonly<Record<string, string | undefined>>;
  timeoutMs?: number;
  /** Where the read-only credential's write probe goes: the index's location, reached with
   * `[search.sql.storage]` alone, by default. */
  probeStore?: () => Store;
  /** A running server's workers (`--server`), read from its `GET /v1/admin/jobs`. */
  server?: () => Promise<ServerPool>;
}

class TimedOut extends Error {}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimedOut()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** What `seshi search --status` says of sql. */
export interface SqlStatus {
  /** What answers it here: SQLite, DuckDB, or nothing (a LanceDB index in a build without
   * DuckDB, which answers 501). */
  engine: "sqlite" | "duckdb" | "unavailable";
  /** A LanceDB index in a bucket: whether the workers hold `[search.sql.storage]` or the
   * index's own credential, which can write. */
  credential?: "read-only" | "index";
  /** The server asked for its workers (`--server`). Each server process starts its own with
   * its first statement, so a process like this one, which answers none, has none. */
  server?: string;
  /** That server's workers: null before its first statement. */
  workers?: SqlPoolStatus | null;
  /** Why the server's workers could not be read. */
  workers_error?: string;
}

/** `server`: what a running server said of its workers, when `--server` named one. */
export function sqlStatus(instance: Instance, server?: ServerPool): SqlStatus | undefined {
  if (!instance.sql || !instance.search) return undefined;
  const config = instance.config;
  const asked = server
    ? {
        server: server.server,
        ...(server.workers !== undefined ? { workers: server.workers } : {}),
        ...(server.error !== undefined ? { workers_error: server.error } : {}),
      }
    : {};
  if (config.search.backend !== "lance") return { engine: "sqlite", ...asked };
  if (sqlBackend() === undefined) return { engine: "unavailable", ...asked };
  const url = config.search.lance.uri ?? config.store.url;
  const folder = url.startsWith("/") || url.startsWith("file:");
  return {
    engine: "duckdb",
    ...(folder ? {} : { credential: config.search.sql.storage ? "read-only" : "index" }),
    ...asked,
  };
}

/** `where`: a server config, whose workers a running server holds (`--server` reads them), or
 * a serverless laptop, where each process that answers sql starts its own. */
export function sqlStatusLines(sql: SqlStatus, where: "server" | "laptop" = "server"): string[] {
  const engine =
    sql.engine === "sqlite"
      ? "sql: SQLite, in worker processes"
      : sql.engine === "unavailable"
        ? "sql: not in this build, which answers 501 (the seshi-server-sql build and the -sql image carry DuckDB)"
        : `sql: DuckDB over the Lance tables, in worker processes${
            sql.credential === "read-only"
              ? " holding [search.sql.storage] (read-only)"
              : sql.credential === "index"
                ? " holding the index's own credential, which can write: set [search.sql.storage]"
                : ""
          }`;
  if (sql.engine === "unavailable") return [engine];
  if (sql.server !== undefined) {
    return [
      engine,
      sql.workers_error !== undefined
        ? `sql workers on ${sql.server}: could not ask: ${sql.workers_error}`
        : `sql workers on ${sql.server}: ${serverPoolText(sql.workers ?? null)}`,
    ];
  }
  if (where === "laptop") return [engine];
  return [
    engine,
    "sql workers: a running server holds them: add --server <url> to ask it (seshi workers status --server <url> shows them too)",
  ];
}

const EXTENSION_HINT =
  "the seshi-server-sql archives and the -sql image put DuckDB's library and its lance extension in duckdb/ beside the binary; [search.sql] extensions names another folder for the extension";

/** `seshi doctor --config`'s sql checks: a statement runs (on LanceDB: DuckDB's `lance`
 * extension loads and the workers' credential reads the index), the read-only credential
 * cannot write the index's location, and the workers that ran it. */
export async function sqlServerChecks(
  instance: Instance,
  config: ServerConfig,
  options: SqlCheckOptions,
): Promise<CheckResult[]> {
  const sql = instance.sql;
  if (!sql || !instance.search) return [];
  const lance = config.search.backend === "lance";
  if (lance && sqlBackend() === undefined) {
    return [
      {
        id: "sql",
        title: "SQL",
        status: "skip",
        summary:
          "not in this build: sql on a LanceDB index answers 501 (the seshi-server-sql build and the -sql image carry DuckDB)",
      },
    ];
  }

  const checks: CheckResult[] = [];
  const started = performance.now();
  let read = false;
  try {
    const result = await within(
      sql.query(DOCTOR, { sql: SQL_PROBE }),
      options.timeoutMs ?? PROBE_TIMEOUT_MS,
    );
    read = true;
    const ms = Math.round(performance.now() - started);
    const sessions = result.rows[0]?.[0];
    checks.push({
      id: "sql",
      title: "SQL",
      status: "ok",
      summary: lance
        ? `DuckDB read the LanceDB index in ${ms} ms (${sessions} sessions)`
        : `SQLite read the index in ${ms} ms (${sessions} sessions)`,
      ...(lance
        ? {
            detail: [
              `lance extension from ${config.search.sql.extensions ?? "duckdb/ beside the binary"}`,
            ],
          }
        : {}),
    });
  } catch (err) {
    checks.push(probeFailure(err, lance, sql.status()));
  }

  if (lance) {
    const credential = await credentialCheck(instance, config, options, read);
    if (credential) checks.push(credential);
  }

  const pool = sql.status();
  if (pool) {
    checks.push({
      id: "sql-workers",
      title: "SQL workers",
      status: pool.restarts > 0 ? "warn" : "ok",
      summary: `this check's: ${poolLine(pool)}`,
      ...(pool.restarts > 0 ? { hint: RESTART_HINT } : {}),
    });
  }
  if (options.server) checks.push(serverPoolCheck(await options.server()));
  return checks;
}

const RESTART_HINT =
  "a worker exited or was killed while answering one statement: see the warnings above, and [search.sql] worker_memory";

/** The running server's workers, as `--server` read them. */
export function serverPoolCheck(asked: ServerPool): CheckResult {
  const base = { id: "sql-server-workers", title: "Server's SQL workers" } as const;
  if (asked.error !== undefined) {
    return {
      ...base,
      status: "warn",
      summary: `could not ask ${asked.server}: ${asked.error}`,
      hint: "GET /v1/admin/jobs takes an admin's credential: seshi login --server <url> as an admin",
    };
  }
  const pool = asked.workers ?? null;
  const restarted = pool !== null && pool.restarts > 0;
  return {
    ...base,
    status: restarted ? "warn" : "ok",
    summary: `${asked.server}: ${serverPoolText(pool)}`,
    ...(restarted ? { hint: RESTART_HINT } : {}),
  };
}

function probeFailure(err: unknown, lance: boolean, pool: SqlPoolStatus | undefined): CheckResult {
  const base = { id: "sql", title: "SQL" } as const;
  if (err instanceof SearchUnavailable) {
    return { ...base, status: "warn", summary: `could not be tried yet: ${err.message}` };
  }
  if (err instanceof TimedOut) {
    return {
      ...base,
      status: "fail",
      summary: `no sql worker answered within ${Math.round(PROBE_TIMEOUT_MS / 1000)} s`,
      ...(pool ? { detail: [`workers: ${poolLine(pool)}`] } : {}),
      hint: lance
        ? `a worker that cannot load DuckDB exits at once and is started again: run seshi sql-worker by hand to see why. ${EXTENSION_HINT}`
        : "run seshi sql-worker by hand to see why a worker does not start",
    };
  }
  const unavailable =
    err instanceof SqlUnavailable || (err instanceof SqlFailed && err.kind === "unavailable");
  if (lance && unavailable) {
    return {
      ...base,
      status: "fail",
      summary: `DuckDB's lance extension did not load: ${message(err)}`,
      hint: EXTENSION_HINT,
    };
  }
  if (lance && err instanceof SqlFailed && err.kind === "runtime") {
    return {
      ...base,
      status: "fail",
      summary: `the sql workers could not read the index: ${message(err)}`,
      hint: "[search.sql.storage] needs read and list on the index's prefix (docs/search.md, sql on a LanceDB index)",
    };
  }
  return { ...base, status: "fail", summary: `${SQL_PROBE} failed: ${message(err)}` };
}

/** The workers' credential: none to narrow on a folder; the index's own (which can write) when
 * `[search.sql.storage]` is not set; else it must be refused a write where the index lives. */
async function credentialCheck(
  instance: Instance,
  config: ServerConfig,
  options: SqlCheckOptions,
  read: boolean,
): Promise<CheckResult | undefined> {
  const id = "sql-credential";
  const title = "SQL credential";
  const access = sqlCredentialAccess(config, instance.deployment, options.env);
  if (access === undefined && config.search.sql.storage === undefined) {
    const url = config.search.lance.uri ?? config.store.url;
    if (url.startsWith("/") || url.startsWith("file:")) return undefined;
    return {
      id,
      title,
      status: "warn",
      summary:
        "[search.sql.storage] is not set: the sql workers read the index with its own credential, which can write",
      hint: "give them a read-only credential on the index's prefix (docs/search.md, sql on a LanceDB index); members = true needs one",
    };
  }
  if (access === undefined) return undefined;
  const store = options.probeStore?.() ?? openStore(access.url, access.options).store;
  const key = `.seshi-doctor-${randomBytes(6).toString("hex")}`;
  try {
    await store.put(key, new TextEncoder().encode("seshi doctor\n"));
  } catch (err) {
    if (err instanceof AccessDenied) {
      return {
        id,
        title,
        status: read ? "ok" : "fail",
        summary: read
          ? "[search.sql.storage] reads the index and cannot write where it lives"
          : "[search.sql.storage] cannot write where the index lives, and could not read it either (above)",
      };
    }
    return {
      id,
      title,
      status: "warn",
      summary: `could not tell whether [search.sql.storage] can write where the index lives: ${message(err)}`,
    };
  }
  await store.delete(key).catch(() => undefined);
  return {
    id,
    title,
    status: "fail",
    summary: "[search.sql.storage] can write where the index lives: it must be read-only",
    hint: "DuckDB's lance extension does not honour DuckDB's own lock-down, so this credential is what keeps a statement from writing: narrow it to read and list on the index's prefix (docs/search.md)",
  };
}
