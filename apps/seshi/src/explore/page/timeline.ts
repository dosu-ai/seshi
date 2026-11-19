import type { TimelineEvent, TimelineKind } from "../types";
import { h, replace } from "./dom";
import { KIND_WORD, when } from "./text";

export function renderTimeline(root: HTMLElement, events: TimelineEvent[]): void {
  let kind: TimelineKind | "" = "";
  const kinds = [...new Set(events.map((e) => e.kind))].sort();
  const body = h("tbody");
  const draw = () =>
    replace(
      body,
      events
        .filter((e) => !kind || e.kind === kind)
        .map((e) =>
          h(
            "tr",
            null,
            h("td", { class: "small nowrap" }, h("time", { datetime: e.at }, when(e.at))),
            h("td", null, h("span", { class: `kind kind-${e.kind}` }, KIND_WORD[e.kind])),
            h("td", { class: "mono small" }, e.text),
          ),
        ),
    );
  replace(
    root,
    h(
      "div",
      { class: "toolbar" },
      h(
        "select",
        {
          "aria-label": "Kind",
          onchange: (e: Event) => {
            kind = (e.target as HTMLSelectElement).value as TimelineKind | "";
            draw();
          },
        },
        h("option", { value: "" }, `All kinds (${events.length})`),
        kinds.map((k) => h("option", { value: k }, KIND_WORD[k])),
      ),
    ),
    events.length === 0
      ? h("p", { class: "muted" }, "Nothing with a time is known about this session.")
      : h(
          "div",
          { class: "table-wrap" },
          h(
            "table",
            { class: "timeline" },
            h(
              "thead",
              null,
              h(
                "tr",
                null,
                ["When", "Kind", "What"].map((t) => h("th", { scope: "col" }, t)),
              ),
            ),
            body,
          ),
        ),
  );
  draw();
}
