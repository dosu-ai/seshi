import { createHash } from "node:crypto";
import type { Connector, ConnectorContext, Cursor } from "@seshi/kit";
import { type Claims, ENVELOPE_SCHEMA, type Envelope, type ReceivedSpan } from "@seshi/model";
import {
  abortableSleep,
  apiBase,
  DatadogApiError,
  type SearchPage,
  searchPage,
  tagFilter,
} from "./api";
import { DATADOG_LLMOBS, datadogClaims } from "./format";
import { sessionOf, tagsOf, tagValue, toReceivedSpan } from "./spans";

export const DATADOG_SOURCE = "datadog";

type SecretLike = string | { reveal(): string };

/** The fields of a `type = "datadog"` source this connector reads (`datadogSource` in
 * `@seshi/config`; durations in milliseconds). */
export interface DatadogSourceConfig {
  site: string;
  api_url?: string;
  api_key: string;
  app_key: string;
  ml_app?: string;
  tags: string[];
  overlap: number;
  lag: number;
  backfill: number;
  page_size: number;
}

export interface DatadogCursor {
  v: 1;
  /** The end of the last window read to its last page (ISO 8601). */
  until?: string;
  window?: { from: string; to: string; page?: string };
  /** Span ids (OTLP hex) submitted with a start inside the overlap, and that start in ms:
   * repeats the next window reads again are left out (F5.2). */
  seen?: Record<string, number>;
}

export interface DatadogConnectorOptions {
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  maxPagesPerRun?: number;
  /** Most span ids the checkpoint remembers (default 50,000); the oldest go first. Past it, a
   * repeat is resubmitted, which the span store absorbs. */
  maxSeen?: number;
  backoffMs?: number;
}

function secretValue(value: unknown, field: string): string {
  const text =
    typeof value === "string"
      ? value
      : typeof value === "object" && value !== null && "reveal" in value
        ? (value as { reveal(): string }).reveal()
        : undefined;
  if (typeof text !== "string" || text === "") {
    throw new Error(`the datadog source needs ${field}`);
  }
  return text;
}

const duration = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`the datadog source's ${field} is not a duration`);
  }
  return value;
};

/** The source's config, checked: what the connector needs, keys revealed. */
export function readDatadogConfig(raw: Readonly<Record<string, unknown>>): DatadogSourceConfig {
  const site = typeof raw.site === "string" && raw.site !== "" ? raw.site : "datadoghq.com";
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((t): t is string => typeof t === "string")
    : [];
  const page = typeof raw.page_size === "number" ? raw.page_size : 500;
  if (!Number.isInteger(page) || page < 1 || page > 5000) {
    throw new Error("the datadog source's page_size must be 1 to 5000");
  }
  tagFilter(tags);
  const api_url = apiUrl(raw.api_url);
  return {
    site,
    ...(api_url ? { api_url } : {}),
    api_key: secretValue(raw.api_key as SecretLike, "api_key"),
    app_key: secretValue(raw.app_key as SecretLike, "app_key"),
    ...(typeof raw.ml_app === "string" && raw.ml_app !== "" ? { ml_app: raw.ml_app } : {}),
    tags,
    overlap: duration(raw.overlap ?? 600_000, "overlap"),
    lag: duration(raw.lag ?? 120_000, "lag"),
    backfill: duration(raw.backfill ?? 7 * 86_400_000, "backfill"),
    page_size: page,
  };
}

function apiUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("the datadog source's api_url is not a URL");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "http:" && !loopback) {
    throw new Error(
      "the datadog source's api_url must be https (plain http would send the keys in clear); http is allowed for localhost only",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("the datadog source's api_url must be https");
  }
  return raw;
}

const isIso = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));

/** The checkpoint as this connector wrote it; null before the first run. A checkpoint of
 * another shape is refused, so a run never silently starts over: rewind the source. */
