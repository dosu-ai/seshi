import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EventRole } from "@seshi/model";
import type { IndexedEvent, IndexedLlmCall, IndexedSession } from "../backend";
import { SqliteIndex } from "../sqlite";

/** The `sql` tests' fixture index (not product code): two members, org and owner-only sessions,
 * a removed session, one outside the default window, and decoy files beside the index, each
 * holding a marker no answer may ever contain. */

export const DAY = 86_400_000;
/** The fixture's "now": this minute, since the examples ask SQLite for `datetime('now')`.
 * Sessions are placed relative to it. */
export const FIXTURE_NOW = Math.floor(Date.now() / 60_000) * 60_000;
export const DECOY_MARKER = "DECOY-7f3a9c";
export const SECRET_MARKER = "SECRET-b41e02";

const H = (n: number) => n.toString(16).padStart(64, "0");

export interface FixtureSession {
  owner: string;
  archive: string;
  visibility: "org" | "owner";
  repo: string;
  started: number;
  removed?: boolean;
}

/** Every session the fixture writes, removed ones included. */
export const FIXTURE_SESSIONS: readonly FixtureSession[] = [
  // alice: org sessions in two repos, one owner-only.
  {
    owner: "alice",
    archive: H(1),
    visibility: "org",
    repo: "github.com/acme/app",
    started: FIXTURE_NOW - 2 * DAY,
  },
  {
    owner: "alice",
    archive: H(2),
    visibility: "org",
    repo: "github.com/acme/api",
    started: FIXTURE_NOW - 3 * DAY,
  },
  {
    owner: "alice",
    archive: H(3),
    visibility: "owner",
    repo: "github.com/acme/app",
    started: FIXTURE_NOW - 4 * DAY,
  },
  // bob: an org session, an owner-only one, a removed one, one 90 days ago (outside 30 days).
  {
    owner: "bob",
    archive: H(4),
    visibility: "org",
    repo: "github.com/acme/app",
    started: FIXTURE_NOW - 1 * DAY,
  },
  {
    owner: "bob",
    archive: H(5),
    visibility: "owner",
    repo: "github.com/acme/secret",
    started: FIXTURE_NOW - 1 * DAY,
  },
  {
    owner: "bob",
    archive: H(6),
    visibility: "org",
    repo: "github.com/acme/app",
    started: FIXTURE_NOW - 2 * DAY,
    removed: true,
  },
  {
    owner: "bob",
    archive: H(7),
    visibility: "org",
    repo: "github.com/acme/old",
    started: FIXTURE_NOW - 90 * DAY,
  },
];

/** The events each session gets: enough for the three examples' thresholds on two of them. */
export function eventsOf(s: FixtureSession, n: number): IndexedEvent[] {
  const hash = H(100 + n);
  const out: IndexedEvent[] = [];
  const push = (role: EventRole, text: string, extra: Partial<IndexedEvent> = {}) => {
    const seq = out.length;
    out.push({
      content_hash: hash,
      event_index: seq,
      seq,
      role,
      text,
      chars: text.length,
      timestamp: s.started + seq * 1000,
      ...extra,
    });
  };
  // Session 1: 12 prompts, 3 tool calls (example 3); 25 Bash results, 7 failed (example 2).
  // Session 4: 25 Bash results, 2 failed. Others: a few of each.
  const prompts = n === 1 ? 12 : 2;
  const results = n === 1 || n === 4 ? 25 : 3;
  const failed = n === 1 ? 7 : n === 4 ? 2 : 1;
  for (let i = 0; i < prompts; i++) push("user", `prompt ${i} for ${s.repo}`);
  for (let i = 0; i < (n === 1 ? 3 : 4); i++) {
    push("tool_call", `bun test ${i}`, { tool_name: "Bash", tool_call_id: `c${i}` });
  }
  for (let i = 0; i < results; i++) {
    const ok = i >= failed;
    push("tool_result", ok ? "pass" : `FAIL case ${i}`, {
      tool_name: "Bash",
      tool_call_id: `c${i}`,
      ok,
    });
  }
  // Only bob's owner-only session holds the secret: no answer to alice may ever contain it.
  push(
    "assistant",
    s.visibility === "owner"
      ? `private plan${s.owner === "bob" ? ` ${SECRET_MARKER}` : ""}`
      : "done",
  );
  return out;
}

