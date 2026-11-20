import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDir } from "./files";
import type { CapturePaths } from "./paths";

export const SPOOL_VERSION = 1;

const NO_WORK_SUFFIX = ".wake.json";

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
      /** The commit `HEAD` named when the hook fired: what the session's lines up to here were
       * written at. */
      commit?: string;
      harness_version?: string;
      model?: string;
      /** The session's labels, resolved by a hook that saw it first (the state held none). */
      labels?: Record<string, string>;
    }
  | {
      v: typeof SPOOL_VERSION;
      kind: "seen";
      at: string;
      agent: string;
      session_id: string;
      cwd: string;
      transcript_path?: string;
      parent_session_id?: string;
      /** The exclude-list entry that kept the session off, and the hook's reason: the session is
       * recorded as excluded for good (`SessionState.excluded`). */
      excluded?: { entry: string; from: "server" | "config"; reason: string };
    }
  | {
      v: typeof SPOOL_VERSION;
      kind: "paused";
      at: string;
      agent: string;
      session_id: string;
      cwd?: string;
      transcript_path?: string;
      parent_session_id?: string;
    }
  | { v: typeof SPOOL_VERSION; kind: "retract"; at: string; agent: string; session_id: string }
  | { v: typeof SPOOL_VERSION; kind: "wake"; at: string };

export interface SpoolItem {
  name: string;
  entry: SpoolEntry;
}

export function appendSpool(paths: CapturePaths, entry: SpoolEntry, now: Date = new Date()): void {
  ensurePrivateDir(paths.spool);
  const name = `${now.getTime().toString().padStart(14, "0")}-${randomBytes(6).toString("hex")}`;
  const temp = join(paths.spool, `.${name}.tmp`);
  writeFileSync(temp, JSON.stringify(entry), { mode: 0o600 });
  const noWork = entry.kind === "wake" || entry.kind === "seen" || entry.kind === "paused";
  renameSync(temp, join(paths.spool, `${name}${noWork ? NO_WORK_SUFFIX : ".json"}`));
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
      (n) => n.endsWith(".json") && !n.endsWith(NO_WORK_SUFFIX) && !n.startsWith("."),
    ).length;
  } catch {
    return 0;
  }
}

export function removeSpool(paths: CapturePaths, names: readonly string[]): void {
  for (const name of names) rmSync(join(paths.spool, name), { force: true });
}
