import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectFormat } from "@seshi/formats";
import type { CaptureHost } from "@seshi/kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { identifyOpencodeExport, OPENCODE_CAPTURE } from "./capture";
import { opencodeDatabase, readOpencodeSession, storedOpencodeSessions } from "./db";
import { OPENCODE_FORMAT } from "./index";
import {
  addOpencodeTurn,
  type OpencodeExport,
  type OpencodeV2Session,
  opencodeSessionAt,
  writeOpencodeDb,
  writeOpencodeDbV2,
} from "./testing";

const EXPORT = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../testdata/transcripts/opencode-export.opencode.json"),
    "utf8",
  ),
) as OpencodeExport;
const DAY = 86_400_000;
type Row = Record<string, unknown>;

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
      /not an OpenCode database seshi can read \(no session_v2.parent_id/,
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

/** The fixture's conversation as OpenCode 2.x keeps it: a prompt, a step that reads a file, an
 * answer; and the markers 2.x writes around them. */
const V2: OpencodeV2Session = {
  session: {
    id: EXPORT.info.id,
    directory: "/repo/app",
    title: "Auth walkthrough",
    time: { created: 1790963932400, updated: 1790963941200 },
  },
  rows: [
    {
      id: "msg_v2_0",
      type: "model-switched",
      time: 1790963932440,
      data: {
        model: { id: "claude-haiku-4-5", providerID: "anthropic" },
        time: { created: 1790963932440 },
      },
    },
    {
      id: "msg_v2_1",
      type: "user",
      time: 1790963932445,
      data: {
        text: 'How does auth work? password: "hunter2secretvalue42"',
        time: { created: 1790963932445 },
      },
    },
    {
      id: "msg_v2_2",
      type: "assistant",
      time: 1790963934500,
      data: {
        agent: "build",
        model: { id: "claude-haiku-4-5", providerID: "anthropic" },
        content: [
          { type: "text", text: "Reading the auth module first." },
          {
            type: "tool",
            id: "toolu_0156L5aHDegRahdNMdG7zTv9",
            name: "read",
            state: {
              status: "completed",
              input: { filePath: "/repo/app/auth.ts" },
              content: [{ type: "text", text: "export const KEY = 1;" }],
            },
            time: { created: 1790963935000, ran: 1790963935000, completed: 1790963935100 },
          },
        ],
        finish: "tool-calls",
        cost: 0.001,
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1790963934500, completed: 1790963936000 },
      },
    },
    {
      id: "msg_v2_3",
      type: "assistant",
      time: 1790963937000,
      data: {
        agent: "build",
        model: { id: "claude-haiku-4-5", providerID: "anthropic" },
        content: [
          {
            type: "text",
            text: String(EXPORT.messages[2]?.parts[0]?.text),
          },
        ],
        finish: "stop",
        time: { created: 1790963937000, completed: 1790963941100 },
      },
    },
    {
      id: "msg_v2_4",
      type: "idle",
      time: 1790963941150,
      data: { outcome: "succeeded", time: { created: 1790963941150 } },
    },
  ],
};

/** The conversation a transcript normalizes to, without the times (1.x keeps a time per part,
 * 2.x per message). */
const conversation = (transcript: string) => {
  const normalized = OPENCODE_FORMAT.normalize(transcript);
  const records = Array.isArray(normalized) ? normalized : normalized.records;
  return records.map((record) => {
    const { timestamp: _t, ...rest } = record as unknown as Record<string, unknown>;
    return rest;
  });
};

