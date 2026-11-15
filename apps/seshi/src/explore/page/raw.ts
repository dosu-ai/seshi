/** The raw tab: the evidence JSON as a tree that opens a level at a time (children are built only
 * when their parent is opened, so a large evidence document costs nothing until read). */

import { h, replace } from "./dom";

function preview(value: unknown): string {
  if (Array.isArray(value)) return `[${value.length}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).length}}`;
  return JSON.stringify(value) ?? "undefined";
}

function node(key: string, value: unknown, open: boolean): HTMLElement {
  const composite = value !== null && typeof value === "object";
  if (!composite) {
    return h(
      "div",
      { class: "leaf" },
      h("span", { class: "key" }, key),
      ": ",
      h(
        "span",
        { class: `val val-${value === null ? "null" : typeof value}` },
        JSON.stringify(value),
      ),
    );
  }
  const children = h("div", { class: "children" });
  let built = false;
  const build = () => {
    if (built) return;
    built = true;
    const entries = Array.isArray(value)
      ? value.map((v, i) => [String(i), v] as const)
      : Object.entries(value as Record<string, unknown>);
    replace(
      children,
      entries.map(([k, v]) => node(k, v, false)),
    );
  };
  const details = h(
    "details",
    { open },
    h(
      "summary",
      null,
      h("span", { class: "key" }, key),
      " ",
      h("span", { class: "muted" }, preview(value)),
    ),
    children,
  );
  details.addEventListener("toggle", () => {
    if (details.open) build();
  });
  if (open) build();
  return details;
}

export function renderRaw(root: HTMLElement, evidence: unknown): void {
  replace(
    root,
    h(
      "p",
      { class: "small muted" },
      "The evidence as the doctor gathered it (schema seshi/doctor-evidence/1); the stored traces' records are in the Records tab. The retraction secret is never here, only its hash.",
    ),
    h("div", { class: "json mono" }, node("evidence", evidence, true)),
  );
}
