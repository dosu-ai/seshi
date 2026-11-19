import type { ListStatus } from "../types";
import { STATUS, splitMarkers } from "./text";

type Child = Node | string | number | false | null | undefined | Child[];
type Attrs = Record<string, string | number | boolean | undefined | EventListener>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === false) continue;
    if (typeof value === "function") el.addEventListener(name.replace(/^on/, ""), value);
    else if (name === "class") el.className = String(value);
    else el.setAttribute(name, value === true ? "" : String(value));
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.appendChild(typeof child === "object" ? child : document.createTextNode(String(child)));
  }
}

export function replace(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}

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