describe("OpenCode 2.x's database", () => {
  it("rebuilds a 2.x session in 1.x's export shape, to the same conversation", () => {
    for (const parts of [false, true]) {
      rmSync(db, { force: true });
      writeOpencodeDbV2(db, [V2], { parts });
      const [found, ...rest] = storedOpencodeSessions(host, 0);
      expect(rest).toEqual([]);
      expect(found?.info).toEqual({
        session_id: EXPORT.info.id,
        cwd: "/repo/app",
        started_at: new Date(V2.session.time.created).toISOString(),
      });
      const text = found?.transcript() as string;
      expect(identifyOpencodeExport(`/x/${EXPORT.info.id}.json`, text)?.session_id).toBe(
        EXPORT.info.id,
      );
      expect(detectFormat([OPENCODE_FORMAT], text)).toBe("opencode");
      expect(conversation(text)).toEqual(conversation(JSON.stringify(EXPORT)));
      const doc = JSON.parse(text);
      // Usage stays on the step, as 1.x's step-finish part.
      expect(doc.messages[1].info).toMatchObject({
        role: "assistant",
        modelID: "claude-haiku-4-5",
      });
      expect(doc.messages[1].parts.at(-1)).toMatchObject({ type: "step-finish", cost: 0.001 });
      // The markers are left out.
      expect(doc.messages).toHaveLength(3);
    }
  });

  it("rebuilds every kind of 2.x row, with content inline and in session_part in one session", () => {
    const at = V2.session.time.created;
    const row = (id: string, type: string, data: Row, inline?: boolean) => ({
      id,
      type,
      time: at + Number(id.slice(-2)),
      data: { time: { created: at + Number(id.slice(-2)) }, ...data },
      ...(inline ? { inline } : {}),
    });
    const model = { id: "claude-haiku-4-5", providerID: "anthropic" };
    const shell = (exit: number | undefined, status: string) => ({
      shellID: "sh_1",
      command: "bun test",
      status,
      ...(exit === undefined ? {} : { exit }),
      output: { output: "1 pass", cursor: 6, size: 6, truncated: false },
    });
    const kinds: OpencodeV2Session = {
      session: { ...V2.session, id: "ses_kinds" },
      rows: [
        row("msg_k01", "user", { text: "Run the tests" }),
        // Written before OpenCode moved assistant content to session_part: still inline.
        row(
          "msg_k02",
          "assistant",
          { agent: "build", model, content: [{ type: "text", text: "Older answer" }] },
          true,
        ),
        row("msg_k03", "assistant", {
          agent: "build",
          model,
          content: [
            { type: "reasoning", text: "Thinking", time: { created: at, completed: at + 1 } },
            {
              type: "tool",
              id: "call_1",
              name: "bash",
              state: { status: "streaming", input: '{"command":"bun' },
              time: { created: at },
            },
            {
              type: "tool",
              id: "call_2",
              name: "read",
              state: {
                status: "error",
                input: { filePath: "/x" },
                error: { type: "fs", message: "no such file" },
              },
              time: { created: at, completed: at + 2 },
            },
          ],
        }),
        row("msg_k04", "shell", shell(0, "exited")),
        row("msg_k05", "shell", shell(1, "exited")),
        row("msg_k06", "shell", shell(undefined, "killed")),
        row("msg_k07", "compaction", {
          status: "completed",
          reason: "auto",
          summary: "So far: tests run",
        }),
        row("msg_k08", "compaction", { status: "running", reason: "auto", summary: "" }),
        row("msg_k09", "synthetic", { text: "A file changed" }),
        row("msg_k10", "skill", { skill: "sk_1", name: "review", text: "Review rules" }),
        row("msg_k11", "idle", { outcome: "succeeded" }),
      ],
    };
    writeOpencodeDbV2(db, [kinds], { parts: true });
    const doc = JSON.parse(storedOpencodeSessions(host, 0)[0]?.transcript() as string);
    const parts = (i: number) => doc.messages[i].parts as Row[];
    expect(doc.messages.map((m: { info: Row }) => [m.info.id, m.info.role])).toEqual([
      ["msg_k01", "user"],
      ["msg_k02", "assistant"],
      ["msg_k03", "assistant"],
      ["msg_k04", "assistant"],
      ["msg_k05", "assistant"],
      ["msg_k06", "assistant"],
      ["msg_k07", "assistant"],
      ["msg_k09", "user"],
      ["msg_k10", "user"],
    ]);
    expect(parts(1)).toMatchObject([{ type: "text", text: "Older answer" }]);
    expect(parts(2)).toMatchObject([
      { type: "reasoning", text: "Thinking" },
      {
        type: "tool",
        tool: "bash",
        state: { status: "running", input: { raw: '{"command":"bun' } },
      },
      { type: "tool", tool: "read", state: { status: "error", error: "no such file" } },
    ]);
    expect(parts(3)).toMatchObject([
      { tool: "shell", state: { status: "completed", output: "1 pass" } },
    ]);
    expect(parts(4)).toMatchObject([
      { tool: "shell", state: { status: "error", error: "exit 1" } },
    ]);
    expect(parts(5)).toMatchObject([
      { tool: "shell", state: { status: "error", error: "exit killed" } },
    ]);
    expect(doc.messages[6].info.summary).toBe(true);
    expect(parts(6)).toMatchObject([{ type: "text", text: "So far: tests run" }]);
    expect(parts(7)).toMatchObject([{ type: "text", text: "A file changed", synthetic: true }]);
    expect(parts(8)).toMatchObject([{ type: "text", text: "Review rules", synthetic: true }]);
  });

  it("reads a 2.x copy of a 1.x session only when the session went on in 2.x", () => {
    // OpenCode 2.x copied the 1.x session over, under the same message ids, and nothing more was
    // said: 1.x's copy is whole.
    const ids = new Map(
      ["msg_v2_1", "msg_v2_2", "msg_v2_3"].map((id, i) => [id, EXPORT.messages[i]?.info.id]),
    );
    const migrated = {
      ...V2,
      rows: V2.rows.map((row) => ({ ...row, id: ids.get(row.id) ?? row.id })),
    };
    writeOpencodeDbV2(db, [migrated], { v1: [EXPORT] });
    let [found] = storedOpencodeSessions(host, 0);
    expect(JSON.parse(found?.transcript() as string).messages[0].info.id).toBe(
      EXPORT.messages[0]?.info.id,
    );
    // Then a turn in 2.x: its copy holds the newer messages, which follow 1.x's whole copy of the
    // ones it copied over (2.x's keeps only each one's last step).
    rmSync(db, { force: true });
    rmSync(`${db}-wal`, { force: true });
    rmSync(`${db}-shm`, { force: true });
    const later = {
      id: "msg_v2_5",
      type: "user",
      time: 1790963999000,
      data: { text: "And logout?", time: { created: 1790963999000 } },
    };
    writeOpencodeDbV2(db, [{ ...migrated, rows: [...migrated.rows, later] }], { v1: [EXPORT] });
    [found] = storedOpencodeSessions(host, 0);
    const doc = JSON.parse(found?.transcript() as string);
    expect(doc.messages.map((m: { info: { id: string } }) => m.info.id)).toEqual([
      ...EXPORT.messages.map((m) => m.info.id),
      "msg_v2_5",
    ]);
    expect(doc.messages.slice(0, -1)).toEqual(JSON.parse(JSON.stringify(EXPORT.messages)));
    expect(found?.updatedMs).toBe(1790963999000);
  });

  it("keeps seshi's copy when OpenCode 1.x works out a prompt's file changes after the turn", () => {
    writeOpencodeDb(db, [EXPORT]);
    const copy = storedOpencodeSessions(host, 0)[0]?.transcript() as string;
    const write = new Database(db);
    write
      .query(
        `UPDATE message SET data = json_set(data, '$.summary', json(?)),
           time_updated = time_updated + 5000 WHERE id = ?`,
      )
      .run(
        JSON.stringify({ diffs: [{ file: "auth.ts", additions: 1, deletions: 0 }] }),
        EXPORT.messages[0]?.info.id as string,
      );
    write.close();
    const [found] = storedOpencodeSessions(host, 0);
    expect(JSON.parse(found?.transcript() as string).messages[0].info.summary).toBeDefined();
    expect(found?.transcript(copy)).toBe(copy);
  });

  it("sweeps each channel's own database too, and skips an early preview's", () => {
    writeOpencodeDb(db, [EXPORT]);
    const data = join(home, ".local", "share", "opencode");
    writeOpencodeDbV2(join(data, "opencode-local.db"), [
      { ...V2, session: { ...V2.session, id: "ses_channel" } },
    ]);
    const preview = new Database(join(data, "opencode-next.db"), { create: true });
    preview.run("CREATE TABLE session (id text PRIMARY KEY)");
    preview.run("CREATE TABLE session_message (id text PRIMARY KEY)");
    preview.close();
    expect(storedOpencodeSessions(host, 0).map((s) => s.info.session_id)).toEqual([
      EXPORT.info.id,
      "ses_channel",
    ]);
    // OPENCODE_DB names the one database OpenCode uses.
    host.env = { OPENCODE_DB: db };
    expect(storedOpencodeSessions(host, 0).map((s) => s.info.session_id)).toEqual([EXPORT.info.id]);
  });

  it("keeps seshi's copy when OpenCode only totals the session after the turn", () => {
    writeOpencodeDbV2(db, [V2]);
    const copy = storedOpencodeSessions(host, 0)[0]?.transcript() as string;
    const write = new Database(db);
    write.run(
      "UPDATE session_v2 SET cost = 0.25, tokens_input = 900, summary_additions = 3, time_updated = time_updated + 5000",
    );
    expect(storedOpencodeSessions(host, 0)[0]?.transcript(copy)).toBe(copy);
    // A new title is something to send.
    write.run("UPDATE session_v2 SET title = 'Login page fix'");
    write.close();
    const retitled = storedOpencodeSessions(host, 0)[0]?.transcript(copy) as string;
    expect(JSON.parse(retitled).info.title).toBe("Login page fix");
  });

  it("chooses between the copies before the cutoff, so a cutoff never picks the lossy one", () => {
    writeOpencodeDbV2(db, [V2], { v1: [EXPORT] });
    const [whole] = storedOpencodeSessions(host, 0);
    const cutoff = (whole?.updatedMs as number) + 1;
    // Only 2.x's copy changed after the cutoff (OpenCode retitled it), with nothing new said: the
    // session is 1.x's copy, which has not changed since.
    for (const file of [db, `${db}-wal`, `${db}-shm`]) rmSync(file, { force: true });
    const retitled = {
      ...V2,
      session: { ...V2.session, time: { ...V2.session.time, updated: cutoff + DAY } },
    };
    writeOpencodeDbV2(db, [retitled], { v1: [EXPORT] });
    expect(storedOpencodeSessions(host, cutoff)).toEqual([]);
    expect(storedOpencodeSessions(host, 0).map((s) => s.updatedMs)).toEqual([whole?.updatedMs]);
  });

  it("reads one session for the hook, from the channel's own database", () => {
    const channel = join(home, ".local", "share", "opencode", "opencode-local.db");
    writeOpencodeDbV2(channel, [V2]);
    expect(() => readOpencodeSession(host, EXPORT.info.id)).toThrow("no OpenCode database");
    const read = readOpencodeSession(host, EXPORT.info.id, "local");
    expect(read.changedMs).toBe(V2.session.time.updated);
    expect(JSON.parse(read.transcript).info.id).toBe(EXPORT.info.id);
    expect(() => readOpencodeSession(host, "ses_nope", "local")).toThrow("has no messages");
    // Unless OpenCode was told to keep every channel in opencode.db.
    host.env = { OPENCODE_DISABLE_CHANNEL_DB: "1" };
    expect(opencodeDatabase(host, "local")).toBeUndefined();
    writeOpencodeDbV2(db, [V2]);
    expect(opencodeDatabase(host, "local")).toBe(db);
  });

  it("does not take OpenCode 2.x's own export (flat message rows) for 1.x's", () => {
    const own = JSON.stringify({
      info: { id: V2.session.id, location: { directory: "/repo/app" } },
      messages: V2.rows.map((row) => ({ id: row.id, type: row.type, ...row.data })),
    });
    expect(detectFormat([OPENCODE_FORMAT], own)).toBeNull();
    expect(detectFormat([OPENCODE_FORMAT], JSON.stringify(EXPORT))).toBe("opencode");
    expect(detectFormat([OPENCODE_FORMAT], '{"info":{"id":"ses_x"},"messages":[]}')).toBe(
      "opencode",
    );
  });

  it("refuses an early 2.x preview database, which OpenCode 2.x imports itself", () => {
    mkdirSync(join(db, ".."), { recursive: true });
    const preview = new Database(db, { create: true });
    preview.run("CREATE TABLE session (id text PRIMARY KEY)");
    preview.run("CREATE TABLE session_message (id text PRIMARY KEY)");
    preview.close();
    expect(() => storedOpencodeSessions(host, 0)).toThrow(/early OpenCode 2.x preview database/);
  });
});
