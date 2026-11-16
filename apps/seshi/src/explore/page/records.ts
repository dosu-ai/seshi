import type { RecordRow, RecordsView, RowFilter, RowState } from "../types";
import { api } from "./api";
import { h, replace, withMarkers } from "./dom";
import { fold, plural, ROW_STATE } from "./text";

const PAGE = 100;
const FOLD_LINES = 14;

const FILTERS: { id: RowFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "mismatch", label: "Mismatches" },
  { id: "redacted", label: "Redacted" },
  { id: "local", label: "Local only" },
  { id: "stored", label: "Stored" },
];

function recordCell(value: unknown, side: "local" | "stored", empty: string): HTMLElement {
  if (value === undefined) return h("td", { class: `rec ${side} empty` }, empty);
  const text = JSON.stringify(value, null, 2);
  const folded = fold(text, FOLD_LINES);
  const pre = h("pre", null, withMarkers(folded.head));
  const cell = h("td", { class: `rec ${side}` }, pre);
  if (folded.folded) {
    let open = false;
    const toggle = h("button", { type: "button", class: "link" });
    const label = () => replace(toggle, open ? "Fold" : `Show all ${plural(folded.lines, "line")}`);
    label();
    toggle.addEventListener("click", () => {
      open = !open;
      replace(pre, withMarkers(open ? text : folded.head));
      label();
    });
    cell.append(toggle);
  }
  return cell;
}

function stateBadge(state: RowState): HTMLElement {
  const s = ROW_STATE[state];
  return h(
    "span",
    { class: `badge tone-${s.tone}` },
    h("span", { class: "icon", "aria-hidden": "true" }, s.icon),
    " ",
    s.word,
  );
}

function divider(text: string): HTMLElement {
  return h("tr", { class: "divider" }, h("td", { colspan: 3 }, text));
}

export function renderRecords(
  root: HTMLElement,
  agent: string,
  id: string,
  first: RecordsView,
): void {
  let filter: RowFilter = "all";
  let loaded = 0;
  let matching = 0;
  let lastIndex = -1;
  const marks = first.marks;
  const body = h("tbody");
  const more = h("button", { type: "button" });
  const status = h("p", { class: "muted", role: "status" });
  const filterBar = h("div", { class: "filters", role: "group", "aria-label": "Show" });

  const legend = h(
    "p",
    { class: "small muted" },
    Object.entries(first.states)
      .map(
        ([state, n]) =>
          `${ROW_STATE[state as RowState].icon} ${ROW_STATE[state as RowState].word}: ${n}`,
      )
      .join(" · "),
    marks.stub ? " · the stored session is a stub" : "",
  );

  function dividersBefore(index: number): HTMLElement[] {
    const out: HTMLElement[] = [];
    const crossed = (at: number | undefined) => at !== undefined && lastIndex < at && index >= at;
    if (crossed(marks.dropped_until)) {
      out.push(
        divider(
          `▲ Review dropped records 0–${(marks.dropped_until as number) - 1} from the first envelope`,
        ),
      );
    }
    if (crossed(marks.sent_until)) {
      out.push(divider(`▼ The server's log ends here (record ${marks.sent_until})`));
    }
    if (crossed(marks.frozen_at)) {
      out.push(
        divider(
          `⏸ A pause stopped the session here (record ${marks.frozen_at}): nothing past it is sent`,
        ),
      );
    }
    return out;
  }

  function row(r: RecordRow): HTMLElement[] {
    const tr = h(
      "tr",
      { class: `row state-${r.state}` },
      h(
        "th",
        { scope: "row", class: "idx" },
        h("span", { class: "mono" }, `#${r.index}`),
        stateBadge(r.state),
        r.trace !== undefined ? h("span", { class: "small muted" }, `trace ${r.trace + 1}`) : null,
        r.withheld ? h("span", { class: "small" }, `withheld: ${r.withheld}`) : null,
        r.markers
          ? Object.entries(r.markers).map(([rule, n]) =>
              h(
                "span",
                { class: "chip", title: `redaction rule ${rule}` },
                `${rule}${n > 1 ? ` ×${n}` : ""}`,
              ),
            )
          : null,
      ),
      recordCell(r.local, "local", "no local record"),
      recordCell(
        r.stored,
        "stored",
        r.state === "dropped" ? "dropped by review" : "nothing stored",
      ),
    );
    const out = [...dividersBefore(r.index), tr];
    lastIndex = r.index;
    return out;
  }

  async function next(): Promise<void> {
    more.disabled = true;
    try {
      const view = await api.records(agent, id, loaded, PAGE, filter);
      matching = view.matching;
      for (const r of view.rows) body.append(...row(r));
      loaded += view.rows.length;
    } catch (err) {
      replace(status, `Could not load records: ${(err as Error).message}`);
      return;
    } finally {
      more.disabled = false;
    }
    replace(status, `Showing ${loaded} of ${plural(matching, "row")} (${first.total} in all)`);
    more.hidden = loaded >= matching;
    replace(more, `Show ${Math.min(PAGE, matching - loaded)} more`);
  }

  function reset(to: RowFilter): void {
    filter = to;
    loaded = 0;
    lastIndex = -1;
    body.replaceChildren();
    drawFilters();
    void next();
  }

  function drawFilters(): void {
    replace(
      filterBar,
      FILTERS.map((f) =>
        h(
          "button",
          {
            type: "button",
            class: f.id === filter ? "current" : "",
            "aria-pressed": f.id === filter ? "true" : "false",
            onclick: () => reset(f.id),
          },
          f.label,
        ),
      ),
    );
  }

  more.addEventListener("click", () => void next());
  replace(
    root,
    filterBar,
    legend,
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        { class: "records" },
        h(
          "thead",
          null,
          h(
            "tr",
            null,
            h("th", { scope: "col" }, "Record"),
            h("th", { scope: "col" }, "Local (re-normalized, redacted with this machine's rules)"),
            h("th", { scope: "col" }, "Stored (as the server stored it)"),
          ),
        ),
        body,
      ),
    ),
    status,
    more,
  );
  drawFilters();
  void next();
}
