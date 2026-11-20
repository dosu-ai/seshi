import { isStub, type NormalizedRecord, prefixSha256, type SessionMetadata } from "@seshi/model";
import type { DoctorDeps } from "./deps";
import {
  type CheckResult,
  type CheckStatus,
  type SecretlessStateEntry,
  type SessionEvidence,
  sentFile,
  type TraceEvidence,
} from "./types";

export const SPOOL_STUCK_MS = 10 * 60 * 1000;
export const PENDING_STUCK_MS = 30 * 60 * 1000;

const short = (hash: string | undefined) => (hash ? hash.slice(0, 12) : "none");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const bytes = (n: number) => plural(n, "byte");

function result(
  id: string,
  title: string,
  status: CheckStatus,
  summary: string,
  extra: { detail?: string[]; hint?: string } = {},
): CheckResult {
  return {
    id,
    title,
    status,
    summary,
    ...(extra.detail && extra.detail.length > 0 ? { detail: extra.detail } : {}),
    ...(extra.hint ? { hint: extra.hint } : {}),
  };
}

function storedOf(ev: SessionEvidence): SessionMetadata | undefined {
  return ev.server.metadata ?? ev.server.pointer ?? undefined;
}

function noServer(ev: SessionEvidence): string | undefined {
  if (ev.server.error) return `could not ask the server: ${ev.server.error.message}`;
  if (ev.server.metadata_error) {
    return `could not read the session from ${ev.server.where ?? "the server"}: ${ev.server.metadata_error.message}`;
  }
  return undefined;
}

const sessionRef = (ev: SessionEvidence) =>
  `seshi capture status --session ${ev.session_id} --agent ${ev.agent}`;

export function decisionCheck(ev: SessionEvidence): CheckResult {
  const id = "decision";
  const title = "Decision";
  if (ev.machine.state_error) {
    return result(id, title, "fail", `the state file cannot be read: nothing is captured`, {
      detail: [ev.machine.state_error.message],
      hint: "move the state file aside to start capture state over",
    });
  }
  const d = ev.decision;
  if (!d) return result(id, title, "skip", "no decision: the state could not be read");
  const word = d.capture
    ? "capturing"
    : d.frozen !== undefined
      ? `stopped at ${bytes(d.frozen)}`
      : "not captured";
  const detail: string[] = [];
  if (!ev.local) detail.push("this machine has not seen the session (no hook or sweep named it)");
  if (ev.parent) {
    detail.push(
      `a subagent of ${ev.parent.session_id}${ev.parent.known ? "" : " (not in the state file)"}`,
    );
  }
  if (ev.machine.paused) {
    detail.push(
      `capture is paused${ev.machine.paused.until ? ` until ${ev.machine.paused.until}` : ""}`,
    );
  }
  const redacted = d.redact_tool_calls ? `; tool calls redacted: ${d.redact_tool_calls}` : "";
  return result(id, title, "ok", `${word}: ${d.reason} (${d.level})${redacted}`, { detail });
}

export function transcriptCheck(ev: SessionEvidence): CheckResult {
  const id = "transcript";
  const title = "Transcript";
  const t = ev.transcript;
  const s = ev.local;
  if (!t.path) {
    if (!s) return result(id, title, "skip", "no transcript is known for this session");
    return result(id, title, "warn", "no hook or sweep has named its transcript yet", {
      hint: "the uploader finds it when the agent's next hook names it, or the sweep does",
    });
  }
  if (t.error) {
    return result(id, title, "fail", `${t.path} cannot be read: ${t.error.message}`);
  }
  if (!t.exists) {
    if (s?.stored) {
      return result(id, title, "warn", `${t.path} is gone; what was uploaded stays stored`, {
        hint: "nothing more of it can be sent or checked against the transcript",
      });
    }
    if (ev.decision && !ev.decision.capture && ev.decision.frozen === undefined) {
      return result(id, title, "ok", `${t.path} is gone; the session is not captured`);
    }
    return result(id, title, "fail", `${t.path} is gone and nothing of it was stored`);
  }
  const size = sentFile(t).size;
  const sent = s?.file_offset ?? 0;
  const problems: { status: CheckStatus; text: string }[] = [];
  if (ev.capture && t.identified_as !== ev.session_id) {
    problems.push({
      status: "fail",
      text:
        t.identified_as === undefined
          ? `${ev.agent} does not recognise the file as a transcript: the uploader refuses to send it`
          : `the file is session ${t.identified_as}'s transcript: the uploader refuses to send it`,
    });
  }
  if (sent > size) {
    problems.push({
      status: "warn",
      text: `the file shrank: ${bytes(sent)} were sent, it now has ${bytes(size)} (rewritten or replaced)`,
    });
  }
  if (s?.frozen && s.frozen.offset > size) {
    problems.push({
      status: "warn",
      text: `a pause stopped it at ${bytes(s.frozen.offset)}, past the file's ${bytes(size)}`,
    });
  }
  if (s?.held_at_size !== undefined && s.held_at_size > size) {
    problems.push({
      status: "warn",
      text: `the file shrank since the server last kept nothing (${bytes(s.held_at_size)} then)`,
    });
  }
  if (s?.sent_path !== undefined && s.sent_path !== t.path) {
    problems.push({
      status: "warn",
      text: `the offsets were taken in ${s.sent_path}: the next upload sends the file whole`,
    });
  }
  const summary = t.uploaded
    ? `${t.path}: ${bytes(t.size ?? 0)}, modified ${t.mtime ?? "?"}; sent from ${t.uploaded.path} (with what the hooks kept): ${bytes(size)}, ${bytes(sent)} sent`
    : `${t.path}: ${bytes(size)}, modified ${t.mtime ?? "?"}; ${bytes(sent)} sent`;
  if (problems.length === 0) return result(id, title, "ok", summary);
  const status = problems.some((p) => p.status === "fail") ? "fail" : "warn";
  return result(id, title, status, (problems[0] as { text: string }).text, {
    detail: [summary, ...problems.slice(1).map((p) => p.text)],
  });
}

