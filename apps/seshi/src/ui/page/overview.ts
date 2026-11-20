/** The team at a glance, as an engineering panel: every number beside its trend and its change
 * on the span before, one time axis for every series, one table per question.
 *
 * - Metrics: sessions, active people, tokens, tool calls, tool error rate, median session,
 *   events stored, redacted sessions; each with a sparkline over the span and the change
 *   against the span before it.
 * - Activity: sessions, people, tokens and tool errors per hour (a day) or per day (a week, a
 *   month), as small multiples on one axis.
 * - Breakdown: one table by agent, model, repository or person, with each one's sessions,
 *   tokens, tool calls, error rate and trend.
 * - Tools, redaction, and ingest health; the pipeline for admins (`sources:admin`).
 *
 * Built from the same browse the list uses, so it counts only what the person may read. */

import type { Identity, SearchResult, SearchResults } from "@seshi/model";
import { type Child, h, replace } from "../../web/dom";
import { ApiError, call } from "./api";
import { compact, sparkline, timeline } from "./charts";
import { EMPTY, type ListState, SINCE, type Since, type TextFilter, withFilter } from "./filters";
import { listHref } from "./list";
import { ago, plural, shortRepo } from "./text";

/** The most sessions read (the span and the one before it): past it, the page says so. */
const MAX_SESSIONS = 4000;
const PAGE = 100;
const HOUR_MS = 3_600_000;

const SPANS: Record<Since, { label: string; before: string }> = {
  "1d": { label: "24 hours", before: "the 24 hours before" },
  "7d": { label: "7 days", before: "the 7 days before" },
  "30d": { label: "30 days", before: "the 30 days before" },
};

interface Bucket {
  start: number;
  end: number;
  label: string;
  tick?: string;
}

/** The span's buckets, oldest first: hours for a day, days for a week or a month. */
function bucketsOf(span: Since, now: Date): Bucket[] {
  const out: Bucket[] = [];
  if (span === "1d") {
    const top = new Date(now);
    top.setMinutes(0, 0, 0);
    for (let i = 23; i >= 0; i--) {
      const start = top.getTime() - i * HOUR_MS;
      const d = new Date(start);
      out.push({
        start,
        end: start + HOUR_MS,
        label: d.toLocaleString([], { weekday: "short", hour: "numeric" }),
        ...(i % 6 === 0 ? { tick: d.toLocaleTimeString([], { hour: "numeric" }) } : {}),
      });
    }
    return out;
  }
  const days = SINCE[span];
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(midnight);
    d.setDate(d.getDate() - i);
    const end = new Date(d);
    end.setDate(end.getDate() + 1);
    const label = d.toLocaleDateString([], { month: "short", day: "numeric" });
    // Every day in a week; in a month, weekly back from today, so labels never collide.
    const ticked = days <= 7 || i % 7 === 0;
    out.push({ start: d.getTime(), end: end.getTime(), label, ...(ticked ? { tick: label } : {}) });
  }
  return out;
}

const at = (iso: string) => new Date(iso).getTime();
const activity = (r: SearchResult) => at(r.ended_at ?? r.updated_at);
const tokensOf = (r: SearchResult) => (r.tokens ? r.tokens.input + r.tokens.output : 0);
const callsOf = (r: SearchResult) => Object.values(r.tools ?? {}).reduce((a, b) => a + b, 0);
const lengthOf = (r: SearchResult) =>
  r.started_at && r.ended_at ? at(r.ended_at) - at(r.started_at) : undefined;

