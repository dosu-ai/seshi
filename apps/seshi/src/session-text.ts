/** Sessions, events and search results as lines of text written for a model (and a person) to
 * read: what `seshi mcp`'s tools answer, and `seshi sessions recent|read` print. Plain text,
 * one thing a line, nothing a terminal would style. docs/seshi/session-tools.md. */
import { parseDuration } from "@seshi/config";
import type {
  SearchResult,
  SearchResults,
  SessionEvent,
  SessionEvents,
  SessionHeader,
  SessionList,
  SessionSummary,
} from "@seshi/model";
import { printable } from "./cli/style";

/** An instant to the second, UTC. */
export function utc(iso: string | undefined): string {
  if (iso === undefined) return "?";
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(0, 19)}Z` : iso;
}

const count = (n: number) => n.toLocaleString("en-US");

/** `repo@branch`, the project when there is no repo, or nothing. */
function where(s: { repo?: string; project?: string; branch?: string }): string | undefined {
  const place = s.repo ?? s.project;
  if (place === undefined) return s.branch === undefined ? undefined : `@${s.branch}`;
  return s.branch === undefined ? place : `${place}@${s.branch}`;
}

function labelsText(labels: Record<string, string> | undefined): string | undefined {
  const entries = Object.entries(labels ?? {});
  return entries.length === 0 ? undefined : entries.map(([k, v]) => `${k}=${v}`).join(" ");
}

function span(started: string | undefined, ended: string | undefined): string {
  if (started === undefined && ended === undefined) return "";
  const end = ended === undefined ? "?" : utc(ended);
  // The same day: only the time again.
  const short =
    started !== undefined && ended !== undefined && utc(started).slice(0, 10) === end.slice(0, 10)
      ? end.slice(11)
      : end;
  return `${utc(started)} → ${short}`;
}

/** `owner/archive_id · agent · repo@branch · started → ended · models · labels`. */
export function summaryLine(s: SessionSummary): string {
  return printable(
    [
      `${s.owner}/${s.archive_id}`,
      `${s.format}/${s.session_id}`,
      where(s),
      span(s.started_at, s.ended_at) || `updated ${utc(s.updated_at)}`,
      s.models && s.models.length > 0 ? s.models.join(",") : undefined,
      labelsText(s.labels),
      s.visibility === "owner" ? "owner-only" : undefined,
    ]
      .filter((p) => p !== undefined && p !== "")
      .join(" · "),
  );
}

export function listLines(list: SessionList): string[] {
  const lines = list.sessions.map(summaryLine);
  if (lines.length === 0) lines.push("no sessions match");
  lines.push(list.cursor === undefined ? "end" : `after: ${list.cursor}`);
  return lines;
}

function tokensText(header: SessionHeader): string {
  const t = header.tokens;
  return [
    `in ${count(t.input_tokens)}`,
    `out ${count(t.output_tokens)}`,
    ...(t.cache_read_input_tokens > 0 ? [`cache read ${count(t.cache_read_input_tokens)}`] : []),
    ...(t.cache_creation_input_tokens > 0
      ? [`cache write ${count(t.cache_creation_input_tokens)}`]
      : []),
    ...(t.reasoning_tokens > 0 ? [`reasoning ${count(t.reasoning_tokens)}`] : []),
  ].join(", ");
}

export function headerLines(h: SessionHeader): string[] {
  return [
    printable(
      [
        `session ${h.owner}/${h.archive_id}`,
        `${h.format}/${h.session_id}`,
        h.harness !== undefined && h.harness !== h.format ? `harness ${h.harness}` : undefined,
        where(h),
        span(h.started_at, h.ended_at) || undefined,
        labelsText(h.labels),
      ]
        .filter((p) => p !== undefined)
        .join(" · "),
    ),
    printable(
      [
        `${count(h.events)} events in ${h.traces} trace${h.traces === 1 ? "" : "s"}`,
        `head ${h.head}`,
        h.models.length > 0 ? `models ${h.models.join(", ")}` : undefined,
        h.llm_calls > 0
          ? `${count(h.llm_calls)} model calls${
              Object.values(h.tokens).some((n) => n > 0) ? ` (tokens ${tokensText(h)})` : ""
            }`
          : undefined,
      ]
        .filter((p) => p !== undefined)
        .join(" · "),
    ),
  ];
}

/** `#212 tool_result Bash  ok=0  2026-11-25T10:02:41Z  FAIL … [+18,422 chars]`, with any
 * further lines of the text indented under it. */