export function queueCheck(ev: SessionEvidence): CheckResult {
  const id = "queue";
  const title = "Queue";
  const s = ev.local;
  const now = Date.parse(ev.at);
  const running = ev.machine.uploader?.running === true;
  const items: { status: CheckStatus; text: string; hint?: string }[] = [];
  const problems = ev.machine.problems ?? {};
  if (problems.sign_in) {
    const word = problems.sign_in.word ?? "sign in";
    items.push({
      status: "warn",
      text: `${word}: ${problems.sign_in.message.split("\n")[0]}`,
      hint:
        word === "needs review key"
          ? "seshi review key set <provider>"
          : word === "needs update"
            ? "update seshi"
            : word === "bucket refused"
              ? "check the bucket key's permissions (seshi doctor)"
              : word === "bad shared settings"
                ? "seshi admin config pull, fix, seshi admin config push"
                : "seshi login --server <url>",
    });
  }
  if (problems.upload)
    items.push({ status: "warn", text: `uploads failing: ${problems.upload.message}` });
  if (ev.spool.entries.length > 0) {
    const oldest = Math.min(...ev.spool.entries.map((e) => Date.parse(e.at)));
    const stuck = !running && now - oldest > SPOOL_STUCK_MS;
    items.push({
      status: stuck ? "warn" : "ok",
      text: `${plural(ev.spool.entries.length, "hook entry", "hook entries")} ${ev.spool.entries.length === 1 ? "waits" : "wait"} for the uploader${stuck ? ", and none runs" : ""}`,
      ...(stuck ? { hint: "seshi daemon --once sends them now" } : {}),
    });
  }
  if (s?.retract === "pending") {
    items.push({ status: "warn", text: "a retraction waits for the uploader" });
  }
  if (s?.retract === "failed") {
    items.push({
      status: "fail",
      text: `the retraction was refused: ${s.retract_error ?? "no reason recorded"}`,
      hint: "the session stays on the server; an admin can delete it (seshi sessions rm)",
    });
  }
  if (s?.error?.permanent) {
    const waiting = s.error.size === undefined || s.error.size === ev.transcript.size;
    items.push({
      status: waiting ? "fail" : "warn",
      text: `refused (${s.error.code}): ${s.error.message}${waiting ? "" : "; the transcript changed since, so it is tried again"}`,
      ...(waiting ? { hint: "it waits until the transcript changes" } : {}),
    });
  } else if (s?.error) {
    items.push({
      status: "warn",
      text: `retrying after ${plural(s.failures ?? 1, "failure")} (${s.error.code}): ${s.error.message}${s.next_attempt_at ? `; next try at ${s.next_attempt_at}` : ""}`,
    });
  }
  if (s?.rebuild) {
    const due = !s.rebuild.not_before || Date.parse(s.rebuild.not_before) <= now;
    items.push({
      status: "ok",
      text: due
        ? `a rebuild is due${s.rebuild.for ? ` (stale against ${s.rebuild.for})` : ""}`
        : `a rebuild waits until ${s.rebuild.not_before}${s.rebuild.for ? ` (stale against ${s.rebuild.for})` : ""}`,
    });
  }
  const d = ev.decision;
  if (
    s &&
    ev.transcript.exists &&
    d &&
    (d.capture || d.frozen !== undefined) &&
    s.retract !== "pending"
  ) {
    const size = ev.transcript.size ?? 0;
    const stop = s.frozen?.offset ?? d.frozen;
    const limit = stop !== undefined ? Math.min(size, stop) : size;
    const pending = s.stored
      ? Math.max(0, limit - (s.file_offset ?? 0))
      : limit > 0 && s.held_at_size !== limit
        ? limit
        : 0;
    if (pending > 0) {
      const mtime = ev.transcript.mtime ? Date.parse(ev.transcript.mtime) : now;
      const stuck = !running && now - mtime > PENDING_STUCK_MS && !s.error;
      items.push({
        status: stuck ? "warn" : "ok",
        text: `${bytes(pending)} not uploaded yet${stuck ? `, the transcript unchanged since ${ev.transcript.mtime} and no uploader running` : ""}`,
        ...(stuck ? { hint: "seshi daemon --once sends them now" } : {}),
      });
    } else if (!s.stored && s.last_status === "filtered") {
      items.push({ status: "ok", text: "held: too small to store yet; sent again once it grows" });
    }
  }
  if (items.length === 0) return result(id, title, "ok", "nothing waiting");
  const order: Record<CheckStatus, number> = { fail: 0, warn: 1, ok: 2, skip: 3 };
  const sorted = [...items].sort((a, b) => order[a.status] - order[b.status]);
  const top = sorted[0] as (typeof items)[number];
  const status = top.status;
  return result(id, title, status, top.text, {
    detail: sorted.slice(1).map((i) => i.text),
    ...(sorted.find((i) => i.hint)?.hint ? { hint: sorted.find((i) => i.hint)?.hint } : {}),
  });
}

