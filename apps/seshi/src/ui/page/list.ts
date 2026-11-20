import type {
  Identity,
  SearchMatch,
  SearchResult,
  SearchResults,
  SessionMetadata,
} from "@seshi/model";
import { type Child, h, replace } from "../../web/dom";
import { ApiError, call } from "./api";
import {
  isFiltered,
  type ListState,
  parseState,
  parseTyped,
  SINCE,
  type Since,
  searchQuery,
  stateQuery,
  TEXT_FILTERS,
  type TextFilter,
  withFilter,
  withLabel,
} from "./filters";
import { ago, duration, highlightParts, plural, shortRepo, when } from "./text";
import { ROLE } from "./thread";

const PAGE = 50;

/** What a row shows: a search result, or a session's metadata when search is off. */
interface Row {
  owner: string;
  archive_id: string;
  format: string;
  session_id: string;
  origin_agent?: string;
  project?: string;
  repo?: string;
  branch?: string;
  models?: string[];
  labels?: Record<string, string>;
  visibility: "org" | "owner";
  updated_at: string;
  started_at?: string;
  ended_at?: string;
  title?: string;
  events?: number;
  tools?: Record<string, number>;
  redactions?: Record<string, number>;
  matches?: SearchMatch[];
}

const sum = (map: Record<string, number> | undefined) =>
  Object.values(map ?? {}).reduce((a, b) => a + b, 0);