function quantile(values: number[], q: number): number | undefined {
  if (values.length === 0) return undefined;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

function duration(ms: number | undefined): string {
  if (ms === undefined) return "–";
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 90) return `${min} min`;
  const hours = Math.round(min / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

const pct = (part: number, whole: number, digits = 1) =>
  whole === 0 ? "–" : `${((100 * part) / whole).toFixed(digits)}%`;

interface Tally {
  sessions: number;
  tokens: number;
  calls: number;
  ok: number;
  failed: number;
  people: Set<string>;
  lengths: number[];
  events: number;
  redacted: number;
}

function tally(rows: SearchResult[]): Tally {
  const t: Tally = {
    sessions: rows.length,
    tokens: 0,
    calls: 0,
    ok: 0,
    failed: 0,
    people: new Set(),
    lengths: [],
    events: 0,
    redacted: 0,
  };
  for (const r of rows) {
    t.tokens += tokensOf(r);
    t.calls += callsOf(r);
    t.ok += r.tool_outcomes?.ok ?? 0;
    t.failed += r.tool_outcomes?.failed ?? 0;
    t.people.add(r.owner);
    const len = lengthOf(r);
    if (len !== undefined) t.lengths.push(len);
    t.events += r.events ?? 0;
    if (r.redactions) t.redacted++;
  }
  return t;
}

const errorRate = (t: Tally) => (t.ok + t.failed === 0 ? undefined : t.failed / (t.ok + t.failed));

/** The change from `before` to `now`, as a signed percent (or points, for a rate). */
function change(now: number | undefined, before: number | undefined, points = false): HTMLElement {
  const show = (text: string) => h("span", { class: "delta" }, text);
  if (now === undefined || before === undefined) return show("–");
  if (points) {
    const d = (now - before) * 100;
    if (Math.abs(d) < 0.05) return show("no change");
    return show(`${d > 0 ? "▲ +" : "▼ −"}${Math.abs(d).toFixed(1)} pt`);
  }
  if (before === 0) return show(now === 0 ? "no change" : "new");
  const d = (now - before) / before;
  if (Math.abs(d) < 0.005) return show("no change");
  return show(`${d > 0 ? "▲ +" : "▼ −"}${Math.abs(d * 100).toFixed(0)}%`);
}

function metric(
  label: string,
  value: string,
  delta: HTMLElement,
  spark: (number | null)[],
): HTMLElement {
  return h(
    "div",
    { class: "metric" },
    h("dt", null, label),
    h("dd", { class: "metric-value" }, value),
    h("dd", { class: "metric-delta" }, delta),
    h("dd", { class: "metric-spark" }, sparkline(spark, `${label} over the span`)),
  );
}

function section(title: string, ...children: Child[]): HTMLElement {
  return h("section", { class: "panel-section" }, h("h2", null, title), ...children);
}

function table(cls: string, head: (string | [string, string])[], rows: Child[][]): HTMLElement {
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      { class: `plain ${cls}` },
      h(
        "thead",
        null,
        h(
          "tr",
          null,
          head.map((c) => (Array.isArray(c) ? h("th", { class: c[1] }, c[0]) : h("th", null, c))),
        ),
      ),
      h(
        "tbody",
        null,
        rows.map((r) => h("tr", null, r)),
      ),
    ),
  );
}

/** A row of the health table: what, its value, and a note under the value. */
function healthRow(label: string, value: string, note: string): Child[] {
  return [
    h("th", { scope: "row" }, label),
    h(
      "td",
      null,
      h("span", { class: "health-value" }, value),
      note ? h("span", { class: "health-note" }, note) : null,
    ),
  ];
}

const num = (text: string, title?: string) =>
  h("td", { class: "num", ...(title ? { title } : {}) }, text);

/** A share as a thin bar in a cell of its own, beside the number it repeats. */
function shareBar(n: number, max: number): HTMLElement {
  const w = Math.max(1, Math.round((n / Math.max(1, max)) * 20));
  return h(
    "td",
    { class: "share", "aria-hidden": "true" },
    h("span", { class: "share-bar" }, h("span", { class: `rank-fill w${w}` })),
  );
}

