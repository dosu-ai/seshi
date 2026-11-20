/** A session's events drawn along one thread: a node per event, its role named in words (the
 * node's shape and colour only repeat it), its text as plain text with redaction markers set
 * apart. Nothing here parses markup: transcripts are untrusted. */

import type { EventRole, TraceEvent } from "@seshi/model";
import { h } from "../../web/dom";
import { clock, fold, splitMarkers, when } from "./text";

export const ROLE: Readonly<Record<EventRole, { word: string; node: string }>> = {
  user: { word: "Prompt", node: "●" },
  assistant: { word: "Assistant", node: "◆" },
  tool_call: { word: "Tool call", node: "▸" },
  tool_result: { word: "Tool result", node: "◂" },
  system: { word: "System", node: "■" },
  observation: { word: "Observation", node: "○" },
  reasoning: { word: "Reasoning", node: "◇" },
};

const FOLD_LINES = 16;

export function withMarkers(text: string): Node[] {
  return splitMarkers(text).map((part) =>
    part.rule
      ? h(
          "mark",
          { class: "redaction", title: `removed by redaction rule ${part.rule}` },
          part.text,
        )
      : document.createTextNode(part.text),
  );
}

/** Text that folds past a few lines, with a button that shows the rest. */
export function foldedText(text: string, cls = "text"): HTMLElement {
  const { head, lines, folded } = fold(text, FOLD_LINES);
  const pre = h("pre", { class: cls }, withMarkers(head));
  if (!folded) return pre;
  const more = lines > FOLD_LINES ? `Show all ${lines.toLocaleString()} lines` : "Show all of it";
  const button = h(
    "button",
    {
      type: "button",
      class: "quiet unfold",
      "aria-expanded": "false",
      onclick: () => {
        const open = button.getAttribute("aria-expanded") === "true";
        pre.replaceChildren(...withMarkers(open ? head : text));
        button.setAttribute("aria-expanded", String(!open));
        button.textContent = open ? more : "Show less";
      },
    },
    more,
  );
  return h("div", { class: "folded" }, pre, button);
}

/** The anchor id of a trace's event, which search results link to. */
export function eventId(hash: string, index: number): string {
  return `e-${hash.slice(0, 16)}-${index}`;
}

export function eventItem(hash: string, event: TraceEvent): HTMLElement {
  const role = ROLE[event.role] ?? { word: event.role, node: "·" };
  const outcome =
    event.role === "tool_result" && event.ok !== undefined
      ? h("span", { class: event.ok ? "ok" : "failed" }, event.ok ? "✓ ok" : "✕ failed")
      : null;
  return h(
    "li",
    { class: `event role-${event.role}`, id: eventId(hash, event.index) },
    h("span", { class: "node", "aria-hidden": "true" }, role.node),
    h(
      "div",
      { class: "event-head" },
      h("span", { class: "role" }, role.word),
      event.tool_name ? h("code", { class: "tool" }, event.tool_name) : null,
      outcome,
      event.timestamp
        ? h(
            "time",
            { datetime: event.timestamp, title: when(event.timestamp) },
            clock(event.timestamp),
          )
        : null,
    ),
    event.text ? foldedText(event.text) : h("p", { class: "empty-text" }, "No text"),
  );
}
