/** The page's two charts, built from DOM and SVG nodes (no HTML strings, no inline styles: the
 * policy allows neither). One series each, in the accent colour; every value is also written
 * out, so nothing is told by colour or length alone. */

import { h } from "../../web/dom";
import { plural } from "./text";

/** A ranked list with a bar for each count. `href` makes each name a link (to the sessions
 * it filters to). Past `limit` rows, a button shows the rest. */
export function ranked(
  rows: [string, number][],
  cls: string,
  limit: number,
  href?: (name: string) => string,
  label: (name: string) => string = (name) => name,
  count: (n: number) => string = (n) => n.toLocaleString(),
): HTMLElement {
  const max = rows[0]?.[1] ?? 1;
  const item = ([name, n]: [string, number]) =>
    h(
      "li",
      null,
      href
        ? h("a", { class: "rank-name", title: name, href: href(name) }, label(name))
        : h("span", { class: "rank-name", title: name }, label(name)),
      h("span", { class: "rank-count", title: n.toLocaleString() }, count(n)),
      h(
        "span",
        { class: "rank-bar", "aria-hidden": "true" },
        h("span", { class: `rank-fill w${Math.max(1, Math.round((n / max) * 20))}` }),
      ),
    );
  const list = h("ol", { class: `ranked ${cls}` }, rows.slice(0, limit).map(item));
  if (rows.length <= limit) return list;
  const rest = rows.slice(limit);
  const more = h(
    "button",
    {
      type: "button",
      class: "quiet unfold",
      onclick: () => {
        list.append(...rest.map(item));
        more.remove();
      },
    },
    `Show ${plural(rest.length, "more", "more")}`,
  );
  return h("div", null, list, more);
}

const SVG = "http://www.w3.org/2000/svg";

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
  ...children: (Node | string)[]
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of children) el.append(c);
  return el;
}

/** A big number in a few characters: 950, 12k, 3.4M. */
export function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  return n.toLocaleString();
}

/** A count per day as bars, oldest on the left, each with its date and count on hover (and in
 * the table under it). The tallest day is labelled. `unit` names what is counted. */
export function dailyBars(
  days: { day: string; label: string; count: number }[],
  unit: { one: string; many: string; heading: string } = {
    one: "session",
    many: "sessions",
    heading: "Sessions",
  },
): HTMLElement {
  // Drawn at about the size it is shown, so its labels read at the page's own small size.
  const width = 480;
  const height = 150;
  const bottom = 22;
  const gap = 2;
  const max = Math.max(1, ...days.map((d) => d.count));
  const top = 18;
  const slot = width / Math.max(1, days.length);
  // Thin bars, centred in their day: a week does not become seven slabs.
  const bar = Math.min(36, Math.max(2, slot - gap));
  const peak = days.reduce(
    (best, d) => (d.count > best.count ? d : best),
    days[0] ?? { day: "", label: "", count: 0 },
  );
  const chart = svg("svg", {
    class: "daily",
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-label": `${unit.heading} per day, ${days[0]?.label ?? ""} to ${days.at(-1)?.label ?? ""}; most on ${peak.label}: ${peak.count.toLocaleString()}`,
  });
  chart.append(
    svg("line", { class: "baseline", x1: 0, x2: width, y1: height - bottom, y2: height - bottom }),
  );
  days.forEach((d, i) => {
    const plot = height - bottom - top;
    const hgt = d.count === 0 ? 0 : Math.max(3, (d.count / max) * plot);
    const x = i * slot + (slot - bar) / 2;
    const y = height - bottom - hgt;
    const group = svg("g", { class: "day" });
    group.append(
      svg("title", {}, `${d.label}: ${plural(d.count, unit.one, unit.many)}`),
      svg("rect", { class: "hit", x: i * slot, y: 0, width: slot, height: height - bottom }),
    );
    if (hgt > 0)
      group.append(
        svg("rect", { class: "bar", x, y, width: bar, height: hgt, rx: Math.min(4, bar / 2) }),
      );
    if (d === peak && d.count > 0) {
      group.append(
        svg(
          "text",
          { class: "peak", x: x + bar / 2, y: y - 4, "text-anchor": "middle" },
          compact(d.count),
        ),
      );
    }
    chart.append(group);
  });
  const ticks = [0, Math.floor((days.length - 1) / 2), days.length - 1];
  for (const i of new Set(ticks)) {
    const d = days[i];
    if (!d) continue;
    const anchor = i === 0 ? "start" : i === days.length - 1 ? "end" : "middle";
    const x = i === 0 ? 0 : i === days.length - 1 ? width : i * slot + slot / 2;
    chart.append(svg("text", { class: "tick", x, y: height - 6, "text-anchor": anchor }, d.label));
  }
  const table = h(
    "details",
    { class: "as-table" },
    h("summary", null, "Show as a table"),
    h(
      "table",
      null,
      h("thead", null, h("tr", null, h("th", null, "Day"), h("th", null, unit.heading))),
      h(
        "tbody",
        null,
        days.map((d) =>
          h("tr", null, h("td", null, d.label), h("td", null, d.count.toLocaleString())),
        ),
      ),
    ),
  );
  return h("figure", { class: "chart" }, chart, table);
}