async function readAll(from: number) {
  const results: SearchResult[] = [];
  let cursor: string | undefined;
  let total = 0;
  let index: SearchResults["index"] | undefined;
  do {
    const query = new URLSearchParams({
      limit: String(PAGE),
      since: new Date(from).toISOString(),
    });
    if (cursor) query.set("cursor", cursor);
    const page = await call<SearchResults>("search", { query });
    total = page.total;
    index = page.index;
    results.push(...page.results);
    cursor = page.cursor;
  } while (cursor && results.length < MAX_SESSIONS);
  return { results, total, index };
}

interface SourceStatus {
  id: string;
  type: string;
  checkpoint: string | null;
  dropped: number;
  failed: number;
  health?: { stored?: number; filtered?: number };
}

interface Jobs {
  worker?: { state: string; last_heartbeat?: string };
  jobs: {
    name: string;
    last?: { runs: number; failures: number; last_outcome?: string; last_finished?: string };
  }[];
}

type Dimension = "agent" | "model" | "repo" | "owner";

const DIMENSIONS: Record<
  Dimension,
  {
    label: string;
    key: (r: SearchResult) => string | undefined;
    filter: TextFilter;
    show: (k: string) => string;
  }
> = {
  agent: {
    label: "Agent",
    key: (r) => r.origin_agent ?? r.format,
    filter: "agent",
    show: (k) => k,
  },
  model: { label: "Model", key: (r) => r.models?.[0], filter: "model", show: (k) => k },
  repo: { label: "Repository", key: (r) => r.repo, filter: "repo", show: shortRepo },
  owner: { label: "Person", key: (r) => r.owner, filter: "owner", show: (k) => k },
};

/** One table for "who or what ran this": a row per agent, model, repository or person, with
 * its sessions, tokens, tool calls, error rate and trend over the span. */
function breakdown(
  results: SearchResult[],
  buckets: Bucket[],
  dimension: Dimension,
  href: (filter: TextFilter, value: string) => string,
): HTMLElement {
  const d = DIMENSIONS[dimension];
  const groups = new Map<string, SearchResult[]>();
  let none = 0;
  for (const r of results) {
    const k = d.key(r);
    if (!k) {
      none++;
      continue;
    }
    const list = groups.get(k) ?? [];
    list.push(r);
    groups.set(k, list);
  }
  const rows = [...groups.entries()]
    .map(([key, rs]) => ({ key, rs, t: tally(rs) }))
    .sort((a, b) => b.t.sessions - a.t.sessions || b.t.tokens - a.t.tokens);
  const max = rows[0]?.t.sessions ?? 1;
  const body = rows.slice(0, 12).map(({ key, rs, t }) => {
    const rate = errorRate(t);
    const series = buckets.map(
      (b) => rs.filter((r) => activity(r) >= b.start && activity(r) < b.end).length,
    );
    return [
      h("td", { class: "name" }, h("a", { href: href(d.filter, key), title: key }, d.show(key))),
      num(t.sessions.toLocaleString()),
      shareBar(t.sessions, max),
      num(t.tokens ? compact(t.tokens) : "–", t.tokens ? t.tokens.toLocaleString() : undefined),
      num(t.calls ? compact(t.calls) : "–"),
      num(
        rate === undefined ? "–" : pct(t.failed, t.ok + t.failed),
        rate === undefined ? "No tool outcomes recorded" : `${t.failed} of ${t.ok + t.failed}`,
      ),
      h("td", { class: "trend" }, sparkline(series, `${d.show(key)}: sessions over the span`)),
    ];
  });
  const notes = [
    dimension === "model" ? "A session that used several models counts toward its first." : "",
    rows.length > 12 ? `${plural(rows.length - 12, "more")} not shown.` : "",
    none > 0 ? `${plural(none, "session")} without one.` : "",
  ].filter(Boolean);
  return h(
    "div",
    null,
    table(
      "breakdown",
      [
        d.label,
        ["Sessions", "num"],
        ["", "share"],
        ["Tokens", "num"],
        ["Tool calls", "num"],
        ["Errors", "num"],
        ["Trend", "trend"],
      ],
      body,
    ),
    notes.length ? h("p", { class: "table-note" }, notes.join(" ")) : null,
  );
}

