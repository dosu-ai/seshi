/** The spool (F9.1): what hooks hand the uploader. Each entry is one small JSON file in
 * `spool/`, written to a temporary name and renamed, so the uploader never reads half of one
 * and no two writers share a file. Entries hold paths and ids, never transcript text (F9 Data):
 * the uploader reads the transcript itself, from where the session left off. */

import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDir } from "./files";
import type { CapturePaths } from "./paths";

export const SPOOL_VERSION = 1;

const WAKE_SUFFIX = ".wake.json";

/** One thing for the uploader to do. */
export type SpoolEntry =
  | {
      v: typeof SPOOL_VERSION;
      kind: "capture";
      at: string;
      agent: string;
      event: string;
      session_id: string;
      transcript_path?: string;
      cwd?: string;
      parent_session_id?: string;
      final?: boolean;
    }
  /** A hook skipped the session because a shared rule (the org's or the repo's) turns its
   * folder off: the uploader records the folder, so the session stays off wherever it goes
   * next (F9.5). No work of its own, so it starts no uploader. */
  | {
      v: typeof SPOOL_VERSION;
      kind: "seen";
      at: string;
      agent: string;
      session_id: string;
      cwd: string;
      transcript_path?: string;
      parent_session_id?: string;
    }
  /** A session was turned off: retract what was uploaded (F9.7). The state file says what; the
   * entry wakes the uploader, so a retraction waits in the spool while it is not running. */
  | { v: typeof SPOOL_VERSION; kind: "retract"; at: string; agent: string; session_id: string }
  /** Something changed that the uploader should look at now (a session turned back on). */
  | { v: typeof SPOOL_VERSION; kind: "wake"; at: string };

export interface SpoolItem {
  /** The entry's file name in the spool folder. */
  name: string;
  entry: SpoolEntry;
}

/** Add an entry to the spool. */
export function appendSpool(paths: CapturePaths, entry: SpoolEntry, now: Date = new Date()): void {
  ensurePrivateDir(paths.spool);
  const name = `${now.getTime().toString().padStart(14, "0")}-${randomBytes(6).toString("hex")}`;
  const temp = join(paths.spool, `.${name}.tmp`);
  writeFileSync(temp, JSON.stringify(entry), { mode: 0o600 });
  // A wake-up (or a folder seen) is no work of its own: its name says so, so the queue count
  // leaves it out.
  const idle = entry.kind === "wake" || entry.kind === "seen";
  renameSync(temp, join(paths.spool, `${name}${idle ? WAKE_SUFFIX : ".json"}`));
}

/** The entries waiting, oldest first. A file that is not an entry is skipped (and reported in
 * `unreadable`, so the uploader can remove it). */
export function readSpool(paths: CapturePaths): { items: SpoolItem[]; unreadable: string[] } {
  let names: string[];
  try {
    names = readdirSync(paths.spool);
  } catch {
    return { items: [], unreadable: [] };
  }
  const items: SpoolItem[] = [];
  const unreadable: string[] = [];
  for (const name of names.filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort()) {
    try {
      const entry = JSON.parse(readFileSync(join(paths.spool, name), "utf8")) as SpoolEntry;
      if (entry?.v !== SPOOL_VERSION || typeof entry.kind !== "string") throw new Error("bad");
      items.push({ name, entry });
    } catch {
      unreadable.push(name);
    }
  }
  return { items, unreadable };
}

/** How many entries with work in them are waiting (the status line's queue), without reading
 * them. */
export function spoolCount(paths: CapturePaths): number {
  try {
    return readdirSync(paths.spool).filter(
      (n) => n.endsWith(".json") && !n.endsWith(WAKE_SUFFIX) && !n.startsWith("."),
    ).length;
  } catch {
    return 0;
  }
}

/** Remove entries the uploader has taken in. */
export function removeSpool(paths: CapturePaths, names: readonly string[]): void {
  for (const name of names) rmSync(join(paths.spool, name), { force: true });
}
