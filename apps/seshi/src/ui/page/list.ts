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
  SINCE,
  type Since,
  searchQuery,
  stateQuery,
  TEXT_FILTERS,
  type TextFilter,
  withFilter,
  withLabel,
} from "./filters";
import { ago, highlightParts, plural, shortRepo, when } from "./text";
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
  matches?: SearchMatch[];
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

function searchForm(state: ListState, owners: string[]): HTMLElement {
  const q = h("input", {
    id: "q",
    type: "search",
    name: "q",
    value: state.q,
    placeholder: "Search prompts, answers, commands and file paths",
    autocomplete: "off",
    spellcheck: "false",
  });
  const fields = TEXT_FILTERS.map((name) =>
    h(
      "div",
      { class: "field" },
      h("label", { for: `f-${name}` }, FILTER_LABEL[name]),
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
  const form = h(
    "form",
    {
      class: "search",
      role: "search",
      onsubmit: (event: Event) => {
        event.preventDefault();
        const data = new FormData(form);
        const next: ListState = {
          q: String(data.get("q") ?? "").trim(),
          filters: {},
          labels: state.labels,
        };
        for (const name of TEXT_FILTERS) {
          const value = String(data.get(name) ?? "").trim();
          if (value) next.filters[name] = value;
        }
        const added = String(data.get("label") ?? "").trim();
        const s = String(data.get("since") ?? "");
        go({
          ...(/^[^=]+=.+$/.test(added) ? withLabel(next, added) : next),
          ...(s in SINCE ? { since: s as Since } : {}),
        });
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
      "details",
      { class: "filters", open: Object.keys(state.filters).length > 0 || undefined },
      h("summary", null, "Filters"),
      h(
        "div",
        { class: "fields" },
        fields,
        label,
        h("div", { class: "field" }, h("label", { for: "f-since" }, "Active"), since),
      ),
      h("datalist", { id: "owners" }, ...owners.map((o) => h("option", { value: o }))),
    ),
  );
  return form;
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
  const title = row.repo ? shortRepo(row.repo) : (row.project ?? row.session_id);
  const agent = row.origin_agent ?? row.format;
  return h(
    "li",
    { class: "row" },
    h(
      "div",
      { class: "row-head" },
      h(
        "a",
        { class: "title", href: sessionHref(row.owner, row.archive_id) },
        title,
        row.branch ? h("span", { class: "branch" }, row.branch) : null,
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
      row.repo && !state.filters.repo
        ? chip(row.repo, "Only this repository", withFilter(state, "repo", row.repo))
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
  const state = parseState(ctx.query);
  const now = new Date();
  const summary = h("p", { class: "summary", role: "status" }, "Loading sessions…");
  const list = h("ol", { class: "rows" });
  const more = h("div", { class: "more" });
  const form = searchForm(state, []);
  replace(root, h("section", { class: "list" }, form, activeFilters(state), summary, list, more));
  document.title = state.q ? `${state.q}: seshi` : "seshi";

  void call<{ owners: string[] }>("owners", { query: new URLSearchParams({ limit: "1000" }) })
    .then((page) => {
      if (!ctx.isCurrent()) return;
      const datalist = form.querySelector("datalist");
      if (datalist) replace(datalist, ...page.owners.map((o) => h("option", { value: o })));
    })
    .catch(() => {});

  const showRows = (rows: Row[]) => {
    list.append(...rows.map((row) => rowItem(row, state, now)));
  };

  const searchPage = async (cursor?: string): Promise<void> => {
    replace(more);
    let page: SearchResults;
    try {
      page = await call<SearchResults>("search", {
        query: searchQuery(state, { now, limit: PAGE, ...(cursor ? { cursor } : {}) }),
      });
    } catch (err) {
      if (!ctx.isCurrent()) return;
      if (err instanceof ApiError && (err.code === "search_disabled" || err.status === 503)) {
        return ownerList(err.status === 503);
      }
      summary.textContent = `The sessions did not load: ${err instanceof Error ? err.message : String(err)}`;
      summary.classList.add("problem");
      return;
    }
    if (!ctx.isCurrent()) return;
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
    if (page.cursor) {
      const next = page.cursor;
      replace(
        more,
        h("button", { type: "button", onclick: () => void searchPage(next) }, "Show more"),
      );
    }
  };

  /** Without search (turned off, or its index still building): one owner's sessions, the
   * newest first, with no other filter. */
  const ownerList = async (building: boolean): Promise<void> => {
    const owner = state.filters.owner ?? ctx.me.owner;
    let page: { sessions: SessionMetadata[]; truncated: boolean };
    try {
      page = await call("sessions", { query: new URLSearchParams({ owner, limit: "1000" }) });
    } catch (err) {
      if (!ctx.isCurrent()) return;
      summary.textContent = `The sessions did not load: ${err instanceof Error ? err.message : String(err)}`;
      summary.classList.add("problem");
      return;
    }
    if (!ctx.isCurrent()) return;
    const rows = page.sessions
      .map(fromMetadata)
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
    summary.textContent = `${building ? "Search is still reading the sessions" : "Search is turned off on this server"}, so this lists ${owner}'s ${plural(rows.length, "session")}${page.truncated ? " (the first 1,000)" : ""}. Set Owner to see someone else's.`;
    summary.classList.add("notice");
    showRows(rows);
    if (building) {
      replace(
        more,
        h("button", { type: "button", onclick: () => location.reload() }, "Try search again"),
      );
    }
  };

  void searchPage();
}
