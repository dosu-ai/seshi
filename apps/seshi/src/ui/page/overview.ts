/** The team at a glance, over a chosen span, in three parts.
 *
 * Usage: sessions, people, tokens and tool reliability, the measures coding-agent dashboards
 * lead with (daily active people and sessions, tokens by model, tool error rate).
 * Ingest: what reached the store and how fast, and what redaction took out.
 * Pipeline (admins): each source's stored, filtered, dropped and failed writes, and the
 * worker's jobs.
 *
 * Usage and ingest are built from the same browse the list uses, page by page, so they count
 * only what the person may read. */

import type { Identity, SearchResult, SearchResults } from "@seshi/model";
import { type Child, h, replace } from "../../web/dom";
import { ApiError, call } from "./api";
import { compact, dailyBars, ranked } from "./charts";
import { EMPTY, type ListState, SINCE, type Since, withFilter } from "./filters";
import { listHref } from "./list";
import { ago, plural, shortRepo } from "./text";

/** The most sessions read for the picture: past it, the page says it counted only these. */
const MAX_SESSIONS = 2000;
const PAGE = 100;
const DAY_MS = 86_400_000;

const SPANS: Record<Since, string> = {
  "1d": "Last day",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

type Ranked = [string, number][];

function tally(rows: string[]): Ranked {
  const map = new Map<string, number>();
  for (const r of rows) map.set(r, (map.get(r) ?? 0) + 1);
  return sorted(map);
}

function sorted(map: Map<string, number>): Ranked {
  return [...map.entries()]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function sumMaps(maps: (Record<string, number> | undefined)[]): Ranked {
  const map = new Map<string, number>();
  for (const m of maps) {
    for (const [k, n] of Object.entries(m ?? {})) map.set(k, (map.get(k) ?? 0) + n);
  }
  return sorted(map);
}

function sumBy(
  results: SearchResult[],
  key: (r: SearchResult) => string | undefined,
  n: (r: SearchResult) => number,
): Ranked {
  const map = new Map<string, number>();
  for (const r of results) {
    const k = key(r);
    if (k) map.set(k, (map.get(k) ?? 0) + n(r));
  }
  return sorted(map);
}

const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** A value per day for the last `days` days, from each result's day and amount. */
function perDay(
  results: SearchResult[],
  days: number,
  now: Date,
  when: (r: SearchResult) => string,
  amount: (r: SearchResult) => number | string,
) {
  const sums = new Map<string, number>();
  const distinct = new Map<string, Set<string>>();
  for (const r of results) {
    const key = dayKey(new Date(when(r)));
    const a = amount(r);
    if (typeof a === "number") sums.set(key, (sums.get(key) ?? 0) + a);
    else distinct.set(key, (distinct.get(key) ?? new Set()).add(a));
  }
  const out: { day: string; label: string; count: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * DAY_MS);
    const key = dayKey(d);
    out.push({
      day: key,
      label: d.toLocaleDateString([], { month: "short", day: "numeric" }),
      count: sums.get(key) ?? distinct.get(key)?.size ?? 0,
    });
  }
  return out;
}

const tokensOf = (r: SearchResult) => (r.tokens ? r.tokens.input + r.tokens.output : 0);
const activity = (r: SearchResult) => r.ended_at ?? r.updated_at;

function quantile(values: number[], q: number): number | undefined {
  if (values.length === 0) return undefined;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

/** A span of time in its largest fitting unit. */
function span(ms: number | undefined): string {
  if (ms === undefined) return "–";
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 90) return `${min} min`;
  const hours = Math.round(min / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

const percent = (part: number, whole: number) =>
  whole === 0 ? "–" : `${((100 * part) / whole).toFixed(part / whole < 0.1 ? 1 : 0)}%`;

function figure(label: string, value: string, note?: string): HTMLElement {
  return h(
    "div",
    { class: "figure" },
    h("dd", null, value),
    h("dt", null, label, note ? h("span", { class: "note" }, note) : null),
  );
}

function card(title: string, body: Child, empty: string, note?: string): HTMLElement {
  return h(
    "section",
    { class: "card" },
    h("h3", null, title),
    note ? h("p", { class: "hint card-note" }, note) : null,
    body ?? h("p", { class: "empty" }, empty),
  );
}

function part(title: string, lede: string, ...children: Child[]): HTMLElement {
  return h(
    "section",
    { class: "overview-part" },
    h("h2", null, title),
    h("p", { class: "hint" }, lede),
    ...children,
  );
}

/** A small table: the pipeline's sources and jobs. */
function table(head: string[], rows: Child[][]): HTMLElement {
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      { class: "plain" },
      h(
        "thead",
        null,
        h(
          "tr",
          null,
          head.map((c) => h("th", null, c)),
        ),
      ),
      h(
        "tbody",
        null,
        rows.map((r) =>
          h(
            "tr",
            null,
            r.map((c) => h("td", null, c)),
          ),
        ),
      ),
    ),
  );
}

async function readAll(span: Since, now: Date) {
  const results: SearchResult[] = [];
  let cursor: string | undefined;
  let total = 0;
  let index: SearchResults["index"] | undefined;
  do {
    const query = new URLSearchParams({ limit: String(PAGE) });
    query.set("since", new Date(now.getTime() - SINCE[span] * DAY_MS).toISOString());
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
  enabled: boolean;
  checkpoint: string | null;
  dropped: number;
  failed: number;
  health?: { stored?: number; filtered?: number; failed?: number; dropped?: number };
}

interface JobStatus {
  name: string;
  last?: {
    runs: number;
    failures: number;
    last_outcome?: string;
    last_ok?: string;
    last_finished?: string;
  };
}

interface Jobs {
  worker?: { state: string; last_heartbeat?: string; version?: string; host?: string };
  jobs: JobStatus[];
}

/** The pipeline, for credentials that may see it (`sources:admin`). */
async function pipeline(span: Since, now: Date): Promise<HTMLElement> {
  const days = String(SINCE[span]);
  const [sources, jobs] = await Promise.all([
    call<{ sources: SourceStatus[] }>("adminSources", { query: new URLSearchParams({ days }) }),
    call<Jobs>("adminJobs"),
  ]);
  const stored = sources.sources.reduce((a, s) => a + (s.health?.stored ?? 0), 0);
  const filtered = sources.sources.reduce((a, s) => a + (s.health?.filtered ?? 0), 0);
  const failed = sources.sources.reduce((a, s) => a + s.failed, 0);
  const dropped = sources.sources.reduce((a, s) => a + s.dropped, 0);
  const worker = jobs.worker;
  const jobsFailing = jobs.jobs.filter((j) => j.last?.last_outcome && j.last.last_outcome !== "ok");
  return part(
    "Pipeline",
    `Writes each source took in, the last ${plural(SINCE[span], "day")}, and the worker's jobs. Only admins see this part.`,
    h(
      "dl",
      { class: "figures" },
      figure("writes stored", stored.toLocaleString()),
      figure("filtered", filtered.toLocaleString(), "too small to keep, or excluded"),
      figure("failed", failed.toLocaleString(), failed > 0 ? "see seshi sync failed" : undefined),
      figure("dropped", dropped.toLocaleString()),
      figure(
        "worker",
        worker?.state ?? "none",
        worker?.last_heartbeat ? `heartbeat ${ago(worker.last_heartbeat, now)}` : undefined,
      ),
    ),
    h(
      "div",
      { class: "cards" },
      card(
        "Sources",
        table(
          ["Source", "Stored", "Filtered", "Failed", "Dropped", "Checkpoint"],
          sources.sources.map((s) => [
            h("span", { title: s.type }, s.id),
            (s.health?.stored ?? 0).toLocaleString(),
            (s.health?.filtered ?? 0).toLocaleString(),
            s.failed.toLocaleString(),
            s.dropped.toLocaleString(),
            s.checkpoint ? ago(s.checkpoint, now) : s.type === "upload" ? "pushed" : "never",
          ]),
        ),
        "No sources.",
      ),
      card(
        jobsFailing.length > 0 ? `Jobs (${jobsFailing.length} failing)` : "Jobs",
        table(
          ["Job", "Last run", "Outcome", "Runs", "Failures"],
          jobs.jobs.map((j) => [
            j.name,
            j.last?.last_finished ? ago(j.last.last_finished, now) : "not yet",
            j.last?.last_outcome === "ok"
              ? "✓ ok"
              : j.last?.last_outcome
                ? `✕ ${j.last.last_outcome}`
                : "–",
            (j.last?.runs ?? 0).toLocaleString(),
            (j.last?.failures ?? 0).toLocaleString(),
          ]),
        ),
        "No jobs on this instance.",
      ),
    ),
  );
}

export function renderOverview(
  root: HTMLElement,
  ctx: { query: URLSearchParams; me: Identity; isCurrent: () => boolean },
): void {
  const asked = ctx.query.get("since");
  const chosen: Since = asked !== null && asked in SINCE ? (asked as Since) : "7d";
  const now = new Date();
  const status = h("p", { class: "loading", role: "status" }, "Reading the sessions…");
  const spans = h(
    "nav",
    { class: "spans", "aria-label": "Span" },
    (Object.keys(SPANS) as Since[]).map((s) =>
      h(
        "a",
        { href: `#/overview?since=${s}`, ...(s === chosen ? { "aria-current": "page" } : {}) },
        SPANS[s],
      ),
    ),
  );
  const body = h("div", { class: "overview-body" }, status);
  replace(
    root,
    h(
      "section",
      { class: "overview" },
      h("div", { class: "overview-head" }, h("h1", null, "Overview"), spans),
      body,
    ),
  );
  document.title = "Overview: seshi";

  const filtered = (name: Parameters<typeof withFilter>[1]) => (value: string) =>
    listHref(withFilter({ ...EMPTY, since: chosen } as ListState, name, value));

  void readAll(chosen, now).then(
    ({ results, total, index }) => {
      if (!ctx.isCurrent()) return;
      if (results.length === 0) {
        status.textContent = "No sessions in this span yet.";
        return;
      }
      const days = SINCE[chosen] === 1 ? 7 : SINCE[chosen];
      const people = tally(results.map((r) => r.owner));
      const repos = tally(results.flatMap((r) => (r.repo ? [r.repo] : [])));
      const agents = tally(results.map((r) => r.origin_agent ?? r.format));
      const models = tally(results.flatMap((r) => r.models ?? []));
      const tools = sumMaps(results.map((r) => r.tools));
      const redactions = sumMaps(results.map((r) => r.redactions));
      const toolCalls = tools.reduce((a, [, n]) => a + n, 0);
      const removed = redactions.reduce((a, [, n]) => a + n, 0);
      const events = results.reduce((a, r) => a + (r.events ?? 0), 0);

      // Tokens: what the agents' model calls record. A session's tokens go to its first model.
      const withTokens = results.filter((r) => r.tokens);
      const tokenTotal = results.reduce((a, r) => a + tokensOf(r), 0);
      const cacheRead = results.reduce((a, r) => a + (r.tokens?.cache_read ?? 0), 0);
      const tokensByModel = sumBy(withTokens, (r) => r.models?.[0] ?? "unknown model", tokensOf);
      const tokensByPerson = sumBy(withTokens, (r) => r.owner, tokensOf);

      // Tool reliability: failed results over results whose outcome the trace records.
      const ok = results.reduce((a, r) => a + (r.tool_outcomes?.ok ?? 0), 0);
      const failedCalls = results.reduce((a, r) => a + (r.tool_outcomes?.failed ?? 0), 0);
      const errorsByAgent = new Map<string, { ok: number; failed: number }>();
      for (const r of results) {
        if (!r.tool_outcomes) continue;
        const agent = r.origin_agent ?? r.format;
        const o = errorsByAgent.get(agent) ?? { ok: 0, failed: 0 };
        o.ok += r.tool_outcomes.ok;
        o.failed += r.tool_outcomes.failed;
        errorsByAgent.set(agent, o);
      }

      const lengths = results.flatMap((r) =>
        r.started_at && r.ended_at
          ? [new Date(r.ended_at).getTime() - new Date(r.started_at).getTime()]
          : [],
      );
      const activePerDay = perDay(results, days, now, activity, (r) => r.owner);
      const meanActive =
        activePerDay.reduce((a, d) => a + d.count, 0) /
        Math.max(1, activePerDay.filter((d) => d.count > 0).length);

      // Ingest: when each session's stored copy was written, against its last event.
      const delays = results.flatMap((r) => {
        if (!r.ended_at) return [];
        const ms = new Date(r.updated_at).getTime() - new Date(r.ended_at).getTime();
        return Number.isFinite(ms) ? [Math.max(0, ms)] : [];
      });
      const prompt = delays.filter((ms) => ms <= 15 * 60_000).length;
      const redacted = results.filter((r) => r.redactions).length;

      const usage = part(
        "Usage",
        "What the team ran: sessions, people, tokens and how often tools failed.",
        h(
          "dl",
          { class: "figures" },
          figure("sessions", results.length.toLocaleString()),
          figure(
            people.length === 1 ? "person" : "people",
            people.length.toLocaleString(),
            `${Number.isInteger(meanActive) || meanActive >= 10 ? Math.round(meanActive) : meanActive.toFixed(1)} active a day, on average`,
          ),
          figure(
            "tokens",
            compact(tokenTotal),
            withTokens.length < results.length
              ? `in ${plural(withTokens.length, "session")} whose agent reports them`
              : cacheRead > 0
                ? `${compact(cacheRead)} more read from cache`
                : undefined,
          ),
          figure("tool calls", compact(toolCalls)),
          figure(
            "tool error rate",
            percent(failedCalls, ok + failedCalls),
            ok + failedCalls > 0
              ? `${failedCalls.toLocaleString()} of ${compact(ok + failedCalls)} results`
              : "no agent reported outcomes",
          ),
          figure("median session", span(quantile(lengths, 0.5))),
        ),
        h(
          "div",
          { class: "cards cards-2" },
          card(
            SINCE[chosen] === 1 ? "Sessions per day, last 7 days" : "Sessions per day",
            dailyBars(perDay(results, days, now, activity, () => 1)),
            "",
          ),
          card(
            "Tokens per day",
            tokenTotal > 0
              ? dailyBars(perDay(withTokens, days, now, activity, tokensOf), {
                  one: "token",
                  many: "tokens",
                  heading: "Tokens",
                })
              : null,
            "No agent in this span reports tokens.",
            "Input and output, from each session's model calls.",
          ),
        ),
        h(
          "div",
          { class: "cards" },
          card(
            "People",
            people.length ? ranked(people, "people", 8, filtered("owner")) : null,
            "No one yet.",
          ),
          card(
            "Tokens by model",
            tokensByModel.length
              ? ranked(tokensByModel, "models", 8, filtered("model"), undefined, compact)
              : null,
            "No tokens recorded.",
            "A session's tokens count toward its main model.",
          ),
          card(
            "Tokens by person",
            tokensByPerson.length
              ? ranked(tokensByPerson, "people", 8, filtered("owner"), undefined, compact)
              : null,
            "No tokens recorded.",
          ),
          card(
            "Repositories",
            repos.length ? ranked(repos, "repos", 8, filtered("repo"), shortRepo) : null,
            "No session named a repository.",
          ),
          card(
            "Agents",
            agents.length ? ranked(agents, "agents", 8, filtered("agent")) : null,
            "None.",
          ),
          card(
            "Models",
            models.length ? ranked(models, "models", 8, filtered("model")) : null,
            "No model recorded.",
          ),
          card(
            "Busiest tools",
            tools.length ? ranked(tools, "tools", 10, undefined, undefined, compact) : null,
            "No tool calls.",
          ),
          card(
            "Tool errors by agent",
            errorsByAgent.size > 0
              ? ranked(
                  [...errorsByAgent.entries()]
                    .map(([agent, o]) => [agent, o.failed] as [string, number])
                    .sort((a, b) => b[1] - a[1]),
                  "errors",
                  8,
                  filtered("agent"),
                  (agent) => {
                    const o = errorsByAgent.get(agent) as { ok: number; failed: number };
                    return `${agent} (${percent(o.failed, o.ok + o.failed)} of ${compact(o.ok + o.failed)})`;
                  },
                )
              : null,
            "No agent reported tool outcomes.",
            "Failed tool results; Codex reports no outcomes.",
          ),
        ),
      );

      const ingest = part(
        "Ingest",
        "What reached the store, how soon after the work, and what redaction took out before it did.",
        h(
          "dl",
          { class: "figures" },
          figure("events stored", compact(events), `in ${plural(results.length, "session")}`),
          figure(
            "capture delay",
            span(quantile(delays, 0.5)),
            `median, p95 ${span(quantile(delays, 0.95))}; a backfill counts from when it was sent`,
          ),
          figure("stored within 15 min", percent(prompt, delays.length), "of the last event"),
          figure(
            "redacted sessions",
            percent(redacted, results.length),
            `${compact(removed)} matches removed`,
          ),
          figure(
            "search index",
            index?.caught_up_at ? ago(index.caught_up_at, now) : "building",
            `caught up; ${plural(index?.sessions ?? 0, "session")}`,
          ),
        ),
        h(
          "div",
          { class: "cards cards-2" },
          card(
            "Events stored per day",
            dailyBars(
              perDay(
                results,
                days,
                now,
                (r) => r.updated_at,
                (r) => r.events ?? 0,
              ),
              {
                one: "event",
                many: "events",
                heading: "Events",
              },
            ),
            "",
            "By when each session's stored copy was last written.",
          ),
          card(
            "What redaction removed",
            redactions.length ? ranked(redactions, "redactions", 10) : null,
            "Nothing matched the redaction rules.",
            "Matches by rule, replaced before the server stored the session.",
          ),
        ),
      );

      const pipelinePart = h("div", { class: "pipeline-slot" });
      status.replaceWith(
        results.length < total
          ? h(
              "p",
              { class: "notice" },
              `Counted the ${results.length.toLocaleString()} most recent of ${plural(total, "session")}.`,
            )
          : "",
        usage,
        ingest,
        pipelinePart,
      );
      if (ctx.me.scopes?.includes("sources:admin")) {
        void pipeline(chosen, now).then(
          (el) => {
            if (ctx.isCurrent()) pipelinePart.replaceWith(el);
          },
          () => {},
        );
      }
    },
    (err: unknown) => {
      if (!ctx.isCurrent()) return;
      status.textContent =
        err instanceof ApiError && (err.code === "search_disabled" || err.status === 403)
          ? "The overview needs search, which this server or this credential does not have."
          : `The overview did not load: ${err instanceof Error ? err.message : String(err)}`;
      status.classList.add("problem");
    },
  );
}
