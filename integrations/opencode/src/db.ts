/** OpenCode's own database, read by the sweep (`seshi upload --since`, the uploader's sweep) for
 * the sessions seshi's plugin never handed over: from before install, or from a run without the
 * plugin. Loaded only by `OPENCODE_CAPTURE.stored`, never by `seshi hook`.
 *
 * The database is opened read-only, so a running OpenCode is not disturbed, and seshi never runs
 * OpenCode's CLI for it (`opencode export` may start OpenCode's service). Each session is rebuilt
 * as OpenCode 1.x's `opencode export` prints it, which is what the plugin hands over: the session
 * row as `Session.Info`, then its messages (by creation time, then id), each with its parts (by
 * id). Only the columns that say which session it is and when it changed are required; a database
 * without them (OpenCode 2.x keeps sessions elsewhere) is refused, saying so. */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { CaptureHost, StoredSession } from "@seshi/kit";
import { opencodeDataDir } from "./capture";

/** The columns seshi reads by name: each table must have these. */
const REQUIRED: Readonly<Record<string, readonly string[]>> = {
  session: ["id", "parent_id", "directory", "title", "time_created", "time_updated"],
  message: ["id", "session_id", "time_created", "time_updated", "data"],
  part: ["id", "message_id", "session_id", "time_updated", "data"],
};

/** The database OpenCode uses here: `$OPENCODE_DB` (a path, or a name in OpenCode's data folder),
 * else `opencode.db` in its data folder (`$XDG_DATA_HOME/opencode`, else
 * `~/.local/share/opencode`). Undefined when there is none. */
export function opencodeDatabase(host: CaptureHost): string | undefined {
  const configured = host.env.OPENCODE_DB;
  if (configured === ":memory:") return undefined;
  const data = opencodeDataDir(host);
  const path = configured
    ? isAbsolute(configured)
      ? configured
      : join(data, configured)
    : join(data, "opencode.db");
  return existsSync(path) ? path : undefined;
}

