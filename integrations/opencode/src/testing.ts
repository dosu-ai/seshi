/** Test helpers: a small OpenCode 1.x database for tests, written from exports (`{info, messages}`, the shape
 * `opencode export` prints): the session, message and part tables as OpenCode 1.18 creates them,
 * in WAL mode as OpenCode keeps it. Never a real person's database. */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

type Row = Record<string, unknown>;

export interface OpencodeExport {
  info: Row & { id: string; directory: string; time: { created: number; updated: number } };
  messages: {
    info: Row & { id: string; time: { created: number; completed?: number } };
    parts: Row[];
  }[];
}

const SCHEMA = `
CREATE TABLE session (
  id text PRIMARY KEY, project_id text NOT NULL, workspace_id text, parent_id text,
  slug text NOT NULL, directory text NOT NULL, path text, title text NOT NULL, version text NOT NULL,
  share_url text, summary_additions integer, summary_deletions integer, summary_files integer,
  summary_diffs text, metadata text, cost real DEFAULT 0 NOT NULL,
  tokens_input integer DEFAULT 0 NOT NULL, tokens_output integer DEFAULT 0 NOT NULL,
  tokens_reasoning integer DEFAULT 0 NOT NULL, tokens_cache_read integer DEFAULT 0 NOT NULL,
  tokens_cache_write integer DEFAULT 0 NOT NULL, revert text, permission text, agent text,
  model text, time_created integer NOT NULL, time_updated integer NOT NULL,
  time_compacting integer, time_archived integer
);
CREATE TABLE message (
  id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL,
  time_updated integer NOT NULL, data text NOT NULL
);
CREATE TABLE part (
  id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
  time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
);
CREATE INDEX session_parent_idx ON session (parent_id);
CREATE INDEX message_session_time_created_id_idx ON message (session_id, time_created, id);
CREATE INDEX part_message_id_id_idx ON part (message_id, id);
CREATE INDEX part_session_idx ON part (session_id);
`;

/** Create the database at `path` (WAL mode), holding `sessions`. */
export function writeOpencodeDb(path: string, sessions: OpencodeExport[] = []): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  try {
    db.run("PRAGMA journal_mode = WAL");
    db.run(SCHEMA);
    for (const session of sessions) addSession(db, session);
  } finally {
    db.close();
  }
}

/** Add `session` to the database at `path`, as OpenCode would while it runs. */
export function addOpencodeSession(path: string, session: OpencodeExport): void {
  const db = new Database(path);
  try {
    addSession(db, session);
  } finally {
    db.close();
  }
}

/** Add a turn (a message and its parts) to a session, and touch the session, as OpenCode does. */
export function addOpencodeTurn(
  path: string,
  sessionId: string,
  message: OpencodeExport["messages"][number],
): void {
  const db = new Database(path);
  try {
    addMessage(db, sessionId, message);
    const at = Number(message.info.time.created);
    db.query("UPDATE session SET time_updated = max(time_updated, ?) WHERE id = ?").run(
      at,
      sessionId,
    );
  } finally {
    db.close();
  }
}

