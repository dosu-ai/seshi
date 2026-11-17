import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaptureHost } from "@seshi/kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { identifyOpencodeExport, OPENCODE_CAPTURE } from "./capture";
import { opencodeDatabase, storedOpencodeSessions } from "./db";
import {
  addOpencodeTurn,
  type OpencodeExport,
  opencodeSessionAt,
  writeOpencodeDb,
} from "./testing";

const EXPORT = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../testdata/transcripts/opencode-export.opencode.json"),
    "utf8",
  ),
) as OpencodeExport;
const DAY = 86_400_000;

/** One more answer, at `at`, with ids of its own. */
const lateTurn = (at: number): OpencodeExport["messages"][number] => ({
  info: { id: `msg_late_${at}`, role: "assistant", time: { created: at, completed: at } },
  parts: [{ id: `prt_late_${at}`, type: "text", text: "And one more thing." }],
});

let home: string;
let host: CaptureHost;
let db: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "seshi-opencode-db-"));
  host = { env: {}, home, platform: "linux" };
  db = join(home, ".local", "share", "opencode", "opencode.db");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("OpenCode's database (the sweep's source for sessions never handed over)", () => {
  it("rebuilds a session as `opencode export` prints it, which the plugin hands over", () => {
    writeOpencodeDb(db, [EXPORT]);
    const [found, ...rest] = storedOpencodeSessions(host, 0);
    expect(rest).toEqual([]);
    expect(found?.info).toEqual({
      session_id: EXPORT.info.id,
      cwd: "/repo/app",
      started_at: new Date(EXPORT.info.time.created).toISOString(),
    });
    expect(found?.updatedMs).toBe(EXPORT.info.time.updated);
    const text = found?.transcript() as string;
    const doc = JSON.parse(text);
    expect(doc.info).toMatchObject(EXPORT.info);
    expect(doc.messages).toEqual(EXPORT.messages);
    // The copy seshi writes is one the file sweep and the uploader know as this session.
    expect(identifyOpencodeExport(`/x/${EXPORT.info.id}.json`, text)).toMatchObject({
      session_id: EXPORT.info.id,
      cwd: "/repo/app",
    });
  });

  it("finds what changed at or after the cutoff, a later turn included", () => {
    const now = Date.now();
    const old = opencodeSessionAt(EXPORT, "ses_old", now - 40 * DAY);
    const recent = opencodeSessionAt(EXPORT, "ses_recent", now - 2 * DAY);
    const empty = opencodeSessionAt(EXPORT, "ses_empty", now - DAY);
    writeOpencodeDb(db, [old, recent, { ...empty, messages: [] }]);
    const ids = (since: number) =>
      storedOpencodeSessions(host, since).map((s) => s.info.session_id);
    expect(ids(now - 30 * DAY)).toEqual(["ses_recent"]);
    expect(ids(now - 60 * DAY)).toEqual(["ses_old", "ses_recent"]);

    // A turn added to the old session today: it changed since the cutoff.
    addOpencodeTurn(db, "ses_old", lateTurn(now));
    const late = storedOpencodeSessions(host, now - 30 * DAY).find(
      (s) => s.info.session_id === "ses_old",
    );
    expect(late?.updatedMs).toBeGreaterThanOrEqual(now);
    expect(JSON.parse(late?.transcript() as string).messages).toHaveLength(4);
  });

  it("names a subagent's session's parent", () => {
    const child = opencodeSessionAt(EXPORT, "ses_child", Date.now());
    writeOpencodeDb(db, [{ ...child, info: { ...child.info, parentID: EXPORT.info.id } }]);
    expect(storedOpencodeSessions(host, 0)[0]?.info.parent_session_id).toBe(EXPORT.info.id);
  });

  it("finds the database where OpenCode does: XDG_DATA_HOME, OPENCODE_DB", () => {
    expect(opencodeDatabase(host)).toBeUndefined();
    const data = join(home, "data");
    host.env = { XDG_DATA_HOME: data };
    writeOpencodeDb(join(data, "opencode", "opencode.db"), [EXPORT]);
    expect(storedOpencodeSessions(host, 0)).toHaveLength(1);
    const elsewhere = join(home, "elsewhere.db");
    writeOpencodeDb(elsewhere);
    host.env = { XDG_DATA_HOME: data, OPENCODE_DB: elsewhere };
    expect(opencodeDatabase(host)).toBe(elsewhere);
    expect(storedOpencodeSessions(host, 0)).toEqual([]);
    host.env = { XDG_DATA_HOME: data, OPENCODE_DB: "opencode.db" };
    expect(opencodeDatabase(host)).toBe(join(data, "opencode", "opencode.db"));
  });

  it("finds nothing, quietly, where OpenCode keeps no database", async () => {
    expect(storedOpencodeSessions(host, 0)).toEqual([]);
    expect(await OPENCODE_CAPTURE.stored?.(host, 0)).toEqual([]);
  });

  it("refuses a database it does not know, saying so", () => {
    const other = new Database(join(home, "x.db"), { create: true });
    other.run("CREATE TABLE session_v2 (id text PRIMARY KEY)");
    other.close();
    host.env = { OPENCODE_DB: join(home, "x.db") };
    expect(() => storedOpencodeSessions(host, 0)).toThrow(
      /not an OpenCode database seshi can read \(no session table\)/,
    );
    writeOpencodeDb(db);
    const changed = new Database(db);
    changed.run("ALTER TABLE part DROP COLUMN data");
    changed.close();
    host.env = {};
    expect(() => storedOpencodeSessions(host, 0)).toThrow(/no part\.data/);
  });

  it("reads without writing, while OpenCode has the database open", () => {
    writeOpencodeDb(db, [EXPORT]);
    const running = new Database(db);
    running.run("PRAGMA journal_mode = WAL");
    // A turn OpenCode wrote that is still only in its write-ahead log.
    running
      .query(
        "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
      )
      .run("msg_wal", EXPORT.info.id, Date.now(), Date.now(), JSON.stringify({ role: "user" }));
    const before = statSync(db).mtimeMs;
    const [found] = storedOpencodeSessions(host, 0);
    expect(
      JSON.parse(found?.transcript() as string).messages.map(
        (m: { info: { id: string } }) => m.info.id,
      ),
    ).toContain("msg_wal");
    expect(statSync(db).mtimeMs).toBe(before);
    running.close();
  });
});
