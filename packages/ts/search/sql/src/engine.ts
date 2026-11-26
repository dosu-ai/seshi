import { dirname, join } from "node:path";
import { type DuckDBConnection, DuckDBInstance, type DuckDBType } from "@duckdb/node-api";
import {
  type DuckdbRequest,
  type SqlColumnInfo,
  type SqlEngine,
  type SqlErrorKind,
  SqlRefused,
  type SqlWorkerResponse,
  sqlString,
} from "@seshi/search";
import { checkDuckdb, SqlUnparsed } from "./check-duckdb";
import { DUCKDB_EXTENSIONS_ENV, SQL_STORAGE_ENV } from "./env";

/** Where DuckDB looks for its `lance` extension (`<dir>/<version>/<platform>/`): the folder
 * `SESHI_DUCKDB_EXTENSIONS` names, else `duckdb/` beside the binary, where the `-sql` build's
 * archive and image put it. */
export function extensionDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env[DUCKDB_EXTENSIONS_ENV] || join(dirname(process.execPath), "duckdb");
}

class QueryFailed extends Error {
  constructor(
    readonly kind: SqlErrorKind,
    message: string,
  ) {
    super(message);
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The storage options in the worker's environment, as a `TYPE lance` secret's `STORAGE_OPTIONS`
 * map, which the extension hands to Lance's object store as they are. Nothing for a folder
 * index, or one reached with the machine's own credentials (a GCS metadata server). */
function storageSecret(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  const options = JSON.parse(raw) as Record<string, unknown>;
  const entries = Object.entries(options).filter(
    (e): e is [string, string] => typeof e[1] === "string",
  );
  if (entries.length === 0) return undefined;
  const keys = entries.map(([k]) => sqlString(k)).join(", ");
  const values = entries.map(([, v]) => sqlString(v)).join(", ");
  return `CREATE SECRET seshi_index (TYPE lance, PROVIDER config, STORAGE_OPTIONS map([${keys}], [${values}]))`;
}

interface Warm {
  instance: DuckDBInstance;
  connection: DuckDBConnection;
}

/** A value as JSON carries it: integers DuckDB gives as text (`BIGINT`, `HUGEINT`, sums) as
 * numbers when they fit, else text; `DECIMAL` as a number. */
function jsonValue(value: unknown, type: DuckDBType): unknown {
  if (typeof value !== "string") return value;
  const id = type.toString();
  if (/^(U?(BIG|HUGE|TINY|SMALL)?INT(EGER)?|DECIMAL.*)$/.test(id)) {
    const n = Number(value);
    if (Number.isFinite(n) && (!/INT/.test(id) || Number.isSafeInteger(n))) return n;
  }
  return value;
}

/** A column's type as the DDL writes it: `JSON` (an alias DuckDB keeps on a `VARCHAR`), and
 * `TIMESTAMPTZ` for `TIMESTAMP WITH TIME ZONE`. */
export function typeName(type: DuckDBType): string {
  if (type.alias) return type.alias.toUpperCase();
  return type.toString().replace(/\bTIMESTAMP WITH TIME ZONE\b/g, "TIMESTAMPTZ");
}

/** DuckDB for `sql` on a LanceDB index (docs/seshi/session-tools.md, "A DuckDB query"), run
 * inside `seshi sql-worker`. A database serves one query: the configuration lock does not stop
 * `CREATE OR REPLACE VIEW` or `DETACH` (the spike), so none is reused after a caller's
 * statement. */
export class DuckdbEngine implements Omit<SqlEngine, "script"> {
  private warmed: Warm | undefined;
  /** Why the last database could not be made ready (the extension missing): every query is
   * answered `unavailable` with it until one can. */
  private failure: string | undefined;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  /** Open an in-memory database with autoloading, community and unsigned extensions off, and
   * `lance` loaded from the extension folder; give it the storage credential and UTC. Settings
   * that bound a query (memory, threads) and the lock come per query, after the views. */
  async warm(): Promise<void> {
    if (this.warmed !== undefined) return;
    let instance: DuckDBInstance | undefined;
    try {
      instance = await DuckDBInstance.create(":memory:", {
        extension_directory: extensionDirectory(this.env),
        autoinstall_known_extensions: "false",
        autoload_known_extensions: "false",
        allow_community_extensions: "false",
        allow_unsigned_extensions: "false",
        // Nothing spills to disk: a query past memory_limit fails instead.
        temp_directory: "",
      });
      const connection = await instance.connect();
      try {
        await connection.run("LOAD lance");
      } catch (err) {
        throw new Error(
          `DuckDB's lance extension could not be loaded from ${extensionDirectory(this.env)}: ${messageOf(err)}`,
        );
      }
      // Lance's times are UTC; TIMESTAMPTZ shows them so.
      await connection.run("SET TimeZone = 'UTC'");
      const secret = storageSecret(this.env[SQL_STORAGE_ENV]);
      if (secret !== undefined) await connection.run(secret);
      this.warmed = { instance, connection };
      this.failure = undefined;
    } catch (err) {
      instance?.closeSync();
      this.failure = messageOf(err);
    }
  }

  async run(request: DuckdbRequest): Promise<SqlWorkerResponse> {
    const started = performance.now();
    const { id, limits } = request;
    await this.warm();
    const warmed = this.warmed;
    this.warmed = undefined;
    if (warmed === undefined) {
      return {
        id,
        ok: false,
        error: { kind: "unavailable", message: this.failure ?? "DuckDB could not start" },
      };
    }
    const { instance, connection } = warmed;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let interrupted = false;
    try {
      if (limits.memory_bytes !== undefined && limits.memory_bytes > 0) {
        await connection.run(`SET memory_limit = '${Math.floor(limits.memory_bytes)}B'`);
      }
      if (limits.threads !== undefined && limits.threads > 0) {
        await connection.run(`SET threads = ${Math.floor(limits.threads)}`);
      }
      for (const view of request.setup.views) await connection.run(view);
      // The lock-down binds DuckDB's own file system (not lance: the statement check and the
      // credential are its walls). No allowed folder at all, so COPY has nowhere to write.
      await connection.run("SET allowed_directories = []");
      await connection.run("SET allowed_paths = []");
      await connection.run("SET enable_external_access = false");
      await connection.run("SET lock_configuration = true");

      try {
        await checkDuckdb(connection, request.sql);
      } catch (err) {
        if (err instanceof SqlUnparsed) throw new QueryFailed("bind", err.message);
        throw err;
      }
      // prepare() refuses more than one statement, whatever the check said.
      let prepared: Awaited<ReturnType<DuckDBConnection["prepare"]>>;
      try {
        prepared = await connection.prepare(request.sql);
      } catch (err) {
        throw new QueryFailed("bind", messageOf(err));
      }
      timer = setTimeout(() => {
        interrupted = true;
        connection.interrupt();
      }, limits.timeout_ms);
      const want = Math.floor(limits.max_rows) + 1;
      let reader: Awaited<ReturnType<typeof prepared.streamAndReadUntil>>;
      try {
        reader = await prepared.streamAndReadUntil(want);
      } catch (err) {
        const message = messageOf(err);
        if (interrupted || /interrupt/i.test(message)) {
          throw new QueryFailed(
            "timeout",
            `the query ran past ${Math.round(limits.timeout_ms / 100) / 10} s: narrow it, or add LIMIT`,
          );
        }
        if (/out of memory/i.test(message)) throw new QueryFailed("memory", message);
        throw new QueryFailed("runtime", message);
      } finally {
        clearTimeout(timer);
      }
      const types = reader.columnTypes();
      const names = reader.columnNames();
      const raw = reader.getRowsJson();
      let truncated = raw.length > limits.max_rows;
      const rows: unknown[][] = [];
      let bytes = 2;
      for (const row of raw.slice(0, limits.max_rows)) {
        const values = row.map((v, i) => jsonValue(v, types[i] as DuckDBType));
        bytes += Buffer.byteLength(JSON.stringify(values), "utf8") + 1;
        if (bytes > limits.max_bytes) {
          truncated = true;
          break;
        }
        rows.push(values);
      }
      reader.closeSync();
      prepared.destroySync();
      const columns: SqlColumnInfo[] = names.map((name, i) => ({
        name,
        type: typeName(types[i] as DuckDBType),
      }));
      return {
        id,
        ok: true,
        columns,
        rows,
        truncated,
        elapsed_ms: Math.round(performance.now() - started),
      };
    } catch (err) {
      if (err instanceof SqlRefused) {
        return {
          id,
          ok: false,
          error: {
            kind: "refused",
            message: err.message,
            ...(err.at !== undefined ? { at: err.at } : {}),
          },
        };
      }
      if (err instanceof QueryFailed) {
        return { id, ok: false, error: { kind: err.kind, message: err.message } };
      }
      return { id, ok: false, error: { kind: "internal", message: messageOf(err) } };
    } finally {
      clearTimeout(timer);
      connection.closeSync();
      instance.closeSync();
    }
  }
}
