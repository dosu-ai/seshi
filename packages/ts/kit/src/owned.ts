import { rmSync } from "node:fs";
import { readTextFile, writeFileAtomic } from "./files";

/** A file seshi writes whole into an agent's folder (pi's extension, OpenCode's plugin), known as
 * seshi's by `marker` in its text: rewritten by every install, so edits do not last. */
export interface OwnedFile {
  path: string;
  text: string;
  marker: string;
}

export interface OwnedFileState {
  path: string;
  present: boolean;
  ours: boolean;
  current: boolean;
}

export function ownedFileState(file: OwnedFile): OwnedFileState {
  const text = readTextFile(file.path);
  const ours = text?.includes(file.marker) === true;
  return { path: file.path, present: text !== undefined, ours, current: text === file.text };
}

/** Write each file that is missing or out of date. When any of them is someone else's, write none
 * and say which: the agent is then not captured. */
export function installOwnedFiles(
  files: readonly OwnedFile[],
  agent: string,
): { changed: string[]; foreign: string[]; notes: string[] } {
  const states = files.map(ownedFileState);
  const foreign = states.filter((s) => s.present && !s.ours).map((s) => s.path);
  if (foreign.length > 0) {
    return {
      changed: [],
      foreign,
      notes: foreign.map(
        (path) => `${path} is not seshi's: left alone, so ${agent} is not captured`,
      ),
    };
  }
  const changed: string[] = [];
  files.forEach((file, i) => {
    if (states[i]?.current) return;
    writeFileAtomic(file.path, file.text);
    changed.push(file.path);
  });
  return { changed, foreign, notes: [] };
}

/** Remove each file that is seshi's; leave anyone else's. */
export function removeOwnedFiles(files: readonly OwnedFile[]): string[] {
  const removed: string[] = [];
  for (const file of files) {
    if (!ownedFileState(file).ours) continue;
    rmSync(file.path, { force: true });
    removed.push(file.path);
  }
  return removed;
}

/** What `capture status` says of the files: someone else's, or seshi's but out of date. */
export function ownedFileNotes(states: readonly OwnedFileState[], agent: string): string[] {
  return states.flatMap((s) => {
    if (s.present && !s.ours) return [`${s.path} is not seshi's`];
    if (s.ours && !s.current)
      return [`${s.path} is out of date: run seshi capture install ${agent}`];
    return [];
  });
}
