/** The team at a glance: how many sessions, by whom, in which repositories, with which agents,
 * models and tools, and what redaction took out, over a chosen span. Built from the same
 * browse the list uses, page by page, so it shows only what the person may read. */

import type { Identity, SearchResult, SearchResults } from "@seshi/model";
import { h, replace } from "../../web/dom";
import { ApiError, call } from "./api";
import { dailyBars, ranked } from "./charts";
import { EMPTY, type ListState, SINCE, type Since, withFilter } from "./filters";
import { listHref } from "./list";
import { plural, shortRepo } from "./text";

/** The most sessions read for the picture: past it, the page says it counted only these. */
const MAX_SESSIONS = 2000;
const PAGE = 100;
const DAY_MS = 86_400_000;

const SPANS: Record<Since, string> = {
  "1d": "Last day",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

function tally(rows: string[]): [string, number][] {
  const map = new Map<string, number>();
  for (const r of rows) map.set(r, (map.get(r) ?? 0) + 1);
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function sumMaps(maps: (Record<string, number> | undefined)[]): [string, number][] {
  const map = new Map<string, number>();
  for (const m of maps)
    for (const [k, n] of Object.entries(m ?? {})) map.set(k, (map.get(k) ?? 0) + n);
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function perDay(results: SearchResult[], days: number, now: Date) {
  const counts = new Map<string, number>();
  for (const r of results) {
    const key = dayKey(new Date(r.ended_at ?? r.updated_at));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const out: { day: string; label: string; count: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * DAY_MS);
    const key = dayKey(d);
    out.push({
      day: key,
      label: d.toLocaleDateString([], { month: "short", day: "numeric" }),
      count: counts.get(key) ?? 0,
    });
  }
  return out;
}

function figure(label: string, value: number, note?: string): HTMLElement {
  return h(
    "div",
    { class: "figure" },
    h("dd", null, value.toLocaleString()),
    h("dt", null, label, note ? h("span", { class: "note" }, ` ${note}`) : null),
  );
}

function card(title: string, body: HTMLElement | null, empty: string): HTMLElement {
  return h(
    "section",
    { class: "card" },
    h("h2", null, title),
    body ?? h("p", { class: "empty" }, empty),
  );
}

async function readAll(span: Since | undefined, now: Date) {
  const results: SearchResult[] = [];
  let cursor: string | undefined;
  let total = 0;
  do {
    const query = new URLSearchParams({ limit: String(PAGE) });
    if (span) query.set("since", new Date(now.getTime() - SINCE[span] * DAY_MS).toISOString());
    if (cursor) query.set("cursor", cursor);
    const page = await call<SearchResults>("search", { query });
    total = page.total;
    results.push(...page.results);
    cursor = page.cursor;
  } while (cursor && results.length < MAX_SESSIONS);
  return { results, total };
}

export function renderOverview(
  root: HTMLElement,
  ctx: { query: URLSearchParams; me: Identity; isCurrent: () => boolean },
): void {
  const asked = ctx.query.get("since");
  const span: Since = asked !== null && asked in SINCE ? (asked as Since) : "7d";
  const now = new Date();
  const status = h("p", { class: "loading", role: "status" }, "Reading the sessions…");
  const spans = h(
    "nav",
    { class: "spans", "aria-label": "Span" },
    (Object.keys(SPANS) as Since[]).map((s) =>
      h(
        "a",
        { href: `#/overview?since=${s}`, ...(s === span ? { "aria-current": "page" } : {}) },
        SPANS[s],
      ),
    ),
  );
  replace(
    root,
    h(
      "section",
      { class: "overview" },
      h("div", { class: "overview-head" }, h("h1", null, "Overview"), spans),
      status,
    ),
  );
  document.title = "Overview: seshi";

  const filtered = (name: Parameters<typeof withFilter>[1]) => (value: string) =>
    listHref(withFilter({ ...EMPTY, since: span } as ListState, name, value));

  void readAll(span, now).then(
    ({ results, total }) => {
      if (!ctx.isCurrent()) return;
      if (results.length === 0) {
        status.textContent = "No sessions in this span yet.";
        return;
      }
      const people = tally(results.map((r) => r.owner));
      const repos = tally(results.flatMap((r) => (r.repo ? [r.repo] : [])));
      const agents = tally(results.map((r) => r.origin_agent ?? r.format));
      const models = tally(results.flatMap((r) => r.models ?? []));
      const tools = sumMaps(results.map((r) => r.tools));
      const redactions = sumMaps(results.map((r) => r.redactions));
      const toolCalls = tools.reduce((a, [, n]) => a + n, 0);
      const removed = redactions.reduce((a, [, n]) => a + n, 0);
      const days = SINCE[span] === 1 ? 7 : SINCE[span];
      status.replaceWith(
        results.length < total
          ? h(
              "p",
              { class: "notice" },
              `Counted the ${results.length.toLocaleString()} most recent of ${plural(total, "session")}.`,
            )
          : "",
        h(
          "dl",
          { class: "figures" },
          figure("sessions", results.length),
          figure(people.length === 1 ? "person" : "people", people.length),
          figure(repos.length === 1 ? "repository" : "repositories", repos.length),
          figure("tool calls", toolCalls),
          figure(
            "redactions",
            removed,
            removed > 0
              ? `in ${plural(results.filter((r) => r.redactions).length, "session")}`
              : undefined,
          ),
        ),
        card(
          SINCE[span] === 1 ? "Sessions per day, last 7 days" : "Sessions per day",
          dailyBars(perDay(results, days, now)),
          "",
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
          card("Busiest tools", tools.length ? ranked(tools, "tools", 10) : null, "No tool calls."),
          card(
            "What redaction removed",
            redactions.length ? ranked(redactions, "redactions", 10) : null,
            "Nothing matched the redaction rules.",
          ),
        ),
      );
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
