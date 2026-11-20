/** The team at a glance, then one page per question.
 *
 * The overview shows only what answers "how are we doing": five headline numbers (each with
 * its trend and its change on the span before), sessions over the span, the top
 * repositories, agents and people, and one line on ingest. Every one of them links to more:
 * a number to its own page (its series over time and a breakdown sorted by it), a name to the
 * sessions it filters to, the ingest line to ingest health.
 *
 * Built from the same browse the list uses, so it counts only what the person may read; the
 * sessions read for a span are kept for a minute, so moving between the pages reads them once. */

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
const KEEP_MS = 60_000;

const SPANS: Record<Since, { label: string; before: string; per: string }> = {
  "1d": { label: "24 hours", before: "the 24 hours before", per: "hour" },
  "7d": { label: "7 days", before: "the 7 days before", per: "day" },
  "30d": { label: "30 days", before: "the 30 days before", per: "day" },
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
  delays: number[];
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
    delays: [],
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
    if (r.ended_at) t.delays.push(Math.max(0, at(r.updated_at) - at(r.ended_at)));
    t.events += r.events ?? 0;
    if (r.redactions) t.redacted++;
  }
  return t;
}

const errorRate = (t: Tally) => (t.ok + t.failed === 0 ? undefined : t.failed / (t.ok + t.failed));

/** The headline measures: what each counts, how it reads, and its page. */
interface Measure {
  label: string;
  value: (t: Tally) => number | undefined;
  show: (n: number | undefined) => string;
  /** A rate: its change is in points. */
  rate?: boolean;
  /** What a bar in its chart counts, for the chart's hover and table. */
  unit: string;
  /** Where its tile leads. */
  page: string;
  /** The breakdown its page opens on. */
  by?: Dimension;
}

const MEASURES: Record<string, Measure> = {
  sessions: {
    label: "Sessions",
    value: (t) => t.sessions,
    show: (n) => (n ?? 0).toLocaleString(),
    unit: "sessions",
    page: "sessions",
  },
  people: {
    label: "Active people",
    value: (t) => t.people.size,
    show: (n) => (n ?? 0).toLocaleString(),
    unit: "people",
    page: "people",
  },
  tokens: {
    label: "Tokens",
    value: (t) => t.tokens,
    show: (n) => compact(n ?? 0),
    unit: "tokens",
    page: "tokens",
    by: "model",
  },
  errors: {
    label: "Tool error rate",
    value: errorRate,
    show: (n) => (n === undefined ? "–" : `${(n * 100).toFixed(1)}%`),
    rate: true,
    unit: "error rate",
    page: "errors",
    by: "agent",
  },
  delay: {
    label: "Capture delay",
    value: (t) => quantile(t.delays, 0.5),
    show: duration,
    unit: "median delay",
    page: "ingest",
  },
};

/** The change from `before` to `now`: a signed percent, or points for a rate. */
function change(now: number | undefined, before: number | undefined, points = false): string {
  if (now === undefined || before === undefined) return "–";
  if (points) {
    const d = (now - before) * 100;
    if (Math.abs(d) < 0.05) return "no change";
    return `${d > 0 ? "▲ +" : "▼ −"}${Math.abs(d).toFixed(1)} pt`;
  }
  if (before === 0) return now === 0 ? "no change" : "new";
  const d = (now - before) / before;
  if (Math.abs(d) < 0.005) return "no change";
  return `${d > 0 ? "▲ +" : "▼ −"}${Math.abs(d * 100).toFixed(0)}%`;
}

interface Data {
  span: Since;
  now: Date;
  buckets: Bucket[];
  current: SearchResult[];
  cur: Tally;
  prev: Tally;
  perBucket: Tally[];
  read: number;
  total: number;
  index: SearchResults["index"] | undefined;
}

let kept: { span: Since; at: number; data: Promise<Data> } | undefined;