function open(path: string): Database {
  const db = new Database(path, { readonly: true });
  try {
    db.run("PRAGMA busy_timeout = 2000");
    for (const [table, columns] of Object.entries(REQUIRED)) {
      const have = new Set(
        db
          .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${table}')`)
          .all()
          .map((c) => c.name),
      );
      const missing = have.size === 0 ? [] : columns.filter((c) => !have.has(c));
      if (have.size === 0 || missing.length > 0) {
        const what =
          have.size === 0
            ? `no ${table} table`
            : `no ${missing.map((c) => `${table}.${c}`).join(", ")}`;
        throw new Error(
          `${path} is not an OpenCode database seshi can read (${what}); seshi reads OpenCode 1.x's session, message and part tables`,
        );
      }
    }
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

type Row = Record<string, unknown>;

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const json = (value: unknown): unknown =>
  typeof value === "string" ? JSON.parse(value) : undefined;
const nullable = <T>(value: T | null | undefined): T | undefined => value ?? undefined;

/** A stored directory as OpenCode gives it back: with backslashes on Windows. */
function directoryOf(row: Row, host: CaptureHost): string {
  const stored = text(row.directory) ?? "";
  if (host.platform !== "win32" || !(/^[A-Za-z]:\//.test(stored) || stored.startsWith("//"))) {
    return stored;
  }
  return stored.replaceAll("/", "\\");
}

/** The session row as OpenCode's `Session.Info` (its `fromRow`), keys in its order; fields it
 * leaves undefined are dropped when the export is written as JSON. */
function sessionInfo(row: Row, host: CaptureHost): Row {
  const counted =
    row.summary_additions != null || row.summary_deletions != null || row.summary_files != null;
  const revert = json(row.revert) as Row | undefined;
  const model = json(row.model) as Row | undefined;
  const permission = json(row.permission);
  return {
    id: row.id,
    slug: row.slug,
    projectID: row.project_id,
    workspaceID: nullable(row.workspace_id),
    directory: directoryOf(row, host),
    path: nullable(row.path),
    parentID: nullable(row.parent_id),
    title: row.title,
    agent: nullable(row.agent),
    model: model
      ? { id: model.id, providerID: model.providerID, variant: model.variant }
      : undefined,
    version: row.version,
    summary: counted
      ? {
          additions: row.summary_additions ?? 0,
          deletions: row.summary_deletions ?? 0,
          files: row.summary_files ?? 0,
          diffs: json(row.summary_diffs),
        }
      : undefined,
    cost: row.cost,
    tokens:
      row.tokens_input === undefined
        ? undefined
        : {
            input: row.tokens_input,
            output: row.tokens_output,
            reasoning: row.tokens_reasoning,
            cache: { read: row.tokens_cache_read, write: row.tokens_cache_write },
          },
    share: row.share_url ? { url: row.share_url } : undefined,
    metadata: json(row.metadata),
    revert: revert
      ? {
          messageID: revert.messageID,
          partID: revert.partID || undefined,
          snapshot: revert.snapshot,
          diff: revert.diff,
        }
      : undefined,
    permission: Array.isArray(permission) ? permission : undefined,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      compacting: nullable(row.time_compacting),
      archived: nullable(row.time_archived),
    },
  };
}

/** One session as `opencode export` prints it, compact, `info` first: the transcript the plugin
 * hands to `seshi hook opencode Stop`. */
function exportOf(db: Database, id: string, host: CaptureHost): string {
  const row = db.query<Row, [string]>("SELECT * FROM session WHERE id = ?").get(id);
  if (!row) throw new Error(`OpenCode session ${id} is no longer in its database`);
  const messages = db
    .query<Row, [string]>(
      "SELECT id, session_id, data FROM message WHERE session_id = ? ORDER BY time_created, id",
    )
    .all(id);
  const parts = new Map<string, Row[]>();
  const partRows = db
    .query<Row, [string]>(
      "SELECT id, message_id, session_id, data FROM part WHERE session_id = ? ORDER BY message_id, id",
    )
    .all(id);
  for (const part of partRows) {
    const list = parts.get(part.message_id as string) ?? [];
    list.push({
      ...(json(part.data) as Row),
      id: part.id,
      sessionID: part.session_id,
      messageID: part.message_id,
    });
    parts.set(part.message_id as string, list);
  }
  return JSON.stringify({
    info: sessionInfo(row, host),
    messages: messages.map((m) => ({
      info: { ...(json(m.data) as Row), id: m.id, sessionID: m.session_id },
      parts: parts.get(m.id as string) ?? [],
    })),
  });
}

/** OpenCode's sessions with at least one message that changed (the session, a message or a part)
 * at or after `sinceMs`. None when OpenCode keeps no database here. */
export function storedOpencodeSessions(host: CaptureHost, sinceMs: number): StoredSession[] {
  const path = opencodeDatabase(host);
  if (!path) return [];
  const db = open(path);
  let rows: Row[];
  try {
    rows = db
      .query<Row, [number]>(
        `SELECT id, parent_id, directory, time_created, changed FROM (
           SELECT s.id, s.parent_id, s.directory, s.time_created,
             max(s.time_updated,
                 coalesce((SELECT max(m.time_updated) FROM message m WHERE m.session_id = s.id), 0),
                 coalesce((SELECT max(p.time_updated) FROM part p WHERE p.session_id = s.id), 0)
             ) AS changed
           FROM session s
           WHERE EXISTS (SELECT 1 FROM message m WHERE m.session_id = s.id)
         ) WHERE changed >= ? ORDER BY time_created, id`,
      )
      .all(sinceMs);
  } finally {
    db.close();
  }
  return rows.flatMap((row) => {
    const id = text(row.id);
    if (!id) return [];
    const cwd = directoryOf(row, host);
    const parent = text(row.parent_id);
    const created = Number(row.time_created);
    return [
      {
        info: {
          session_id: id,
          ...(cwd ? { cwd } : {}),
          ...(Number.isFinite(created) ? { started_at: new Date(created).toISOString() } : {}),
          ...(parent ? { parent_session_id: parent } : {}),
        },
        updatedMs: Number(row.changed),
        transcript: () => {
          const read = open(path);
          try {
            return read.transaction(() => exportOf(read, id, host))();
          } finally {
            read.close();
          }
        },
      },
    ];
  });
}