/** What a row says a session did: its length, its events and tool calls, its redactions. */
function rowStats(row: Row): HTMLElement | null {
  const took = duration(row.started_at, row.ended_at);
  const calls = sum(row.tools);
  const removed = sum(row.redactions);
  const parts = [
    took ? `ran ${took}` : "",
    row.events ? plural(row.events, "event") : "",
    calls ? plural(calls, "tool call") : "",
    removed ? `${plural(removed, "redaction")}` : "",
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return h(
    "p",
    { class: "row-stats" },
    parts.map((p) => h("span", null, p)),
  );
}

const FILTER_LABEL: Record<TextFilter, string> = {
  owner: "Owner",
  agent: "Agent",
  repo: "Repository",
  branch: "Branch",
  model: "Model",
};

const SINCE_LABEL: Record<Since, string> = {
  "1d": "Last day",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

export function listHref(state: ListState): string {
  const query = stateQuery(state).toString();
  return query ? `#/?${query}` : "#/";
}

export function sessionHref(owner: string, archive: string, query?: URLSearchParams): string {
  const base = `#/s/${encodeURIComponent(owner)}/${encodeURIComponent(archive)}`;
  const rest = query?.toString();
  return rest ? `${base}?${rest}` : base;
}

function go(state: ListState): void {
  location.hash = listHref(state);
}

function fromMetadata(m: SessionMetadata): Row {
  return {
    owner: m.owner,
    archive_id: m.archive_id,
    format: m.format,
    session_id: m.session_id,
    ...(m.origin_agent ? { origin_agent: m.origin_agent } : {}),
    ...(m.project ? { project: m.project } : {}),
    ...(m.repo ? { repo: m.repo } : {}),
    ...(m.branch ? { branch: m.branch } : {}),
    ...(m.models ? { models: m.models } : {}),
    ...(m.labels ? { labels: m.labels } : {}),
    visibility: m.visibility,
    updated_at: m.active_at ?? m.updated_at,
  };
}

function fromResult(r: SearchResult): Row {
  return { ...r, updated_at: r.ended_at ?? r.updated_at };
}

/** How long typing pauses before the search runs. */
const TYPING_MS = 250;

function searchForm(
  state: ListState,
  owners: string[],
  search: (next: ListState, push: boolean) => void,
): HTMLElement {
  const q = h("input", {
    id: "q",
    type: "search",
    name: "q",
    value: state.q,
    placeholder: "Search, or filter: repo:  owner:  agent:  model:  label:k=v  since:7d",
    "aria-describedby": "q-help",
    autocomplete: "off",
    spellcheck: "false",
  });
  const fields = TEXT_FILTERS.map((name) =>
    h(
      "div",
      { class: "field" },
      h("label", { for: `f-${name}` }, FILTER_LABEL[name]),
      pickable(
        name === "owner",
        h("input", {
          id: `f-${name}`,
          name,
          type: "text",
          value: state.filters[name] ?? "",
          autocomplete: "off",
          spellcheck: "false",
          ...(name === "owner" ? { list: "owners" } : {}),
        }),
      ),
    ),
  );
  const label = h(
    "div",
    { class: "field" },
    h("label", { for: "f-label" }, "Label"),
    h("input", {
      id: "f-label",
      name: "label",
      type: "text",
      placeholder: "key=value",
      autocomplete: "off",
      spellcheck: "false",
    }),
  );
  const since = h(
    "select",
    { id: "f-since", name: "since" },
    h("option", { value: "" }, "Any time"),
    (Object.keys(SINCE) as Since[]).map((key) =>
      h("option", { value: key, selected: state.since === key }, SINCE_LABEL[key]),
    ),
  );
  /** The search the form describes: the box's words and the filters typed in it, over the
   * Filters fields and the labels already in force. */
  const collect = (): ListState => {
    const data = new FormData(form);
    const typed = parseTyped(String(data.get("q") ?? ""));
    const filters: ListState["filters"] = {};
    for (const name of TEXT_FILTERS) {
      const value = String(data.get(name) ?? "").trim();
      if (value) filters[name] = value;
    }
    let next: ListState = {
      q: typed.q,
      filters: { ...filters, ...typed.filters },
      labels: [...state.labels],
    };
    for (const label of typed.labels) next = withLabel(next, label);
    const added = String(data.get("label") ?? "").trim();
    if (/^[^=]+=.+$/.test(added)) next = withLabel(next, added);
    const s = typed.since ?? String(data.get("since") ?? "");
    return s in SINCE ? { ...next, since: s as Since } : next;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = stateQuery(state).toString();
  const live = (push: boolean) => {
    clearTimeout(timer);
    const next = collect();
    const key = stateQuery(next).toString();
    if (key === last && !push) return;
    last = key;
    search(next, push);
  };
  const form = h(
    "form",
    {
      class: "search",
      role: "search",
      onsubmit: (event: Event) => {
        event.preventDefault();
        live(true);
      },
      onchange: (event: Event) => {
        if (event.target !== q) live(false);
      },
    },
    h(
      "div",
      { class: "query" },
      h("label", { for: "q", class: "visually-hidden" }, "Search"),
      q,
      h("button", { type: "submit", class: "primary" }, "Search"),
    ),
    h(
      "p",
      { id: "q-help", class: "hint q-help" },
      "Results update as you type. Press / to come back here from anywhere.",
    ),
    h(
      "details",
      { class: "filters", open: Object.keys(state.filters).length > 0 || undefined },
      h("summary", null, "Filters"),
      h(
        "div",
        { class: "fields" },
        fields,
        label,
        h(
          "div",
          { class: "field" },
          h("label", { for: "f-since" }, "Active"),
          pickable(true, since),
        ),
      ),
      h("datalist", { id: "owners" }, ...owners.map((o) => h("option", { value: o }))),
    ),
  );
  q.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => live(false), TYPING_MS);
  });
  return form;
}

/** A field that offers a list (a select, or a text box with suggestions) wears the page's one
 * chevron, drawn by `.pick` in the stylesheet, in place of the browser's own arrow. */
function pickable(offers: boolean, field: HTMLElement): HTMLElement {
  return offers ? h("span", { class: "pick" }, field) : field;
}