/** The sessions of the span and the one before it, read once a minute at most. */
function load(span: Since): Promise<Data> {
  if (kept && kept.span === span && Date.now() - kept.at < KEEP_MS) return kept.data;
  const data = (async (): Promise<Data> => {
    const now = new Date();
    const buckets = bucketsOf(span, now);
    const start = buckets[0]?.start ?? now.getTime();
    const before = start - (now.getTime() - start);
    const results: SearchResult[] = [];
    let cursor: string | undefined;
    let total = 0;
    let index: SearchResults["index"] | undefined;
    do {
      const query = new URLSearchParams({
        limit: String(PAGE),
        since: new Date(before).toISOString(),
      });
      if (cursor) query.set("cursor", cursor);
      const page = await call<SearchResults>("search", { query });
      total = page.total;
      index = page.index;
      results.push(...page.results);
      cursor = page.cursor;
    } while (cursor && results.length < MAX_SESSIONS);
    const current = results.filter((r) => activity(r) >= start);
    const previous = results.filter((r) => activity(r) >= before && activity(r) < start);
    return {
      span,
      now,
      buckets,
      current,
      cur: tally(current),
      prev: tally(previous),
      perBucket: buckets.map((b) =>
        tally(current.filter((r) => activity(r) >= b.start && activity(r) < b.end)),
      ),
      read: results.length,
      total,
      index,
    };
  })();
  kept = { span, at: Date.now(), data };
  data.catch(() => {
    kept = undefined;
  });
  return data;
}

/** Forget the sessions read, on a change of who is signed in. */
export function forgetOverview(): void {
  kept = undefined;
}

function table(cls: string, head: (string | [string, string])[], rows: Child[][]): HTMLElement {
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      { class: `plain ${cls}` },
      head.length
        ? h(
            "thead",
            null,
            h(
              "tr",
              null,
              head.map((c) =>
                Array.isArray(c) ? h("th", { class: c[1] }, c[0]) : h("th", null, c),
              ),
            ),
          )
        : null,
      h(
        "tbody",
        null,
        rows.map((r) => h("tr", null, r)),
      ),
    ),
  );
}

const num = (text: string, title?: string) =>
  h("td", { class: "num", ...(title ? { title } : {}) }, text);

/** A share as a thin bar in a cell of its own, beside the number it repeats. */
function shareBar(n: number, max: number): HTMLElement {
  const w = Math.max(1, Math.round((n / Math.max(1e-9, max)) * 20));
  return h(
    "td",
    { class: "share", "aria-hidden": "true" },
    h("span", { class: "share-bar" }, h("span", { class: `rank-fill w${w}` })),
  );
}

type Dimension = "agent" | "model" | "repo" | "owner";

const DIMENSIONS: Record<
  Dimension,
  {
    label: string;
    plural: string;
    key: (r: SearchResult) => string | undefined;
    filter: TextFilter;
    show: (k: string) => string;
  }
> = {
  repo: {
    label: "Repository",
    plural: "Repositories",
    key: (r) => r.repo,
    filter: "repo",
    show: shortRepo,
  },
  agent: {
    label: "Agent",
    plural: "Agents",
    key: (r) => r.origin_agent ?? r.format,
    filter: "agent",
    show: (k) => k,
  },
  model: {
    label: "Model",
    plural: "Models",
    key: (r) => r.models?.[0],
    filter: "model",
    show: (k) => k,
  },
  owner: {
    label: "Person",
    plural: "People",
    key: (r) => r.owner,
    filter: "owner",
    show: (k) => k,
  },
};

function groups(rows: SearchResult[], dimension: Dimension): Map<string, SearchResult[]> {
  const out = new Map<string, SearchResult[]>();
  for (const r of rows) {
    const k = DIMENSIONS[dimension].key(r);
    if (!k) continue;
    const list = out.get(k) ?? [];
    list.push(r);
    out.set(k, list);
  }
  return out;
}

/** Links that keep the span: the list filtered to a value, and the pages here. */
function links(span: Since) {
  return {
    list: (filter: TextFilter, value: string) =>
      listHref(withFilter({ ...EMPTY, since: span } as ListState, filter, value)),
    sessions: listHref({ ...EMPTY, since: span }),
    overview: (page?: string, by?: Dimension) =>
      `#/overview${page ? `/${page}` : ""}?since=${span}${by ? `&by=${by}` : ""}`,
  };
}

