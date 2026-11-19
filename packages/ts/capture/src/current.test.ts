import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { currentSession, readRecent, writeRecent } from "./current";
import { type CapturePaths, capturePaths } from "./paths";
import type { CaptureState } from "./state";

let dir: string;
let paths: CapturePaths;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-current-"));
  paths = capturePaths({ env: { XDG_STATE_HOME: dir }, home: dir, platform: "linux" });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const now = new Date("2026-11-17T12:00:00Z");

function state(sessions: Record<string, { cwd: string; last_seen: string; parent?: string }>) {
  return {
    schema: 1,
    agents: {},
    sessions: Object.fromEntries(
      Object.entries(sessions).map(([id, s]) => [
        `cursor:${id}`,
        {
          agent: "cursor",
          session_id: id,
          cwd: s.cwd,
          first_seen: s.last_seen,
          last_seen: s.last_seen,
          ...(s.parent ? { parent_session_id: s.parent } : {}),
        },
      ]),
    ),
  } as unknown as CaptureState;
}

describe("the last conversation prompted in a folder", () => {
  it("is kept per agent and folder, read for any folder at or above it, newest first", () => {
    writeRecent(paths, {
      agent: "cursor",
      session_id: "a",
      cwd: "/w/app",
      at: "2026-11-17T10:00:00Z",
    });
    writeRecent(paths, {
      agent: "cursor",
      session_id: "b",
      cwd: "/w/app",
      at: "2026-11-17T11:00:00Z",
    });
    writeRecent(paths, {
      agent: "cursor",
      session_id: "c",
      cwd: "/w/app/pkg",
      at: "2026-11-17T09:00:00Z",
    });
    writeRecent(paths, {
      agent: "codex",
      session_id: "x",
      cwd: "/w/app",
      at: "2026-11-17T11:30:00Z",
    });
    expect(readRecent(paths, "cursor", ["/w/app"], "linux").map((r) => r.session_id)).toEqual([
      "b",
      "c",
    ]);
    expect(readRecent(paths, "cursor", ["/elsewhere"], "linux")).toEqual([]);
  });
});

describe("which conversation an editor is on", () => {
  const recent = [
    { agent: "cursor", session_id: "p1", cwd: "/w/app", at: "2026-11-17T11:00:00Z" },
    { agent: "cursor", session_id: "p2", cwd: "/w/app", at: "2026-11-17T10:00:00Z" },
  ];
  const base = { agent: "cursor", folders: ["/w/app"], now, platform: "linux" as const };

  it("is the one the editor says has focus", () => {
    const got = currentSession({
      ...base,
      state: undefined,
      recent,
      focused: "f",
      selected: ["f", "p1"],
    });
    expect(got.session).toEqual({ session_id: "f", by: "focused" });
    expect(got.candidates.map((c) => c.session_id)).toEqual(["p1"]);
  });

  it("else the only one open, else the last prompted of those open", () => {
    expect(currentSession({ ...base, state: undefined, recent, selected: ["s"] }).session).toEqual({
      session_id: "s",
      by: "selected",
    });
    expect(
      currentSession({ ...base, state: undefined, recent, selected: ["p2", "zz"] }).session,
    ).toEqual({ session_id: "p2", by: "prompt", at: recent[1]?.at });
    expect(
      currentSession({ ...base, state: undefined, recent: [], selected: ["q", "r"] }).session,
    ).toEqual({ session_id: "q", by: "selected" });
  });

  it("else the last prompted here, else the one seen most recently here in the past day", () => {
    expect(currentSession({ ...base, state: undefined, recent }).session).toEqual({
      session_id: "p1",
      by: "prompt",
      at: recent[0]?.at,
    });
    const seen = state({
      old: { cwd: "/w/app", last_seen: "2026-11-15T12:00:00Z" },
      new: { cwd: "/w/app/pkg", last_seen: "2026-11-17T11:30:00Z" },
      sub: { cwd: "/w/app", last_seen: "2026-11-17T11:59:00Z", parent: "new" },
      far: { cwd: "/other", last_seen: "2026-11-17T11:59:00Z" },
    });
    expect(currentSession({ ...base, state: seen, recent: [] })).toEqual({
      session: { session_id: "new", by: "recent", at: "2026-11-17T11:30:00Z" },
      candidates: [],
    });
    expect(currentSession({ ...base, state: undefined, recent: [] })).toEqual({ candidates: [] });
  });
});