async function pipeline(span: Since, now: Date): Promise<{ rows: Child[][]; jobs: HTMLElement }> {
  const [sources, jobs] = await Promise.all([
    call<{ sources: SourceStatus[] }>("adminSources", {
      query: new URLSearchParams({ days: String(SINCE[span]) }),
    }),
    call<Jobs>("adminJobs"),
  ]);
  const rows: Child[][] = sources.sources.map((s) =>
    healthRow(
      `Source ${s.id}`,
      `${(s.health?.stored ?? 0).toLocaleString()} stored, ${(s.health?.filtered ?? 0).toLocaleString()} filtered`,
      `${s.failed.toLocaleString()} failed, ${s.dropped.toLocaleString()} dropped; ${
        s.checkpoint
          ? `checkpoint ${ago(s.checkpoint, now)}`
          : s.type === "upload"
            ? "pushed by laptops"
            : "not polled yet"
      }`,
    ),
  );
  if (jobs.worker) {
    rows.push(
      healthRow(
        "Worker",
        jobs.worker.state,
        jobs.worker.last_heartbeat ? `heartbeat ${ago(jobs.worker.last_heartbeat, now)}` : "",
      ),
    );
  }
  const jobTable = table(
    "jobs",
    ["Job", "Last run", "Outcome", ["Runs", "num"], ["Failures", "num"]],
    jobs.jobs.map((j) => [
      h("td", null, j.name),
      h("td", null, j.last?.last_finished ? ago(j.last.last_finished, now) : "not yet"),
      h(
        "td",
        null,
        j.last?.last_outcome === "ok"
          ? "✓ ok"
          : j.last?.last_outcome
            ? `✕ ${j.last.last_outcome}`
            : "–",
      ),
      num((j.last?.runs ?? 0).toLocaleString()),
      num((j.last?.failures ?? 0).toLocaleString()),
    ]),
  );
  return { rows, jobs: jobTable };
}