export function presenceCheck(ev: SessionEvidence): CheckResult {
  const id = "presence";
  const title = "Server presence";
  const why = noServer(ev);
  if (why) return result(id, title, "skip", why);
  const s = ev.local;
  const m = ev.server.metadata ?? null;
  const pointer = ev.server.pointer;
  const where = ev.server.mode === "serverless" ? "the bucket" : "the server";
  const uid = ev.server.upload_id ?? ev.session_id;
  const has = (x: SessionMetadata | null | undefined) =>
    x !== null && x !== undefined && x.status === "stored" && x.head !== undefined;
  const lost = (text: string, hint?: string) =>
    result(id, title, "fail", text, {
      hint:
        hint ??
        `${sessionRef(ev)} shows what this machine thinks; seshi capture resend --session ${ev.session_id} sends it again`,
    });

  if (!s) {
    if (has(m)) {
      return result(id, title, "warn", `${where} holds ${uid}, which this machine never sent`, {
        hint: "another machine uploaded it, or this machine's state was moved aside",
      });
    }
    return result(id, title, "ok", `${where} holds nothing of it, and nothing was sent from here`);
  }
  if (s.retract === "pending") {
    return result(id, title, "skip", "a retraction is waiting; checked once it is done");
  }
  const d = ev.decision;
  const off = d?.level === "session" && !d.capture;
  let retracted: string | undefined;
  const previous = ev.server.retracted;
  if (s.retract === "done" && previous) {
    if (previous.error) {
      return result(
        id,
        title,
        "skip",
        `could not read ${previous.upload_id}: ${previous.error.message}`,
      );
    }
    if (has(previous.metadata)) {
      return lost(
        `retracted here, but ${where} still holds ${previous.upload_id} with a trace`,
        "seshi capture off --session asks again; an admin can delete it (seshi sessions rm)",
      );
    }
    retracted = `${previous.upload_id} retracted (${previous.metadata ? "tombstoned" : "absent"})`;
  }
  if (off) {
    if (has(m)) {
      return lost(
        `turned off, but ${where} holds ${uid} with a trace`,
        "turn it off again: seshi capture off --session",
      );
    }
    return result(
      id,
      title,
      "ok",
      retracted
        ? `turned off: ${retracted}`
        : `turned off before anything was sent; ${where} holds nothing`,
    );
  }
  const now = presenceNow(ev, s, m, pointer, where, uid, has, lost);
  return retracted && now.status === "ok"
    ? { ...now, summary: `${now.summary}; earlier, ${retracted}` }
    : now;
}

function heldAsStub(status: SecretlessStateEntry["last_status"]): boolean {
  return status === "dropped" || status === "unchanged";
}

function filteredButResentAnswerLost(ev: SessionEvidence, s: SecretlessStateEntry): boolean {
  return s.held_at_size !== undefined && (ev.transcript.size ?? 0) > s.held_at_size;
}

function presenceNow(
  ev: SessionEvidence,
  s: NonNullable<SessionEvidence["local"]>,
  m: SessionMetadata | null,
  pointer: SessionMetadata | null | undefined,
  where: string,
  uid: string,
  has: (x: SessionMetadata | null | undefined) => boolean,
  lost: (text: string, hint?: string) => CheckResult,
): CheckResult {
  const id = "presence";
  const title = "Server presence";
  const d = ev.decision;
  if (m && m.status === "redacted") {
    return lost(
      `${where} deleted ${uid} (tombstoned), but this machine did not retract it`,
      "someone deleted it on the server (seshi sessions rm); later uploads are refused (422 redacted)",
    );
  }
  if (!s.sent) {
    if (has(m)) {
      return result(id, title, "warn", `${where} holds ${uid}, which this machine never sent`, {
        hint: "another machine uploaded it, or this machine's state was moved aside",
      });
    }
    return result(
      id,
      title,
      "ok",
      d?.capture ? "nothing sent yet; the uploader sends it" : "nothing sent, and nothing stored",
    );
  }
  if (s.stored) {
    if (has(m)) {
      const frozen = s.frozen ? `, stopped by a pause at ${bytes(s.frozen.offset)}` : "";
      return result(id, title, "ok", `stored as ${uid}: head ${short(m?.head)}${frozen}`);
    }
    if (heldAsStub(s.last_status)) {
      if (pointer && isStub(pointer)) {
        return result(
          id,
          title,
          "ok",
          `a stub: review dropped its first envelope, nothing of it stored${s.last_status === "unchanged" ? "; a later whole send added nothing" : ""}`,
        );
      }
      if (!ev.server.sees_stubs) {
        return result(
          id,
          title,
          "ok",
          `review dropped its first envelope: a stub ${where} does not show (it serves no stubs)`,
          {
            detail: [
              `the laptop's last answer was ${s.last_status} at ${bytes(s.server_offset ?? 0)}`,
            ],
          },
        );
      }
      return lost(`review dropped its first envelope, but ${where} has no stub for ${uid}`);
    }
    return lost(
      `this machine stored ${uid} (${bytes(s.file_offset ?? 0)} sent), but ${where} holds nothing of it`,
    );
  }
  if (s.last_status === "filtered") {
    if (!has(m)) {
      return result(id, title, "ok", "filtered: nothing stored until the transcript grows");
    }
    if (!filteredButResentAnswerLost(ev, s))
      return lost(`the session filter kept it out, yet ${where} holds ${uid}`);
  }
  if (has(m)) {
    return result(id, title, "warn", `${where} holds ${uid} though no answer said so here`, {
      hint: "an answer was lost; the next upload is told the server's offset and goes on from there",
    });
  }
  return result(id, title, "ok", `sent, nothing stored yet (${s.last_status ?? "no answer yet"})`);
}

