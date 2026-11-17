import { closeSync, openSync, readdirSync, readSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import {
  type CaptureAgent,
  type CaptureHost,
  expandTilde,
  handedTranscriptPath,
  type StoredSession,
  type SweepPath,
  type TranscriptInfo,
} from "@seshi/kit";
import { readText, writePrivateFile } from "./files";

export const HEAD_BYTES = 64 * 1024;

export interface FoundTranscript {
  agent: CaptureAgent;
  path: string;
  info: TranscriptInfo;
  size: number;
  mtimeMs: number;
  /** When the session started: its first record's time, else the file's birth time, else its
   * modification time. */
  startedMs: number;
  /** For a session found in the agent's own store (`CaptureAgent.stored`) whose copy at `path` is
   * missing or older than the store: writes that copy, as the agent's hook would have. Call it
   * only for a session that is captured: one turned off never reaches the disk. */
  keep?(): void;
}

export interface SweepOptions {
  /** Told why an agent's store could not be read (its sessions there are left out). */
  onProblem?(message: string): void;
}

/** The first `HEAD_BYTES` of a file as text; empty when it cannot be read. */
export function readHead(path: string, bytes = HEAD_BYTES): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(bytes);
    const n = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, n).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** What `agent` says a transcript is; null for one it cannot read (an agent's `identify` that
 * throws on a file it does not expect is treated as "not mine"). */
export function identifySafely(
  agent: CaptureAgent,
  path: string,
  head: string,
): TranscriptInfo | null {
  try {
    return agent.identify(path, head);
  } catch {
    return null;
  }
}

export function sweepRoot(path: SweepPath, host: CaptureHost): string {
  return path.resolve ? path.resolve(host) : expandTilde(path.root, host.home);
}

/** Files at exactly the depths `path` names below its root that it says are transcripts, with
 * their paths relative to the root (`/`-separated). */
export function transcriptFiles(
  path: SweepPath,
  root: string,
): { file: string; relative: string }[] {
  const out: { file: string; relative: string }[] = [];
  const deepest = Math.max(...path.depths);
  const walk = (dir: string, relative: string, depth: number) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relative === "" ? entry.name : `${relative}/${entry.name}`;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < deepest) walk(full, rel, depth + 1);
      } else if (entry.isFile() && path.depths.includes(depth) && path.match(rel)) {
        out.push({ file: full, relative: rel });
      }
    }
  };
  walk(root, "", 1);
  return out;
}

function startedMs(info: TranscriptInfo, birthtimeMs: number, mtimeMs: number): number {
  const fromRecord = info.started_at ? Date.parse(info.started_at) : Number.NaN;
  if (Number.isFinite(fromRecord)) return fromRecord;
  return birthtimeMs > 0 ? birthtimeMs : mtimeMs;
}

/** Every transcript of `agent` that started at or after `sinceMs`: its files, and the sessions
 * in its own store (`CaptureAgent.stored`) that are newer than seshi's copy of them, or that seshi
 * has no copy of. A session is found once, whichever way. */
export async function sweepAgent(
  agent: CaptureAgent,
  host: CaptureHost,
  sinceMs: number,
  options: SweepOptions = {},
): Promise<FoundTranscript[]> {
  const found = sweepFiles(agent, host, sinceMs);
  if (!agent.stored) return found;
  let stored: StoredSession[];
  try {
    stored = await agent.stored(host, sinceMs);
  } catch (err) {
    options.onProblem?.((err as Error).message);
    return found;
  }
  const at = new Map(found.map((f, i) => [f.info.session_id, i]));
  for (const session of stored) {
    const path = handedTranscriptPath(host, agent, session.info.session_id);
    if (!path) continue;
    // seshi's copy is as new as the store: the files above found it, or left it out for its age.
    const copied = statSync(path, { throwIfNoEntry: false })?.mtimeMs;
    if (copied !== undefined && copied >= session.updatedMs) continue;
    const started = startedMs(session.info, 0, session.updatedMs);
    if (started < sinceMs) continue;
    const entry: FoundTranscript = {
      agent,
      path,
      info: session.info,
      size: 0,
      mtimeMs: session.updatedMs,
      startedMs: started,
      keep: () => keepStored(path, session),
    };
    const i = at.get(session.info.session_id);
    if (i === undefined) found.push(entry);
    else found[i] = entry;
  }
  return found;
}

/** Write a stored session's transcript to seshi's copy, dated when the session last changed: a
 * copy that is already the same is left as it is, so nothing is sent again. */
function keepStored(path: string, session: StoredSession): void {
  const text = session.transcript();
  if (readText(path) !== text) writePrivateFile(path, text);
  const changed = new Date(session.updatedMs);
  utimesSync(path, changed, changed);
}

function sweepFiles(agent: CaptureAgent, host: CaptureHost, sinceMs: number): FoundTranscript[] {
  const found: FoundTranscript[] = [];
  for (const path of agent.sweep) {
    for (const { file } of transcriptFiles(path, sweepRoot(path, host))) {
      let stat: import("node:fs").Stats;
      try {
        stat = statSync(file);
      } catch {
        continue;
      }
      if (stat.mtimeMs < sinceMs || stat.size === 0) continue;
      const info = identifySafely(agent, file, readHead(file));
      if (!info) continue;
      const started = startedMs(info, stat.birthtimeMs, stat.mtimeMs);
      if (started < sinceMs) continue;
      found.push({
        agent,
        path: file,
        info,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        startedMs: started,
      });
    }
  }
  return found;
}
