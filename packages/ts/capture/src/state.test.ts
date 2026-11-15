import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendLog, LOG_MAX_BYTES, LockTimeout, withLock, writePrivateFile } from "./files";
import { type CapturePaths, captureDir, capturePaths } from "./paths";
import { appendSpool, readSpool, removeSpool, spoolCount } from "./spool";
import {
  type CaptureState,
  emptyState,
  endPause,
  isPaused,
  MAX_PAUSES,
  newSecret,
  pauseWindows,
  readState,
  StateUnreadable,
  sessionKey,
  stateFacts,
  updateState,
  uploadId,
} from "./state";
import {
  acquireUploaderLock,
  processAlive,
  readUploaderLock,
  STALE_MS,
  TAKEOVER_STALE_MS,
  uploaderRunning,
} from "./uploader-lock";

let dir: string;
let paths: CapturePaths;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-state-"));
  paths = capturePaths({ env: { XDG_STATE_HOME: dir }, home: "/nowhere", platform: "linux" });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("where capture keeps its files (F9.1)", () => {
  it("is ~/.local/state/seshi, XDG_STATE_HOME/seshi, or %LOCALAPPDATA%\\seshi", () => {
    expect(captureDir({ env: {}, home: "/home/a", platform: "linux" })).toBe(
      "/home/a/.local/state/seshi",
    );
    expect(captureDir({ env: {}, home: "/Users/a", platform: "darwin" })).toBe(
      "/Users/a/.local/state/seshi",
    );
    expect(captureDir({ env: { XDG_STATE_HOME: "/s" }, home: "/h", platform: "linux" })).toBe(
      "/s/seshi",
    );
    expect(
      captureDir({
        env: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" },
        home: "C:\\Users\\a",
        platform: "win32",
      }),
    ).toBe("C:\\Users\\a\\AppData\\Local\\seshi");
    expect(captureDir({ env: {}, home: "C:\\Users\\a", platform: "win32" })).toBe(
      "C:\\Users\\a\\AppData\\Local\\seshi",
    );
  });
});

describe("the state file (F9.5)", () => {
  it("is empty until written, then private", async () => {
    expect(readState(paths)).toEqual(emptyState());
    await updateState(paths, (s) => {
      s.sessions[sessionKey("claude-code", "s1")] = {
        agent: "claude-code",
        session_id: "s1",
        first_seen: "2026-11-01T00:00:00.000Z",
      };
    });
    expect(Object.keys(readState(paths).sessions)).toEqual(["claude-code:s1"]);
    if (process.platform !== "win32") expect(statSync(paths.state).mode & 0o777).toBe(0o600);
  });

  it("writes nothing when the step says so", async () => {
    await updateState(paths, () => false);
    expect(() => statSync(paths.state)).toThrow();
  });

  it("loses no update when writers race", async () => {
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        updateState(paths, (s) => {
          s.agents[`a${i}`] = { installed_at: "x" };
        }),
      ),
    );
    expect(Object.keys(readState(paths).agents)).toHaveLength(25);
  });

  it("refuses a file it cannot read, rather than starting over", async () => {
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.state, "{not json");
    expect(() => readState(paths)).toThrow(StateUnreadable);
    writeFileSync(paths.state, JSON.stringify({ schema: "other" }));
    expect(() => readState(paths)).toThrow(/move it aside/);
    await expect(updateState(paths, () => {})).rejects.toThrow(StateUnreadable);
  });

  it("knows a pause, timed or not", () => {
    const now = new Date("2026-11-01T12:00:00Z");
    expect(isPaused(emptyState(), now)).toBe(false);
    expect(isPaused({ ...emptyState(), paused: { at: "x" } }, now)).toBe(true);
    expect(
      isPaused({ ...emptyState(), paused: { at: "x", until: "2026-11-01T13:00:00Z" } }, now),
    ).toBe(true);
    expect(
      isPaused({ ...emptyState(), paused: { at: "x", until: "2026-11-01T11:00:00Z" } }, now),
    ).toBe(false);
  });

  it("keeps a pause that ended, at its own end or now, whichever came first", () => {
    const now = new Date("2026-11-01T12:00:00Z");
    const state: CaptureState = { ...emptyState(), paused: { at: "2026-11-01T10:00:00Z" } };
    endPause(state, now);
    expect(state.paused).toBeUndefined();
    expect(state.pauses).toEqual([{ at: "2026-11-01T10:00:00Z", until: now.toISOString() }]);
    state.paused = { at: "2026-11-01T12:30:00Z", until: "2026-11-01T13:00:00Z" };
    expect(pauseWindows(state)).toHaveLength(2);
    endPause(state, new Date("2026-11-01T14:00:00Z"));
    expect(state.pauses?.at(-1)).toEqual({
      at: "2026-11-01T12:30:00Z",
      until: "2026-11-01T13:00:00Z",
    });
    for (let i = 0; i < MAX_PAUSES + 5; i++) {
      state.paused = { at: now.toISOString() };
      endPause(state, now);
    }
    expect(state.pauses).toHaveLength(MAX_PAUSES);
  });

  it("gives the decision a session's pause facts: its stop, a parent's, the pause in force", () => {
    const now = new Date("2026-11-01T12:00:00Z");
    const state = {
      ...emptyState(),
      paused: { at: "2026-11-01T11:00:00Z" },
      sessions: {
        "a:p": {
          agent: "a",
          session_id: "p",
          first_seen: "x",
          stored: true,
          file_offset: 40,
          frozen: { at: "y", offset: 40 },
        },
        "a:c": {
          agent: "a",
          session_id: "c",
          first_seen: "x",
          parent_session_id: "p",
          stored: true,
          file_offset: 10,
        },
      },
    };
    expect(stateFacts(state, "a", state.sessions["a:p"], now)).toMatchObject({
      paused: true,
      pausedAt: "2026-11-01T11:00:00Z",
      frozen: 40,
      uploaded: 40,
      pauses: [{ at: "2026-11-01T11:00:00Z" }],
    });
    // A subagent of a stopped session is stopped at what it uploaded, by hook or sweep.
    expect(stateFacts(state, "a", state.sessions["a:c"], now)).toMatchObject({ frozen: 10 });
    expect(stateFacts(state, "a", undefined, now, "p")).toMatchObject({ frozen: 0 });
    expect(stateFacts(emptyState(), "a", undefined, now)).toEqual({ paused: false, uploaded: 0 });
  });

  it("names an upload after its retractions, and makes long random secrets", () => {
    expect(uploadId({ session_id: "s1" })).toBe("s1");
    expect(uploadId({ session_id: "s1", generation: 2 })).toBe("s1~2");
    const a = newSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newSecret()).not.toBe(a);
  });
});

