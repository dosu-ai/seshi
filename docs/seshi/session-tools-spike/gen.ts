// Writes the spike's data under <root>: an index folder shaped like each search backend, and
// files outside it that a locked-down DuckDB must not read.
//
//   <root>/index/lance/{events,sessions}.lance   LanceDB tables, columns as in lance.ts
//   <root>/index/sqlite/search.db                 the SQLite index's tables, WAL, FTS5 text
//   <root>/outside/secret.csv                     a file outside the index
//   <root>/outside/secret.lance                   a Lance table outside the index
//   <root>/outside/secret.db                      a SQLite file outside the index
//
// Usage: bun gen.ts <root> [sessions]
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";

const root = process.argv[2] ?? "data";
const sessionCount = Number(process.argv[3] ?? 2000);
rmSync(root, { recursive: true, force: true });
for (const dir of ["index/lance", "index/sqlite", "outside"]) mkdirSync(join(root, dir), { recursive: true });

const owners = ["alice", "bob", "carol", "dave"];
const roles = ["user", "assistant", "tool_call", "tool_result"];
const tools = ["Bash", "Read", "Edit", "Grep"];
const t0 = Date.parse("2026-11-01T00:00:00Z");

type Session = { owner: string; archive_id: string; visibility: string; started: number };
type Event = { owner: string; archive_id: string; seq: number; role: string; tool: string | null; ts: number; text: string };
const sessions: Session[] = [];
const events: Event[] = [];
for (let s = 0; s < sessionCount; s++) {
  const owner = owners[s % owners.length];
  const session = { owner, archive_id: `a${s}`, visibility: s % 5 === 0 ? "owner" : "org", started: t0 + s * 60_000 };
  sessions.push(session);
  for (let i = 0; i < 40; i++) {
    const role = roles[i % roles.length];
    events.push({
      owner,
      archive_id: session.archive_id,
      seq: i,
      role,
      tool: role.startsWith("tool") ? tools[i % tools.length] : null,
      ts: session.started + i * 1000,
      text: `${role} ${i} of ${owner}/${session.archive_id} ${"lorem ipsum ".repeat(i % 7)}`,
    });
  }
}

const db = await lancedb.connect(join(root, "index/lance"));
await db.createTable(
  "sessions",
  sessions.map((s) => ({
    id: `${s.owner}/${s.archive_id}`,
    owner: s.owner,
    archive_id: s.archive_id,
    visibility: s.visibility,
    started_at: s.started,
    removed: false,
  })),
);
await db.createTable(
  "events",
  events.map((e) => ({
    id: `${e.owner}/${e.archive_id}/h/${e.seq}`,
    owner: e.owner,
    archive_id: e.archive_id,
    event_index: e.seq,
    role: e.role,
    tool_name: e.tool ?? "",
    ts: e.ts,
    text: e.text,
    visibility: sessions[Number(e.archive_id.slice(1))].visibility,
  })),
);
const outside = await lancedb.connect(join(root, "outside"));
await outside.createTable("secret", [{ secret: "outside-lance-secret" }]);

const sqlite = new Database(join(root, "index/sqlite/search.db"));
sqlite.run("PRAGMA journal_mode = WAL");
sqlite.run(`CREATE TABLE sessions (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, archive_id TEXT NOT NULL,
  visibility TEXT NOT NULL, started_at INTEGER, removed INTEGER NOT NULL DEFAULT 0)`);
sqlite.run(`CREATE TABLE events (id INTEGER PRIMARY KEY, session INTEGER NOT NULL, content_hash TEXT NOT NULL,
  event_index INTEGER NOT NULL, role TEXT NOT NULL, tool_name TEXT, ts INTEGER)`);
sqlite.run(`CREATE VIRTUAL TABLE events_text USING fts5 (text, tokenize = 'unicode61 remove_diacritics 2')`);
const insertSession = sqlite.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, 0)");
const insertEvent = sqlite.prepare("INSERT INTO events VALUES (?, ?, 'h', ?, ?, ?, ?)");
const insertText = sqlite.prepare("INSERT INTO events_text (rowid, text) VALUES (?, ?)");
sqlite.transaction(() => {
  sessions.forEach((s, i) => insertSession.run(i + 1, s.owner, s.archive_id, s.visibility, s.started));
  events.forEach((e, i) => {
    insertEvent.run(i + 1, Number(e.archive_id.slice(1)) + 1, e.seq, e.role, e.tool, e.ts);
    insertText.run(i + 1, e.text);
  });
})();
sqlite.close();

const secretDb = new Database(join(root, "outside/secret.db"));
secretDb.run("CREATE TABLE secret (secret TEXT)");
secretDb.run("INSERT INTO secret VALUES ('outside-sqlite-secret')");
secretDb.close();
writeFileSync(join(root, "outside/secret.csv"), "secret\noutside-csv-secret\n");

console.log(`${sessions.length} sessions, ${events.length} events under ${root}`);