function addSession(db: Database, { info, messages }: OpencodeExport): void {
  db.query(
    `INSERT INTO session (id, project_id, parent_id, slug, directory, path, title, version,
       time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    info.id,
    String(info.projectID ?? "project"),
    (info.parentID as string | undefined) ?? null,
    String(info.slug ?? "slug"),
    info.directory,
    (info.path as string | undefined) ?? null,
    String(info.title ?? ""),
    String(info.version ?? "1.18.31"),
    info.time.created,
    info.time.updated,
  );
  for (const message of messages) addMessage(db, info.id, message);
}

function addMessage(
  db: Database,
  sessionId: string,
  { info, parts }: OpencodeExport["messages"][number],
): void {
  const { id, sessionID: _s, ...data } = info;
  const created = info.time.created;
  const updated = info.time.completed ?? created;
  db.query(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
  ).run(id, sessionId, created, updated, JSON.stringify(data));
  for (const part of parts) {
    const { id: partId, sessionID: _ps, messageID: _m, ...rest } = part;
    const end = Number((part.time as Row | undefined)?.end ?? updated);
    db.query(
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(String(partId), id, sessionId, created, end, JSON.stringify(rest));
  }
}

/** `doc` moved to start at `created` (milliseconds), its times shifted with it, under `id`. */
export function opencodeSessionAt(
  doc: OpencodeExport,
  id: string,
  created: number,
): OpencodeExport {
  const shift = created - doc.info.time.created;
  const moved = (time: unknown): unknown =>
    time && typeof time === "object"
      ? Object.fromEntries(
          Object.entries(time as Row).map(([k, v]) => [k, typeof v === "number" ? v + shift : v]),
        )
      : time;
  const rename = (value: string) => value.replaceAll(doc.info.id, id);
  return {
    info: { ...doc.info, id, time: moved(doc.info.time) as OpencodeExport["info"]["time"] },
    messages: doc.messages.map(({ info, parts }) => ({
      info: {
        ...info,
        id: rename(info.id),
        sessionID: id,
        ...(typeof info.parentID === "string" ? { parentID: rename(info.parentID) } : {}),
        time: moved(info.time) as { created: number },
      },
      parts: parts.map((part) => ({
        ...part,
        id: rename(String(part.id)),
        sessionID: id,
        messageID: rename(String(part.messageID)),
        ...(part.time ? { time: moved(part.time) } : {}),
        ...(part.state && typeof part.state === "object"
          ? {
              state: {
                ...(part.state as Row),
                ...((part.state as Row).time ? { time: moved((part.state as Row).time) } : {}),
              },
            }
          : {}),
      })),
    })),
  };
}

/** One OpenCode 2.x session as its rows: the session, and its message rows in order (`seq`), with
 * an assistant row's content inline in `data.content`. */
export interface OpencodeV2Session {
  session: {
    id: string;
    directory: string;
    parentID?: string;
    title?: string;
    time: { created: number; updated: number };
  };
  rows: { id: string; type: string; time: number; data: Row }[];
}

const SCHEMA_V2 = `
CREATE TABLE migration (id text PRIMARY KEY, time_completed integer NOT NULL);
CREATE TABLE session_v2 (
  id text PRIMARY KEY, project_id text NOT NULL, workspace_id text, parent_id text,
  fork_session_id text, fork_boundary text, slug text NOT NULL, directory text NOT NULL, path text,
  title text, version text NOT NULL, share_url text, summary_additions integer,
  summary_deletions integer, summary_files integer, summary_diffs text, metadata text,
  cost real DEFAULT 0 NOT NULL, tokens_input integer DEFAULT 0 NOT NULL,
  tokens_output integer DEFAULT 0 NOT NULL, tokens_reasoning integer DEFAULT 0 NOT NULL,
  tokens_cache_read integer DEFAULT 0 NOT NULL, tokens_cache_write integer DEFAULT 0 NOT NULL,
  revert text, permission text, agent text, model text, time_created integer NOT NULL,
  time_updated integer NOT NULL, time_idle integer, time_viewed integer, idle_outcome text,
  time_compacting integer, time_archived integer, time_suspended integer,
  resume_attempts integer DEFAULT 0 NOT NULL
);
CREATE TABLE session_message (
  id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL,
  time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
);
CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message (session_id, seq);
`;

const SCHEMA_PART = `
CREATE TABLE session_part (
  message_id text NOT NULL, session_id text NOT NULL, ordinal integer NOT NULL, type text NOT NULL,
  call_id text, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL,
  PRIMARY KEY (message_id, ordinal)
);
`;

/** Create (or add to) a database at `path` with OpenCode 2.x's tables holding `sessions`: as
 * 2.0–2.2.1 keep them (content inline), or with `parts`, as 2.2.2 and later can (assistant content
 * in `session_part` rows). `v1` also writes OpenCode 1.x's tables with those sessions, as a
 * database 2.x opened after 1.x looks. */
export function writeOpencodeDbV2(
  path: string,
  sessions: OpencodeV2Session[],
  options: { parts?: boolean; v1?: OpencodeExport[] } = {},
): void {
  if (options.v1) writeOpencodeDb(path, options.v1);
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  try {
    db.run("PRAGMA journal_mode = WAL");
    db.run(SCHEMA_V2);
    if (options.parts) db.run(SCHEMA_PART);
    for (const { session, rows } of sessions) {
      db.query(
        `INSERT INTO session_v2 (id, project_id, parent_id, slug, directory, title, version,
           time_created, time_updated) VALUES (?, 'project', ?, 'slug', ?, ?, '2.3.0', ?, ?)`,
      ).run(
        session.id,
        session.parentID ?? null,
        session.directory,
        session.title ?? null,
        session.time.created,
        session.time.updated,
      );
      rows.forEach((row, seq) => {
        const content = Array.isArray(row.data.content) ? (row.data.content as Row[]) : [];
        const split = options.parts && row.type === "assistant";
        const data = split ? { ...row.data, content: [] } : row.data;
        db.query(
          `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(row.id, session.id, row.type, seq, row.time, row.time, JSON.stringify(data));
        if (!split) return;
        content.forEach((part, ordinal) => {
          db.query(
            `INSERT INTO session_part (message_id, session_id, ordinal, type, call_id, time_created,
               time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            row.id,
            session.id,
            ordinal,
            String(part.type),
            (part.id as string | undefined) ?? null,
            row.time,
            row.time,
            JSON.stringify(part),
          );
        });
      });
    }
  } finally {
    db.close();
  }
}
