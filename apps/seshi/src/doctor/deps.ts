/** What the doctor reads through: every loader `gatherEvidence` and `runChecks` use, so a test
 * fakes each one and `seshi explore` can hand in its own. `real.ts` builds them for this machine
 * from a command's context. Nothing here writes: no uploads, no state, no spool entries. */

import type { CaptureState, Decision, SessionState, SpoolItem } from "@seshi/capture";
import type { ReviewDecision } from "@seshi/client";
import type {
  ChangeEntry,
  NormalizedRecord,
  SearchResults,
  SessionMetadata,
  StoredTrace,
} from "@seshi/model";
import { classify } from "../cli/failures";
import type { Failure } from "./types";

/** What the doctor asks of a server, or of the local bucket: read-only. Built from a `Backend`
 * (`server.ts`). */
export interface ServerView {
  mode: "server" | "local";
  where: string;
  /** The session's metadata as readers get it (a stub is null). */
  getSession(agent: string, sessionId: string): Promise<SessionMetadata | null>;
  /** The pointer as stored, stubs included; only where the bucket can be read (local mode). */
  pointer?(agent: string, sessionId: string): Promise<SessionMetadata | null>;
  /** The trace `hash` of the session, in the canonical format. */
  getTrace(agent: string, sessionId: string, hash: string): Promise<StoredTrace | null>;
  reviews(agent: string, sessionId: string): Promise<ReviewDecision[] | null>;
  /** The caller's change entries since `since` (ISO 8601), oldest first; at most `limit`. */
  changes?(since: string, limit: number): Promise<{ key: string; entry: ChangeEntry }[]>;
  search(q: string, agent: string): Promise<SearchResults>;
}

/** A capture agent, as far as the doctor needs one. */
export interface AgentInfo {
  name: string;
  /** The format its transcripts are uploaded as: the server's `agent`. */
  format: string;
  encoding: "jsonl" | "json";
  chunkable: boolean;
  /** Which session the file at `path` belongs to, by the agent's own reading of its head;
   * undefined when it cannot tell. */
  identify(path: string): string | undefined;
  /** The transcript of a session no hook named a path for. */
  locate?(sessionId: string): string | undefined;
}

/** The transcript on disk. */
export interface FileReader {
  /** Size and modification time; null when there is no such file. Throws when it cannot be
   * read for another reason. */
  stat(path: string): { size: number; mtimeMs: number } | null;
  /** Its first `end` bytes, as UTF-8. */
  read(path: string, end: number): string;
}

/** The format registry, as the server's adapter would normalize. */
export interface Normalizer {
  /** The adapter's records of a whole log (meta record included); throws for a log the adapter
   * cannot read. */
  records(format: string, text: string): NormalizedRecord[];
  /** The adapter's version now (`FormatAdapter.version`); undefined for a format not read. */
  version(format: string): string | undefined;
  /** Whether a session built with `builtWith` is stale against it (X4.9). */
  stale(format: string, builtWith: string | undefined): boolean;
}

/** One record the rules would still change: a secret (or another rule's match) was stored. */
export interface Residue {
  /** The record's index in its trace. */
  index: number;
  /** The rules that fired; never what they matched. */
  rules: string[];
}

/** The redaction rules this machine knows, and what they do. */
export interface Redaction {
  /** The rule set's hash, as `metadata.redaction.rule_set` records one. */
  rule_set: string;
  /** Where the rules came from, in words. */
  origin: string;
  /** What the uploader does to a piece's text before sending it (F2.4); identity in local mode. */
  transcript(text: string, encoding: "jsonl" | "json"): string;
  /** The server's redaction stage over a log's records. */
  records(records: readonly NormalizedRecord[]): NormalizedRecord[];
  /** The records a pass of the rules would still change. */
  residue(records: readonly NormalizedRecord[]): Residue[];
}

export interface DoctorDeps {
  now(): Date;
  /** The state file; throws `StateUnreadable`. */
  state(): CaptureState;
  /** `decide` for the session, with the inputs every caller builds (`stateFacts`,
   * `otherFolders`, the CLI config's rules, the folders' repos). */
  judge(state: CaptureState, agent: string, entry: SessionState | undefined): Decision;
  agent(name: string): AgentInfo | undefined;
  files: FileReader;
  spool(): SpoolItem[];
  /** The capture log's lines, oldest first (the rotated file's included). */
  log(): string[];
  uploaderRunning(): boolean;
  /** Where to ask what was stored; absent when nothing can be asked (`serverError` says why). */
  server?: ServerView;
  serverError?: Failure & { exit?: number };
  normalizer: Normalizer;
  redaction: Redaction;
}

/** An error as a `Failure`, with the exit code a command would end with when it is one. */
export function failureOf(err: unknown): Failure & { exit?: number } {
  try {
    const known = classify(err);
    if (known) return { code: known.code, message: known.message, exit: known.exit };
  } catch {}
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error && err.name !== "Error" ? err.name : "error";
  return { code: name, message };
}

/** `run`'s value, or its error as a `Failure`. */
export async function attempt<T>(
  run: () => Promise<T> | T,
): Promise<{ value: T; error?: undefined } | { value?: undefined; error: Failure }> {
  try {
    return { value: await run() };
  } catch (err) {
    const { exit: _exit, ...failure } = failureOf(err);
    return { error: failure };
  }
}
