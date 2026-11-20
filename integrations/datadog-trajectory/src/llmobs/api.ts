import { abortableSleep } from "@seshi/kit";
import type {
  DatadogSearchRequest,
  DatadogSearchResponse,
  DatadogSpan,
  DatadogSpanResource,
} from "./api-types";

export const SEARCH_PATH = "/api/v2/llm-obs/v1/spans/events/search";

/** A failure talking to Datadog. `status` is the HTTP status when there was one. */
export class DatadogApiError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "DatadogApiError";
    this.status = status;
  }
}

/** The Export API answered something that is not the shape this poller was tested against
 * (F5.1: fail loudly when the preview API changes). */
export class DatadogShapeError extends Error {
  constructor(message: string) {
    super(`the Datadog Export API answer changed shape: ${message}`);
    this.name = "DatadogShapeError";
  }
}

/** The Export API's base URL for a site: `https://api.<site>` (`datadoghq.com`,
 * `us5.datadoghq.com`, `datadoghq.eu`; an `app.` in front is dropped), or `apiUrl` when set. */
export function apiBase(site: string, apiUrl?: string): string {
  if (apiUrl) return apiUrl.replace(/\/+$/, "");
  const host = site
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^(?:app|api)\./, "");
  return `https://api.${host}`;
}

export function tagFilter(tags: readonly string[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const tag of tags) {
    const at = tag.indexOf(":");
    if (at <= 0 || at === tag.length - 1) {
      throw new Error(`tag '${tag}' is not key:value`);
    }
    const key = tag.slice(0, at);
    if (key in out) throw new Error(`tag key '${key}' is given twice; a span must carry all tags`);
    out[key] = tag.slice(at + 1);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function assertValidTags(tags: readonly string[]): void {
  tagFilter(tags);
}

export interface SearchQuery {
  from: Date;
  to: Date;
  mlApp?: string;
  tags?: readonly string[];
  limit: number;
  cursor?: string;
}

/** The search request for one page of a window, oldest spans first. */
export function searchBody(query: SearchQuery): DatadogSearchRequest {
  const tags = tagFilter(query.tags ?? []);
  return {
    data: {
      type: "spans",
      attributes: {
        filter: {
          from: query.from.toISOString(),
          to: query.to.toISOString(),
          ...(query.mlApp ? { ml_app: query.mlApp } : {}),
          ...(tags ? { tags } : {}),
        },
        page: { limit: query.limit, ...(query.cursor ? { cursor: query.cursor } : {}) },
        sort: "timestamp",
        // Truncated input and output in full (the docs' default, said explicitly).
        options: { include_attachments: true },
      },
    },
  };
}

export interface SearchPage {
  spans: DatadogSpan[];
  /** Items of `data` that did not have a span's shape, skipped. */
  invalid: number;
  /** What was wrong with the first of them, in words that quote no data. */
  problem?: string;
  next?: string;
  /** `meta.status`: `done`, or `timeout` when Datadog cut the query short. */
  status?: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function spanProblem(item: unknown): string | undefined {
  if (!isObject(item)) return "an item of data is not an object";
  const a = item.attributes;
  if (!isObject(a)) return "an item of data has no attributes object";
  if (typeof a.span_id !== "string" && typeof a.span_id !== "number") return "span_id is missing";
  if (typeof a.trace_id !== "string" && typeof a.trace_id !== "number")
    return "trace_id is missing";
  if (typeof a.start_ns !== "number" && typeof a.start_ns !== "string")
    return "start_ns is missing";
  if (a.tags !== undefined && a.tags !== null && !Array.isArray(a.tags))
    return "tags is not a list";
  for (const io of ["input", "output"] as const) {
    if (a[io] !== undefined && a[io] !== null && !isObject(a[io])) return `${io} is not an object`;
  }
  for (const map of ["metadata", "metrics"] as const) {
    if (a[map] !== undefined && a[map] !== null && !isObject(a[map]))
      return `${map} is not an object`;
  }
  if (a.duration !== undefined && a.duration !== null && typeof a.duration !== "number") {
    return "duration is not a number";
  }
  return undefined;
}

/** A search answer, checked against the documented shape. Throws `DatadogShapeError` when the
 * answer as a whole does not fit, or when not one of its spans does; single odd items are
 * counted in `invalid` and skipped. */
export function readSearchResponse(value: unknown): SearchPage {
  if (!isObject(value)) throw new DatadogShapeError("the answer is not a JSON object");
  const { data, meta } = value as Partial<DatadogSearchResponse> & Record<string, unknown>;
  if (!Array.isArray(data)) throw new DatadogShapeError("the answer has no data list");
  if (meta !== undefined && meta !== null && !isObject(meta)) {
    throw new DatadogShapeError("meta is not an object");
  }
  const page = meta?.page;
  if (page !== undefined && page !== null && !isObject(page)) {
    throw new DatadogShapeError("meta.page is not an object");
  }
  const after = page?.after;
  if (after !== undefined && after !== null && typeof after !== "string") {
    throw new DatadogShapeError("meta.page.after is not a string");
  }
  const spans: DatadogSpan[] = [];
  let invalid = 0;
  let first: string | undefined;
  for (const item of data as unknown[]) {
    const problem = spanProblem(item);
    if (problem) {
      invalid++;
      first ??= problem;
      continue;
    }
    const a = (item as DatadogSpanResource).attributes;
    spans.push({
      ...a,
      span_id: String(a.span_id),
      trace_id: String(a.trace_id),
      // A number id (not the documented string) is read like span_id.
      ...(typeof (a.parent_id as unknown) === "number" ? { parent_id: String(a.parent_id) } : {}),
    });
  }
  if (data.length > 0 && spans.length === 0) {
    throw new DatadogShapeError(`no span in the answer could be read (${first})`);
  }
  return {
    spans,
    invalid,
    ...(first ? { problem: first } : {}),
    ...(typeof after === "string" && after !== "" ? { next: after } : {}),
    ...(typeof meta?.status === "string" ? { status: meta.status } : {}),
  };
}

export interface ExportApiOptions {
  baseUrl: string;
  apiKey: string;
  appKey: string;
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  signal: AbortSignal;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Attempts for 5xx answers, timeouts and network failures (default 4). */
  attempts?: number;
  rateLimitAttempts?: number;
  /** The longest single wait a 429 may ask for (default 5 minutes); asking for longer fails
   * the run, so the job's own backoff takes over. */
  maxRateLimitWaitMs?: number;
  backoffMs?: number;
  /** How long one request may take, answer body included, before it counts as a network
   * failure and is retried (default 2 minutes). */
  requestTimeoutMs?: number;
  now?: () => number;
}

export { abortableSleep };

/** How long a 429 asks to wait, in milliseconds: `Retry-After` (seconds or an HTTP date), else
 * Datadog's `X-RateLimit-Reset` (seconds until the window resets). */
export function retryAfterMs(headers: Headers, now: number): number | undefined {
  const retry = headers.get("retry-after")?.trim();
  if (retry) {
    if (/^\d+(?:\.\d+)?$/.test(retry)) return Math.ceil(Number(retry) * 1000);
    const at = Date.parse(retry);
    if (!Number.isNaN(at)) return Math.max(0, at - now);
  }
  const reset = headers.get("x-ratelimit-reset")?.trim();
  if (reset && /^\d+(?:\.\d+)?$/.test(reset)) return Math.ceil(Number(reset) * 1000);
  return undefined;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function errorText(response: Response): Promise<string> {
  let body = "";
  try {
    body = await response.text();
  } catch {
    return "";
  }
  const parsed = tryParseJson(body) as { errors?: unknown } | null | undefined;
  if (Array.isArray(parsed?.errors)) {
    const parts = parsed.errors.map((e) =>
      typeof e === "string" ? e : isObject(e) ? String(e.detail ?? e.title ?? "") : "",
    );
    body = parts.filter((p) => p !== "").join("; ");
  }
  body = body.replace(/\s+/g, " ").trim();
  return body.length > 300 ? `${body.slice(0, 300)}…` : body;
}

export async function searchPage(
  options: ExportApiOptions,
  query: SearchQuery,
): Promise<SearchPage> {
  const sleep = options.sleep ?? abortableSleep;
  const attempts = options.attempts ?? 4;
  const rateAttempts = options.rateLimitAttempts ?? 6;
  const maxWait = options.maxRateLimitWaitMs ?? 300_000;
  const base = options.backoffMs ?? 1000;
  const now = options.now ?? Date.now;
  const requestTimeout = options.requestTimeoutMs ?? 120_000;
  const body = JSON.stringify(searchBody(query));
  const url = `${options.baseUrl}${SEARCH_PATH}`;
  let failures = 0;
  let limited = 0;
  const backoff = () => base * 2 ** (failures - 1);

  for (;;) {
    options.signal.throwIfAborted();
    const timeout = AbortSignal.timeout(requestTimeout);
    const signal = AbortSignal.any([options.signal, timeout]);
    const failed = async (err: unknown): Promise<void> => {
      if (options.signal.aborted) throw options.signal.reason ?? err;
      failures++;
      const reason = timeout.aborted
        ? `no answer within ${Math.ceil(requestTimeout / 1000)}s`
        : err instanceof Error
          ? err.message
          : String(err);
      if (failures >= attempts) throw new DatadogApiError(`could not reach Datadog: ${reason}`);
      await sleep(backoff(), options.signal);
    };
    let response: Response;
    try {
      response = await options.fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "dd-api-key": options.apiKey,
          "dd-application-key": options.appKey,
        },
        body,
        // Never follow: the keys would go along to the redirect's host.
        redirect: "manual",
        signal,
      });
    } catch (err) {
      await failed(err);
      continue;
    }

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      throw new DatadogApiError(
        `Datadog answered ${response.status} (a redirect, not followed so the keys stay with ${new URL(url).host}); check site or api_url`,
        response.status,
      );
    }

    if (response.status === 429) {
      limited++;
      const wait = retryAfterMs(response.headers, now()) ?? base * 2 ** (limited - 1);
      await response.body?.cancel().catch(() => {});
      if (wait > maxWait) {
        throw new DatadogApiError(
          `Datadog rate-limited the search for ${Math.ceil(wait / 1000)}s; the next run tries again`,
          429,
        );
      }
      if (limited >= rateAttempts) {
        throw new DatadogApiError(`Datadog rate-limited the search ${limited} times in a row`, 429);
      }
      await sleep(wait, options.signal);
      continue;
    }

    if (response.status >= 500) {
      failures++;
      const said = await errorText(response);
      if (failures >= attempts) {
        throw new DatadogApiError(
          `Datadog answered ${response.status}${said ? `: ${said}` : ""}`,
          response.status,
        );
      }
      await sleep(backoff(), options.signal);
      continue;
    }

    if (!response.ok) {
      const said = await errorText(response);
      const hint =
        response.status === 401 || response.status === 403
          ? " (check api_key and app_key; the application key needs LLM Observability read access)"
          : "";
      throw new DatadogApiError(
        `Datadog answered ${response.status}${said ? `: ${said}` : ""}${hint}`,
        response.status,
      );
    }

    let text: string;
    try {
      text = await response.text();
    } catch (err) {
      await failed(err);
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new DatadogShapeError("the answer is not JSON");
    }
    const page = readSearchResponse(json);
    if (page.status === "timeout") {
      failures++;
      if (failures >= attempts) {
        throw new DatadogApiError("Datadog cut the search short (timeout) every time");
      }
      await sleep(backoff(), options.signal);
      continue;
    }
    return page;
  }
}
