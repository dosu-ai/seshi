import { createHash } from "node:crypto";
import {
  type CaptureState,
  isPaused,
  type SessionState,
  sessionKey,
  uploadId,
} from "@seshi/capture";
import { isStub, type NormalizedRecord, type SessionMetadata, type Trace } from "@seshi/model";
import { attempt, type DoctorDeps, failureOf } from "./deps";
import {
  EVIDENCE_SCHEMA,
  MAX_LOG_LINES,
  type SearchEvidence,
  type SecretlessStateEntry,
  type SessionEvidence,
  type TraceEvidence,
  type TranscriptFacts,
} from "./types";

export interface Target {
  agent: string;
  session_id: string;
}

export interface GatherOptions {
  deep?: boolean;
}

const MAX_CHANGES = 5000;

export function localEntry(entry: SessionState): SecretlessStateEntry {
  const { secret, ...rest } = entry;
  return secret
    ? {
        ...rest,
        secret: {
          present: true,
          sha256: createHash("sha256").update(secret, "utf8").digest("hex"),
        },
      }
    : rest;
}

/** The id the session uploaded to before its last retraction. */
export function retractedUploadId(entry: Pick<SessionState, "session_id" | "generation">) {
  const generation = entry.generation ?? 0;
  if (generation === 0) return undefined;
  return uploadId({ session_id: entry.session_id, generation: generation - 1 });
}

function transcriptFacts(
  deps: DoctorDeps,
  agent: string,
  path: string | undefined,
): TranscriptFacts {
  if (path === undefined) return { exists: false };
  try {
    const stat = deps.files.stat(path);
    if (!stat) return { path, exists: false };
    const identified = deps.agent(agent)?.identify(path);
    return {
      path,
      exists: true,
      size: stat.size,
      mtime: new Date(stat.mtimeMs).toISOString(),
      ...(identified !== undefined ? { identified_as: identified } : {}),
    };
  } catch (err) {
    const { exit: _exit, ...error } = failureOf(err);
    return { path, exists: false, error };
  }
}

function textOf(record: NormalizedRecord): string {
  const content = (record as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : ((part as { text?: string })?.text ?? "")))
      .join(" ");
  }
  return "";
}

export function distinctiveTerm(records: readonly NormalizedRecord[]): string | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i] as NormalizedRecord;
    if (record.role === "meta") continue;
    const text = textOf(record).replace(/\[redacted:[^\]]*\]/g, " ");
    const words = text.match(/[A-Za-z][A-Za-z0-9_]{5,}/g) ?? [];
    let best: string | undefined;
    for (const word of words) if (!best || word.length > best.length) best = word;
    if (best) return best;
  }
  return undefined;
}

async function traceEvidence(
  deps: DoctorDeps,
  format: string,
  id: string,
  ref: SessionMetadata["traces"][number],
): Promise<TraceEvidence> {
  const base: TraceEvidence = {
    content_hash: ref.content_hash,
    listed_records: ref.records,
    ...(ref.rule_set ? { rule_set: ref.rule_set } : {}),
    ...(ref.continuation ? { continuation: ref.continuation } : {}),
    fetched: false,
  };
  const server = deps.server;
  if (!server) return base;
  const got = await attempt(() => server.getTrace(format, id, ref.content_hash));
  if (got.error) return { ...base, error: got.error };
  if (!got.value) {
    return { ...base, error: { code: "not_found", message: "the server has no such trace" } };
  }
  const trace = got.value as Trace;
  const records = Array.isArray(trace.records) ? (trace.records as NormalizedRecord[]) : [];
  return {
    ...base,
    fetched: true,
    record_count: records.length,
    starts_with_meta: records[0]?.role === "meta",
    ...(typeof trace.content_hash === "string" ? { stored_hash: trace.content_hash } : {}),
    records,
  };
}