export function secretCheck(ev: SessionEvidence): CheckResult {
  const id = "secret";
  const title = "Retraction secret";
  const s = ev.local;
  if (!s?.sent) return result(id, title, "skip", "nothing sent from here");
  const why = noServer(ev);
  if (why) return result(id, title, "skip", why);
  const m = storedOf(ev);
  if (!m) return result(id, title, "skip", "nothing stored to compare with");
  if (m.status === "redacted") return result(id, title, "skip", "deleted: nothing left to retract");
  if (!s.secret) {
    return result(id, title, "fail", "this machine sent the session but keeps no secret for it", {
      hint: "it cannot be retracted from here; an admin can delete it",
    });
  }
  if (!m.retract_hash) {
    return result(
      id,
      title,
      "warn",
      "stored without a retraction hash: turning it off cannot retract it",
    );
  }
  if (m.retract_hash !== s.secret.sha256) {
    return result(id, title, "fail", "the secret here is not the one the session was stored with", {
      hint: "a retraction from this machine would be refused (another machine, or older state, uploaded it)",
    });
  }
  return result(id, title, "ok", "the secret here matches the stored hash");
}

function replaceDropped(ev: SessionEvidence): boolean {
  return ev.local?.replace_next === true;
}

const REPLACE_DROPPED =
  "review dropped the last replace: the server keeps the session it had, which this transcript no longer extends";
const REPLACE_HINT = "the uploader sends it whole, as a replace, once the transcript grows";

export function offsetsCheck(ev: SessionEvidence): CheckResult {
  const id = "offsets";
  const title = "Offsets";
  const s = ev.local;
  if (!s?.stored) return result(id, title, "skip", "nothing stored from here");
  const why = noServer(ev);
  if (why) return result(id, title, "skip", why);
  const m = storedOf(ev);
  if (!m?.normalized) {
    return result(
      id,
      title,
      "skip",
      m ? "the server records no offset" : "nothing stored can be read here",
    );
  }
  if (m.status === "redacted") return result(id, title, "skip", "deleted");
  const n = m.normalized;
  const fails: string[] = [];
  const pausedAhead = s.frozen !== undefined && n.bytes > (s.server_offset ?? 0);
  if (s.server_offset !== n.bytes && !pausedAhead) {
    fails.push(
      `the server's log ends at ${bytes(n.bytes)}; this machine thinks ${bytes(s.server_offset ?? 0)}`,
    );
  }
  const awaitingWholeReplace = replaceDropped(ev) && s.file_offset !== s.server_offset;
  if (s.aligned !== false && s.file_offset !== s.server_offset && !awaitingWholeReplace) {
    fails.push(
      `pre-redaction kept every length, yet ${bytes(s.file_offset ?? 0)} of the transcript map to ${bytes(s.server_offset ?? 0)} on the server`,
    );
  }
  if (s.frozen && (s.file_offset ?? 0) > s.frozen.offset) {
    fails.push(
      `${bytes(s.file_offset ?? 0)} were sent, past the pause's stop at ${bytes(s.frozen.offset)}`,
    );
  }
  if (m.dropped_prefix && m.dropped_prefix.bytes > n.bytes) {
    fails.push(`the dropped start (${bytes(m.dropped_prefix.bytes)}) is longer than the log`);
  }
  if (
    s.shipped &&
    !pausedAhead &&
    (s.shipped.records !== n.records || s.shipped.prefix_sha256 !== n.prefix_sha256)
  ) {
    fails.push(
      `the last answer said ${plural(s.shipped.records, "record")} (${short(s.shipped.prefix_sha256)}), the server now holds ${n.records} (${short(n.prefix_sha256)})`,
    );
  }
  const summary = `the server holds ${bytes(n.bytes)} (${plural(n.records, "record")}); ${bytes(s.file_offset ?? 0)} of the transcript sent${s.frozen ? `, stopped at ${bytes(s.frozen.offset)}` : ""}`;
  if (fails.length > 0) {
    return result(id, title, "fail", fails[0] as string, {
      detail: [...fails.slice(1), summary],
      hint: "another machine wrote the session, or an answer was lost; the next upload is told 409 offset_mismatch and goes on from the server's offset",
    });
  }
  if (awaitingWholeReplace) {
    return result(id, title, "warn", REPLACE_DROPPED, { detail: [summary], hint: REPLACE_HINT });
  }
  if (pausedAhead) {
    return result(
      id,
      title,
      "warn",
      `the server's log ends at ${bytes(n.bytes)}, past the ${bytes(s.server_offset ?? 0)} this machine heard of before a pause stopped it: a piece whose answer was lost`,
      {
        detail: [summary],
        hint: `the server keeps it and nothing more is sent; seshi capture on --session ${ev.session_id} uploads the rest`,
      },
    );
  }
  return result(id, title, "ok", summary);
}