function head(
  title: string,
  span: Since,
  hrefFor: (s: Since) => string,
  back?: string,
): { el: HTMLElement; asOf: HTMLElement } {
  const asOf = h("p", { class: "as-of", role: "status" }, "Reading sessions…");
  const el = h(
    "header",
    { class: "panel-head" },
    back ? h("a", { class: "back crumb", href: back }, "Overview") : null,
    h("h1", null, title),
    h(
      "nav",
      { class: "segmented", "aria-label": "Span" },
      (Object.keys(SPANS) as Since[]).map((s) =>
        h(
          "a",
          { href: hrefFor(s), ...(s === span ? { "aria-current": "page" } : {}) },
          SPANS[s].label,
        ),
      ),
    ),
    asOf,
  );
  return { el, asOf };
}

function stamp(asOf: HTMLElement, data: Data): void {
  replace(
    asOf,
    h(
      "span",
      null,
      `As of ${data.now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`,
    ),
    data.read < data.total
      ? h("span", null, `counted the ${data.read.toLocaleString()} most recent sessions`)
      : null,
  );
}

function failed(asOf: HTMLElement, err: unknown): void {
  asOf.textContent =
    err instanceof ApiError && (err.code === "search_disabled" || err.status === 403)
      ? "The overview needs search, which this server or this credential does not have."
      : `The overview did not load: ${err instanceof Error ? err.message : String(err)}`;
  asOf.classList.add("problem");
}

/** A headline number as a link to its page: label, value, change, sparkline. */
function tile(data: Data, key: string, href: string): HTMLElement {
  const m = MEASURES[key] as Measure;
  return h(
    "a",
    { class: "metric", href },
    h("span", { class: "metric-label" }, m.label),
    h("span", { class: "metric-value" }, m.show(m.value(data.cur))),
    h("span", { class: "metric-delta" }, change(m.value(data.cur), m.value(data.prev), m.rate)),
    h(
      "span",
      { class: "metric-spark" },
      sparkline(
        data.perBucket.map((t) => m.value(t) ?? null),
        `${m.label} over the span`,
      ),
    ),
  );
}

/** The top five of a dimension by sessions, each a link to its sessions. */
function top(data: Data, dimension: Dimension): HTMLElement {
  const d = DIMENSIONS[dimension];
  const l = links(data.span);
  const rows = [...groups(data.current, dimension).entries()]
    .map(([k, rs]) => [k, rs.length] as const)
    .sort((a, b) => b[1] - a[1]);
  const max = rows[0]?.[1] ?? 1;
  return h(
    "section",
    { class: "top-list" },
    h(
      "h2",
      null,
      d.plural,
      h("a", { class: "see-all", href: l.overview("sessions", dimension) }, "See all"),
    ),
    rows.length === 0
      ? h("p", { class: "empty" }, "None in this span.")
      : table(
          "top-table",
          [],
          rows
            .slice(0, 5)
            .map(([k, n]) => [
              h(
                "td",
                { class: "name" },
                h("a", { href: l.list(d.filter, k), title: k }, d.show(k)),
              ),
              num(n.toLocaleString()),
              shareBar(n, max),
            ]),
        ),
  );
}

