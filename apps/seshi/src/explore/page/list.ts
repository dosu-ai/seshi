import type { ListStatus, SessionList, SessionSummary } from "../types";
import { api } from "./api";
import { badge, h, replace } from "./dom";
import { STATUS, when } from "./text";

interface Filters {
  status: ListStatus | "";
  agent: string;
  text: string;
}

const filters: Filters = { status: "", agent: "", text: "" };

function visible(s: SessionSummary): boolean {
  if (filters.status && s.worst !== filters.status) return false;
  if (filters.agent && s.agent !== filters.agent) return false;
  const q = filters.text.trim().toLowerCase();
  if (!q) return true;
  return [s.session_id, s.folder, s.decision.reason, s.last_status, s.worst_check?.summary]
    .filter(Boolean)
    .some((v) => (v as string).toLowerCase().includes(q));
}

export function sessionHref(agent: string, id: string, tab?: string): string {
  return `#/s/${encodeURIComponent(agent)}/${encodeURIComponent(id)}${tab ? `/${tab}` : ""}`;
}

export function renderList(root: HTMLElement, isCurrent: () => boolean): void {
  let list: SessionList | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const status = h("p", { class: "muted", role: "status" }, "Loading sessions…");
  const body = h("tbody");
  const agentSelect = h(
    "select",
    {
      "aria-label": "Agent",
      onchange: (e: Event) => {
        filters.agent = (e.target as HTMLSelectElement).value;
        draw();
      },
    },
    h("option", { value: "" }, "All agents"),
  );
  const statusSelect = h(
    "select",
    {
      "aria-label": "Worst status",
      onchange: (e: Event) => {
        filters.status = (e.target as HTMLSelectElement).value as Filters["status"];
        draw();
      },
    },
    h("option", { value: "" }, "Any status"),
    (["fail", "warn", "ok", "skip", "pending"] as const).map((s) =>
      h(
        "option",
        { value: s, selected: filters.status === s },
        `${STATUS[s].icon} ${STATUS[s].word}`,
      ),
    ),
  );
  const search = h("input", {
    type: "search",
    placeholder: "Filter by id, folder, reason…",
    "aria-label": "Filter text",
    value: filters.text,
    oninput: (e: Event) => {
      filters.text = (e.target as HTMLInputElement).value;
      draw();
    },
  });
  const refresh = h(
    "button",
    { type: "button", onclick: () => load(true) },
    h("span", { "aria-hidden": "true" }, "↻"),
    " Refresh",
  );
  const where = h("p", { class: "muted" });

  replace(
    root,
    h(
      "section",
      { class: "list" },
      h("div", { class: "toolbar" }, statusSelect, agentSelect, search, refresh),
      where,
      status,
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          { class: "sessions" },
          h(
            "thead",
            null,
            h(
              "tr",
              null,
              ["Checks", "Capture", "Agent", "Session", "Folder", "Last answer", "Last seen"].map(
                (t) => h("th", { scope: "col" }, t),
              ),
            ),
          ),
          body,
        ),
      ),
    ),
  );

  function draw(): void {
    if (!list) return;
    const agents = [...new Set(list.sessions.map((s) => s.agent))].sort();
    if (agentSelect.options.length !== agents.length + 1) {
      replace(
        agentSelect,
        h("option", { value: "" }, "All agents"),
        agents.map((a) => h("option", { value: a, selected: filters.agent === a }, a)),
      );
    }
    const server = list.server;
    replace(
      where,
      `Sessions seen since ${when(list.since)}. Stored sessions: `,
      server.mode === "none"
        ? `none can be read (${server.error ?? "no server"}).`
        : `${server.mode === "serverless" ? "bucket" : "server"} ${server.where ?? ""}.`,
      list.state_error ? ` The state file cannot be read: ${list.state_error}` : "",
    );
    const shown = list.sessions.filter(visible);
    replace(
      status,
      list.sessions.length === 0
        ? "No sessions seen in this window."
        : `${shown.length} of ${list.sessions.length} sessions${list.pending > 0 ? `; checking ${list.pending}…` : ""}`,
    );
    replace(
      body,
      shown.map((s) => {
        const href = sessionHref(s.agent, s.session_id);
        return h(
          "tr",
          null,
          h(
            "td",
            null,
            badge(s.worst),
            s.worst_check ? h("div", { class: "small muted" }, s.worst_check.title) : null,
          ),
          h(
            "td",
            { title: s.decision.reason },
            h("span", { class: "glyph", "aria-hidden": "true" }, s.decision.glyph),
            " ",
            s.decision.capture ? "capturing" : "not capturing",
            h("div", { class: "small muted" }, s.decision.reason),
          ),
          h("td", null, s.agent),
          h("td", { class: "mono" }, h("a", { href }, s.session_id)),
          h("td", { class: "mono small" }, s.folder ?? ""),
          h("td", null, s.last_status ?? "—"),
          h("td", { class: "small" }, when(s.last_seen ?? s.first_seen)),
        );
      }),
    );
  }

  async function load(refreshing = false): Promise<void> {
    clearTimeout(timer);
    try {
      list = await api.list(refreshing);
      draw();
    } catch (err) {
      replace(status, `Could not load the sessions: ${(err as Error).message}`);
    }
    if (list && list.pending > 0) {
      timer = setTimeout(() => {
        if (isCurrent()) void load();
      }, 2000);
    }
  }

  void load();
}