/** The filters in force, each with a button that drops it. */
function activeFilters(state: ListState): HTMLElement | null {
  if (!isFiltered(state)) return null;
  const chips: Child[] = [];
  const drop = (label: string, next: ListState) =>
    h(
      "li",
      null,
      h(
        "button",
        {
          type: "button",
          class: "chip active",
          title: "Remove this filter",
          onclick: () => go(next),
        },
        label,
        h("span", { "aria-hidden": "true", class: "x" }, "×"),
        h("span", { class: "visually-hidden" }, " (remove)"),
      ),
    );
  if (state.q) chips.push(drop(`"${state.q}"`, { ...state, q: "" }));
  for (const name of TEXT_FILTERS) {
    const value = state.filters[name];
    if (!value) continue;
    const { [name]: _, ...rest } = state.filters;
    chips.push(drop(`${FILTER_LABEL[name]}: ${value}`, { ...state, filters: rest }));
  }
  for (const label of state.labels) {
    chips.push(drop(label, { ...state, labels: state.labels.filter((l) => l !== label) }));
  }
  if (state.since) {
    const { since: _, ...rest } = state;
    chips.push(drop(SINCE_LABEL[state.since], rest));
  }
  return h(
    "div",
    { class: "active-filters" },
    h("ul", { class: "chips" }, chips),
    h("a", { href: "#/", class: "clear" }, "Clear all"),
  );
}

function chip(label: string, title: string, next: ListState): HTMLElement {
  return h("button", { type: "button", class: "chip", title, onclick: () => go(next) }, label);
}

function snippet(row: Row, match: SearchMatch): HTMLElement {
  const role = ROLE[match.role];
  const query = new URLSearchParams({ hash: match.content_hash, event: String(match.event_index) });
  return h(
    "li",
    null,
    h(
      "a",
      { href: sessionHref(row.owner, row.archive_id, query) },
      h(
        "span",
        { class: `role role-${match.role}` },
        h("span", { class: "node", "aria-hidden": "true" }, role.node),
        match.tool_name ? `${role.word} ${match.tool_name}` : role.word,
      ),
      h(
        "span",
        { class: "excerpt" },
        highlightParts(match.snippet, match.highlights).map((p) =>
          p.hit ? h("mark", null, p.text) : p.text,
        ),
      ),
    ),
  );
}

function rowItem(row: Row, state: ListState, now: Date): HTMLElement {
  const where = row.repo ? shortRepo(row.repo) : (row.project ?? row.session_id);
  const agent = row.origin_agent ?? row.format;
  return h(
    "li",
    { class: "row" },
    h(
      "div",
      { class: "row-head" },
      h(
        "a",
        {
          class: `title${row.title ? "" : " untitled"}`,
          href: sessionHref(row.owner, row.archive_id),
        },
        row.title ?? `${where}${row.branch ? ` on ${row.branch}` : ""}`,
      ),
      h(
        "time",
        { datetime: row.updated_at, title: when(row.updated_at) },
        ago(row.updated_at, now),
      ),
    ),
    h(
      "div",
      { class: "facts" },
      chip(row.owner, "Only this owner's sessions", withFilter(state, "owner", row.owner)),
      chip(agent, "Only this agent's sessions", withFilter(state, "agent", agent)),
      row.repo
        ? chip(
            row.branch ? `${shortRepo(row.repo)} @ ${row.branch}` : shortRepo(row.repo),
            `Only ${row.repo}`,
            withFilter(state, "repo", row.repo),
          )
        : row.branch
          ? chip(row.branch, "Only this branch", withFilter(state, "branch", row.branch))
          : null,
      (row.models ?? []).map((m) =>
        chip(m, "Only sessions with this model", withFilter(state, "model", m)),
      ),
      Object.entries(row.labels ?? {}).map(([k, v]) =>
        chip(`${k}=${v}`, "Only sessions with this label", withLabel(state, `${k}=${v}`)),
      ),
      row.visibility === "owner"
        ? h(
            "span",
            { class: "private", title: "Only its owner and admins can read it" },
            "owner only",
          )
        : null,
    ),
    rowStats(row),
    row.matches && row.matches.length > 0
      ? h(
          "ol",
          { class: "snippets" },
          row.matches.map((m) => snippet(row, m)),
        )
      : null,
  );
}

