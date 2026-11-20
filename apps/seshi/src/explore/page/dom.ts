import { h } from "../../web/dom";
import type { ListStatus } from "../types";
import { STATUS, splitMarkers } from "./text";

export { append, h, replace } from "../../web/dom";

export function badge(status: ListStatus, extra = ""): HTMLElement {
  const s = STATUS[status];
  return h(
    "span",
    { class: `badge tone-${status}${extra ? ` ${extra}` : ""}` },
    h("span", { class: "icon", "aria-hidden": "true" }, s.icon),
    " ",
    s.word,
  );
}

export function withMarkers(text: string): Node[] {
  return splitMarkers(text).map((part) =>
    part.rule
      ? h("mark", { class: "redaction", title: `redacted by rule ${part.rule}` }, part.text)
      : document.createTextNode(part.text),
  );
}