export function readDatadogCursor(raw: Cursor | null): DatadogCursor {
  if (raw === null) return { v: 1 };
  const problem = (why: string) =>
    new Error(
      `the datadog checkpoint is not one this version wrote (${why}); rewind the source with seshi reprocess`,
    );
  if (raw.v !== 1) throw problem(`version ${JSON.stringify(raw.v)}`);
  const cursor: DatadogCursor = { v: 1 };
  if (raw.until !== undefined) {
    if (!isIso(raw.until)) throw problem("until");
    cursor.until = raw.until;
  }
  if (raw.window !== undefined) {
    const w = raw.window as Record<string, unknown> | null;
    if (!w || !isIso(w.from) || !isIso(w.to)) throw problem("window");
    if (w.page !== undefined && typeof w.page !== "string") throw problem("window.page");
    cursor.window = { from: w.from, to: w.to, ...(w.page ? { page: w.page } : {}) };
  }
  if (raw.seen !== undefined) {
    if (typeof raw.seen !== "object" || raw.seen === null || Array.isArray(raw.seen)) {
      throw problem("seen");
    }
    cursor.seen = {};
    for (const [id, ms] of Object.entries(raw.seen)) {
      if (typeof ms === "number") cursor.seen[id] = ms;
    }
  }
  return cursor;
}