export function renderList(
  root: HTMLElement,
  ctx: { query: URLSearchParams; me: Identity; isCurrent: () => boolean },
): void {
  const initial = parseState(ctx.query);
  const results = h("div", { class: "results" });
  let generation = 0;
  // A search as the person types: the address follows (so it can be shared, and Back works
  // after a submit), but the page is not drawn again, so the box keeps its focus.
  const form = searchForm(initial, [], (next, push) => {
    const href = `${location.pathname}${listHref(next)}`;
    if (push) history.pushState(null, "", href);
    else history.replaceState(null, "", href);
    load(next);
  });
  replace(root, h("section", { class: "list" }, form, results));

  void call<{ owners: string[] }>("owners", { query: new URLSearchParams({ limit: "1000" }) })
    .then((page) => {
      if (!ctx.isCurrent()) return;
      const datalist = form.querySelector("datalist");
      if (datalist) replace(datalist, ...page.owners.map((o) => h("option", { value: o })));
    })
    .catch(() => {});

  load(initial);

  function load(state: ListState): void {
    const mine = ++generation;
    const isCurrent = () => ctx.isCurrent() && mine === generation;
    const now = new Date();
    const summary = h("p", { class: "summary", role: "status" }, "Loading sessions…");
    const list = h("ol", { class: "rows" });
    const more = h("div", { class: "more" });
    replace(results, activeFilters(state), summary, list, more);
    document.title = state.q ? `${state.q}: seshi` : "seshi";

    const showRows = (rows: Row[]) => {
      list.append(...rows.map((row) => rowItem(row, state, now)));
    };

    const searchPage = async (cursor?: string, skipped = 0): Promise<void> => {
      replace(more);
      let page: SearchResults;
      try {
        page = await call<SearchResults>("search", {
          query: searchQuery(state, { now, limit: PAGE, ...(cursor ? { cursor } : {}) }),
        });
      } catch (err) {
        if (!isCurrent()) return;
        if (err instanceof ApiError && err.code === "search_disabled") return ownerList("off");
        if (err instanceof ApiError && err.status === 503) return ownerList("building");
        if (err instanceof ApiError && err.status === 403) return ownerList("scope");
        summary.textContent = `The sessions did not load: ${err instanceof Error ? err.message : String(err)}`;
        summary.classList.add("problem");
        return;
      }
      if (!isCurrent()) return;
      if (!cursor) {
        summary.textContent =
          page.total === 0
            ? isFiltered(state)
              ? "No session matches. Try fewer words or filters."
              : "No sessions yet. They appear here once someone's capture uploads one."
            : state.q
              ? `${plural(page.total, "session")} ${page.total === 1 ? "matches" : "match"}, best first`
              : `${plural(page.total, "session")}, most recent first`;
      }
      showRows(page.results.map(fromResult));
      // A page can come back empty when every session on it was made private or removed since
      // the index read it: go on to the next one rather than show a page of nothing.
      if (page.results.length === 0 && page.cursor && skipped < 5) {
        return searchPage(page.cursor, skipped + 1);
      }
      if (page.cursor) {
        const next = page.cursor;
        replace(
          more,
          h("button", { type: "button", onclick: () => void searchPage(next) }, "Show more"),
        );
      }
    };

    /** Without search (turned off, its index still building, or a credential without the
     * `search` scope): one owner's sessions, the newest first, with no other filter. */
    const ownerList = async (why: "off" | "building" | "scope"): Promise<void> => {
      const owner = state.filters.owner ?? ctx.me.owner;
      let page: { sessions: SessionMetadata[]; truncated: boolean };
      try {
        page = await call("sessions", { query: new URLSearchParams({ owner, limit: "1000" }) });
      } catch (err) {
        if (!isCurrent()) return;
        summary.textContent = `The sessions did not load: ${err instanceof Error ? err.message : String(err)}`;
        summary.classList.add("problem");
        return;
      }
      if (!isCurrent()) return;
      const rows = page.sessions
        .map(fromMetadata)
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
      const reason = {
        off: "Search is turned off on this server",
        building: "Search is still reading the sessions",
        scope: "This credential cannot search",
      }[why];
      summary.textContent = `${reason}, so this lists ${owner}'s ${plural(rows.length, "session")}${page.truncated ? " (the first 1,000)" : ""}. Set Owner to see someone else's.`;
      summary.classList.add("notice");
      showRows(rows);
      if (why === "building") {
        replace(
          more,
          h("button", { type: "button", onclick: () => location.reload() }, "Try search again"),
        );
      }
    };

    if (ctx.me.scopes && !ctx.me.scopes.includes("search")) void ownerList("scope");
    else void searchPage();
  }
}
