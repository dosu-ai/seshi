/** OpenCode's own database, read by the sweep (`seshi upload --since`, the uploader's sweep) for
 * the sessions seshi's plugin never handed over (from before install, or a run without the
 * plugin), and by `seshi hook opencode Stop` for OpenCode 2.x, whose plugin names only the
 * session. Loaded lazily: `seshi hook` loads it only for a captured 2.x session.
 *
 * The database is opened read-only, so a running OpenCode is not disturbed, and seshi never runs
 * OpenCode's CLI for it (its export may start OpenCode's service). Which OpenCode wrote it is told
 * from the tables there, never from a version string:
 *
 * - `session` + `message` + `part`: OpenCode 1.x.
 * - `session_v2` + `session_message` (+ `session_part` from 2.2.2): OpenCode 2.x.
 * - both: OpenCode 2.x opened a 1.x database and copied its sessions over once, under the same
 *   ids, keeping only each message's last step of usage. A session in both is read from 2.x's
 *   copy when it went on there (it holds newer messages), else from 1.x's, which is whole.
 * - `session` + `session_message` alone: an early 2.x preview database, which OpenCode 2.x
 *   imports itself. Refused, as is anything else, saying why.
 *
 * Every session is rebuilt in 1.x's export shape (`./db-export.ts`). */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { CaptureHost, StoredSession } from "@seshi/kit";
import { opencodeDataDir } from "./capture";
import { directoryOf, exportV1, exportV2, type Row, text } from "./db-export";

/** The columns seshi reads by name, per table. */
const V1_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  session: ["id", "parent_id", "directory", "time_created", "time_updated"],
  message: ["id", "session_id", "time_created", "time_updated", "data"],
  part: ["id", "message_id", "session_id", "time_updated", "data"],
};
const V2_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  session_v2: ["id", "parent_id", "directory", "time_created", "time_updated"],
  session_message: ["id", "session_id", "type", "seq", "time_created", "time_updated", "data"],
};
const PART_COLUMNS = ["message_id", "session_id", "ordinal", "time_updated", "data"];

/** OpenCode's release channels that keep `opencode.db`; another channel keeps
 * `opencode-<channel>.db` (2.x's rule). */
const SHARED_CHANNELS = ["latest", "dev", "beta", "next", "prod"];

/** The database OpenCode uses here: `$OPENCODE_DB` (a path, or a name in OpenCode's data folder),
 * else, in its data folder (`$XDG_DATA_HOME/opencode`, else `~/.local/share/opencode`),
 * `opencode-<channel>.db` for a `channel` that keeps its own, else `opencode.db`. Undefined when
 * there is none. */
export function opencodeDatabase(host: CaptureHost, channel?: string): string | undefined {
  const configured = host.env.OPENCODE_DB;
  if (configured === ":memory:") return undefined;
  const data = opencodeDataDir(host);
  const name =
    configured ??
    (channel && !SHARED_CHANNELS.includes(channel)
      ? `opencode-${channel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`
      : "opencode.db");
  const path = isAbsolute(name) ? name : join(data, name);
  return existsSync(path) ? path : undefined;
}

interface Opened {
  db: Database;
  v1: boolean;
  v2: boolean;
  /** Whether 2.x's `session_part` table is there. */
  parts: boolean;
}

function columnsOf(db: Database, table: string): Set<string> {
  return new Set(
    db
      .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${table}')`)
      .all()
      .map((c) => c.name),
  );
}

function refused(path: string, why: string): Error {
  return new Error(
    `${path} is not an OpenCode database seshi can read (${why}); seshi reads OpenCode 1.x's session, message and part tables and 2.x's session_v2 and session_message`,
  );
}

function missing(db: Database, wanted: Readonly<Record<string, readonly string[]>>): string[] {
  return Object.entries(wanted).flatMap(([table, columns]) => {
    const have = columnsOf(db, table);
    return columns.filter((c) => !have.has(c)).map((c) => `${table}.${c}`);
  });
}

function open(path: string): Opened {
  const db = new Database(path, { readonly: true });
  try {
    db.run("PRAGMA busy_timeout = 2000");
    const tables = new Set(
      db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((t) => t.name),
    );
    const v2 = tables.has("session_v2");
    const v1 = tables.has("session") && tables.has("message") && tables.has("part");
    if (!v1 && !v2) {
      throw refused(
        path,
        tables.has("session") && tables.has("session_message")
          ? "an early OpenCode 2.x preview database, which OpenCode 2.x imports itself"
          : "no session or session_v2 table",
      );
    }
    const gaps = [...(v1 ? missing(db, V1_COLUMNS) : []), ...(v2 ? missing(db, V2_COLUMNS) : [])];
    const parts = v2 && tables.has("session_part");
    if (parts) gaps.push(...missing(db, { session_part: PART_COLUMNS }));
    if (gaps.length > 0) throw refused(path, `no ${gaps.join(", ")}`);
    return { db, v1, v2, parts };
  } catch (err) {
    db.close();
    throw err;
  }
}

/** A session as listed: which copy holds it, when it last changed, and its newest message. */
interface Listed {
  id: string;
  parent_id: string | null;
  directory: string;
  time_created: number;
  changed: number;
  newest: number;
  copy: "v1" | "v2";
}

