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

export interface ServerView {
  mode: "server" | "serverless";
  where: string;
  getSession(agent: string, sessionId: string): Promise<SessionMetadata | null>;
  pointer?(agent: string, sessionId: string): Promise<SessionMetadata | null>;
  getTrace(agent: string, sessionId: string, hash: string): Promise<StoredTrace | null>;
  reviews(agent: string, sessionId: string): Promise<ReviewDecision[] | null>;
  changes?(since: string, limit: number): Promise<{ key: string; entry: ChangeEntry }[]>;
  search(q: string, agent: string): Promise<SearchResults>;
}

export interface AgentInfo {
  name: string;
  format: string;
  encoding: "jsonl" | "json";
  chunkable: boolean;
  identify(path: string): string | undefined;
  locate?(sessionId: string): string | undefined;
}

export interface FileReader {
  stat(path: string): { size: number; mtimeMs: number } | null;
  read(path: string, end: number): string;
}

export interface Normalizer {
  records(format: string, text: string): NormalizedRecord[];
  version(format: string): string | undefined;
  stale(format: string, builtWith: string | undefined): boolean;
}

export interface Residue {
  index: number;
  rules: string[];
}

export interface Redaction {
  rule_set: string;
  origin: string;
  transcript(text: string, encoding: "jsonl" | "json"): string;
  records(records: readonly NormalizedRecord[]): NormalizedRecord[];
  residue(records: readonly NormalizedRecord[]): Residue[];
}

export interface DoctorDeps {
  now(): Date;
  state(): CaptureState;
  judge(state: CaptureState, agent: string, entry: SessionState | undefined): Decision;
  agent(name: string): AgentInfo | undefined;
  files: FileReader;
  spool(): SpoolItem[];
  log(): string[];
  uploaderRunning(): boolean;
  server?: ServerView;
  serverError?: Failure & { exit?: number };
  normalizer: Normalizer;
  redaction: Redaction;
}

export function failureOf(err: unknown): Failure & { exit?: number } {
  try {
    const known = classify(err);
    if (known) return { code: known.code, message: known.message, exit: known.exit };
  } catch {}
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error && err.name !== "Error" ? err.name : "error";
  return { code: name, message };
}

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