/** The window the next read covers, or undefined when nothing is due yet. */
export function nextWindow(
  cursor: DatadogCursor,
  config: Pick<DatadogSourceConfig, "overlap" | "lag" | "backfill">,
  now: Date,
): { from: string; to: string } | undefined {
  const to = now.getTime() - config.lag;
  const until = cursor.until ? Date.parse(cursor.until) : undefined;
  const from = until !== undefined ? until - config.overlap : now.getTime() - config.backfill;
  if (to <= (until ?? from) || to <= from) return undefined;
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

export function batchKey(spans: readonly ReceivedSpan[]): string {
  const ids = spans.map((s) => `${s.traceId}:${s.spanId}`).sort();
  return `datadog:${createHash("sha256").update(ids.join("\n")).digest("hex")}`;
}

export function serviceEnvelopeIdentity(
  sourceId: string,
): Pick<Envelope, "caller" | "owner" | "owner_basis"> {
  const owner = `svc:${sourceId}`;
  return { caller: { kind: "service", principal: owner }, owner, owner_basis: "service" };
}

function mergeClaims(a: Claims | undefined, b: Claims | undefined): Claims | undefined {
  if (!a) return b;
  if (!b) return a;
  const accounts =
    a.account_ids || b.account_ids ? { account_ids: { ...b.account_ids, ...a.account_ids } } : {};
  return { ...b, ...a, ...accounts };
}

const startMs = (span: ReceivedSpan) => Number(BigInt(span.startTimeUnixNano) / 1_000_000n);

interface PageTally {
  spans: number;
  submitted: number;
  repeats: number;
  unsessioned: number;
  invalid: number;
  sessions: number;
  rejected: number;
  failed: number;
  recorded: number;
}

export const UNREADABLE_SPANS = "unreadable_spans";

export function datadogConnector(options: DatadogConnectorOptions = {}): Connector {
  const maxPages = options.maxPagesPerRun ?? 20;
  const maxSeen = options.maxSeen ?? 50_000;

  async function submitPage(
    ctx: ConnectorContext,
    page: SearchPage,
    window: { from: string; to: string; page?: string },
    seen: Map<string, number>,
  ): Promise<PageTally> {
    const tally: PageTally = {
      spans: page.spans.length,
      submitted: 0,
      repeats: 0,
      unsessioned: 0,
      invalid: page.invalid,
      sessions: 0,
      rejected: 0,
      failed: 0,
      recorded: 0,
    };
    let problem = page.problem;
    const groups = new Map<string, ReceivedSpan[]>();
    for (const raw of page.spans) {
      let span: ReceivedSpan;
      try {
        span = toReceivedSpan(raw);
      } catch {
        tally.invalid++;
        problem ??= "a span has no trace id, span id or start time";
        continue;
      }
      if (seen.has(span.spanId)) {
        tally.repeats++;
        continue;
      }
      const key = sessionOf(span);
      if (!key) {
        tally.unsessioned++;
        continue;
      }
      const group = groups.get(key) ?? [];
      if (!group.some((s) => s.spanId === span.spanId && s.traceId === span.traceId)) {
        group.push(span);
      }
      groups.set(key, group);
    }
    const id = ctx.source.id;
    for (const [session_key, spans] of groups) {
      let claims: Claims | undefined;
      for (const span of spans) claims = mergeClaims(claims, datadogClaims(span));
      const project = spans.map((s) => tagValue(tagsOf(s), "project_dir")).find((p) => !!p);
      const envelope: Envelope = {
        schema: ENVELOPE_SCHEMA,
        source: "datadog",
        source_id: id,
        format: DATADOG_LLMOBS,
        session_key,
        payload: { kind: "spans", spans: spans as unknown as Record<string, unknown>[] },
        ...serviceEnvelopeIdentity(id),
        idempotency_key: batchKey(spans),
        provenance: { cursor: `${window.from}/${window.to}` },
        received_at: ctx.now().toISOString(),
        ...(claims ? { claims } : {}),
        ...(project ? { project } : {}),
      };
      const outcome = await ctx.submit(envelope);
      tally.sessions++;
      tally.submitted += spans.length;
      if (outcome.status === "accepted") tally.rejected += outcome.rejected ?? 0;
      if (outcome.status === "failed") tally.failed++;
      for (const span of spans) seen.set(span.spanId, startMs(span));
    }
    if (tally.invalid > 0 && ctx.fail) {
      const where = `${window.from}/${window.to}`;
      await ctx.fail({
        code: UNREADABLE_SPANS,
        message: `${tally.invalid} span(s) of an Export API page could not be read and were skipped (${problem ?? "unknown shape"})`,
        idempotency_key: `datadog:${where}#${window.page ?? "start"}~unreadable`,
        provenance: { cursor: window.page ? `${where}#${window.page}` : where },
      });
      tally.recorded++;
    }
    return tally;
  }

  function prune(seen: Map<string, number>, keep: (ms: number) => boolean): Record<string, number> {
    let entries = [...seen.entries()].filter(([, ms]) => keep(ms));
    if (entries.length > maxSeen) {
      entries.sort((a, b) => b[1] - a[1]);
      entries = entries.slice(0, maxSeen);
    }
    return Object.fromEntries(entries);
  }

  return {
    kind: DATADOG_SOURCE,

    async run(ctx) {
      const config = readDatadogConfig(ctx.source.config);
      let cursor = readDatadogCursor(ctx.checkpoint.read());
      const now = ctx.now();
      const lagOf = (c: DatadogCursor) =>
        c.until ? Math.max(0, now.getTime() - Date.parse(c.until)) : undefined;
      const resumed = cursor.window !== undefined;
      let window: { from: string; to: string; page?: string } | undefined =
        cursor.window ?? nextWindow(cursor, config, now);
      if (!window) {
        const lag = lagOf(cursor);
        return lag !== undefined ? { lag_ms: lag } : {};
      }
      const api = {
        baseUrl: apiBase(config.site, config.api_url),
        apiKey: config.api_key,
        appKey: config.app_key,
        fetch: (input: string, init: RequestInit) => ctx.fetch(input, init),
        signal: ctx.signal,
        sleep: options.sleep ?? abortableSleep,
        ...(options.backoffMs !== undefined ? { backoffMs: options.backoffMs } : {}),
        now: () => ctx.now().getTime(),
      };
      const seen = new Map(Object.entries(cursor.seen ?? {}));
      const total = { pages: 0, spans: 0, submitted: 0, repeats: 0, unsessioned: 0, invalid: 0 };
      const totals = { sessions: 0, rejected: 0, failed: 0, recorded: 0 };
      let restarted = false;

      for (;;) {
        ctx.signal.throwIfAborted();
        let page: SearchPage;
        try {
          page = await searchPage(api, {
            from: new Date(window.from),
            to: new Date(window.to),
            ...(config.ml_app ? { mlApp: config.ml_app } : {}),
            tags: config.tags,
            limit: config.page_size,
            ...(window.page ? { cursor: window.page } : {}),
          });
        } catch (err) {
          // A page cursor from an earlier run that Datadog no longer takes: read the window
          // again from its start (the seen ids and the span store absorb the repeats).
          if (!restarted && window.page && err instanceof DatadogApiError && err.status === 400) {
            ctx.log.warn(
              `Datadog refused the saved page cursor (${err.message}); reading the window ${window.from}/${window.to} again from its start`,
            );
            restarted = true;
            window = { from: window.from, to: window.to };
            continue;
          }
          throw err;
        }
        total.pages++;
        const tally = await submitPage(ctx, page, window, seen);
        total.spans += tally.spans;
        total.submitted += tally.submitted;
        total.repeats += tally.repeats;
        total.unsessioned += tally.unsessioned;
        total.invalid += tally.invalid;
        totals.sessions += tally.sessions;
        totals.rejected += tally.rejected;
        totals.failed += tally.failed;
        totals.recorded += tally.recorded;

        const done = page.next === undefined;
        const until = done ? window.to : cursor.until;
        const next: DatadogCursor = {
          v: 1,
          ...(until ? { until } : {}),
          ...(done ? {} : { window: { from: window.from, to: window.to, page: page.next } }),
        };
        const nextFrom = Date.parse(window.to) - config.overlap;
        const windowFrom = Date.parse(window.from);
        const overlapEnd = windowFrom + config.overlap;
        const kept = prune(
          seen,
          (ms) => ms >= nextFrom || (!done && ms >= windowFrom && ms < overlapEnd),
        );
        if (Object.keys(kept).length > 0) next.seen = kept;
        await ctx.checkpoint.write(next as unknown as Cursor);
        cursor = next;

        if (done || total.pages >= maxPages) {
          const parts = [
            `read ${total.spans} spans in ${total.pages} page(s) of ${window.from}/${window.to}`,
            `submitted ${total.submitted} in ${totals.sessions} session batch(es)`,
          ];
          if (total.repeats) parts.push(`${total.repeats} already submitted`);
          if (total.unsessioned) parts.push(`${total.unsessioned} without a session tag, skipped`);
          if (total.invalid) {
            parts.push(
              `${total.invalid} unreadable, skipped${totals.recorded ? " (see sync failed)" : ""}`,
            );
          }
          if (totals.rejected) parts.push(`${totals.rejected} refused by the format`);
          if (totals.failed) parts.push(`${totals.failed} batch(es) failed (see sync failed)`);
          ctx.log.info(parts.join("; "));
          const lag = lagOf(cursor) ?? now.getTime() - Date.parse(window.from);
          if (done) return { lag_ms: lag, ...(resumed ? { more: true } : {}) };
          return { more: true, lag_ms: lag };
        }
        window = next.window as { from: string; to: string; page?: string };
      }
    },

    /** Read everything since `since` again (X4.9): the next window starts there, minus the
     * overlap. Seen ids are dropped so nothing is left out. A rewind never moves the
     * checkpoint forward: when the source has not read up to `since` yet (its last window
     * ended before it, or a window being read starts before it), the checkpoint stays as it
     * is, so what lies between it and `since` is still read. An unreadable checkpoint is
     * replaced. */
    rewind(cursor, since) {
      let current: DatadogCursor | undefined;
      try {
        current = cursor === null ? undefined : readDatadogCursor(cursor);
      } catch {
        current = undefined;
      }
      const frontier = current?.until ?? current?.window?.from;
      if (current && frontier !== undefined && Date.parse(frontier) <= since.getTime()) {
        return current as unknown as Cursor;
      }
      return { v: 1, until: new Date(since.getTime()).toISOString() } as unknown as Cursor;
    },
  };
}

export const DATADOG_CONNECTOR: Connector = datadogConnector();
