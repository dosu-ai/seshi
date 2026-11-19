import type { SessionEvidence } from "../doctor/types";
import type { TimelineEvent } from "./types";

const short = (hash: string | null | undefined) => (hash ? hash.slice(0, 12) : "none");

export function splitLogLine(line: string): { at?: string; text: string } {
  const space = line.indexOf(" ");
  if (space > 0) {
    const at = line.slice(0, space);
    if (/^\d{4}-\d\d-\d\dT/.test(at) && !Number.isNaN(Date.parse(at))) {
      return { at, text: line.slice(space + 1) };
    }
  }
  return { text: line };
}

export function timelineOf(ev: SessionEvidence): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const add = (at: string | undefined, kind: TimelineEvent["kind"], text: string) => {
    if (at && !Number.isNaN(Date.parse(at))) events.push({ at, kind, text });
  };
  const s = ev.local;
  if (s) {
    add(s.first_seen, "seen", "first seen by a hook or the sweep");
    if (s.last_seen)
      add(s.last_seen, "seen", `last seen${s.final ? " (the agent said it ended)" : ""}`);
    if (s.uploaded_at) {
      add(s.uploaded_at, "upload", `last upload answered ${s.last_status ?? "?"}`);
    }
    if (s.error) {
      add(
        s.error.at,
        "error",
        `refused (${s.error.code}${s.error.permanent ? ", permanent" : ""}): ${s.error.message}`,
      );
    }
    if (s.next_attempt_at) {
      add(s.next_attempt_at, "error", `next attempt after ${s.failures ?? 1} failure(s)`);
    }
    if (s.toggle && s.toggled_at)
      add(s.toggled_at, "toggle", `turned ${s.toggle} for this session`);
    if (s.retract) {
      add(
        s.toggled_at ?? s.last_seen ?? s.first_seen,
        "retraction",
        `retraction ${s.retract}${s.retract_error ? `: ${s.retract_error}` : ""}`,
      );
    }
    if (s.frozen)
      add(s.frozen.at, "pause", `a pause stopped the session at ${s.frozen.offset} bytes`);
    if (s.rebuild) {
      add(
        s.rebuild.at,
        "rebuild",
        `rebuild asked${s.rebuild.for ? ` (stale against ${s.rebuild.for})` : ""}${s.rebuild.not_before ? `, not before ${s.rebuild.not_before}` : ""}`,
      );
    }
  }
  const paused = ev.machine.paused;
  if (paused)
    add(paused.at, "pause", `capture paused${paused.until ? ` until ${paused.until}` : ""}`);
  for (const e of ev.spool.entries) {
    add(e.at, "spool", `spool ${e.kind}${e.event ? ` ${e.event}` : ""} (${e.name})`);
  }
  for (const line of ev.log.lines) {
    const { at, text } = splitLogLine(line);
    add(at, "log", text);
  }
  const m = ev.server.metadata ?? ev.server.pointer;
  if (m) {
    add(m.created_at, "upload", `the server created the session (${m.status})`);
    if (m.updated_at !== m.created_at) add(m.updated_at, "upload", "the server last wrote it");
  }
  const retracted = ev.server.retracted;
  if (retracted?.metadata) {
    add(
      retracted.metadata.updated_at,
      "retraction",
      `${retracted.upload_id} on the server: ${retracted.metadata.status}`,
    );
  }
  for (const { entry } of ev.server.changes ?? []) {
    add(
      entry.at,
      "change",
      `${entry.kind}${entry.reason ? ` (${entry.reason})` : ""}${entry.content_hash ? ` ${short(entry.content_hash)}` : ""}${entry.continuation ? ` continuing from record ${entry.continuation.from_record}` : ""}${entry.replace ? " (replace)" : ""}`,
    );
  }
  for (const r of ev.server.reviews ?? []) {
    add(
      r.at,
      "review",
      `review ${r.decision} ${short(r.content_hash)}${r.findings?.length ? `: ${r.findings.length} finding(s)` : ""}${r.failure ? ` (${r.failure.step} failed: ${r.failure.code})` : ""}`,
    );
  }
  return events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