interface LocalRecords {
  end: number;
  records?: NormalizedRecord[];
  error?: string;
  skip?: string;
}

function localRecords(ev: SessionEvidence, deps: DoctorDeps): LocalRecords {
  const s = ev.local;
  const m = storedOf(ev);
  const n = m?.normalized;
  if (!s || !m || !n) return { end: 0, skip: "nothing stored can be read here" };
  if (m.status === "redacted") return { end: 0, skip: "deleted" };
  if (!ev.capture) return { end: 0, skip: `this binary does not capture ${ev.agent}` };
  if (!ev.transcript.exists || !ev.transcript.path) {
    return { end: 0, skip: "the transcript is not here to compare" };
  }
  if (s.server_offset === undefined && s.aligned === undefined) {
    return {
      end: 0,
      skip: "no answer came for what was sent: where the server's log ends in the transcript is not known",
    };
  }
  if (s.server_offset !== undefined && n.bytes > s.server_offset) {
    return {
      end: 0,
      skip: `the server holds ${bytes(n.bytes - s.server_offset)} past what this machine heard of (an answer was lost): where its log ends in the transcript is not known`,
    };
  }
  let end: number;
  if (s.server_offset === n.bytes && s.file_offset !== undefined) end = s.file_offset;
  else if (s.aligned !== false) end = n.bytes;
  else {
    return {
      end: 0,
      skip: "pre-redaction changed lengths and the offsets disagree: the server's offset cannot be found in the transcript",
    };
  }
  const file = sentFile(ev.transcript);
  if (end > file.size) {
    return { end, skip: `the transcript is shorter than the ${bytes(end)} the server holds` };
  }
  try {
    const read = deps.files.read(file.path ?? ev.transcript.path, end);
    // What the uploader sent: the tool-call pass first, for a session the org lists.
    const pass = ev.decision?.redact_tool_calls ? deps.agent(ev.agent)?.redactToolCalls : undefined;
    const text = pass ? pass(read) : read;
    const sent = deps.redaction.transcript(text, ev.capture.encoding);
    return { end, records: deps.normalizer.records(ev.capture.format, sent) };
  } catch (err) {
    return { end, error: err instanceof Error ? err.message : String(err) };
  }
}

export function recordsCheck(
  ev: SessionEvidence,
  deps: DoctorDeps,
  local: LocalRecords = localRecords(ev, deps),
): CheckResult {
  const id = "records";
  const title = "Records";
  const why = noServer(ev);
  if (why) return result(id, title, "skip", why);
  if (local.skip) return result(id, title, "skip", local.skip);
  const m = storedOf(ev) as SessionMetadata;
  const n = m.normalized as NonNullable<SessionMetadata["normalized"]>;
  if (local.error || !local.records) {
    return result(id, title, "fail", `the adapter cannot read the transcript now: ${local.error}`);
  }
  const format = ev.capture?.format as string;
  const stale = deps.normalizer.stale(format, m.normalizer?.format_version);
  const detail: string[] = [];
  const dropped = m.dropped_prefix;
  if (dropped) {
    detail.push(
      `review dropped the first ${plural(dropped.records, "record")} (${bytes(dropped.bytes)}); both counts include them`,
    );
  }
  const count = local.records.length;
  if (dropped && dropped.records > n.records) {
    return result(
      id,
      title,
      "fail",
      `the dropped start (${dropped.records}) is longer than the log (${n.records})`,
    );
  }
  if (count !== n.records && replaceDropped(ev)) {
    return result(id, title, "warn", REPLACE_DROPPED, {
      detail: [
        ...detail,
        `the transcript's first ${bytes(local.end)} normalize to ${plural(count, "record")}; the server counts ${n.records}`,
      ],
      hint: REPLACE_HINT,
    });
  }
  if (count !== n.records) {
    return result(
      id,
      title,
      stale ? "warn" : "fail",
      `the transcript's first ${bytes(local.end)} normalize to ${plural(count, "record")}; the server counts ${n.records}`,
      {
        detail,
        hint: stale
          ? "an older normalizer built the session; a rebuild (seshi capture resend) makes them agree"
          : "the server's records do not follow this transcript: check the trace chain and the offsets",
      },
    );
  }
  return result(
    id,
    title,
    "ok",
    `${plural(count, "record")} in the first ${bytes(local.end)}, as the server counts`,
    {
      detail,
    },
  );
}

function backfilledSincePrefix(ev: SessionEvidence): boolean {
  let backfilled = false;
  for (const { entry } of ev.server.changes ?? []) {
    if (entry.kind !== "published") continue;
    if (entry.reason === "redacted") backfilled = true;
    else if (!entry.continuation) backfilled = false;
  }
  return backfilled;
}

function markersIn(records: readonly NormalizedRecord[]): Set<string> {
  const out = new Set<string>();
  for (const record of records) {
    for (const match of JSON.stringify(record).matchAll(
      /\[redacted:([a-z0-9]+(?:-[a-z0-9]+)*)\]/g,
    )) {
      out.add(match[1] as string);
    }
  }
  return out;
}

function droppedPrefixUnderOldRules(
  dropped: NonNullable<SessionMetadata["dropped_prefix"]>,
  records: NormalizedRecord[],
  deps: DoctorDeps,
): boolean {
  return (
    dropped.records > 0 &&
    dropped.records <= records.length &&
    prefixSha256(deps.redaction.records(records.slice(0, dropped.records)), dropped.records) !==
      dropped.prefix_sha256
  );
}