function home(root: HTMLElement, ctx: Ctx, span: Since): void {
  const l = links(span);
  const { el, asOf } = head("Overview", span, (s) => `#/overview?since=${s}`);
  const body = h("div", { class: "panel-body" });
  replace(root, h("section", { class: "overview" }, el, body));
  document.title = "Overview: seshi";
  void load(span).then(
    (data) => {
      if (!ctx.isCurrent()) return;
      stamp(asOf, data);
      if (data.current.length === 0) {
        replace(body, h("p", { class: "empty" }, `No sessions in the last ${SPANS[span].label}.`));
        return;
      }
      const { cur } = data;
      replace(
        body,
        h(
          "nav",
          { class: "metrics", "aria-label": "Headline numbers" },
          (["sessions", "people", "tokens", "errors", "delay"] as const).map((k) =>
            tile(data, k, l.overview((MEASURES[k] as Measure).page)),
          ),
        ),
        h(
          "p",
          { class: "compare-note" },
          `Each number against ${SPANS[span].before}. Select one for its detail.`,
        ),
        h(
          "section",
          { class: "panel-section" },
          h(
            "h2",
            null,
            `Sessions per ${SPANS[span].per}`,
            h("a", { class: "see-all", href: l.sessions }, "Open these sessions"),
          ),
          timeline(
            [
              {
                label: "Sessions",
                summary: cur.sessions.toLocaleString(),
                values: data.perBucket.map((t) => t.sessions),
                format: (n) => n.toLocaleString(),
                unit: "sessions",
              },
            ],
            data.buckets,
            { tall: true },
          ),
        ),
        h("div", { class: "tops" }, top(data, "repo"), top(data, "agent"), top(data, "owner")),
        h(
          "p",
          { class: "status-line" },
          h("strong", null, "Ingest"),
          h("span", null, `${cur.events.toLocaleString()} events stored`),
          h("span", null, `${pct(cur.redacted, cur.sessions, 0)} of sessions redacted`),
          h(
            "span",
            null,
            data.index?.caught_up_at
              ? `search current as of ${ago(data.index.caught_up_at, data.now)}`
              : "search index building",
          ),
          h("a", { href: l.overview("ingest") }, "Ingest details"),
        ),
      );
    },
    (err: unknown) => {
      if (ctx.isCurrent()) failed(asOf, err);
    },
  );
}

/** The tools behind the error rate, for its page. */
function toolsSection(data: Data): HTMLElement {
  const counts = new Map<string, number>();
  for (const r of data.current) {
    for (const [k, n] of Object.entries(r.tools ?? {})) counts.set(k, (counts.get(k) ?? 0) + n);
  }
  const tools = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const max = tools[0]?.[1] ?? 1;
  return h(
    "section",
    { class: "panel-section" },
    h("h2", null, "Tool calls by tool"),
    table(
      "tools",
      ["Tool", ["Calls", "num"], ["", "share"]],
      tools
        .slice(0, 15)
        .map(([name, n]) => [
          h("td", { class: "name mono-cell", title: name }, name),
          num(n.toLocaleString(), `${pct(n, data.cur.calls, 0)} of tool calls`),
          shareBar(n, max),
        ]),
    ),
    tools.length > 15
      ? h("p", { class: "table-note" }, `${plural(tools.length - 15, "more tool")} not shown.`)
      : null,
  );
}