export function eventLines(e: SessionEvent): string[] {
  const head = [
    `#${e.seq}`,
    e.role.padEnd(11),
    ...(e.tool_name !== undefined ? [printable(e.tool_name)] : []),
    ...(e.ok !== undefined ? [`ok=${e.ok ? 1 : 0}`] : []),
    utc(e.timestamp),
  ].join(" ");
  const offset = e.offset !== undefined && e.offset > 0 ? `[from char ${count(e.offset)}] ` : "";
  const cut = e.cut !== undefined && e.cut > 0 ? ` [+${count(e.cut)} chars]` : "";
  // A trailing newline (most tool output ends with one) would print an empty line.
  const text = `${offset}${e.text.replace(/\n+$/, "")}${cut}`;
  const [first, ...rest] = text.split("\n");
  return [`${head}  ${printable(first ?? "")}`, ...rest.map((l) => `    ${printable(l)}`)];
}

export function eventsLines(read: SessionEvents): string[] {
  const lines = headerLines(read.session);
  const piece = read.next_offset !== undefined || read.events[0]?.offset !== undefined;
  lines.push(
    piece
      ? `event #${read.from}, from character ${count(read.events[0]?.offset ?? 0)}`
      : `events #${read.from} to #${Math.max(read.from, read.to - 1)} (${read.mode})`,
  );
  for (const e of read.events) lines.push(...eventLines(e));
  if (read.events.length === 0) lines.push("no events in this range");
  if (piece) {
    lines.push(
      read.next_offset !== undefined
        ? `next_offset: ${read.next_offset} (event ${read.from}, offset ${read.next_offset})`
        : "end of event",
    );
  }
  lines.push(read.next === undefined ? "end" : `next: ${read.next}`);
  return lines;
}

/** One result: its session's line, then each match as `#index@trace role tool: excerpt`, where
 * `trace` is the first 8 characters of the content hash (read_session's `trace`, with `around`
 * the index). */
export function searchResultLines(r: SearchResult): string[] {
  const lines = [
    `${summaryLine(r)} · score ${r.score} · ${r.hits} match${r.hits === 1 ? "" : "es"}`,
  ];
  for (const m of r.matches) {
    const label = m.tool_name === undefined ? m.role : `${m.role} ${m.tool_name}`;
    lines.push(
      printable(
        `  #${m.event_index}@${m.content_hash.slice(0, 8)} ${label}: ${m.snippet.replace(/\s+/g, " ")}`,
      ),
    );
  }
  return lines;
}

export function searchLines(results: SearchResults): string[] {
  const lines = results.results.flatMap(searchResultLines);
  if (lines.length === 0) lines.push("no sessions match");
  lines.push(
    `${results.capped ? "at least " : ""}${results.total} session${results.total === 1 ? "" : "s"} match${
      results.cursor !== undefined ? ` · more after cursor ${results.cursor}` : ""
    }${results.capped ? " · capped" : ""}`,
  );
  return lines;
}

/** A time as a date or an RFC 3339 time: four-digit year first, so a bare number (`7`) is not
 * read as a year. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}/;

/** A time a person or an agent gave (RFC 3339, a date) or an age back from `now` (`7d`, `24h`),
 * as RFC 3339; undefined for neither. */
export function timeOrAge(value: string, now: Date): string | undefined {
  const ago = parseDuration(value);
  if (ago !== undefined) return new Date(now.getTime() - ago).toISOString();
  const ms = ISO_TIME.test(value) ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}
