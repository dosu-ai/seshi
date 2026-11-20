import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ChangeEntry, EventRole, Labels, Visibility } from "@seshi/model";
import { changeStamp } from "@seshi/store";
import type {
  BackendHit,
  BackendMatch,
  BackendQuery,
  BackendResults,
  FeedPosition,
  FeedRow,
  IndexedSession,
  IndexStore,
  SessionUpdate,
} from "./backend";
import { MEMORY_INDEX, tryRestrictToOwner } from "./paths";
import { indexText, MATCH_END, MATCH_START } from "./snippet";

/** The index's own schema: a file built under another is wiped and rebuilt from the change
 * feeds. 3: sessions' `agent` column is `format`, and the feed's copies of entries written
 * before seshi 0.16 carry the format filled in from the session. 4: sessions gained `labels`. 5:
 * sessions' `repo`, `harness`, `agent_version` and `models`. 6: sessions' `title`, `events`,
 * `tools` and `redactions`. 7: sessions' `tool_outcomes` and `tokens`. */
export const INDEX_SCHEMA = "seshi/search-index/7";

const SNIPPET_TOKENS = 24;

const TABLES = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS feeds (owner TEXT PRIMARY KEY, cursor TEXT) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS seen (
  owner TEXT NOT NULL,
  key TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (owner, key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS changes (
  stamp TEXT NOT NULL,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  entry TEXT NOT NULL,
  PRIMARY KEY (stamp, owner, name)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  owner TEXT NOT NULL,
  archive_id TEXT NOT NULL,
  format TEXT NOT NULL,
  session_id TEXT NOT NULL,
  origin_agent TEXT,
  native_session_id TEXT,
  project TEXT,
  branch TEXT,
  repo TEXT,
  harness TEXT,
  agent_version TEXT,
  models TEXT,
  labels TEXT,
  source_id TEXT,
  visibility TEXT NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  updated_at TEXT NOT NULL,
  updated_ms INTEGER NOT NULL,
  title TEXT,
  events INTEGER,
  tools TEXT,
  redactions TEXT,
  tool_outcomes TEXT,
  tokens TEXT,
  traces TEXT NOT NULL,
  read_ms INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (owner, archive_id)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  session INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  event_index INTEGER NOT NULL,
  role TEXT NOT NULL,
  tool_name TEXT,
  ts INTEGER
);
CREATE INDEX IF NOT EXISTS events_by_session ON events (session);
CREATE INDEX IF NOT EXISTS sessions_by_activity ON sessions (coalesce(ended_at, updated_ms));
CREATE VIRTUAL TABLE IF NOT EXISTS events_text USING fts5 (
  text,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

const DROP = `
DROP TABLE IF EXISTS events_text;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS seen;
DROP TABLE IF EXISTS feeds;
DROP TABLE IF EXISTS changes;
DROP TABLE IF EXISTS meta;
`;

interface SessionRow {
  id: number;
  owner: string;
  archive_id: string;
  format: string;
  session_id: string;
  origin_agent: string | null;
  native_session_id: string | null;
  project: string | null;
  branch: string | null;
  repo: string | null;
  harness: string | null;
  agent_version: string | null;
  models: string | null;
  labels: string | null;
  source_id: string | null;
  visibility: string;
  started_at: number | null;
  ended_at: number | null;
  updated_at: string;
  updated_ms: number;
  title: string | null;
  events: number | null;
  tools: string | null;
  redactions: string | null;
  tool_outcomes: string | null;
  tokens: string | null;
  traces: string;
  read_ms: number;
  removed: number;
}

function sessionOf(row: SessionRow): IndexedSession {
  return {
    owner: row.owner,
    archive_id: row.archive_id,
    format: row.format,
    session_id: row.session_id,
    ...(row.origin_agent !== null ? { origin_agent: row.origin_agent } : {}),
    ...(row.native_session_id !== null ? { native_session_id: row.native_session_id } : {}),
    ...(row.project !== null ? { project: row.project } : {}),
    ...(row.branch !== null ? { branch: row.branch } : {}),
    ...(row.repo !== null ? { repo: row.repo } : {}),
    ...(row.harness !== null ? { harness: row.harness } : {}),
    ...(row.agent_version !== null ? { agent_version: row.agent_version } : {}),
    ...(row.models !== null ? { models: JSON.parse(row.models) as string[] } : {}),
    ...(row.labels !== null ? { labels: JSON.parse(row.labels) as Labels } : {}),
    ...(row.source_id !== null ? { source_id: row.source_id } : {}),
    visibility: row.visibility as Visibility,
    ...(row.started_at !== null ? { started_at: row.started_at } : {}),
    ...(row.ended_at !== null ? { ended_at: row.ended_at } : {}),
    updated_at: row.updated_at,
    ...(row.title !== null ? { title: row.title } : {}),
    ...(row.events !== null ? { events: row.events } : {}),
    ...(row.tools !== null ? { tools: JSON.parse(row.tools) as Record<string, number> } : {}),
    ...(row.redactions !== null
      ? { redactions: JSON.parse(row.redactions) as Record<string, number> }
      : {}),
    ...(row.tool_outcomes !== null
      ? { tool_outcomes: JSON.parse(row.tool_outcomes) as IndexedSession["tool_outcomes"] }
      : {}),
    ...(row.tokens !== null ? { tokens: JSON.parse(row.tokens) as IndexedSession["tokens"] } : {}),
    traces: JSON.parse(row.traces) as string[],
  };
}

/** A count map as a column: null when it counts nothing. */
function counts(map: Record<string, number> | undefined): string | null {
  return map && Object.keys(map).length > 0 ? JSON.stringify(map) : null;
}

/** Push the session filters every query shares (live sessions only, what the viewer may
 * read, owner, agent, repo and the rest) onto `where` and `params`, for a `sessions` table
 * aliased `s`. False when nothing can match (an owner filter that names no folder). */
function filtersOf(q: BackendQuery, where: string[], params: SQLQueryBindings[]): boolean {
  where.push("s.removed = 0");
  if (!q.viewer.everything) {
    if (q.viewer.own.length > 0) {
      where.push(`(s.visibility = 'org' OR s.owner IN (${placeholders(q.viewer.own.length)}))`);
      params.push(...q.viewer.own);
    } else {
      where.push("s.visibility = 'org'");
    }
  }
  if (q.owners !== undefined) {
    if (q.owners.length === 0) return false;
    where.push(`s.owner IN (${placeholders(q.owners.length)})`);
    params.push(...q.owners);
  }
  if (q.agent !== undefined) {
    where.push("(s.format = ? OR s.origin_agent = ?)");
    params.push(q.agent, q.agent);
  }
  if (q.repo !== undefined) {
    where.push("(s.repo = ? COLLATE NOCASE OR s.repo LIKE ? ESCAPE '\\')");
    params.push(q.repo, `%/${likeLiteral(q.repo)}`);
  }
  if (q.branch !== undefined) {
    where.push("s.branch = ?");
    params.push(q.branch);
  }
  if (q.harness !== undefined) {
    where.push("s.harness = ?");
    params.push(q.harness);
  }
  if (q.agent_version !== undefined) {
    where.push("s.agent_version = ?");
    params.push(q.agent_version);
  }
  if (q.model !== undefined) {
    where.push("EXISTS (SELECT 1 FROM json_each(s.models) WHERE json_each.value = ?)");
    params.push(q.model);
  }
  for (const [key, value] of Object.entries(q.labels ?? {})) {
    where.push("EXISTS (SELECT 1 FROM json_each(s.labels) AS l WHERE l.key = ? AND l.value = ?)");
    params.push(key, value);
  }
  if (q.source !== undefined) {
    where.push("s.source_id = ?");
    params.push(q.source);
  }
  return true;
}

/** When a session last did something, as a browse orders it. */
const ACTIVITY = "coalesce(s.ended_at, s.updated_ms)";

function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

/** The snippets of `n` picked events: binds the two markers, the match, then the event ids.
 * `rowid+0`, not `rowid`: SQLite pushes `rowid IN (…)` into FTS5, which then evaluates the
 * match again for every id, so one search with many matches stalls the server. As an
 * expression it is only a filter, and FTS5 reads the match once. */
export function snippetsSql(n: number): string {
  return `SELECT e.id AS id, e.content_hash, e.event_index, e.role, e.tool_name, e.ts,
      snippet(events_text, 0, ?, ?, '…', ${SNIPPET_TOKENS}) AS marked
    FROM events_text JOIN events e ON e.id = events_text.rowid
    WHERE events_text MATCH ? AND events_text.rowid+0 IN (${placeholders(n)})`;
}

export interface SqliteIndexOptions {
  /** The file, or `:memory:`. Its folder is created (owner-only) when missing. */
  path: string;
  /** The deployment the index belongs to: a file built for another is wiped. */
  deployment: string;
  /** Which event roles are indexed: a file built with others is wiped (it would miss some,
   * or hold some it should not). */
  events: readonly EventRole[];
  /** What the indexer admits, named (F11.9: a serverless laptop's search scope and owner): a
   * file built under another scope is wiped, so it holds nothing this one would leave out. */
  scope?: string;
  /** The file keeps a copy of every change entry read, for the cross-owner feed. A file built
   * without it is wiped when it is turned on, so the copy starts from every feed's start. */
  feed?: boolean;
}

export class SqliteIndex implements IndexStore {
  readonly path: string;
  private readonly db: Database;

  constructor(options: SqliteIndexOptions) {
    this.path = options.path;
    const memory = options.path === MEMORY_INDEX;
    if (!memory) mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
    this.db = new Database(options.path, { create: true, strict: true });
    if (!memory && process.platform !== "win32") tryRestrictToOwner(options.path);
    this.db.run("PRAGMA busy_timeout = 5000");
    if (!memory) {
      this.db.run("PRAGMA journal_mode = WAL");
      this.db.run("PRAGMA synchronous = NORMAL");
    }
    this.db.run(TABLES);
    const expected: Record<string, string> = {
      schema: INDEX_SCHEMA,
      deployment: options.deployment,
      events: JSON.stringify([...options.events].sort()),
      ...(options.scope !== undefined ? { scope: options.scope } : {}),
      ...(options.feed ? { feed: "kept" } : {}),
    };
    this.transaction(() => {
      const stored = this.metaAll();
      const fresh = Object.keys(stored).length === 0;
      const matches = Object.entries(expected).every(([k, v]) => stored[k] === v);
      if (!fresh && !matches) {
        this.db.run(DROP);
        this.db.run(TABLES);
      }
      if (fresh || !matches) {
        for (const [key, value] of Object.entries(expected)) this.setMeta(key, value);
      }
    });
  }

  private metaAll(): Record<string, string> {
    const rows = this.db.query("SELECT key, value FROM meta").all() as {
      key: string;
      value: string;
    }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  private meta(key: string): string | undefined {
    const row = this.db.query("SELECT value FROM meta WHERE key = ?").get(key) as {
      value: string;
    } | null;
    return row?.value;
  }

  private setMeta(key: string, value: string): void {
    this.db
      .query(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  private row(owner: string, archive: string): SessionRow | null {
    return this.db
      .query("SELECT * FROM sessions WHERE owner = ? AND archive_id = ?")
      .get(owner, archive) as SessionRow | null;
  }

  session(owner: string, archive: string): IndexedSession | null {
    const row = this.row(owner, archive);
    return row === null || row.removed === 1 ? null : sessionOf(row);
  }

  private dropEvents(sessionId: number): void {
    this.db
      .query("DELETE FROM events_text WHERE rowid IN (SELECT id FROM events WHERE session = ?)")
      .run(sessionId);
    this.db.query("DELETE FROM events WHERE session = ?").run(sessionId);
  }

  apply(update: SessionUpdate): boolean {
    const { session, events } = update;
    return this.transaction(() => {
      const existing = this.row(session.owner, session.archive_id);
      const readAt = update.read_at ?? 0;
      if (existing !== null && existing.read_ms > readAt) return false;
      if (!update.replace) {
        const holds = existing === null || existing.removed === 1 ? "[]" : existing.traces;
        if (holds !== JSON.stringify(update.base ?? [])) return false;
      }
      const values = [
        session.format,
        session.session_id,
        session.origin_agent ?? null,
        session.native_session_id ?? null,
        session.project ?? null,
        session.branch ?? null,
        session.repo ?? null,
        session.harness ?? null,
        session.agent_version ?? null,
        session.models && session.models.length > 0 ? JSON.stringify(session.models) : null,
        session.labels && Object.keys(session.labels).length > 0
          ? JSON.stringify(session.labels)
          : null,
        session.source_id ?? null,
        session.visibility,
        session.started_at ?? null,
        session.ended_at ?? null,
        session.updated_at,
        Date.parse(session.updated_at) || 0,
        session.title ?? null,
        session.events ?? null,
        counts(session.tools),
        counts(session.redactions),
        session.tool_outcomes ? JSON.stringify(session.tool_outcomes) : null,
        session.tokens ? JSON.stringify(session.tokens) : null,
        JSON.stringify(session.traces),
        readAt,
      ];
      let id: number;
      if (existing === null) {
        const row = this.db
          .query(
            `INSERT INTO sessions (owner, archive_id, format, session_id, origin_agent,
               native_session_id, project, branch, repo, harness, agent_version, models,
               labels, source_id, visibility, started_at, ended_at, updated_at, updated_ms,
               title, events, tools, redactions, tool_outcomes, tokens, traces, read_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             RETURNING id`,
          )
          .get(session.owner, session.archive_id, ...values) as { id: number };
        id = row.id;
      } else {
        id = existing.id;
        if (update.replace || existing.removed === 1) this.dropEvents(id);
        this.db
          .query(
            `UPDATE sessions SET format = ?, session_id = ?, origin_agent = ?,
               native_session_id = ?, project = ?, branch = ?, repo = ?, harness = ?,
               agent_version = ?, models = ?, labels = ?, source_id = ?, visibility = ?,
               started_at = ?, ended_at = ?, updated_at = ?, updated_ms = ?, title = ?,
               events = ?, tools = ?, redactions = ?, tool_outcomes = ?, tokens = ?, traces = ?,
               read_ms = ?, removed = 0
             WHERE id = ?`,
          )
          .run(...values, id);
      }
      const insertEvent = this.db.query(
        `INSERT INTO events (session, content_hash, event_index, role, tool_name, ts)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      );
      const insertText = this.db.query("INSERT INTO events_text (rowid, text) VALUES (?, ?)");
      for (const event of events) {
        const text = indexText(event.text);
        if (text.trim() === "") continue;
        const row = insertEvent.get(
          id,
          event.content_hash,
          event.event_index,
          event.role,
          event.tool_name ?? null,
          event.timestamp ?? null,
        ) as { id: number };
        insertText.run(row.id, text);
      }
      return true;
    });
  }

  remove(owner: string, archive: string, readAt = 0): boolean {
    return this.transaction(() => {
      const existing = this.row(owner, archive);
      if (existing !== null && existing.read_ms > readAt) return false;
      if (existing === null) {
        this.db
          .query(
            `INSERT INTO sessions (owner, archive_id, format, session_id, visibility, updated_at,
               updated_ms, traces, read_ms, removed)
             VALUES (?, ?, '', '', 'owner', '', 0, '[]', ?, 1)`,
          )
          .run(owner, archive, readAt);
        return true;
      }
      this.dropEvents(existing.id);
      this.db
        .query("UPDATE sessions SET removed = 1, traces = '[]', read_ms = ? WHERE id = ?")
        .run(readAt, existing.id);
      return true;
    });
  }

  query(q: BackendQuery): BackendResults {
    if (q.match === undefined) return this.browse(q);
    const where: string[] = ["events_text MATCH ?"];
    const params: SQLQueryBindings[] = [q.match];
    if (!filtersOf(q, where, params)) return { total: 0, hits: [] };
    if (q.since !== undefined) {
      where.push("coalesce(e.ts, s.updated_ms) >= ?");
      params.push(q.since);
    }
    if (q.until !== undefined) {
      where.push("coalesce(e.ts, s.updated_ms) <= ?");
      params.push(q.until);
    }
    const matching = `
      SELECT e.session AS sid, e.id AS eid, events_text.rank AS r
      FROM events_text
      JOIN events e ON e.id = events_text.rowid
      JOIN sessions s ON s.id = e.session
      WHERE ${where.join(" AND ")}`;
    const order =
      q.sort === "recent"
        ? "s.updated_ms DESC, g.best ASC, s.id DESC"
        : "g.best ASC, s.updated_ms DESC, s.id DESC";
    const rows = this.db
      .query(
        `SELECT s.*, g.best AS best, g.hits AS hits, count(*) OVER () AS total
         FROM (SELECT sid, min(r) AS best, count(*) AS hits FROM (${matching}) GROUP BY sid) g
         JOIN sessions s ON s.id = g.sid
         ORDER BY ${order}
         LIMIT ? OFFSET ?`,
      )
      .all(...params, q.limit, q.offset) as (SessionRow & {
      best: number;
      hits: number;
      total: number;
    })[];
    const total =
      rows[0]?.total ??
      (q.offset > 0
        ? (
            this.db.query(`SELECT count(DISTINCT sid) AS n FROM (${matching})`).get(...params) as {
              n: number;
            }
          ).n
        : 0);
    const matches = this.matchesOf(
      matching,
      params,
      rows.map((r) => r.id),
      q.matches,
      q.match,
    );
    const hits: BackendHit[] = rows.map((row) => ({
      session: sessionOf(row),
      score: Number((-row.best).toPrecision(6)),
      hits: row.hits,
      matches: matches.get(row.id) ?? [],
    }));
    return { total, hits };
  }

  /** Sessions without keywords (a browse): the filters alone, the most recently active first
   * (by the last event, or the last update when the traces carry no times). `since` and
   * `until` keep sessions whose span (first to last event, or that update) overlaps them. */
  private browse(q: BackendQuery): BackendResults {
    const where: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (!filtersOf(q, where, params)) return { total: 0, hits: [] };
    if (q.since !== undefined) {
      where.push("coalesce(s.ended_at, s.updated_ms) >= ?");
      params.push(q.since);
    }
    if (q.until !== undefined) {
      where.push("coalesce(s.started_at, s.updated_ms) <= ?");
      params.push(q.until);
    }
    const total = (
      this.db
        .query(`SELECT count(*) AS n FROM sessions s WHERE ${where.join(" AND ")}`)
        .get(...params) as { n: number }
    ).n;
    const page = [...where];
    const pageParams = [...params];
    if (q.after) {
      page.push(`(${ACTIVITY} < ? OR (${ACTIVITY} = ? AND s.id < ?))`);
      pageParams.push(q.after.activity, q.after.activity, q.after.id);
    }
    const rows = this.db
      .query(
        `SELECT s.*, ${ACTIVITY} AS activity FROM sessions s
         WHERE ${page.join(" AND ")}
         ORDER BY ${ACTIVITY} DESC, s.id DESC
         LIMIT ?`,
      )
      .all(...pageParams, q.limit + 1) as (SessionRow & { activity: number })[];
    const more = rows.length > q.limit;
    const shown = more ? rows.slice(0, q.limit) : rows;
    const last = shown.at(-1);
    return {
      total,
      hits: shown.map((row) => ({ session: sessionOf(row), score: 0, hits: 0, matches: [] })),
      ...(more && last ? { after: { activity: last.activity, id: last.id } } : {}),
    };
  }

  /** The best `limit` matching events of each session, with snippets. FTS5 refuses
   * `snippet()` beside a window function, so the events are picked first and their snippets
   * read in a second query. */
  private matchesOf(
    matching: string,
    params: readonly SQLQueryBindings[],
    sessions: readonly number[],
    limit: number,
    match: string,
  ): Map<number, BackendMatch[]> {
    const out = new Map<number, BackendMatch[]>();
    if (sessions.length === 0 || limit === 0) return out;
    const picked = this.db
      .query(
        `SELECT sid, eid, r FROM (
           SELECT sid, eid, r, row_number() OVER (PARTITION BY sid ORDER BY r, eid) AS n
           FROM (${matching}) WHERE sid IN (${placeholders(sessions.length)})
         ) WHERE n <= ? ORDER BY sid, r, eid`,
      )
      .all(...params, ...sessions, limit) as { sid: number; eid: number; r: number }[];
    if (picked.length === 0) return out;
    const ids = picked.map((p) => p.eid);
    const details = this.db
      .query(snippetsSql(ids.length))
      .all(MATCH_START, MATCH_END, match, ...ids) as {
      id: number;
      content_hash: string;
      event_index: number;
      role: string;
      tool_name: string | null;
      ts: number | null;
      marked: string;
    }[];
    const byId = new Map(details.map((d) => [d.id, d]));
    for (const { sid, eid } of picked) {
      const d = byId.get(eid);
      if (!d) continue;
      const list = out.get(sid) ?? [];
      list.push({
        content_hash: d.content_hash,
        event_index: d.event_index,
        role: d.role as EventRole,
        ...(d.tool_name !== null ? { tool_name: d.tool_name } : {}),
        ...(d.ts !== null ? { timestamp: d.ts } : {}),
        marked: d.marked,
      });
      out.set(sid, list);
    }
    return out;
  }

  counts(): { sessions: number; events: number } {
    const sessions = this.db
      .query("SELECT count(*) AS n FROM sessions WHERE removed = 0")
      .get() as {
      n: number;
    };
    const events = this.db.query("SELECT count(*) AS n FROM events").get() as { n: number };
    return { sessions: sessions.n, events: events.n };
  }

  close(): void {
    this.db.close();
  }

  cursor(owner: string): string | undefined {
    const row = this.db.query("SELECT cursor FROM feeds WHERE owner = ?").get(owner) as {
      cursor: string | null;
    } | null;
    return row?.cursor ?? undefined;
  }

  seen(owner: string, keys: readonly string[]): Set<string> {
    const found = new Set<string>();
    const lookup = this.db.query("SELECT 1 AS hit FROM seen WHERE owner = ? AND key = ?");
    for (const key of keys) if (lookup.get(owner, key) !== null) found.add(key);
    return found;
  }

  advance(
    owner: string,
    cursor: string | undefined,
    processed: readonly { key: string; at: number }[],
    forgetBefore: number,
  ): void {
    this.transaction(() => {
      const insert = this.db.query(
        "INSERT INTO seen (owner, key, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      );
      for (const { key, at } of processed) insert.run(owner, key, at);
      const held = this.cursor(owner);
      const next = held === undefined || (cursor !== undefined && cursor > held) ? cursor : held;
      this.db
        .query(
          "INSERT INTO feeds (owner, cursor) VALUES (?, ?) ON CONFLICT (owner) DO UPDATE SET cursor = excluded.cursor",
        )
        .run(owner, next ?? null);
      this.db.query("DELETE FROM seen WHERE owner = ? AND at < ?").run(owner, forgetBefore);
    });
  }

  record(owner: string, entries: readonly { name: string; entry: ChangeEntry }[]): void {
    if (entries.length === 0) return;
    this.transaction(() => {
      const insert = this.db.query(
        "INSERT INTO changes (stamp, owner, name, entry) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
      );
      for (const { name, entry } of entries) {
        insert.run(name.slice(0, name.indexOf("-")), owner, name, JSON.stringify(entry));
      }
    });
  }

  feed(
    after: FeedPosition | undefined,
    limit: number,
  ): { entries: FeedRow[]; more: boolean; through: string } | null {
    // One read snapshot: the bound reported is the one the rows were read under.
    return this.db.transaction(() => this.feedPage(after, limit)).deferred();
  }

  private feedPage(
    after: FeedPosition | undefined,
    limit: number,
  ): { entries: FeedRow[]; more: boolean; through: string } | null {
    const through = this.meta("feed_through");
    if (through === undefined) return null;
    const last = changeStamp(through);
    const from = after ?? { stamp: "", owner: "", name: "" };
    const rows = this.db
      .query(
        `SELECT stamp, owner, name, entry FROM changes
          WHERE (stamp, owner, name) > (?, ?, ?) AND stamp <= ?
          ORDER BY stamp, owner, name LIMIT ?`,
      )
      .all(from.stamp, from.owner, from.name, last, limit + 1) as {
      stamp: string;
      owner: string;
      name: string;
      entry: string;
    }[];
    return {
      entries: rows.slice(0, limit).map((r) => ({
        stamp: r.stamp,
        owner: r.owner,
        name: r.name,
        entry: JSON.parse(r.entry) as ChangeEntry,
      })),
      more: rows.length > limit,
      through,
    };
  }

  readThrough(through: string): void {
    this.transaction(() => {
      const held = this.meta("feed_through");
      if (held === undefined || Date.parse(through) > Date.parse(held)) {
        this.setMeta("feed_through", through);
      }
    });
  }

  readyAt(): string | undefined {
    return this.meta("ready_at");
  }

  caughtUpAt(): string | undefined {
    return this.meta("caught_up_at");
  }

  caughtUp(at: string): void {
    this.transaction(() => {
      if (this.meta("ready_at") === undefined) this.setMeta("ready_at", at);
      this.setMeta("caught_up_at", at);
    });
  }

  generation(): string {
    return this.meta("generation") ?? "0";
  }

  reset(): void {
    this.transaction(() => {
      this.setMeta("generation", crypto.randomUUID());
      this.db.run("DELETE FROM events_text");
      this.db.run("DELETE FROM events");
      this.db.run("DELETE FROM sessions");
      this.db.run("DELETE FROM seen");
      this.db.run("DELETE FROM feeds");
      this.db.run("DELETE FROM changes");
      this.db.run("DELETE FROM meta WHERE key IN ('ready_at', 'caught_up_at', 'feed_through')");
    });
  }
}
