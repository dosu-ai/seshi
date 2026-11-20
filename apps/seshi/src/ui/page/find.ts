/** Find within one session: every step whose text holds the words, with the step drawn (past
 * "Show more" if it must be), its input and output opened, its folded text unfolded, and each
 * occurrence marked. Marks split text nodes; nothing is parsed as markup. */

import { h } from "../../web/dom";
import { eventId, type Step } from "./thread";

export interface ThreadPart {
  hash: string;
  steps: Step[];
  /** Draw the trace's steps up to `index`, if they are not drawn yet. */
  reveal(index: number): void;
}

interface Hit {
  part: ThreadPart;
  index: number;
}

const TYPING_MS = 150;

function textOf(step: Step): string {
  return step.kind === "event" ? step.event.text : `${step.call.text}\n${step.result?.text ?? ""}`;
}

function firstIndex(step: Step): number {
  return step.kind === "event" ? step.event.index : step.call.index;
}

/** Wrap each occurrence of `needle` (already lower case) in `root`'s text in a mark. */
export function markText(root: Node, needle: string): HTMLElement[] {
  const marks: HTMLElement[] = [];
  if (!needle) return marks;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  for (const node of nodes) {
    let current: Text = node;
    for (;;) {
      const at = current.data.toLowerCase().indexOf(needle);
      if (at < 0) break;
      const match = current.splitText(at);
      const rest = match.splitText(needle.length);
      const mark = h("mark", { class: "find" }, match.data);
      match.replaceWith(mark);
      marks.push(mark);
      current = rest;
    }
  }
  return marks;
}

function unmark(root: ParentNode): void {
  for (const mark of root.querySelectorAll("mark.find")) {
    const parent = mark.parentNode;
    mark.replaceWith(document.createTextNode(mark.textContent ?? ""));
    parent?.normalize();
  }
}

export function findBar(parts: () => ThreadPart[]): HTMLElement {
  const input = h("input", {
    id: "find",
    type: "search",
    placeholder: "Find in this session",
    "aria-label": "Find in this session",
    autocomplete: "off",
    spellcheck: "false",
  });
  const count = h("span", { class: "find-count", role: "status" });
  let hits: Hit[] = [];
  let at = -1;
  let needle = "";
  let shown: Element | null = null;
  /** What the shown step had closed or folded before find opened it, put back on leaving. */
  let opened: HTMLDetailsElement[] = [];
  let unfolded: HTMLButtonElement[] = [];

  const leave = () => {
    if (!shown) return;
    unmark(shown);
    shown.classList.remove("found");
    for (const details of opened) details.open = false;
    for (const button of unfolded) if (button.isConnected) button.click();
    opened = [];
    unfolded = [];
    shown = null;
  };

  const show = (i: number) => {
    if (hits.length === 0) return;
    at = (i + hits.length) % hits.length;
    const hit = hits[at] as Hit;
    const step = hit.part.steps[hit.index] as Step;
    hit.part.reveal(hit.index);
    leave();
    const el = document.getElementById(eventId(hit.part.hash, firstIndex(step)));
    count.textContent = `${at + 1} of ${hits.length}`;
    if (!el) return;
    for (const details of el.querySelectorAll("details")) {
      if (details.open) continue;
      details.open = true;
      opened.push(details);
    }
    for (const button of el.querySelectorAll<HTMLButtonElement>("button.unfold")) {
      if (button.getAttribute("aria-expanded") === "false") {
        button.click();
        unfolded.push(button);
      } else if (
        !button.hasAttribute("aria-expanded") &&
        /^Show all/.test(button.textContent ?? "")
      ) {
        button.click();
      }
    }
    el.classList.add("found");
    shown = el;
    const marks = markText(el, needle);
    marks[0]?.classList.add("current");
    (marks[0] ?? el).scrollIntoView({ block: "center" });
  };

  const run = () => {
    needle = input.value.trim().toLowerCase();
    leave();
    hits = [];
    at = -1;
    if (needle.length < 2) {
      count.textContent = "";
      return;
    }
    for (const part of parts()) {
      part.steps.forEach((step, index) => {
        if (textOf(step).toLowerCase().includes(needle)) hits.push({ part, index });
      });
    }
    if (hits.length === 0) {
      count.textContent = "Not in this session";
      return;
    }
    show(0);
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(run, TYPING_MS);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      clearTimeout(timer);
      if (needle !== input.value.trim().toLowerCase()) run();
      else show(at + (event.shiftKey ? -1 : 1));
    } else if (event.key === "Escape") {
      input.value = "";
      run();
    }
  });
  return h(
    "div",
    { class: "find-bar", role: "search" },
    input,
    count,
    h(
      "button",
      {
        type: "button",
        class: "quiet",
        title: "Previous (Shift+Enter)",
        onclick: () => show(at - 1),
      },
      "Previous",
    ),
    h(
      "button",
      { type: "button", class: "quiet", title: "Next (Enter)", onclick: () => show(at + 1) },
      "Next",
    ),
  );
}
