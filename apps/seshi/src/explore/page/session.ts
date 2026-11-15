/** One session: the header (agent, id, folder, the capture decision, visibility, where it is
 * stored), the checks (failures first), the pipeline strip, and three tabs: records side by
 * side, the timeline, and the raw evidence. */

import type { CheckResult } from "../../doctor/types";
import type { Pipeline, RecordsView, SessionDetail } from "../types";
import { api } from "./api";
import { badge, h, replace } from "./dom";
import { sessionHref } from "./list";
import { renderRaw } from "./raw";
import { renderRecords } from "./records";
import { bytes, plural } from "./text";
import { renderTimeline } from "./timeline";

export type Tab = "records" | "timeline" | "raw";
const TABS: { id: Tab; label: string }[] = [
  { id: "records", label: "Records" },
  { id: "timeline", label: "Timeline" },
  { id: "raw", label: "Raw" },
];

function header(d: SessionDetail, onRefresh: () => void): HTMLElement {
  const ev = d.evidence;
  const m = ev.server.metadata ?? ev.server.pointer ?? undefined;
  const decision = ev.decision;
  const server = ev.server;
  return h(
    "header",
    { class: "session-head" },
    h("p", null, h("a", { href: "#/" }, "← Sessions")),
    h(
      "div",
      { class: "title-row" },
      h(
        "h1",
        null,
        badge(d.worst),
        " ",
        ev.agent,
        " ",
        h("span", { class: "mono" }, ev.session_id),
      ),
      h(
        "button",
        { type: "button", onclick: onRefresh },
        h("span", { "aria-hidden": "true" }, "↻"),
        " Check again",
      ),
    ),
    h(
      "dl",
      { class: "facts" },
      h("dt", null, "Folder"),
      h("dd", { class: "mono" }, ev.local?.cwd ?? "unknown"),
      h("dt", null, "Session Capture"),
      h(
        "dd",
        null,
        h("span", { class: "glyph", "aria-hidden": "true" }, d.glyph),
        " ",
        decision ? (decision.capture ? "capturing" : "not capturing") : "unknown",
        decision ? `: ${decision.reason} (${decision.level})` : "",
      ),
      h("dt", null, "Visibility"),
      h("dd", null, m?.visibility ?? "—"),
      h("dt", null, "Stored at"),
      h(
        "dd",
        null,
        server.mode === "none"
          ? `nowhere: ${server.error?.message ?? "no server"}`
          : `${server.mode === "local" ? "local bucket" : "server"} ${server.where ?? ""}`,
        server.upload_id && server.upload_id !== ev.session_id ? ` (as ${server.upload_id})` : "",
      ),
    ),
  );
}

function checksPanel(checks: CheckResult[]): HTMLElement {
  return h(
    "section",
    { class: "checks", "aria-label": "Checks" },
    h("h2", null, "Checks"),
    h(
      "ul",
      null,
      checks.map((c) =>
        h(
          "li",
          { class: `check tone-${c.status}` },
          badge(c.status),
          h(
            "div",
            null,
            h("strong", null, c.title),
            " ",
            c.summary,
            c.detail?.length
              ? h(
                  "ul",
                  { class: "detail" },
                  c.detail.map((x) => h("li", null, x)),
                )
              : null,
            c.hint ? h("p", { class: "hint" }, "Hint: ", c.hint) : null,
          ),
        ),
      ),
    ),
  );
}

function stage(title: string, main: string, notes: (string | false | undefined)[], warn = false) {
  return h(
    "li",
    { class: `stage${warn ? " has-gap" : ""}` },
    h("span", { class: "stage-title" }, title),
    h("span", { class: "stage-main" }, main),
    notes
      .filter(Boolean)
      .map((n) =>
        h(
          "span",
          { class: "stage-note" },
          warn ? h("span", { "aria-hidden": "true" }, "▲ ") : null,
          n,
        ),
      ),
  );
}