/** A measure's page: its value and change, its series, and who or what drove it. */
function detail(root: HTMLElement, ctx: Ctx, span: Since, key: string, by: Dimension): void {
  const m = MEASURES[key] as Measure;
  const l = links(span);
  const { el, asOf } = head(
    m.label,
    span,
    (s) => `#/overview/${key}?since=${s}&by=${by}`,
    l.overview(),
  );
  const body = h("div", { class: "panel-body" });
  replace(root, h("section", { class: "overview" }, el, body));
  document.title = `${m.label}: seshi`;
  void load(span).then(
    (data) => {
      if (!ctx.isCurrent()) return;
      stamp(asOf, data);
      const value = m.value(data.cur);
      const d = DIMENSIONS[by];
      const rows = [...groups(data.current, by).entries()]
        .map(([k, rs]) => {
          const t = tally(rs);
          return { k, rs, t, v: m.value(t) };
        })
        .sort((a, b) => (b.v ?? -1) - (a.v ?? -1) || b.t.sessions - a.t.sessions);
      // Sessions with no value for this breakdown (no repository, say) are a row of their own,
      // so the rows add up to the headline.
      const without = data.current.filter((r) => !d.key(r));
      const withoutTally = tally(without);
      const max = Math.max(...rows.map((r) => r.v ?? 0), m.value(withoutTally) ?? 0, 0);
      const breakdownRows = rows.map(({ k, rs, t, v }) => [
        h("td", { class: "name" }, h("a", { href: l.list(d.filter, k), title: k }, d.show(k))),
        num(m.show(v), key === "errors" ? `${t.failed} of ${t.ok + t.failed}` : undefined),
        v === undefined ? h("td", { class: "share" }) : shareBar(v, max),
        num(t.sessions.toLocaleString()),
        h(
          "td",
          { class: "trend" },
          sparkline(
            data.buckets.map((b) => {
              const inside = rs.filter((r) => activity(r) >= b.start && activity(r) < b.end);
              return inside.length ? (m.value(tally(inside)) ?? null) : null;
            }),
            `${d.show(k)}: ${m.label.toLowerCase()} over the span`,
          ),
        ),
      ]);
      replace(
        body,
        h(
          "div",
          { class: "headline" },
          h("span", { class: "metric-value big" }, m.show(value)),
          h(
            "span",
            { class: "metric-delta" },
            (() => {
              const c = change(value, m.value(data.prev), m.rate);
              return c === "–"
                ? `nothing to compare with in ${SPANS[span].before}`
                : `${c} against ${SPANS[span].before}`;
            })(),
          ),
          h("a", { class: "see-all", href: l.sessions }, "Open these sessions"),
        ),
        h(
          "section",
          { class: "panel-section" },
          h("h2", null, `${m.label} per ${SPANS[span].per}`),
          timeline(
            [
              {
                label: m.label,
                summary: m.show(value),
                values: data.perBucket.map((t) => {
                  const v = m.value(t) ?? 0;
                  return m.rate ? v * 100 : v;
                }),
                format: m.rate
                  ? (n) => `${n.toFixed(1)}%`
                  : key === "tokens"
                    ? compact
                    : (n) => n.toLocaleString(),
                unit: m.rate ? "of results failed" : m.unit,
              },
            ],
            data.buckets,
            { tall: true },
          ),
        ),
        h(
          "section",
          { class: "panel-section" },
          h(
            "h2",
            null,
            `By ${d.label.toLowerCase()}`,
            h(
              "nav",
              { class: "segmented", "aria-label": "Break down by" },
              (Object.keys(DIMENSIONS) as Dimension[]).map((dim) =>
                h(
                  "a",
                  {
                    href: l.overview(key, dim),
                    ...(dim === by ? { "aria-current": "page" } : {}),
                  },
                  DIMENSIONS[dim].label,
                ),
              ),
            ),
          ),
          rows.length
            ? table(
                "breakdown",
                [d.label, [m.label, "num"], ["", "share"], ["Sessions", "num"], ["Trend", "trend"]],
                [
                  ...breakdownRows,
                  ...(without.length
                    ? [
                        [
                          h("td", { class: "name muted" }, `No ${d.label.toLowerCase()}`),
                          num(m.show(m.value(withoutTally))),
                          shareBar(m.value(withoutTally) ?? 0, max),
                          num(without.length.toLocaleString()),
                          h("td", { class: "trend" }),
                        ],
                      ]
                    : []),
                ],
              )
            : h("p", { class: "empty" }, "None in this span."),
          by === "model"
            ? h(
                "p",
                { class: "table-note" },
                "A session that used several models counts toward its first.",
              )
            : null,
          key === "errors"
            ? h(
                "p",
                { class: "table-note" },
                "Failed results over results whose outcome the agent records; Codex records none.",
              )
            : null,
        ),
        key === "errors" ? toolsSection(data) : null,
      );
    },
    (err: unknown) => {
      if (ctx.isCurrent()) failed(asOf, err);
    },
  );
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

/** A row of the health table: what, its value, and a note under the value. */
function healthRow(label: string, value: string, note: string): HTMLElement {
  return h(
    "tr",
    null,
    h("th", { scope: "row" }, label),
    h(
      "td",
      null,
      h("span", { class: "health-value" }, value),
      note ? h("span", { class: "health-note" }, note) : null,
    ),
  );
}

/** Ingest health: how soon sessions reach the store, what redaction took out, the index, and
 * for admins the sources, worker and jobs. */
function ingest(root: HTMLElement, ctx: Ctx, span: Since): void {
  const l = links(span);
  const { el, asOf } = head("Ingest", span, (s) => `#/overview/ingest?since=${s}`, l.overview());
  const body = h("div", { class: "panel-body" });
  replace(root, h("section", { class: "overview" }, el, body));
  document.title = "Ingest: seshi";
  void load(span).then(
    (data) => {
      if (!ctx.isCurrent()) return;
      stamp(asOf, data);
      const { cur, now } = data;
      const prompt = cur.delays.filter((ms) => ms <= 15 * 60_000).length;
      const health = h(
        "tbody",
        null,
        healthRow(
          "Capture delay",
          `${duration(quantile(cur.delays, 0.5))} median, ${duration(quantile(cur.delays, 0.95))} p95`,
          "Last event to stored copy; a backfill counts from its upload.",
        ),
        healthRow(
          "Stored within 15 min",
          pct(prompt, cur.delays.length, 0),
          `${prompt.toLocaleString()} of ${plural(cur.delays.length, "session")}`,
        ),
        healthRow(
          "Events stored",
          cur.events.toLocaleString(),
          `in ${plural(cur.sessions, "session")}`,
        ),
        healthRow(
          "Search index",
          data.index?.caught_up_at
            ? `current as of ${ago(data.index.caught_up_at, now)}`
            : "building",
          `${plural(data.index?.sessions ?? 0, "session")} indexed`,
        ),
      );
      const rules = new Map<string, { matches: number; sessions: number }>();
      for (const r of data.current) {
        for (const [k, n] of Object.entries(r.redactions ?? {})) {
          const e = rules.get(k) ?? { matches: 0, sessions: 0 };
          e.matches += n;
          e.sessions++;
          rules.set(k, e);
        }
      }
      const ruleRows = [...rules.entries()].sort((a, b) => b[1].matches - a[1].matches);
      const jobsSlot = h("div");
      replace(
        body,
        h(
          "div",
          { class: "panel-grid two" },
          h(
            "section",
            { class: "panel-section" },
            h("h2", null, "Health"),
            h("div", { class: "table-wrap" }, h("table", { class: "plain health" }, health)),
            jobsSlot,
          ),
          h(
            "section",
            { class: "panel-section" },
            h(
              "h2",
              null,
              "Redaction",
              h("span", { class: "h2-note" }, `${pct(cur.redacted, cur.sessions, 0)} of sessions`),
            ),
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
        ),
      );
      if (!ctx.me.scopes?.includes("sources:admin")) return;
      void Promise.all([
        call<{ sources: SourceStatus[] }>("adminSources", {
          query: new URLSearchParams({ days: String(SINCE[span]) }),
        }),
        call<Jobs>("adminJobs"),
      ]).then(
        ([sources, jobs]) => {
          if (!ctx.isCurrent()) return;
          for (const s of sources.sources) {
            const where = s.checkpoint
              ? `checkpoint ${ago(s.checkpoint, now)}`
              : s.type === "upload"
                ? "pushed by laptops"
                : "not polled yet";
            health.append(
              healthRow(
                `Source ${s.id}`,
                `${(s.health?.stored ?? 0).toLocaleString()} stored, ${(s.health?.filtered ?? 0).toLocaleString()} filtered`,
                `${s.failed.toLocaleString()} failed, ${s.dropped.toLocaleString()} dropped; ${where}`,
              ),
            );
          }
          if (jobs.worker) {
            health.append(
              healthRow(
                "Worker",
                jobs.worker.state,
                jobs.worker.last_heartbeat
                  ? `heartbeat ${ago(jobs.worker.last_heartbeat, now)}`
                  : "",
              ),
            );
          }
          jobsSlot.replaceWith(
            h("h3", { class: "sub" }, "Jobs"),
            table(
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
            ),
          );
        },
        () => {},
      );
    },
    (err: unknown) => {
      if (ctx.isCurrent()) failed(asOf, err);
    },
  );
}

interface Ctx {
  query: URLSearchParams;
  me: Identity;
  isCurrent: () => boolean;
  view?: string | undefined;
}

export function renderOverview(root: HTMLElement, ctx: Ctx): void {
  const asked = ctx.query.get("since");
  const span: Since = asked !== null && asked in SINCE ? (asked as Since) : "7d";
  const askedBy = ctx.query.get("by");
  const fallback = (ctx.view && MEASURES[ctx.view]?.by) || "repo";
  const by: Dimension =
    askedBy !== null && askedBy in DIMENSIONS ? (askedBy as Dimension) : fallback;
  if (ctx.view === "ingest") ingest(root, ctx, span);
  else if (ctx.view && ctx.view in MEASURES && ctx.view !== "delay") {
    detail(root, ctx, span, ctx.view, by);
  } else home(root, ctx, span);
  window.scrollTo(0, 0);
}
