/** Step two of the doctor: what the evidence of one session says, as checks. Each check reads
 * the evidence (and, for the records it re-normalizes, the transcript through `deps`) and
 * answers ok, warn, fail or skip with one line and, when there is more, detail and a hint.
 * Pure apart from those reads: the same evidence always gives the same answers. */

import { isStub, type NormalizedRecord, prefixSha256, type SessionMetadata } from "@seshi/model";
import type { DoctorDeps } from "./deps";
import type { CheckResult, CheckStatus, SessionEvidence, TraceEvidence } from "./types";

/** A spool entry older than this, with no uploader running, is stuck. */
export const SPOOL_STUCK_MS = 10 * 60 * 1000;
/** Bytes not uploaded for this long after the transcript last changed, with no uploader
 * running, are stuck. */
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

/** What the server stored, as far as it can be seen: the metadata readers get, else the stored
 * pointer (a stub, in local mode). */
function storedOf(ev: SessionEvidence): SessionMetadata | undefined {
  return ev.server.metadata ?? ev.server.pointer ?? undefined;
}

/** Why a check that needs the server cannot run, if it cannot. */
function noServer(ev: SessionEvidence): string | undefined {
  if (ev.server.error) return `could not ask the server: ${ev.server.error.message}`;
  if (ev.server.metadata_error) {
    return `could not read the session from ${ev.server.where ?? "the server"}: ${ev.server.metadata_error.message}`;
  }
  return undefined;
}

const sessionRef = (ev: SessionEvidence) =>
  `seshi capture status --session ${ev.session_id} --agent ${ev.agent}`;

// --- decision -------------------------------------------------------------------------------

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
  return result(id, title, "ok", `${word}: ${d.reason} (${d.level})`, { detail });
}

// --- transcript -----------------------------------------------------------------------------

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
  const size = t.size ?? 0;
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
  const summary = `${t.path}: ${bytes(size)}, modified ${t.mtime ?? "?"}; ${bytes(sent)} sent`;
  if (problems.length === 0) return result(id, title, "ok", summary);
  const status = problems.some((p) => p.status === "fail") ? "fail" : "warn";
  return result(id, title, status, (problems[0] as { text: string }).text, {
    detail: [summary, ...problems.slice(1).map((p) => p.text)],
  });
}

// --- queue ----------------------------------------------------------------------------------

