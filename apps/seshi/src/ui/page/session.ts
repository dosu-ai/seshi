import type { Identity, SessionMetadata, Trace, TraceRecord } from "@seshi/model";
import { append, type Child, h, replace } from "../../web/dom";
import { ApiError, call, download } from "./api";
import { EMPTY } from "./filters";
import { listHref, sessionHref } from "./list";
import { ago, plural, shortRepo, when } from "./text";
import { eventId, eventItem, foldedText } from "./thread";

const TABS = ["thread", "records", "reviews", "details"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = {
  thread: "Thread",
  records: "Records",
  reviews: "Reviews",
  details: "Details",
};

/** Events (or records) drawn at once; the rest wait for "Show more". */
const CHUNK = 300;

interface Review {
  n: number;
  at: string;
  content_hash: string;
  decision: "allow" | "redact" | "skipped";
  policy?: string;
  decision_model?: string;
  redactor_model?: string;
  findings?: unknown[];
  failure?: { step: string; code: string };
}

const DECISION: Record<Review["decision"], { icon: string; word: string }> = {
  allow: { icon: "✓", word: "Allowed as written" },
  redact: { icon: "✂", word: "Redacted before storing" },
  skipped: { icon: "–", word: "Review skipped" },
};

/** The session last opened, kept while the person moves between its tabs. */
let cached:
  | { key: string; metadata: Promise<SessionMetadata>; traces: Map<string, Promise<Trace>> }
  | undefined;

function opened(owner: string, archive: string) {
  const key = `${owner}/${archive}`;
  if (cached?.key !== key) {
    cached = {
      key,
      metadata: call<SessionMetadata>("session", { params: { owner, archive_id: archive } }),
      traces: new Map(),
    };
    cached.metadata.catch(() => {
      cached = undefined;
    });
  }
  const session = cached;
  return {
    metadata: session.metadata,
    trace(hash: string): Promise<Trace> {
      let trace = session.traces.get(hash);
      if (!trace) {
        trace = call<Trace>("trace", {
          params: { owner, archive_id: archive },
          query: new URLSearchParams({ hash }),
        });
        trace.catch(() => session.traces.delete(hash));
        session.traces.set(hash, trace);
      }
      return trace;
    },
  };
}

function problem(err: unknown, what: string): HTMLElement {
  const message =
    err instanceof ApiError && err.status === 404
      ? "There is no such session, or you may not read it."
      : `${what} did not load: ${err instanceof Error ? err.message : String(err)}`;
  return h("p", { class: "problem", role: "alert" }, message);
}

function fact(label: string, ...value: Child[]): HTMLElement {
  return h("div", null, h("dt", null, label), h("dd", null, ...value));
}

function header(m: SessionMetadata): HTMLElement {
  const title = m.repo ? shortRepo(m.repo) : (m.project ?? "Session");
  const redactions = Object.entries(m.redaction?.counts ?? {}).filter(([, n]) => n > 0);
  const removed = redactions.reduce((sum, [, n]) => sum + n, 0);
  return h(
    "header",
    { class: "session-head" },
    h("a", { class: "back", href: listHref(EMPTY) }, "All sessions"),
    h("h1", null, title, m.branch ? h("span", { class: "branch" }, m.branch) : null),
    h("p", { class: "session-id" }, h("code", null, m.session_id)),
    h(
      "dl",
      { class: "facts-grid" },
      fact("Owner", m.owner),
      fact("Agent", m.origin_agent ?? m.format),
      m.repo ? fact("Repository", m.repo) : null,
      m.models?.length ? fact("Models", m.models.join(", ")) : null,
      fact(
        "Last active",
        h(
          "time",
          { datetime: m.active_at ?? m.updated_at, title: when(m.active_at ?? m.updated_at) },
          ago(m.active_at ?? m.updated_at, new Date()),
        ),
      ),
      fact("Visible to", m.visibility === "owner" ? "Its owner and admins" : "The team"),
      fact(
        "Redaction",
        removed === 0
          ? "Nothing matched the rules"
          : h(
              "span",
              { title: redactions.map(([rule, n]) => `${rule}: ${n}`).join("\n") },
              `${plural(removed, "match", "matches")} removed (${redactions
                .map(([rule]) => rule)
                .join(", ")})`,
            ),
      ),
      Object.keys(m.labels ?? {}).length
        ? fact(
            "Labels",
            Object.entries(m.labels ?? {})
              .map(([k, v]) => `${k}=${v}`)
              .join(", "),
          )
        : null,
    ),
  );
}

function tabs(owner: string, archive: string, current: Tab, redacted: boolean): HTMLElement {
  return h(
    "nav",
    { class: "tabs", "aria-label": "Session views" },
    TABS.filter((t) => !redacted || t === "details").map((t) =>
      h(
        "a",
        {
          href: sessionHref(owner, archive, new URLSearchParams(t === "thread" ? {} : { tab: t })),
          ...(t === current ? { "aria-current": "page" } : {}),
        },
        TAB_LABEL[t],
      ),
    ),
  );
}

/** Items drawn a chunk at a time, `through` (an index) drawn at once. */
function chunked<T>(
  items: readonly T[],
  draw: (item: T) => HTMLElement,
  list: HTMLElement,
  after: HTMLElement,
  through = -1,
): void {
  let shown = 0;
  const step = (upTo: number) => {
    const end = Math.min(items.length, Math.max(upTo, shown + CHUNK));
    list.append(...items.slice(shown, end).map(draw));
    shown = end;
    replace(after);
    if (shown < items.length) {
      after.append(
        h(
          "button",
          { type: "button", onclick: () => step(0) },
          `Show ${Math.min(CHUNK, items.length - shown).toLocaleString()} more of ${plural(items.length - shown, "item")} left`,
        ),
      );
    }
  };
  step(through + 1);
}

async function threadPanel(
  panel: HTMLElement,
  m: SessionMetadata,
  load: (hash: string) => Promise<Trace>,
  target: { hash: string; event: number } | undefined,
  isCurrent: () => boolean,
): Promise<void> {
  if (m.traces.length === 0) {
    panel.append(h("p", { class: "empty" }, "This session has no trace yet."));
    return;
  }
  for (const [part, ref] of m.traces.entries()) {
    const status = h("p", { class: "loading", role: "status" }, "Loading…");
    if (m.traces.length > 1) {
      panel.append(
        h(
          "h2",
          { class: "part" },
          part === 0 ? "Start" : `Continued`,
          h("time", { datetime: ref.created_at }, ` stored ${when(ref.created_at)}`),
        ),
      );
    }
    panel.append(status);
    let trace: Trace;
    try {
      trace = await load(ref.content_hash);
    } catch (err) {
      if (!isCurrent()) return;
      status.replaceWith(problem(err, "This part of the thread"));
      continue;
    }
    if (!isCurrent()) return;
    const list = h("ol", { class: "thread" });
    const after = h("div", { class: "more" });
    status.replaceWith(list, after);
    const through =
      target?.hash === ref.content_hash
        ? trace.events.findIndex((e) => e.index === target.event)
        : -1;
    chunked(trace.events, (e) => eventItem(ref.content_hash, e), list, after, through);
    if (trace.events.length === 0) list.replaceWith(h("p", { class: "empty" }, "No events."));
  }
  if (target) {
    const el = document.getElementById(eventId(target.hash, target.event));
    if (el) {
      el.classList.add("target");
      el.setAttribute("tabindex", "-1");
      el.scrollIntoView({ block: "center" });
      el.focus({ preventScroll: true });
    }
  }
}

function recordItem(record: TraceRecord, index: number): HTMLElement {
  const stamp = "timestamp" in record ? record.timestamp : undefined;
  const tools =
    record.role === "assistant" && record.tool_calls?.length
      ? record.tool_calls.map((c) => c.name).join(", ")
      : undefined;
  return h(
    "li",
    { class: "record" },
    h(
      "div",
      { class: "record-head" },
      h("span", { class: "index" }, `#${index}`),
      h("span", { class: "role" }, record.role),
      tools ? h("code", { class: "tool" }, tools) : null,
      record.role === "tool" && record.withheld
        ? h("span", { class: "withheld" }, `withheld: ${record.withheld}`)
        : null,
      stamp ? h("time", { datetime: stamp }, when(stamp)) : null,
    ),
    foldedText(JSON.stringify(record, null, 2), "json"),
  );
}

async function recordsPanel(
  panel: HTMLElement,
  m: SessionMetadata,
  load: (hash: string) => Promise<Trace>,
  isCurrent: () => boolean,
): Promise<void> {
  panel.append(
    h(
      "p",
      { class: "hint" },
      "Each record as the server stored it, after redaction: what the agent's log said, in seshi's own format.",
    ),
  );
  let offset = 0;
  for (const ref of m.traces) {
    const status = h("p", { class: "loading", role: "status" }, "Loading…");
    panel.append(status);
    let trace: Trace;
    try {
      trace = await load(ref.content_hash);
    } catch (err) {
      if (!isCurrent()) return;
      status.replaceWith(problem(err, "These records"));
      continue;
    }
    if (!isCurrent()) return;
    const start = ref.continuation?.from_record ?? offset;
    const list = h("ol", { class: "records" });
    const after = h("div", { class: "more" });
    status.replaceWith(list, after);
    chunked(
      trace.records.map((r, i) => [r, start + i] as const),
      ([r, i]) => recordItem(r, i),
      list,
      after,
    );
    offset = start + trace.records.length;
  }
}

async function reviewsPanel(
  panel: HTMLElement,
  owner: string,
  archive: string,
  isCurrent: () => boolean,
): Promise<void> {
  let reviews: Review[];
  try {
    ({ reviews } = await call<{ reviews: Review[] }>("reviews", {
      params: { owner, archive_id: archive },
    }));
  } catch (err) {
    if (isCurrent()) panel.append(problem(err, "The reviews"));
    return;
  }
  if (!isCurrent()) return;
  if (reviews.length === 0) {
    panel.append(
      h(
        "p",
        { class: "empty" },
        "No model review ran on this session: the server stored what redaction left.",
      ),
    );
    return;
  }
  panel.append(
    h(
      "p",
      { class: "hint" },
      "What model review decided for each write before the server stored it.",
    ),
    h(
      "ol",
      { class: "reviews" },
      reviews.map((r) => {
        const d = DECISION[r.decision] ?? { icon: "?", word: r.decision };
        return h(
          "li",
          { class: `review decision-${r.decision}` },
          h(
            "div",
            { class: "review-head" },
            h("span", { class: "write" }, `Write ${r.n}`),
            h(
              "span",
              { class: "decision" },
              h("span", { "aria-hidden": "true" }, d.icon),
              ` ${d.word}`,
            ),
            h("time", { datetime: r.at }, when(r.at)),
          ),
          r.decision_model
            ? h(
                "p",
                { class: "audit" },
                `Policy ${r.policy ?? "?"}, decided by ${r.decision_model}`,
                r.redactor_model ? `, redacted by ${r.redactor_model}` : "",
                r.findings ? `; ${plural(r.findings.length, "finding")}` : "",
                r.failure ? `; failed at ${r.failure.step}: ${r.failure.code}` : "",
              )
            : null,
        );
      }),
    ),
  );
}

function detailsPanel(panel: HTMLElement, m: SessionMetadata, owner: string, archive: string) {
  const failed = h("p", { class: "problem", role: "alert", hidden: true });
  append(panel, [
    m.traces.length > 0
      ? h(
          "section",
          { class: "downloads" },
          h("h2", null, "Download"),
          h(
            "p",
            { class: "hint" },
            m.traces.length > 1
              ? "The session is stored in parts; read them in this order for the whole session."
              : "The stored trace as JSON, in seshi's format.",
          ),
          h(
            "ul",
            null,
            m.traces.map((ref, i) =>
              h(
                "li",
                null,
                h(
                  "button",
                  {
                    type: "button",
                    onclick: () =>
                      download(
                        "export",
                        {
                          params: { owner, archive_id: archive },
                          query: new URLSearchParams({ hash: ref.content_hash }),
                        },
                        `${m.session_id}-${i + 1}.json`,
                      ).catch((err: unknown) => {
                        failed.textContent = `The download did not start: ${err instanceof Error ? err.message : String(err)}`;
                        failed.hidden = false;
                      }),
                  },
                  m.traces.length > 1 ? `Part ${i + 1} of ${m.traces.length}` : "Trace",
                ),
                h("span", { class: "hint" }, ` ${plural(ref.records, "record")}`),
              ),
            ),
          ),
          failed,
        )
      : null,
    h("h2", null, "Stored record"),
    h("p", { class: "hint" }, "The session's metadata as the API returns it."),
    h("pre", { class: "json" }, JSON.stringify(m, null, 2)),
  ]);
}

export function renderSession(
  root: HTMLElement,
  ctx: {
    owner: string;
    archive: string;
    query: URLSearchParams;
    me: Identity;
    isCurrent: () => boolean;
  },
): void {
  const { owner, archive, query, isCurrent } = ctx;
  const asked = query.get("tab") ?? "thread";
  const tab: Tab = (TABS as readonly string[]).includes(asked) ? (asked as Tab) : "thread";
  const hash = query.get("hash");
  const event = Number(query.get("event"));
  const target =
    hash && /^[0-9a-f]{64}$/.test(hash) && Number.isInteger(event) ? { hash, event } : undefined;
  const session = opened(owner, archive);
  const status = h("p", { class: "loading", role: "status" }, "Loading the session…");
  replace(root, h("section", { class: "session" }, status));
  if (!target) window.scrollTo(0, 0);

  void session.metadata.then(
    (m) => {
      if (!isCurrent()) return;
      document.title = `${m.repo ? shortRepo(m.repo) : m.session_id}: seshi`;
      const redacted = m.status === "redacted";
      const panel = h("div", { class: `panel panel-${tab}` });
      replace(
        root,
        h(
          "section",
          { class: "session" },
          header(m),
          redacted
            ? h(
                "p",
                { class: "notice" },
                "This session was redacted: its trace is gone, and only this record of it is left.",
              )
            : null,
          tabs(owner, archive, redacted ? "details" : tab, redacted),
          panel,
        ),
      );
      if (redacted || tab === "details") detailsPanel(panel, m, owner, archive);
      else if (tab === "thread") void threadPanel(panel, m, session.trace, target, isCurrent);
      else if (tab === "records") void recordsPanel(panel, m, session.trace, isCurrent);
      else void reviewsPanel(panel, owner, archive, isCurrent);
    },
    (err: unknown) => {
      if (!isCurrent()) return;
      replace(
        root,
        h(
          "section",
          { class: "session" },
          h("a", { class: "back", href: listHref(EMPTY) }, "All sessions"),
          problem(err, "The session"),
        ),
      );
    },
  );
}