export async function gatherEvidence(
  target: Target,
  deps: DoctorDeps,
  options: GatherOptions = {},
): Promise<SessionEvidence> {
  const now = deps.now();
  const key = sessionKey(target.agent, target.session_id);
  const info = deps.agent(target.agent);
  const evidence: SessionEvidence = {
    schema: EVIDENCE_SCHEMA,
    at: now.toISOString(),
    agent: target.agent,
    session_id: target.session_id,
    key,
    machine: {},
    transcript: { exists: false },
    spool: { entries: [] },
    log: { lines: [] },
    server: {
      mode: deps.server?.mode ?? "none",
      ...(deps.server ? { where: deps.server.where } : {}),
      sees_stubs: deps.server?.pointer !== undefined,
      traces: [],
    },
    ...(info
      ? { capture: { format: info.format, encoding: info.encoding, chunkable: info.chunkable } }
      : {}),
  };

  let state: CaptureState | undefined;
  try {
    state = deps.state();
  } catch (err) {
    const { exit: _exit, ...error } = failureOf(err);
    evidence.machine.state_error = error;
  }
  const entry = state?.sessions[key];
  if (state) {
    if (isPaused(state, now) && state.paused) evidence.machine.paused = state.paused;
    if (state.problems && Object.keys(state.problems).length > 0) {
      evidence.machine.problems = state.problems;
    }
    evidence.machine.uploader = { ...(state.uploader ?? {}), running: deps.uploaderRunning() };
    if (entry) evidence.local = localEntry(entry);
    if (entry?.parent_session_id) {
      evidence.parent = {
        session_id: entry.parent_session_id,
        known: state.sessions[sessionKey(target.agent, entry.parent_session_id)] !== undefined,
      };
    }
    const labelProblems = deps.labelProblems?.(entry) ?? [];
    if (labelProblems.length > 0) evidence.machine.label_problems = labelProblems;
    try {
      evidence.decision = deps.judge(state, target.agent, entry);
    } catch (err) {
      const { exit: _exit, ...error } = failureOf(err);
      evidence.machine.state_error ??= error;
    }
  }

  let path = entry?.path;
  if (path === undefined && info?.locate) {
    try {
      path = info.locate(target.session_id);
    } catch {}
  }
  evidence.transcript = transcriptFacts(deps, target.agent, path);
  const uploaded = evidence.transcript.exists ? info?.uploaded?.(target.session_id) : undefined;
  const stat = uploaded ? deps.files.stat(uploaded) : null;
  if (uploaded && stat) evidence.transcript.uploaded = { path: uploaded, size: stat.size };

  try {
    evidence.spool.entries = deps
      .spool()
      .filter(({ entry: e }) => {
        const named = e as { agent?: string; session_id?: string };
        return named.agent === target.agent && named.session_id === target.session_id;
      })
      .map(({ name, entry: e }) => ({
        name,
        kind: e.kind,
        at: e.at,
        ...("event" in e && typeof e.event === "string" ? { event: e.event } : {}),
      }));
  } catch (err) {
    const { exit: _exit, ...error } = failureOf(err);
    evidence.spool.error = error;
  }
  try {
    evidence.log.lines = deps
      .log()
      .filter((line) => line.includes(target.session_id))
      .slice(-MAX_LOG_LINES);
  } catch (err) {
    const { exit: _exit, ...error } = failureOf(err);
    evidence.log.error = error;
  }

  const server = deps.server;
  if (!server) {
    evidence.server.error = deps.serverError ?? {
      code: "no_server",
      message: "no server to ask (not signed in, and no serverless bucket)",
    };
    return evidence;
  }
  const format = info?.format ?? target.agent;
  const id = entry ? uploadId(entry) : target.session_id;
  evidence.server.agent = format;
  evidence.server.upload_id = id;
  const metadata = await attempt(() => server.getSession(format, id));
  if (metadata.error) evidence.server.metadata_error = metadata.error;
  else evidence.server.metadata = metadata.value;
  if (server.pointer) {
    const pointer = await attempt(() => server.pointer?.(format, id) ?? null);
    if (!pointer.error) evidence.server.pointer = pointer.value ?? null;
  }
  const previous = entry ? retractedUploadId(entry) : undefined;
  if (previous !== undefined) {
    const got = await attempt(() => server.getSession(format, previous));
    evidence.server.retracted = {
      upload_id: previous,
      metadata: got.value ?? null,
      ...(got.error ? { error: got.error } : {}),
    };
  }
  const stored = evidence.server.metadata ?? evidence.server.pointer ?? undefined;
  for (const ref of stored?.traces ?? []) {
    evidence.server.traces.push(await traceEvidence(deps, format, id, ref));
  }
  if (evidence.server.metadata?.head) {
    const reviews = await attempt(() => server.reviews(format, id));
    if (reviews.error) evidence.server.reviews_error = reviews.error;
    else evidence.server.reviews = reviews.value;
  }
  const archive = stored ?? evidence.server.retracted?.metadata ?? undefined;
  if (server.changes && archive) {
    const since = new Date(Date.parse(archive.created_at) - 1000).toISOString();
    const changes = await attempt(() => server.changes?.(since, MAX_CHANGES) ?? []);
    if (changes.error) evidence.server.changes_error = changes.error;
    else {
      evidence.server.changes = (changes.value ?? []).filter(
        (c) => c.entry.archive_id === archive.archive_id,
      );
    }
  }
  if (options.deep) {
    const search = await searchEvidence(evidence, deps, format);
    if (search) evidence.server.search = search;
  }
  return evidence;
}

async function searchEvidence(
  evidence: SessionEvidence,
  deps: DoctorDeps,
  format: string,
): Promise<SearchEvidence | undefined> {
  const server = deps.server;
  if (!server) return undefined;
  const metadata = evidence.server.metadata;
  let search: SearchEvidence;
  if (metadata?.head && metadata.status === "stored" && !isStub(metadata)) {
    const head = evidence.server.traces.find((t) => t.content_hash === metadata.head);
    const term = head?.records ? distinctiveTerm(head.records) : undefined;
    search = {
      upload_id: evidence.server.upload_id as string,
      expect: "found",
      ...(term ? { term, term_from: "stored trace" as const } : {}),
    };
  } else {
    const deleted =
      metadata?.status === "redacted"
        ? (evidence.server.upload_id as string)
        : evidence.server.retracted?.metadata?.status === "redacted" ||
            (evidence.server.retracted && evidence.server.retracted.metadata === null)
          ? evidence.server.retracted.upload_id
          : undefined;
    if (deleted === undefined) return undefined;
    let term: string | undefined;
    const path = evidence.transcript.path;
    if (path && evidence.transcript.exists && evidence.capture) {
      try {
        const text = deps.files.read(path, evidence.transcript.size ?? 0);
        term = distinctiveTerm(deps.normalizer.records(format, text));
      } catch {}
    }
    search = {
      upload_id: deleted,
      expect: "absent",
      ...(term ? { term, term_from: "transcript" as const } : {}),
    };
  }
  if (!search.term) {
    return { ...search, error: { code: "no_term", message: "found no word to search for" } };
  }
  const term = search.term;
  const got = await attempt(() => server.search(term, format));
  if (got.error) return { ...search, error: got.error };
  const results = got.value;
  return {
    ...search,
    found: results.results.some((r) => r.session_id === search.upload_id && r.agent === format),
    results: results.results.length,
    ...(results.index.caught_up_at ? { index_caught_up_at: results.index.caught_up_at } : {}),
  };
}