export function queueCheck(ev: SessionEvidence): CheckResult {
  const id = "queue";
  const title = "Queue";
  const s = ev.local;
  const now = Date.parse(ev.at);
  const running = ev.machine.uploader?.running === true;
  const items: { status: CheckStatus; text: string; hint?: string }[] = [];
  const problems = ev.machine.problems ?? {};
  if (problems.sign_in) {
    items.push({
      status: "warn",
      text: `sign in: ${problems.sign_in.message}`,
      hint: "seshi login --server <url>",
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
  // Bytes still to send, up to where a pause stopped the session.
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

// --- server presence ------------------------------------------------------------------------

export function presenceCheck(ev: SessionEvidence): CheckResult {
  const id = "presence";
  const title = "Server presence";
  const why = noServer(ev);
  if (why) return result(id, title, "skip", why);
  const s = ev.local;
  const m = ev.server.metadata ?? null;
  const pointer = ev.server.pointer;
  const where = ev.server.mode === "local" ? "the local bucket" : "the server";
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
  // What an earlier retraction left: the upload id before it is gone or tombstoned.
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

/** Presence of the session's current upload id. */
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
    if (s.last_status === "dropped") {
      if (pointer && isStub(pointer)) {
        return result(
          id,
          title,
          "ok",
          `a stub: review dropped its first envelope, nothing of it stored`,
        );
      }
      if (!ev.server.sees_stubs) {
        return result(
          id,
          title,
          "ok",
          `review dropped its first envelope: a stub ${where} does not show (it serves no stubs)`,
          { detail: [`the laptop's last answer was dropped at ${bytes(s.server_offset ?? 0)}`] },
        );
      }
      return lost(`review dropped its first envelope, but ${where} has no stub for ${uid}`);
    }
    return lost(
      `this machine stored ${uid} (${bytes(s.file_offset ?? 0)} sent), but ${where} holds nothing of it`,
    );
  }
  // Sent, nothing stored.
  if (s.last_status === "filtered") {
    if (has(m)) {
      return lost(`the session filter kept it out, yet ${where} holds ${uid}`);
    }
    return result(id, title, "ok", "filtered: nothing stored until the transcript grows");
  }
  if (has(m)) {
    return result(id, title, "warn", `${where} holds ${uid} though no answer said so here`, {
      hint: "an answer was lost; the next upload is told the server's offset and goes on from there",
    });
  }
  return result(id, title, "ok", `sent, nothing stored yet (${s.last_status ?? "no answer yet"})`);
}

// --- retraction secret ----------------------------------------------------------------------

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

// --- a dropped replace ------------------------------------------------------------------------

/** Model review dropped this machine's last replace (or rebuild) of the session: the server kept
 * the session it had, which this transcript no longer extends, and the uploader sends it whole
 * as a replace again once the transcript grows (`replace_next`, uploader.ts; 20 × 21). Until
 * then the offsets, the record count and the prefix differ by design: a warning, not a fault. */
function replaceDropped(ev: SessionEvidence): boolean {
  return ev.local?.replace_next === true;
}

const REPLACE_DROPPED =
  "review dropped the last replace: the server keeps the session it had, which this transcript no longer extends";
const REPLACE_HINT = "the uploader sends it whole, as a replace, once the transcript grows";

// --- offsets --------------------------------------------------------------------------------

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
  if (s.server_offset !== n.bytes) {
    fails.push(
      `the server's log ends at ${bytes(n.bytes)}; this machine thinks ${bytes(s.server_offset ?? 0)}`,
    );
  }
  // A dropped replace is answered with what the server kept: the offsets wait for the
  // transcript to grow, and then it goes whole (uploader.ts).
  const waiting = replaceDropped(ev) && s.file_offset !== s.server_offset;
  if (s.aligned !== false && s.file_offset !== s.server_offset && !waiting) {
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
  if (waiting) {
    return result(id, title, "warn", REPLACE_DROPPED, { detail: [summary], hint: REPLACE_HINT });
  }
  return result(id, title, "ok", summary);
}

// --- records and prefix hash ----------------------------------------------------------------

interface LocalRecords {
  /** Where in the transcript the server's log ends. */
  end: number;
  records?: NormalizedRecord[];
  error?: string;
  skip?: string;
}

/** The transcript up to where the server's log ends, normalized as the server would. */
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
  let end: number;
  if (s.server_offset === n.bytes && s.file_offset !== undefined) end = s.file_offset;
  else if (s.aligned !== false) end = n.bytes;
  else {
    return {
      end: 0,
      skip: "pre-redaction changed lengths and the offsets disagree: the server's offset cannot be found in the transcript",
    };
  }
  if (end > (ev.transcript.size ?? 0)) {
    return { end, skip: `the transcript is shorter than the ${bytes(end)} the server holds` };
  }
  try {
    const text = deps.files.read(ev.transcript.path, end);
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

/** Whether a redaction backfill (F2.5) rewrote the session's traces after its prefix hash was
 * last computed from a whole log. A backfill leaves `normalized` as the earlier rules made it,
 * by design (the next whole upload conflicts and replaces); only a whole write (a first
 * publish, a replace, a rebuild) computes it afresh. The change feed says which came last: a
 * backfill's entry is a `published` replace with `reason: "redacted"`; a whole write's is a
 * `published` entry without `continuation`. Undefined feed: false. */
function backfilledSincePrefix(ev: SessionEvidence): boolean {
  let backfilled = false;
  for (const { entry } of ev.server.changes ?? []) {
    if (entry.kind !== "published") continue;
    if (entry.reason === "redacted") backfilled = true;
    else if (!entry.continuation) backfilled = false;
  }
  return backfilled;
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

// --- trace chain ----------------------------------------------------------------------------

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

// --- redaction residue ----------------------------------------------------------------------

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

// --- staleness ------------------------------------------------------------------------------

export function stalenessCheck(ev: SessionEvidence, deps: DoctorDeps): CheckResult {
  const id = "staleness";
  const title = "Staleness";
  const why = noServer(ev);
  if (why) return result(id, title, "skip", why);
  const m = storedOf(ev);
  if (!m || m.status === "redacted") return result(id, title, "skip", "nothing stored");
  const format = ev.server.agent ?? ev.agent;
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

// --- change feed ----------------------------------------------------------------------------

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

// --- search ---------------------------------------------------------------------------------

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

/** Every check of one session, in order. */
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
  ];
  const search = searchCheck(ev);
  if (search) results.push(search);
  return results;
}