export function pipelineStrip(p: Pipeline, marks: RecordsView["marks"]): HTMLElement {
  const t = p.transcript;
  const markerRules = Object.entries(p.redacted.markers)
    .map(([rule, n]) => `${rule} ×${n}`)
    .join(", ");
  const gapsSent = t.frozen_offset !== undefined || p.sent.filtered;
  const gapsStored = p.stored.dropped_prefix !== undefined || p.stored.stub;
  return h(
    "ol",
    { class: "pipeline", "aria-label": "Pipeline" },
    stage(
      "Transcript",
      t.error ? "not here" : bytes(t.bytes),
      [
        t.error,
        t.sent_bytes !== undefined && `${bytes(t.sent_bytes)} sent`,
        t.server_offset !== undefined &&
          t.server_offset !== t.sent_bytes &&
          `server's log ends at ${bytes(t.server_offset)}`,
        t.frozen_offset !== undefined && `frozen at ${bytes(t.frozen_offset)}`,
      ],
      t.error !== undefined || t.frozen_offset !== undefined,
    ),
    stage(
      "Records",
      p.records.count !== undefined ? plural(p.records.count, "record") : "—",
      [p.records.error, "the current adapter, whole transcript"],
      p.records.error !== undefined,
    ),
    stage("Redacted", plural(p.redacted.records, "record"), [
      markerRules || "no markers",
      p.redacted.withheld > 0 && `${plural(p.redacted.withheld, "tool result")} withheld`,
      `rules: ${p.redacted.origin}`,
    ]),
    stage(
      "Sent",
      p.sent.records !== undefined ? plural(p.sent.records, "record") : "—",
      [
        p.sent.last_status && `last answer ${p.sent.last_status}`,
        p.sent.filtered && "kept back (filtered, off or a rule)",
        marks.frozen_at !== undefined && `nothing past record ${marks.frozen_at} (paused)`,
      ],
      gapsSent,
    ),
    stage(
      "Stored",
      p.stored.records !== undefined ? plural(p.stored.records, "record") : "nothing",
      [
        `${plural(p.stored.traces, "trace")}${p.stored.status ? `, ${p.stored.status}` : ""}`,
        p.stored.dropped_prefix !== undefined &&
          `review dropped the first ${plural(p.stored.dropped_prefix, "record")}`,
        p.stored.stub && "a stub (no trace yet)",
        p.stored.withheld_calls !== undefined &&
          `${plural(p.stored.withheld_calls, "call")} withheld`,
      ],
      gapsStored,
    ),
  );
}

export function renderSession(
  root: HTMLElement,
  agent: string,
  id: string,
  tab: Tab,
  isCurrent: () => boolean,
): void {
  const status = h("p", { class: "muted", role: "status" }, "Gathering evidence…");
  replace(root, status);

  const load = async (fresh: boolean) => {
    replace(status, fresh ? "Checking again…" : "Gathering evidence…");
    let detail: SessionDetail;
    let first: RecordsView;
    try {
      detail = await api.detail(agent, id, fresh);
      // The records view reads the evidence the detail just gathered (the server keeps it).
      first = await api.records(agent, id, 0, 0, "all");
    } catch (err) {
      replace(
        root,
        h("p", null, h("a", { href: "#/" }, "← Sessions")),
        h("p", { role: "alert" }, (err as Error).message),
      );
      return;
    }
    if (!isCurrent()) return;
    const panel = h("div", { class: "tab-panel", role: "tabpanel" });
    const tabs = h(
      "nav",
      { class: "tabs", role: "tablist" },
      TABS.map((t) =>
        h(
          "a",
          {
            role: "tab",
            href: sessionHref(agent, id, t.id),
            "aria-selected": t.id === tab ? "true" : "false",
            class: t.id === tab ? "tab current" : "tab",
          },
          t.label,
        ),
      ),
    );
    replace(
      root,
      header(detail, () => void load(true)),
      h(
        "div",
        { class: "overview" },
        checksPanel(detail.checks),
        h(
          "section",
          { class: "pipeline-wrap" },
          h("h2", null, "Pipeline"),
          pipelineStrip(first.pipeline, first.marks),
        ),
      ),
      tabs,
      panel,
    );
    if (tab === "records") renderRecords(panel, agent, id, first);
    else if (tab === "timeline") renderTimeline(panel, detail.timeline);
    else renderRaw(panel, detail.evidence);
  };
  void load(false);
}
