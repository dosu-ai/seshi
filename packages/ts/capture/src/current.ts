import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { tryReadJson, tryWritePrivateFile } from "./files";
import type { CapturePaths } from "./paths";
import { within } from "./rules";
import type { CaptureState } from "./state";

/** The conversation last prompted in a folder: written by an agent's prompt hook, read by an
 * editor's indicator to know which conversation is current when the editor cannot say. */
export interface RecentPrompt {
  agent: string;
  session_id: string;
  cwd: string;
  at: string;
}

const DAY_MS = 24 * 3600 * 1000;

function recentFile(paths: CapturePaths, agent: string, cwd: string): string {
  const key = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  return join(paths.recent, `${agent}-${key}.json`);
}

/** Record the prompt (atomically; a failure only loses the hint). */
export function writeRecent(paths: CapturePaths, record: RecentPrompt): boolean {
  return tryWritePrivateFile(recentFile(paths, record.agent, record.cwd), JSON.stringify(record));
}

/** Every record for `agent` whose folder is one of `folders` or inside one, newest first. */
export function readRecent(
  paths: CapturePaths,
  agent: string,
  folders: readonly string[],
  platform: NodeJS.Platform,
): RecentPrompt[] {
  let names: string[];
  try {
    names = readdirSync(paths.recent);
  } catch {
    return [];
  }
  const found: RecentPrompt[] = [];
  for (const name of names) {
    if (!name.startsWith(`${agent}-`) || !name.endsWith(".json")) continue;
    const record = tryReadJson(join(paths.recent, name)) as
      | Partial<RecentPrompt>
      | null
      | undefined;
    if (
      typeof record?.session_id !== "string" ||
      typeof record.cwd !== "string" ||
      typeof record.at !== "string" ||
      record.agent !== agent
    ) {
      continue;
    }
    const cwd = record.cwd;
    if (!folders.some((f) => within(cwd, f, platform))) continue;
    found.push(record as RecentPrompt);
  }
  return found.sort((a, b) => b.at.localeCompare(a.at));
}

export type CurrentBy = "focused" | "selected" | "prompt" | "recent";

export interface CurrentCandidate {
  session_id: string;
  by: CurrentBy;
  at?: string;
}

export interface CurrentInput {
  state: CaptureState | undefined;
  agent: string;
  folders: readonly string[];
  recent: readonly RecentPrompt[];
  /** The conversation the editor says has focus. */
  focused?: string;
  /** The conversations the editor says are open, in its order. */
  selected?: readonly string[];
  now: Date;
  platform: NodeJS.Platform;
}

export interface Current {
  session?: CurrentCandidate;
  candidates: CurrentCandidate[];
}

/** Which conversation an editor in `folders` is on: the one it says has focus; else the only one
 * it says is open; else the last prompted among those open (or at all); else the one seen most
 * recently in these folders in the past day. `candidates` lists the others it could be. */
export function currentSession(input: CurrentInput): Current {
  const { state, agent, folders, now, platform } = input;
  const selected = [...(input.selected ?? [])];
  const candidates: CurrentCandidate[] = [];
  const add = (c: CurrentCandidate) => {
    if (!candidates.some((x) => x.session_id === c.session_id)) candidates.push(c);
  };
  for (const id of selected) add({ session_id: id, by: "selected" });
  for (const r of input.recent) {
    if (selected.length === 0 || selected.includes(r.session_id)) {
      add({ session_id: r.session_id, by: "prompt", at: r.at });
    }
  }
  const seen = Object.values(state?.sessions ?? {})
    .filter(
      (s) =>
        s.agent === agent &&
        s.parent_session_id === undefined &&
        s.cwd !== undefined &&
        folders.some((f) => within(s.cwd as string, f, platform)) &&
        now.getTime() - Date.parse(s.last_seen ?? s.first_seen) < DAY_MS,
    )
    .sort((a, b) => (b.last_seen ?? "").localeCompare(a.last_seen ?? ""));
  if (selected.length === 0) {
    for (const s of seen) add({ session_id: s.session_id, by: "recent", at: s.last_seen });
  }
  const pick = (): CurrentCandidate | undefined => {
    if (input.focused) return { session_id: input.focused, by: "focused" };
    if (selected.length === 1) return { session_id: selected[0] as string, by: "selected" };
    const prompted = input.recent.find(
      (r) => selected.length === 0 || selected.includes(r.session_id),
    );
    if (prompted) return { session_id: prompted.session_id, by: "prompt", at: prompted.at };
    if (selected.length > 0) return { session_id: selected[0] as string, by: "selected" };
    const last = seen[0];
    return last ? { session_id: last.session_id, by: "recent", at: last.last_seen } : undefined;
  };
  const session = pick();
  return {
    ...(session ? { session } : {}),
    candidates: candidates.filter((c) => c.session_id !== session?.session_id).slice(0, 5),
  };
}