function listV1(db: Database, sinceMs: number, id?: string): Listed[] {
  return db
    .query<Listed, [number, ...string[]]>(
      `SELECT id, parent_id, directory, time_created, changed, newest, 'v1' AS copy FROM (
         SELECT s.id, s.parent_id, s.directory, s.time_created,
           max(s.time_updated,
               coalesce((SELECT max(m.time_updated) FROM message m WHERE m.session_id = s.id), 0),
               coalesce((SELECT max(p.time_updated) FROM part p WHERE p.session_id = s.id), 0)
           ) AS changed,
           (SELECT max(m.time_created) FROM message m WHERE m.session_id = s.id) AS newest
         FROM session s
         WHERE EXISTS (SELECT 1 FROM message m WHERE m.session_id = s.id)${id ? " AND s.id = ?2" : ""}
       ) WHERE changed >= ?1 ORDER BY time_created, id`,
    )
    .all(sinceMs, ...(id ? [id] : []));
}

/** Only rows a person or the model wrote make a 2.x session worth sending. */
const SPOKEN = "m.type IN ('user', 'assistant')";

function listV2(db: Database, parts: boolean, sinceMs: number, id?: string): Listed[] {
  const partChanged = parts
    ? ",\n coalesce((SELECT max(p.time_updated) FROM session_part p WHERE p.session_id = s.id), 0)"
    : "";
  return db
    .query<Listed, [number, ...string[]]>(
      `SELECT id, parent_id, directory, time_created, changed, newest, 'v2' AS copy FROM (
         SELECT s.id, s.parent_id, s.directory, s.time_created,
           max(s.time_updated,
               coalesce((SELECT max(m.time_updated) FROM session_message m WHERE m.session_id = s.id), 0)${partChanged}
           ) AS changed,
           (SELECT max(m.time_created) FROM session_message m WHERE m.session_id = s.id AND ${SPOKEN}) AS newest
         FROM session_v2 s
         WHERE EXISTS (SELECT 1 FROM session_message m WHERE m.session_id = s.id AND ${SPOKEN})${id ? " AND s.id = ?2" : ""}
       ) WHERE changed >= ?1 ORDER BY time_created, id`,
    )
    .all(sinceMs, ...(id ? [id] : []));
}

/** Every session changed at or after `sinceMs` (or only `id`), one copy each. */
function list(opened: Opened, sinceMs: number, id?: string): Listed[] {
  const v1 = opened.v1 ? listV1(opened.db, sinceMs, id) : [];
  if (!opened.v2) return v1;
  const v2 = listV2(opened.db, opened.parts, sinceMs, id);
  const byId = new Map(v1.map((s) => [s.id, s]));
  for (const session of v2) {
    const old = byId.get(session.id);
    // 2.x's copy of a 1.x session is lossy: read it only when the session went on in 2.x.
    if (!old || session.newest > old.newest) byId.set(session.id, session);
  }
  return [...byId.values()].sort(
    (a, b) => a.time_created - b.time_created || (a.id < b.id ? -1 : 1),
  );
}

function exportOf(opened: Opened, session: Listed, host: CaptureHost): string {
  return session.copy === "v2"
    ? exportV2(opened.db, session.id, host, opened.parts)
    : exportV1(opened.db, session.id, host);
}

/** Read `session`'s export in one read transaction, from the database at `path`. */
function readExport(path: string, session: Listed, host: CaptureHost): string {
  const opened = open(path);
  try {
    return opened.db.transaction(() => exportOf(opened, session, host))();
  } finally {
    opened.db.close();
  }
}

/** `value` with every object's keys sorted. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sorted((value as Row)[key])]),
  );
}

/** Whether two exports hold the same session: the plugin's copy has OpenCode's server's key
 * order and the time it was handed over, and the session's `time.updated` moves on after a turn
 * (its title, its summary) without anything new to send. */
function sameSession(a: string, b: string): boolean {
  try {
    const [x, y] = [JSON.parse(a), JSON.parse(b)];
    for (const doc of [x, y]) delete doc?.info?.time?.updated;
    return JSON.stringify(sorted(x)) === JSON.stringify(sorted(y));
  } catch {
    return false;
  }
}

/** OpenCode's sessions with at least one message that changed (the session, a message or a part)
 * at or after `sinceMs`. None when OpenCode keeps no database here. */
export function storedOpencodeSessions(host: CaptureHost, sinceMs: number): StoredSession[] {
  const path = opencodeDatabase(host);
  if (!path) return [];
  const opened = open(path);
  let sessions: Listed[];
  try {
    sessions = list(opened, sinceMs);
  } finally {
    opened.db.close();
  }
  return sessions.map((session) => {
    const cwd = directoryOf(session as unknown as Row, host);
    const parent = text(session.parent_id);
    return {
      info: {
        session_id: session.id,
        ...(cwd ? { cwd } : {}),
        started_at: new Date(session.time_created).toISOString(),
        ...(parent ? { parent_session_id: parent } : {}),
      },
      updatedMs: session.changed,
      transcript: (copy?: string) => {
        const text = readExport(path, session, host);
        return copy !== undefined && sameSession(copy, text) ? copy : text;
      },
    };
  });
}

/** One session's export and when it last changed, for `seshi hook opencode Stop` from a plugin
 * that names only the session (OpenCode 2.x's). `channel` is the OpenCode release channel the
 * plugin ran in, which says which database file it keeps. */
export function readOpencodeSession(
  host: CaptureHost,
  id: string,
  channel?: string,
): { transcript: string; changedMs: number } {
  const path = opencodeDatabase(host, channel);
  if (!path) throw new Error(`no OpenCode database here to read session ${id} from`);
  const opened = open(path);
  try {
    return opened.db.transaction(() => {
      const [session] = list(opened, 0, id);
      if (!session) throw new Error(`OpenCode session ${id} has no messages in ${path} yet`);
      return { transcript: exportOf(opened, session, host), changedMs: session.changed };
    })();
  } finally {
    opened.db.close();
  }
}
