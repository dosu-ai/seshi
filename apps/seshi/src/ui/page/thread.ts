/** A session's events drawn along one thread. Prompts and answers read as Markdown; the blocks
 * an agent's harness puts before a prompt (AGENTS.md, environment context) fold away; a tool
 * call and its result are one step, closed until opened. Each node names its role in words
 * (its shape and colour only repeat it). Nothing here parses markup: transcripts are
 * untrusted, and every node is built from text. */

import type { EventRole, TraceEvent } from "@seshi/model";
import { splitPrompt } from "@seshi/model/prompts";
import { h } from "../../web/dom";
import { renderMarkdown } from "./markdown";
import { clock, fold, plural, prettyArgs, splitMarkers, when } from "./text";

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

/** Prose as Markdown, folded when long. */
function prose(text: string): HTMLElement {
  const { head, folded } = fold(text, 40, 4000);
  if (!folded) return renderMarkdown(text, withMarkers);
  const box = h("div", { class: "folded" }, renderMarkdown(head, withMarkers));
  box.append(
    h(
      "button",
      {
        type: "button",
        class: "quiet unfold",
        onclick: () => box.replaceChildren(renderMarkdown(text, withMarkers)),
      },
      "Show all of it",
    ),
  );
  return box;
}

/** The anchor id of a trace's event, which search results link to. */
export function eventId(hash: string, index: number): string {
  return `e-${hash.slice(0, 16)}-${index}`;
}

function stamp(iso: string | null): HTMLElement | null {
  return iso ? h("time", { datetime: iso, title: when(iso) }, clock(iso)) : null;
}

function promptBody(text: string): HTMLElement[] {
  const { context, prompt } = splitPrompt(text);
  const out: HTMLElement[] = [];
  if (context) {
    out.push(
      h(
        "details",
        { class: "context" },
        h(
          "summary",
          null,
          `Context the agent's harness added (${plural(context.split("\n").length, "line")})`,
        ),
        foldedText(context, "text mono-text"),
      ),
    );
  }
  if (prompt) out.push(prose(prompt));
  return out;
}

function outcome(event: TraceEvent | undefined): HTMLElement | null {
  if (event?.role !== "tool_result" || event.ok === undefined) return null;
  return h("span", { class: event.ok ? "ok" : "failed" }, event.ok ? "✓ ok" : "✕ failed");
}

/** One event on its own (a prompt, an answer, a result whose call is not in the trace…). */
export function eventItem(hash: string, event: TraceEvent): HTMLElement {
  const role = ROLE[event.role] ?? { word: event.role, node: "·" };
  const contextOnly = event.role === "user" && splitPrompt(event.text).prompt === "";
  return h(
    "li",
    {
      class: `event role-${event.role}${contextOnly ? " context-only" : ""}`,
      id: eventId(hash, event.index),
    },
    h("span", { class: "node", "aria-hidden": "true" }, role.node),
    h(
      "div",
      { class: "event-head" },
      h("span", { class: "role" }, contextOnly ? "Harness context" : role.word),
      event.tool_name ? h("code", { class: "tool" }, event.tool_name) : null,
      outcome(event),
      stamp(event.timestamp),
    ),
    !event.text
      ? h("p", { class: "empty-text" }, "No text")
      : event.role === "user"
        ? promptBody(event.text)
        : event.role === "assistant" || event.role === "reasoning"
          ? prose(event.text)
          : foldedText(event.text),
  );
}

/** A tool call's input: the text after the tool's name, which the trace puts first. */
export function argsOf(event: TraceEvent): string {
  const name = event.tool_name ?? "";
  return name && event.text.startsWith(name) ? event.text.slice(name.length).trim() : event.text;
}

/** One line that says what a tool call did: its command, file, pattern or query. */
export function callSummary(args: string): string {
  const first = (text: string) => text.trim().split("\n")[0]?.slice(0, 140) ?? "";
  let value: unknown;
  try {
    value = JSON.parse(args);
  } catch {
    return first(args);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    for (const key of [
      "command",
      "cmd",
      "file_path",
      "path",
      "notebook_path",
      "pattern",
      "query",
      "url",
      "description",
      "prompt",
    ]) {
      const v = o[key];
      const text = Array.isArray(v) ? v.join(" ") : v;
      if (typeof text === "string" && text.trim()) return first(text);
    }
  }
  return args.replace(/\s+/g, " ").slice(0, 140);
}

/** A tool call and its result as one step: the tool, what it was asked, how it ended; the
 * input and the output each closed until opened. */
export function stepItem(hash: string, call: TraceEvent, result?: TraceEvent): HTMLElement {
  const args = argsOf(call);
  const summary = callSummary(args);
  const lines = result?.text ? result.text.split("\n").length : 0;
  return h(
    "li",
    { class: "event step role-tool_call", id: eventId(hash, call.index) },
    h("span", { class: "node", "aria-hidden": "true" }, ROLE.tool_call.node),
    h(
      "div",
      { class: "event-head" },
      h("code", { class: "tool" }, call.tool_name ?? "tool"),
      summary ? h("span", { class: "summary-line" }, ...withMarkers(summary)) : null,
      outcome(result),
      stamp(call.timestamp),
    ),
    h(
      "details",
      { class: "io" },
      h("summary", null, "Input"),
      foldedText(prettyArgs(args), "text mono-text"),
    ),
    result
      ? h(
          "details",
          { class: "io", id: eventId(hash, result.index) },
          h("summary", null, lines > 0 ? `Output (${plural(lines, "line")})` : "Output"),
          result.text
            ? foldedText(result.text, "text mono-text")
            : h("p", { class: "empty-text" }, "No output"),
        )
      : null,
  );
}

export type Step =
  | { kind: "event"; event: TraceEvent }
  | { kind: "step"; call: TraceEvent; result?: TraceEvent };

/** A trace's events as the thread draws them: each tool call with its result (found by
 * `tool_call_id`, wherever it is), every other event on its own. */
export function stepsOf(events: readonly TraceEvent[]): Step[] {
  const results = new Map<string, TraceEvent>();
  for (const e of events) {
    if (e.role === "tool_result" && e.tool_call_id && !results.has(e.tool_call_id)) {
      results.set(e.tool_call_id, e);
    }
  }
  const used = new Set<TraceEvent>();
  for (const e of events) {
    const result = e.role === "tool_call" && e.tool_call_id && results.get(e.tool_call_id);
    if (result) used.add(result);
  }
  const steps: Step[] = [];
  for (const e of events) {
    if (e.role === "tool_call") {
      const result = e.tool_call_id ? results.get(e.tool_call_id) : undefined;
      steps.push({ kind: "step", call: e, ...(result ? { result } : {}) });
    } else if (!used.has(e)) {
      steps.push({ kind: "event", event: e });
    }
  }
  return steps;
}

/** The trace event indexes a step draws. */
export function stepIndexes(step: Step): number[] {
  return step.kind === "event"
    ? [step.event.index]
    : [step.call.index, ...(step.result ? [step.result.index] : [])];
}

export function drawStep(hash: string, step: Step): HTMLElement {
  return step.kind === "event"
    ? eventItem(hash, step.event)
    : stepItem(hash, step.call, step.result);
}