export function prefixCheck(
  ev: SessionEvidence,
  deps: DoctorDeps,
  local: LocalRecords = localRecords(ev, deps),
): CheckResult {
  const id = "prefix";
  const title = "Prefix hash";
  const why = noServer(ev);
  if (why) return result(id, title, "skip", why);
  if (local.skip) return result(id, title, "skip", local.skip);
  if (local.error || !local.records)
    return result(id, title, "skip", "the transcript could not be normalized");
  const m = storedOf(ev) as SessionMetadata;
  const n = m.normalized as NonNullable<SessionMetadata["normalized"]>;
  if (local.records.length !== n.records) {
    return result(id, title, "skip", "the record counts differ (see records)");
  }
  const stored = m.redaction?.rule_set;
  if (!stored) {
    return result(
      id,
      title,
      "skip",
      "the session records no rule set (a stub, or written before rule sets)",
    );
  }
  const sets = new Set([stored, ...m.traces.map((t) => t.rule_set ?? stored)]);
  const mine = deps.redaction.rule_set;
  if (sets.size > 1 || !sets.has(mine)) {
    return result(
      id,
      title,
      "skip",
      `the session was redacted with rule set ${[...sets].map(short).join(", ")}; this machine has ${short(mine)} (${deps.redaction.origin})`,
    );
  }
  const hash = prefixSha256(deps.redaction.records(local.records), local.records.length);
  if (hash !== n.prefix_sha256 && backfilledSincePrefix(ev)) {
    return result(
      id,
      title,
      "skip",
      "a redaction backfill rewrote the stored records after this prefix was recorded; the prefix keeps the earlier rules' hash, so it cannot be compared",
      { hint: "the next whole upload is a 409 conflict, answered with replace" },
    );
  }
  const dropped = m.dropped_prefix;
  if (
    hash !== n.prefix_sha256 &&
    dropped &&
    droppedPrefixUnderOldRules(dropped, local.records, deps)
  ) {
    return result(
      id,
      title,
      "skip",
      `review dropped the first ${plural(dropped.records, "record")}, hashed under earlier rules and not stored to redact again; the hashes cannot agree`,
    );
  }
  const markersFromRetiredRules =
    hash === n.prefix_sha256
      ? []
      : [...markersIn(ev.server.traces.flatMap((t) => t.records ?? []))].filter(
          (marker) => !markersIn(deps.redaction.records(local.records ?? [])).has(marker),
        );
  if (markersFromRetiredRules.includes("tool-call")) {
    return result(
      id,
      title,
      "skip",
      "the stored records keep [redacted:tool-call]: the session was uploaded while the org redacted tool calls where it ran (capture.redact_tool_calls), which no longer applies here; the hashes cannot agree",
      { hint: "a whole upload (seshi capture resend) stores it as the rules stand now" },
    );
  }
  if (markersFromRetiredRules.length > 0) {
    return result(
      id,
      title,
      "skip",
      `the stored records keep ${markersFromRetiredRules.map((m) => `[redacted:${m}]`).join(", ")}, which this machine's rules do not write (an earlier rule set's markers); the hashes cannot agree`,
      { hint: "a whole upload (seshi capture resend) stores it under the current rules" },
    );
  }
  if (hash !== n.prefix_sha256 && replaceDropped(ev)) {
    return result(id, title, "warn", REPLACE_DROPPED, {
      detail: [
        `the transcript's records hash to ${short(hash)}; the server's prefix is ${short(n.prefix_sha256)}`,
      ],
      hint: REPLACE_HINT,
    });
  }
  if (hash !== n.prefix_sha256) {
    const stale = deps.normalizer.stale(ev.capture?.format as string, m.normalizer?.format_version);
    return result(
      id,
      title,
      stale ? "warn" : "fail",
      `the transcript's records hash to ${short(hash)}; the server's prefix is ${short(n.prefix_sha256)}`,
      {
        hint: stale
          ? "an older normalizer built the session; a rebuild makes them agree"
          : "what is stored is not what this transcript normalizes to (rewritten history, or another machine's)",
      },
    );
  }
  return result(
    id,
    title,
    "ok",
    `${short(hash)} over ${plural(local.records.length, "record")}, as stored`,
  );
}

