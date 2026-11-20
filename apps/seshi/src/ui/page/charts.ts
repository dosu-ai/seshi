/** The page's charts, built from DOM and SVG nodes (no HTML strings, no inline styles: the
 * policy allows neither). Small and quiet: one ink colour for data, a hairline for the axis,
 * every value also written out (a title on hover, a table on request), so nothing is told by
 * colour, length or position alone. */

import { h } from "../../web/dom";
import { plural } from "./text";

/** A ranked list with a bar for each count: the tools a session used, the files it touched.
 * `href` makes each name a link. Past `limit` rows, a button shows the rest. */
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

/** A big number in a few characters: 950, 3,352, 12k, 3.4M. */
export function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  return Math.round(n).toLocaleString();
}

/** A word-sized line of a series (Tufte's sparkline): no axes, the last value dotted. Gaps
 * (`null`, a bucket with nothing to measure) break the line. */
export function sparkline(values: (number | null)[], label: string): SVGSVGElement {
  const width = 88;
  const height = 22;
  const pad = 2;
  const known = values.filter((v): v is number => v !== null);
  const max = Math.max(...known, 0);
  const min = Math.min(...known, 0);
  const x = (i: number) => pad + (i * (width - 2 * pad)) / Math.max(1, values.length - 1);
  const y = (v: number) =>
    max === min ? height / 2 : height - pad - ((v - min) / (max - min)) * (height - 2 * pad);
  const chart = svg("svg", {
    class: "spark",
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    role: "img",
    "aria-label": label,
  });
  let run: string[] = [];
  const flush = () => {
    if (run.length > 1) chart.append(svg("polyline", { points: run.join(" ") }));
    run = [];
  };
  values.forEach((v, i) => {
    if (v === null) flush();
    else run.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  });
  flush();
  const lastIndex = values.findLastIndex((v) => v !== null);
  const last = values[lastIndex];
  if (last !== null && last !== undefined) {
    chart.append(svg("circle", { cx: x(lastIndex), cy: y(last), r: 2 }));
  }
  return chart;
}

export interface Series {
  label: string;
  /** The span's total or summary, written beside the label. */
  summary: string;
  values: number[];
  format: (n: number) => string;
  unit: string;
}

/** Several series over the same buckets, one thin row of bars each, sharing the time axis
 * (small multiples): each row has its own scale, labelled by its maximum. */
export function timeline(
  series: Series[],
  buckets: { label: string; tick?: string }[],
): HTMLElement {
  const width = 960;
  const rowHeight = 56;
  const gap = 1;
  const slot = width / Math.max(1, buckets.length);
  const bar = Math.max(1, Math.min(28, slot - gap * 2));
  const rows = series.map((s) => {
    const max = Math.max(1, ...s.values);
    const chart = svg("svg", {
      class: "strip",
      viewBox: `0 0 ${width} ${rowHeight}`,
      preserveAspectRatio: "none",
      role: "img",
      "aria-label": `${s.label} per ${buckets.length === 24 ? "hour" : "day"}; ${s.summary}`,
    });
    chart.append(
      svg("line", { class: "axis", x1: 0, x2: width, y1: rowHeight - 0.5, y2: rowHeight - 0.5 }),
    );
    s.values.forEach((v, i) => {
      const hgt = v === 0 ? 0 : Math.max(2, (v / max) * (rowHeight - 6));
      const g = svg("g", { class: "bucket" });
      g.append(
        svg("title", {}, `${buckets[i]?.label ?? ""}: ${s.format(v)} ${s.unit}`),
        svg("rect", { class: "hit", x: i * slot, y: 0, width: slot, height: rowHeight }),
      );
      if (hgt > 0) {
        g.append(
          svg("rect", {
            class: "bar",
            x: i * slot + (slot - bar) / 2,
            y: rowHeight - hgt,
            width: bar,
            height: hgt,
          }),
        );
      }
      chart.append(g);
    });
    return h(
      "div",
      { class: "strip-row" },
      h(
        "div",
        { class: "strip-label" },
        h("span", { class: "strip-name" }, s.label),
        h("span", { class: "strip-sum" }, s.summary),
      ),
      h("div", { class: "strip-plot" }, chart),
      h("div", { class: "strip-max", title: "The tallest bar" }, s.format(max)),
    );
  });
  const ticks = h(
    "div",
    { class: "strip-row strip-ticks", "aria-hidden": "true" },
    h("div", { class: "strip-label" }),
    h(
      "div",
      { class: "strip-plot ticks" },
      buckets.map((b) => h("span", null, b.tick ?? "")),
    ),
    h("div", { class: "strip-max" }),
  );
  const table = h(
    "details",
    { class: "as-table" },
    h("summary", null, "Show as a table"),
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        { class: "plain" },
        h(
          "thead",
          null,
          h(
            "tr",
            null,
            h("th", null, ""),
            series.map((s) => h("th", { class: "num" }, s.label)),
          ),
        ),
        h(
          "tbody",
          null,
          buckets.map((b, i) =>
            h(
              "tr",
              null,
              h("td", null, b.label),
              series.map((s) => h("td", { class: "num" }, s.format(s.values[i] ?? 0))),
            ),
          ),
        ),
      ),
    ),
  );
  return h("figure", { class: "timeline" }, ...rows, ticks, table);
}
