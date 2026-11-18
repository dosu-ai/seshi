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
 *   ids, keeping only each message's last step of usage. A session in both is read from 1.x's
 *   copy, which is whole, and when it went on in 2.x (2.x's copy holds newer messages), with the
 *   messages said since read from 2.x's.
 * - `session` + `session_message` alone: an early 2.x preview database, which OpenCode 2.x
 *   imports itself. Refused, as is anything else, saying why.
 *
 * Every session is rebuilt in 1.x's export shape (`./db-export.ts`). */

import { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
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
 * `opencode-<channel>.db` for a `channel` that keeps its own (unless
 * `$OPENCODE_DISABLE_CHANNEL_DB` says not to), else `opencode.db`. Undefined when there is none. */
export function opencodeDatabase(host: CaptureHost, channel?: string): string | undefined {
  const configured = host.env.OPENCODE_DB;
  if (configured === ":memory:") return undefined;
  const data = opencodeDataDir(host);
  const shared =
    !channel ||
    SHARED_CHANNELS.includes(channel) ||
    ["1", "true"].includes(host.env.OPENCODE_DISABLE_CHANNEL_DB ?? "");
  const name =
    configured ??
    (shared ? "opencode.db" : `opencode-${channel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`);
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

function refused(path: string, why: string, preview = false): Error & { preview: boolean } {
  return Object.assign(
    new Error(
      `${path} is not an OpenCode database seshi can read (${why}); seshi reads OpenCode 1.x's session, message and part tables and 2.x's session_v2 and session_message`,
    ),
    { preview },
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
      const preview = tables.has("session") && tables.has("session_message");
      throw refused(
        path,
        preview
          ? "an early OpenCode 2.x preview database, which OpenCode 2.x imports itself"
          : "no session or session_v2 table",
        preview,
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
  const { db, parts } = opened;
  const v1 = opened.v1 ? listV1(db, sinceMs, id) : [];
  if (!opened.v2) return v1;
  const v2 = listV2(db, parts, sinceMs, id);
  if (!opened.v1) return v2;
  // Which copy a session is read from does not depend on the cutoff: a session whose one copy
  // changed since is weighed against its other copy, changed since or not, and listed only if
  // the copy chosen changed since.
  const one = new Map(v1.map((s) => [s.id, s]));
  const two = new Map(v2.map((s) => [s.id, s]));
  for (const s of v2) {
    if (!one.has(s.id)) for (const o of listV1(db, 0, s.id)) one.set(o.id, o);
  }
  for (const s of v1) {
    if (!two.has(s.id)) for (const o of listV2(db, parts, 0, s.id)) two.set(o.id, o);
  }
  const chosen: Listed[] = [];
  for (const sessionId of new Set([...one.keys(), ...two.keys()])) {
    const old = one.get(sessionId);
    const now = two.get(sessionId);
    // 2.x's copy of a 1.x session is lossy: read it only when the session went on in 2.x.
    const session = now && (!old || now.newest > old.newest) ? now : old;
    if (session && session.changed >= sinceMs) chosen.push(session);
  }
  return chosen.sort((a, b) => a.time_created - b.time_created || (a.id < b.id ? -1 : 1));
}

function exportOf(opened: Opened, session: Listed, host: CaptureHost): string {
  if (session.copy === "v1") return exportV1(opened.db, session.id, host);
  const now = exportV2(opened.db, session.id, host, opened.parts);
  if (!opened.v1 || !opened.db.query("SELECT 1 FROM session WHERE id = ?").get(session.id)) {
    return now;
  }
  // A 1.x session that went on in 2.x: the messages 2.x copied over (under their own ids, with
  // only each one's last step of usage and without subtasks) are read from 1.x's tables, whole,
  // and only those said since from 2.x's.
  const old = JSON.parse(exportV1(opened.db, session.id, host)) as { messages: { info: Row }[] };
  const doc = JSON.parse(now) as { info: Row; messages: { info: Row }[] };
  const copied = new Set(old.messages.map((m) => m.info.id));
  return JSON.stringify({
    info: doc.info,
    messages: [...old.messages, ...doc.messages.filter((m) => !copied.has(m.info.id))],
  });
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
 * order and what the session looked like when it was handed over, and once a turn is over
 * OpenCode goes on to total the session's usage and changes (`cost`, `tokens`, `summary`) and
 * moves its `time.updated`, all from what its messages already hold: nothing new to send. OpenCode
 * 1.x also works out each prompt's file changes (its message's `summary`) after the turn, in the
 * background: not new either. A new title is sent. */
function sameSession(a: string, b: string): boolean {
  try {
    const [x, y] = [JSON.parse(a), JSON.parse(b)];
    for (const doc of [x, y]) {
      const info = doc?.info;
      if (!info || typeof info !== "object") continue;
      delete info.cost;
      delete info.tokens;
      delete info.summary;
      delete info.time?.updated;
      for (const message of Array.isArray(doc.messages) ? doc.messages : []) {
        if (message?.info?.role === "user") delete message.info.summary;
      }
    }
    return JSON.stringify(sorted(x)) === JSON.stringify(sorted(y));
  } catch {
    return false;
  }
}

/** The channels' own databases beside `opencode.db` (`opencode-<channel>.db`, which 2.x keeps for
 * some release channels), unless `$OPENCODE_DB` names the one database OpenCode uses. */
function channelDatabases(host: CaptureHost): string[] {
  if (host.env.OPENCODE_DB !== undefined) return [];
  const data = opencodeDataDir(host);
  let names: string[];
  try {
    names = readdirSync(data);
  } catch {
    return [];
  }
  return names
    .filter((name) => /^opencode-[\w.-]+\.db$/.test(name))
    .sort()
    .map((name) => join(data, name));
}

/** OpenCode's sessions with at least one message that changed (the session, a message or a part)
 * at or after `sinceMs`, from its database and each channel's own. None when OpenCode keeps no
 * database here. A session in more than one is read from the one where it changed last. */
export function storedOpencodeSessions(host: CaptureHost, sinceMs: number): StoredSession[] {
  const main = opencodeDatabase(host);
  const found = new Map<string, StoredSession>();
  for (const path of [...(main ? [main] : []), ...channelDatabases(host)]) {
    let opened: Opened;
    try {
      opened = open(path);
    } catch (err) {
      // An early 2.x preview's own file (`opencode-next.db`), which OpenCode 2.x imports itself.
      if (path !== main && (err as { preview?: boolean }).preview) continue;
      throw err;
    }
    let sessions: Listed[];
    try {
      sessions = list(opened, sinceMs);
    } finally {
      opened.db.close();
    }
    for (const session of sessions) {
      const known = found.get(session.id);
      if (!known || known.updatedMs < session.changed) {
        found.set(session.id, storedSession(path, session, host));
      }
    }
  }
  return [...found.values()];
}

function storedSession(path: string, session: Listed, host: CaptureHost): StoredSession {
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