export function chainCheck(ev: SessionEvidence): CheckResult {
  const id = "chain";
  const title = "Trace chain";
  const why = noServer(ev);
  if (why) return result(id, title, "skip", why);
  const m = storedOf(ev);
  if (!m) return result(id, title, "skip", "nothing stored can be read here");
  if (m.status === "redacted") return result(id, title, "skip", "deleted: no traces");
  const traces = ev.server.traces;
  if (traces.length === 0) {
    if (isStub(m)) {
      return result(id, title, "ok", "a stub: no trace yet", {
        detail: m.dropped_prefix
          ? [`review dropped ${plural(m.dropped_prefix.records, "record")}`]
          : [],
      });
    }
    return result(id, title, "fail", "the session is stored but names no trace");
  }
  const fails: string[] = [];
  const notes: string[] = [];
  const last = traces.at(-1) as TraceEvidence;
  if (!m.head) fails.push("it names traces but has no head");
  else if (!traces.some((t) => t.content_hash === m.head))
    fails.push(`its head ${short(m.head)} is not among its traces`);
  else if (last.content_hash !== m.head)
    fails.push(`its head ${short(m.head)} is not its last trace`);
  for (const t of traces) {
    if (!t.fetched)
      fails.push(`trace ${short(t.content_hash)} cannot be fetched: ${t.error?.message ?? "?"}`);
    else {
      if (t.stored_hash !== undefined && t.stored_hash !== t.content_hash) {
        fails.push(`trace ${short(t.content_hash)} says it is ${short(t.stored_hash)}`);
      }
      if (t.record_count !== t.listed_records) {
        fails.push(
          `trace ${short(t.content_hash)} has ${t.record_count} records; the metadata says ${t.listed_records}`,
        );
      }
    }
  }
  const first = traces[0] as TraceEvidence;
  const start = first.continuation?.from_record ?? 0;
  if (m.dropped_prefix && start !== m.dropped_prefix.records) {
    fails.push(
      `the first trace continues from record ${start}; review dropped ${m.dropped_prefix.records}`,
    );
  }
  const explained = (m.applied ?? []).some((a) => a.status === "dropped");
  let end = start;
  traces.forEach((t, i) => {
    const count = t.record_count ?? t.listed_records;
    const meta = t.continuation ? (t.starts_with_meta ?? first.starts_with_meta ?? true) : false;
    if (i > 0) {
      const from = t.continuation?.from_record;
      if (from === undefined) {
        fails.push(`trace ${i + 1} (${short(t.content_hash)}) is not a continuation`);
        end += count;
        return;
      }
      if (from < end) {
        fails.push(
          `trace ${i + 1} continues from record ${from}, inside what trace ${i} holds (to ${end})`,
        );
      } else if (from > end) {
        notes.push(
          `records ${end}–${from - 1} are in no trace${explained ? " (review dropped them)" : ""}`,
        );
      }
      end = from;
    }
    end += count - (meta ? 1 : 0);
  });
  const total = m.normalized?.records;
  if (total !== undefined && end > total) {
    fails.push(`the traces hold records to ${end}; the metadata counts ${total}`);
  } else if (total !== undefined && end < total) {
    notes.push(
      `records ${end}–${total - 1} are in no trace${explained ? " (review dropped them)" : ""}`,
    );
  }
  const summary = `${plural(traces.length, "trace")} hold records ${start}–${end - 1} of ${total ?? "?"}; head ${short(m.head)}`;
  if (fails.length > 0) {
    return result(id, title, "fail", fails[0] as string, {
      detail: [...fails.slice(1), ...notes, summary],
    });
  }
  if (notes.length > 0 && !explained) {
    return result(id, title, "warn", notes[0] as string, {
      detail: [...notes.slice(1), summary],
      hint: "a write failed between its entry and its pointer, or review dropped part of it",
    });
  }
  return result(id, title, "ok", summary, { detail: notes });
}

export function residueCheck(ev: SessionEvidence, deps: DoctorDeps): CheckResult {
  const id = "residue";
  const title = "Redaction residue";
  const why = noServer(ev);
  if (why) return result(id, title, "skip", why);
  const fetched = ev.server.traces.filter((t) => t.records !== undefined);
  if (fetched.length === 0) return result(id, title, "skip", "no stored trace to read");
  const hits: string[] = [];
  let records = 0;
  for (const t of fetched) {
    const list = t.records as NormalizedRecord[];
    records += list.length;
    for (const hit of deps.redaction.residue(list)) {
      hits.push(
        `trace ${short(t.content_hash)} record ${hit.index}: ${hit.rules.join(", ") || "a rule"}`,
      );
    }
  }
  if (hits.length > 0) {
    const m = storedOf(ev);
    const other =
      m?.redaction?.rule_set !== undefined && m.redaction.rule_set !== deps.redaction.rule_set;
    return result(
      id,
      title,
      "fail",
      `${plural(hits.length, "stored record")} still match the rules: ${hits[0]}`,
      {
        detail: [
          ...hits.slice(1),
          ...(other
            ? [
                `stored under rule set ${short(m?.redaction?.rule_set)}; this machine has ${short(deps.redaction.rule_set)} (${deps.redaction.origin})`,
              ]
            : []),
        ],
        hint: "a secret was stored (never printed here): run seshi redact backfill on the server, or delete the session (seshi sessions rm)",
      },
    );
  }
  return result(
    id,
    title,
    "ok",
    `no rule matches the ${plural(records, "stored record")} (${deps.redaction.origin})`,
  );
}

export function stalenessCheck(ev: SessionEvidence, deps: DoctorDeps): CheckResult {
  const id = "staleness";
  const title = "Staleness";
  const why = noServer(ev);
  if (why) return result(id, title, "skip", why);
  const m = storedOf(ev);
  if (!m || m.status === "redacted") return result(id, title, "skip", "nothing stored");
  const format = ev.server.format ?? ev.agent;
  const current = deps.normalizer.version(format);
  if (current === undefined)
    return result(id, title, "skip", `this binary does not read ${format}`);
  const built = m.normalizer?.format_version;
  if (!deps.normalizer.stale(format, built)) {
    return result(id, title, "ok", `built with ${built ?? "?"}; the adapter is ${current}`);
  }
  const s = ev.local;
  const now = Date.parse(ev.at);
  const rebuild = s?.rebuild
    ? !s.rebuild.not_before || Date.parse(s.rebuild.not_before) <= now
      ? "a rebuild is due"
      : `a rebuild waits until ${s.rebuild.not_before}`
    : s?.rebuilt_for === current
      ? "it was rebuilt for this version already; the server still lists it"
      : s?.sent
        ? "the uploader asks hourly which sessions are stale"
        : "another machine uploaded it";
  return result(
    id,
    title,
    "warn",
    `built with ${built ?? "no recorded version"}; the adapter is ${current}: ${rebuild}`,
    {
      ...(s?.sent && !s.rebuild
        ? { hint: `seshi capture resend --session ${ev.session_id} sends it now` }
        : {}),
    },
  );
}