describe("the spool (F9.1)", () => {
  it("keeps one file per entry, read back oldest first", () => {
    expect(readSpool(paths)).toEqual({ items: [], unreadable: [] });
    appendSpool(paths, { v: 1, kind: "wake", at: "b" }, new Date(2000));
    appendSpool(
      paths,
      { v: 1, kind: "capture", at: "a", agent: "codex", event: "notify", session_id: "t" },
      new Date(1000),
    );
    writeFileSync(join(paths.spool, "00000000000500-junk.json"), "nope");
    const { items, unreadable } = readSpool(paths);
    expect(items.map((i) => i.entry.kind)).toEqual(["capture", "wake"]);
    expect(unreadable).toEqual(["00000000000500-junk.json"]);
    expect(spoolCount(paths)).toBe(2);
    removeSpool(paths, [...items.map((i) => i.name), ...unreadable]);
    expect(spoolCount(paths)).toBe(0);
  });
});

describe("files", () => {
  it("writes private files whole", () => {
    const file = join(dir, "x", "y.json");
    writePrivateFile(file, "{}");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("takes over a lock its holder left, and times out on a live one", async () => {
    const target = join(dir, "t");
    writeFileSync(`${target}.~lock`, "dead");
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${target}.~lock`, old, old);
    expect(await withLock(target, () => "got it", { timeoutMs: 1000 })).toBe("got it");
    writeFileSync(`${target}.~lock`, "alive");
    await expect(withLock(target, () => "never", { timeoutMs: 50 })).rejects.toThrow(LockTimeout);
  });

  it("rolls the log over past its size", () => {
    appendLog(paths.log, "x".repeat(LOG_MAX_BYTES + 10));
    appendLog(paths.log, "next");
    expect(statSync(`${paths.log}.1`).size).toBeGreaterThan(LOG_MAX_BYTES);
    expect(statSync(paths.log).size).toBeLessThan(100);
  });
});

describe("one uploader per machine", () => {
  it("holds the lock until released; a second one waits its turn", () => {
    const first = acquireUploaderLock(paths);
    expect(first).not.toBeNull();
    expect(uploaderRunning(paths)).toBe(true);
    expect(acquireUploaderLock(paths)).toBeNull();
    first?.release();
    expect(uploaderRunning(paths)).toBe(false);
    expect(acquireUploaderLock(paths)).not.toBeNull();
  });

  it("takes over from a process that is gone, or one that stopped beating", () => {
    const now = new Date();
    const dead = acquireUploaderLock(paths, now, 2 ** 30);
    expect(dead).not.toBeNull();
    expect(processAlive(2 ** 30)).toBe(false);
    expect(uploaderRunning(paths, now)).toBe(false);
    const next = acquireUploaderLock(paths, now);
    expect(next).not.toBeNull();
    // The old holder finds out on its next beat and stops.
    expect(dead?.beat()).toBe(false);
    expect(next?.beat()).toBe(true);
    const later = new Date(Date.now() + STALE_MS + 1000);
    expect(uploaderRunning(paths, later)).toBe(false);
    const third = acquireUploaderLock(paths, later);
    expect(third).not.toBeNull();
    expect(readUploaderLock(paths)?.token).toBe(third?.lock.token);
    expect(next?.held()).toBe(false);
  });

  it("lets one taker at a time replace a stale lock (two uploaders started together)", () => {
    const now = new Date();
    const dead = acquireUploaderLock(paths, now, 2 ** 30);
    const guard = `${paths.uploader}.takeover`;
    // Another uploader is taking the stale lock over right now: this one gives way and leaves
    // the lock alone, instead of writing its own over it and both running.
    writeFileSync(guard, "other");
    expect(acquireUploaderLock(paths, now)).toBeNull();
    expect(readUploaderLock(paths)?.token).toBe(dead?.lock.token);
    // A guard left by a taker that died mid-takeover is cleared, and the next uploader takes over.
    const old = new Date(Date.now() - TAKEOVER_STALE_MS - 1000);
    utimesSync(guard, old, old);
    expect(acquireUploaderLock(paths, now)).toBeNull();
    const next = acquireUploaderLock(paths, now);
    expect(next?.held()).toBe(true);
    expect(() => statSync(guard)).toThrow();
    // Taken over, the lock is live: a second taker finds it so.
    expect(acquireUploaderLock(paths, now)).toBeNull();
    expect(next?.held()).toBe(true);
  });
});