export function renderOverview(
  root: HTMLElement,
  ctx: { query: URLSearchParams; me: Identity; isCurrent: () => boolean },
): void {
  const asked = ctx.query.get("since");
  const span: Since = asked !== null && asked in SINCE ? (asked as Since) : "7d";
  const askedBy = ctx.query.get("by");
  const by: Dimension =
    askedBy !== null && askedBy in DIMENSIONS ? (askedBy as Dimension) : "agent";
  const now = new Date();
  const buckets = bucketsOf(span, now);
  const start = buckets[0]?.start ?? now.getTime();
  const before = start - (now.getTime() - start);
  const asOf = h("p", { class: "as-of", role: "status" }, "Reading sessions…");
  const body = h("div", { class: "panel-body" });
  const spanNav = h(
    "nav",
    { class: "segmented", "aria-label": "Span" },
    (Object.keys(SPANS) as Since[]).map((s) =>
      h(
        "a",
        {
          href: `#/overview?since=${s}&by=${by}`,
          ...(s === span ? { "aria-current": "page" } : {}),
        },
        SPANS[s].label,
      ),
    ),
  );
  replace(
    root,
    h(
      "section",
      { class: "overview" },
      h("header", { class: "panel-head" }, h("h1", null, "Overview"), spanNav, asOf),
      body,
    ),
  );
  document.title = "Overview: seshi";
  const href = (filter: TextFilter, value: string) =>
    listHref(withFilter({ ...EMPTY, since: span } as ListState, filter, value));

  void readAll(before).then(
    ({ results, total, index }) => {
      if (!ctx.isCurrent()) return;
      const current = results.filter((r) => activity(r) >= start);
      const previous = results.filter((r) => activity(r) >= before && activity(r) < start);
      const cur = tally(current);
      const prev = tally(previous);
      const perTally = buckets.map((b) =>
        tally(current.filter((r) => activity(r) >= b.start && activity(r) < b.end)),
      );

      replace(
        asOf,
        h(
          "span",
          null,
          `As of ${now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`,
        ),
        results.length < total
          ? h("span", null, `counted the ${results.length.toLocaleString()} most recent sessions`)
          : null,
      );

      if (current.length === 0) {
        replace(body, h("p", { class: "empty" }, `No sessions in the last ${SPANS[span].label}.`));
        return;
      }

      const median = quantile(cur.lengths, 0.5);
      const rate = errorRate(cur);
      const metrics = h(
        "dl",
        { class: "metrics" },
        metric(
          "Sessions",
          cur.sessions.toLocaleString(),
          change(cur.sessions, prev.sessions),
          perTally.map((t) => t.sessions),
        ),
        metric(
          "Active people",
          cur.people.size.toLocaleString(),
          change(cur.people.size, prev.people.size),
          perTally.map((t) => t.people.size),
        ),
        metric(
          "Tokens",
          compact(cur.tokens),
          change(cur.tokens, prev.tokens),
          perTally.map((t) => t.tokens),
        ),
        metric(
          "Tool calls",
          compact(cur.calls),
          change(cur.calls, prev.calls),
          perTally.map((t) => t.calls),
        ),
        metric(
          "Tool error rate",
          rate === undefined ? "–" : pct(cur.failed, cur.ok + cur.failed),
          change(rate, errorRate(prev), true),
          perTally.map((t) => errorRate(t) ?? null),
        ),
        metric(
          "Median session",
          duration(median),
          change(median, quantile(prev.lengths, 0.5)),
          perTally.map((t) => quantile(t.lengths, 0.5) ?? null),
        ),
        metric(
          "Events stored",
          compact(cur.events),
          change(cur.events, prev.events),
          perTally.map((t) => t.events),
        ),
        metric(
          "Redacted",
          pct(cur.redacted, cur.sessions, 0),
          change(
            cur.redacted / cur.sessions,
            prev.sessions ? prev.redacted / prev.sessions : undefined,
            true,
          ),
          perTally.map((t) => (t.sessions ? t.redacted / t.sessions : null)),
        ),
      );

      const activityChart = timeline(
        [
          {
            label: "Sessions",
            summary: cur.sessions.toLocaleString(),
            values: perTally.map((t) => t.sessions),
            format: (n) => n.toLocaleString(),
            unit: "sessions",
          },
          {
            label: "People",
            summary: `${cur.people.size.toLocaleString()} in all`,
            values: perTally.map((t) => t.people.size),
            format: (n) => n.toLocaleString(),
            unit: "active",
          },
          {
            label: "Tokens",
            summary: compact(cur.tokens),
            values: perTally.map((t) => t.tokens),
            format: compact,
            unit: "tokens",
          },
          {
            label: "Tool errors",
            summary: `${cur.failed.toLocaleString()} failed`,
            values: perTally.map((t) => t.failed),
            format: (n) => n.toLocaleString(),
            unit: "failed results",
          },
        ],
        buckets,
      );

      const tabs = h(
        "nav",
        { class: "segmented", "aria-label": "Break down by" },
        (Object.keys(DIMENSIONS) as Dimension[]).map((d) =>
          h(
            "a",
            {
              href: `#/overview?since=${span}&by=${d}`,
              ...(d === by ? { "aria-current": "page" } : {}),
            },
            DIMENSIONS[d].label,
          ),
        ),
      );

      const toolCounts = new Map<string, number>();
      for (const r of current) {
        for (const [k, n] of Object.entries(r.tools ?? {})) {
          toolCounts.set(k, (toolCounts.get(k) ?? 0) + n);
        }
      }
      const tools = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]);
      const toolMax = tools[0]?.[1] ?? 1;
      const rules = new Map<string, { matches: number; sessions: number }>();
      for (const r of current) {
        for (const [k, n] of Object.entries(r.redactions ?? {})) {
          const e = rules.get(k) ?? { matches: 0, sessions: 0 };
          e.matches += n;
          e.sessions++;
          rules.set(k, e);
        }
      }
      const ruleRows = [...rules.entries()].sort((a, b) => b[1].matches - a[1].matches);

      // How soon sessions reach the store, and how current the index is.
      const delays = current.flatMap((r) =>
        r.ended_at ? [Math.max(0, at(r.updated_at) - at(r.ended_at))] : [],
      );
      const prompt = delays.filter((ms) => ms <= 15 * 60_000).length;
      const health: Child[][] = [
        healthRow(
          "Capture delay",
          `${duration(quantile(delays, 0.5))} median, ${duration(quantile(delays, 0.95))} p95`,
          "Last event to stored copy; a backfill counts from its upload.",
        ),
        healthRow(
          "Stored within 15 min",
          pct(prompt, delays.length, 0),
          `${prompt.toLocaleString()} of ${plural(delays.length, "session")}`,
        ),
        healthRow(
          "Search index",
          index?.caught_up_at ? `caught up ${ago(index.caught_up_at, now)}` : "building",
          `${plural(index?.sessions ?? 0, "session")} indexed`,
        ),
      ];
      const healthTable = h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          { class: "plain health" },
          h(
            "tbody",
            null,
            health.map((r) => h("tr", null, r)),
          ),
        ),
      );
      const jobsSlot = h("div", { class: "jobs-slot" });

      replace(
        body,
        metrics,
        h(
          "p",
          { class: "compare-note" },
          `Changes compare the last ${SPANS[span].label} with ${SPANS[span].before}. Sparklines run over the same span.`,
        ),
        section(span === "1d" ? "Activity per hour" : "Activity per day", activityChart),
        section("Breakdown", tabs, breakdown(current, buckets, by, href)),
        h(
          "div",
          { class: "panel-grid" },
          section(
            "Tools",
            tools.length
              ? table(
                  "tools",
                  ["Tool", ["Calls", "num"], ["", "share"]],
                  tools
                    .slice(0, 10)
                    .map(([name, n]) => [
                      h("td", { class: "name mono-cell", title: name }, name),
                      num(n.toLocaleString(), `${pct(n, cur.calls, 0)} of tool calls`),
                      shareBar(n, toolMax),
                    ]),
                )
              : h("p", { class: "empty" }, "No tool calls."),
            tools.length > 10
              ? h(
                  "p",
                  { class: "table-note" },
                  `${plural(tools.length - 10, "more tool")} not shown.`,
                )
              : null,
          ),
          section(
            "Redaction",
            ruleRows.length
              ? table(
                  "rules",
                  ["Rule", ["Matches", "num"], ["Sessions", "num"]],
                  ruleRows.map(([rule, e]) => [
                    h("td", { class: "name mono-cell" }, rule),
                    num(e.matches.toLocaleString()),
                    num(e.sessions.toLocaleString()),
                  ]),
                )
              : h("p", { class: "empty" }, "Nothing matched the redaction rules."),
            h("p", { class: "table-note" }, "Replaced before the server stored each session."),
          ),
          section("Ingest health", healthTable, jobsSlot),
        ),
      );

      if (ctx.me.scopes?.includes("sources:admin")) {
        void pipeline(span, now).then(
          ({ rows, jobs }) => {
            if (!ctx.isCurrent()) return;
            const tbody = healthTable.querySelector("tbody");
            for (const r of rows) tbody?.append(h("tr", null, r));
            jobsSlot.replaceWith(h("h3", { class: "sub" }, "Jobs"), jobs);
          },
          () => {},
        );
      }
    },
    (err: unknown) => {
      if (!ctx.isCurrent()) return;
      asOf.textContent =
        err instanceof ApiError && (err.code === "search_disabled" || err.status === 403)
          ? "The overview needs search, which this server or this credential does not have."
          : `The overview did not load: ${err instanceof Error ? err.message : String(err)}`;
      asOf.classList.add("problem");
    },
  );
}
