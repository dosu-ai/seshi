import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  type CaptureAgent,
  type CaptureHost,
  expandTilde,
  type SweepPath,
  type TranscriptInfo,
} from "@seshi/kit";

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

/** Every transcript of `agent` that started at or after `sinceMs`. */
export function sweepAgent(
  agent: CaptureAgent,
  host: CaptureHost,
  sinceMs: number,
): FoundTranscript[] {
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