export function changesCheck(ev: SessionEvidence): CheckResult {
  const id = "changes";
  const title = "Change feed";
  const why = noServer(ev);
  if (why) return result(id, title, "skip", why);
  if (ev.server.changes_error) {
    return result(
      id,
      title,
      "skip",
      `the change feed cannot be read here: ${ev.server.changes_error.message}`,
    );
  }
  const changes = ev.server.changes;
  if (!changes) return result(id, title, "skip", "no change feed here");
  const m = storedOf(ev) ?? ev.server.retracted?.metadata ?? undefined;
  if (!m) return result(id, title, "skip", "nothing stored");
  if (isStub(m)) return result(id, title, "skip", "a stub writes no change entry");
  const kinds = changes.map((c) => c.entry.kind);
  const summary = `${plural(changes.length, "entry", "entries")}: ${kinds.join(", ") || "none"}`;
  if (m.status === "redacted") {
    if (!changes.some((c) => c.entry.kind === "tombstone")) {
      return result(id, title, "fail", "deleted, but no tombstone entry is in the feed", {
        detail: [summary],
        hint: "search and feed readers keep showing the session",
      });
    }
    return result(id, title, "ok", summary);
  }
  if (
    m.head &&
    !changes.some((c) => c.entry.kind === "published" && c.entry.content_hash === m.head)
  ) {
    return result(id, title, "fail", `no published entry for its head ${short(m.head)}`, {
      detail: [summary],
      hint: "search and feed readers never see the latest trace",
    });
  }
  return result(id, title, "ok", summary);
}

export function searchCheck(ev: SessionEvidence): CheckResult | undefined {
  const id = "search";
  const title = "Search";
  const s = ev.server.search;
  if (!s) return undefined;
  if (s.error) return result(id, title, "skip", s.error.message);
  const term = `'${s.term}' (from the ${s.term_from})`;
  if (s.expect === "found") {
    if (s.found) return result(id, title, "ok", `found by ${term}`);
    const m = ev.server.metadata;
    const behind =
      m && (!s.index_caught_up_at || Date.parse(s.index_caught_up_at) < Date.parse(m.updated_at));
    return result(id, title, behind ? "warn" : "fail", `not found by ${term}`, {
      hint: behind
        ? "the search index has not caught up with the session's last change yet"
        : "the index holds the change but not the session: check the change feed",
    });
  }
  if (s.found) {
    return result(id, title, "fail", `${s.upload_id} was deleted but is still found by ${term}`, {
      hint: "the index has not applied the tombstone; seshi search --rebuild redoes it",
    });
  }
  return result(id, title, "ok", `deleted ${s.upload_id} is not found by ${term}`);
}

const labelText = (labels: Readonly<Record<string, string>>) =>
  Object.entries(labels)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");

/** The session's labels: those pinned on this machine, those the server keeps, and any the
 * config gives that are left out. */
export function labelsCheck(ev: SessionEvidence): CheckResult {
  const id = "labels";
  const title = "Labels";
  const local = ev.local?.labels;
  const stored = storedOf(ev)?.labels;
  const problems = ev.machine.label_problems ?? [];
  const detail: string[] = [];
  // Both as stored: the evidence redacts the pinned values with the rules the server uses.
  if (local !== undefined) detail.push(`pinned here: ${labelText(local) || "none"}`);
  if (stored !== undefined) detail.push(`on the server: ${labelText(stored)}`);
  if (local && stored && labelText(local) !== labelText(stored)) {
    detail.push(
      "the server keeps the labels of the session's first upload that carried any; a replace may change them",
    );
  }
  if (problems.length > 0) {
    return result(id, title, "warn", `${plural(problems.length, "label")} left out`, {
      detail: [...problems, ...detail],
      hint: "fix [labels] in the CLI config (seshi config check --cli) or the repo's .seshi/config.toml",
    });
  }
  const shown = stored ?? local;
  return result(id, title, "ok", shown && labelText(shown) ? labelText(shown) : "none", {
    detail,
  });
}

export function runChecks(ev: SessionEvidence, deps: DoctorDeps): CheckResult[] {
  const local = localRecords(ev, deps);
  const results = [
    decisionCheck(ev),
    transcriptCheck(ev),
    queueCheck(ev),
    presenceCheck(ev),
    secretCheck(ev),
    offsetsCheck(ev),
    recordsCheck(ev, deps, local),
    prefixCheck(ev, deps, local),
    chainCheck(ev),
    residueCheck(ev, deps),
    stalenessCheck(ev, deps),
    changesCheck(ev),
    labelsCheck(ev),
  ];
  const search = searchCheck(ev);
  if (search) results.push(search);
  return results;
}