export function callsOf(s: FixtureSession, n: number): IndexedLlmCall[] {
  return [0, 1].map((i) => ({
    content_hash: H(100 + n),
    call_id: `m${i}`,
    model: i === 0 ? "claude-opus-5-5" : "claude-haiku-5-5",
    provider: "anthropic",
    started_at: s.started + i * 60_000,
    ended_at: s.started + i * 60_000 + 2_000,
    duration_ms: 2_000,
    input_tokens: 100 * n,
    output_tokens: 10 * n,
    total_tokens: 110 * n,
  }));
}

export function fixtureSession(s: FixtureSession, n: number): IndexedSession {
  return {
    owner: s.owner,
    archive_id: s.archive,
    format: "claude-code",
    session_id: `s${n}`,
    repo: s.repo,
    branch: "main",
    models: ["claude-opus-5-5", "claude-haiku-5-5"],
    labels: { team: n % 2 === 0 ? "core" : "web" },
    visibility: s.visibility,
    started_at: s.started,
    ended_at: s.started + 3_600_000,
    updated_at: new Date(s.started + 3_600_000).toISOString(),
    traces: [H(100 + n)],
    event_count: eventsOf(s, n).length,
  };
}

/** Build the fixture index in `dir` (the index at `dir/index.sqlite`) with the decoys beside it:
 * a CSV, a SQLite file, a fake credentials file and a folder named like a Lance table. Returns
 * the index's path. */
export async function buildFixture(dir: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "index.sqlite");
  const index = new SqliteIndex({
    path,
    deployment: "fixture",
    events: ["user", "assistant", "tool_call", "tool_result"],
  });
  FIXTURE_SESSIONS.forEach((s, i) => {
    const n = i + 1;
    index.apply({
      session: fixtureSession(s, n),
      events: eventsOf(s, n),
      llm_calls: callsOf(s, n),
      replace: true,
    });
    if (s.removed) index.remove(s.owner, s.archive, 1);
  });
  await index.passDone(await index.generation(), new Date(FIXTURE_NOW).toISOString());
  await index.close();
  writeFileSync(join(dir, "decoy.csv"), `a,b\n${DECOY_MARKER},1\n`);
  writeFileSync(join(dir, "credentials.json"), JSON.stringify({ secret: DECOY_MARKER }));
  mkdirSync(join(dir, "decoy.lance"), { recursive: true });
  writeFileSync(join(dir, "decoy.lance", "data.txt"), DECOY_MARKER);
  const decoy = new Database(join(dir, "decoy.sqlite"), { create: true });
  decoy.run("CREATE TABLE secrets (value TEXT)");
  decoy.run(`INSERT INTO secrets VALUES ('${DECOY_MARKER}')`);
  decoy.close();
  return path;
}

/** The sessions a caller sees in a window: what every `owner`/`archive_id` pair an answer
 * returns must be one of. `own` empty and `everything` true for an admin. */
export function visiblePairs(
  viewer: { everything: boolean; own: readonly string[] },
  window: { since: number; until: number },
): Set<string> {
  const pairs = new Set<string>();
  for (const s of FIXTURE_SESSIONS) {
    if (s.removed) continue;
    const ended = s.started + 3_600_000;
    if (!(s.started < window.until && ended >= window.since)) continue;
    if (!viewer.everything && s.visibility !== "org" && !viewer.own.includes(s.owner)) continue;
    pairs.add(`${s.owner}/${s.archive}`);
  }
  return pairs;
}
