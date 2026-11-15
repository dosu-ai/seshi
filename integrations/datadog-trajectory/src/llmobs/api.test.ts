/** The Export API client against a local HTTP server standing in for Datadog: no request
 * leaves the machine. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  apiBase,
  DatadogApiError,
  DatadogShapeError,
  type ExportApiOptions,
  readSearchResponse,
  retryAfterMs,
  SEARCH_PATH,
  searchBody,
  searchPage,
  tagFilter,
} from "./api";

const span = (id: string) => ({
  id,
  type: "span",
  attributes: { span_id: id, trace_id: "ab".repeat(16), start_ns: 1_794_650_400_000_000_000 },
});

describe("apiBase", () => {
  it("is api.<site>, with an app. or scheme in front dropped", () => {
    expect(apiBase("datadoghq.com")).toBe("https://api.datadoghq.com");
    expect(apiBase("us5.datadoghq.com")).toBe("https://api.us5.datadoghq.com");
    expect(apiBase("app.datadoghq.eu")).toBe("https://api.datadoghq.eu");
    expect(apiBase("https://app.datadoghq.com/")).toBe("https://api.datadoghq.com");
  });

  it("is api_url when set", () => {
    expect(apiBase("datadoghq.com", "http://127.0.0.1:9/dd/")).toBe("http://127.0.0.1:9/dd");
  });
});

describe("the search request", () => {
  it("filters by window, ml_app and tags, oldest first, with attachments", () => {
    expect(
      searchBody({
        from: new Date("2026-11-14T10:00:00Z"),
        to: new Date("2026-11-14T11:00:00Z"),
        mlApp: "coding-agents",
        tags: ["env:prod", "team:a:b"],
        limit: 50,
        cursor: "c1",
      }),
    ).toEqual({
      data: {
        type: "spans",
        attributes: {
          filter: {
            from: "2026-11-14T10:00:00.000Z",
            to: "2026-11-14T11:00:00.000Z",
            ml_app: "coding-agents",
            tags: { env: "prod", team: "a:b" },
          },
          page: { limit: 50, cursor: "c1" },
          sort: "timestamp",
          options: { include_attachments: true },
        },
      },
    });
    const bare = searchBody({ from: new Date(0), to: new Date(1), limit: 1 }).data.attributes;
    expect(bare.filter).toEqual({ from: new Date(0).toISOString(), to: new Date(1).toISOString() });
    expect(bare.page).toEqual({ limit: 1 });
  });

  it("refuses a tag that is not key:value", () => {
    expect(() => tagFilter(["prod"])).toThrow(/key:value/);
    expect(() => tagFilter([":x"])).toThrow(/key:value/);
    expect(tagFilter([])).toBeUndefined();
  });
});

describe("readSearchResponse", () => {
  it("reads spans and the next page's cursor", () => {
    expect(
      readSearchResponse({
        data: [span("1"), { ...span("2"), attributes: { ...span("2").attributes, span_id: 2 } }],
        meta: { status: "done", page: { after: "next-1" } },
      }),
    ).toMatchObject({
      spans: [{ span_id: "1" }, { span_id: "2" }],
      invalid: 0,
      next: "next-1",
      status: "done",
    });
    expect(readSearchResponse({ data: [], meta: { page: null } })).toEqual({
      spans: [],
      invalid: 0,
    });
    expect(readSearchResponse({ data: [], meta: { page: { after: "" } } }).next).toBeUndefined();
  });

  it("skips an odd item, and fails loudly when the shape has changed", () => {
    expect(readSearchResponse({ data: [span("1"), { attributes: {} }] }).invalid).toBe(1);
    const changed: [unknown, RegExp][] = [
      [[], /not a JSON object/],
      [{ spans: [] }, /no data list/],
      [{ data: [], meta: "x" }, /meta is not/],
      [{ data: [], meta: { page: 3 } }, /meta.page is not/],
      [{ data: [], meta: { page: { after: 3 } } }, /after is not/],
      [{ data: [{ attributes: { span_id: "1", trace_id: "t" } }] }, /start_ns/],
      [{ data: [{ id: "1" }] }, /attributes/],
      [{ data: ["x"] }, /not an object/],
      [{ data: [{ attributes: { ...span("1").attributes, tags: "a:b" } }] }, /tags/],
      [{ data: [{ attributes: { ...span("1").attributes, input: "hi" } }] }, /input/],
      [{ data: [{ attributes: { ...span("1").attributes, metrics: [] } }] }, /metrics/],
      [{ data: [{ attributes: { ...span("1").attributes, duration: "1" } }] }, /duration/],
    ];
    for (const [value, message] of changed) {
      expect(() => readSearchResponse(value)).toThrow(DatadogShapeError);
      expect(() => readSearchResponse(value)).toThrow(message);
    }
  });
});

describe("retryAfterMs", () => {
  it("reads Retry-After in seconds or as a date, else X-RateLimit-Reset", () => {
    expect(retryAfterMs(new Headers({ "retry-after": "3" }), 0)).toBe(3000);
    expect(retryAfterMs(new Headers({ "retry-after": "0.5" }), 0)).toBe(500);
    const now = Date.parse("2026-11-14T10:00:00Z");
    expect(retryAfterMs(new Headers({ "retry-after": "Sat, 14 Nov 2026 10:00:07 GMT" }), now)).toBe(
      7000,
    );
    expect(retryAfterMs(new Headers({ "x-ratelimit-reset": "12" }), 0)).toBe(12_000);
    expect(retryAfterMs(new Headers({}), 0)).toBeUndefined();
  });
});

describe("searchPage", () => {
  type Reply = (request: Request) => Response | Promise<Response>;
  let replies: Reply[];
  let requests: { headers: Headers; body: unknown; path: string }[];
  let server: ReturnType<typeof Bun.serve>;
  let waits: number[];

  beforeEach(() => {
    replies = [];
    requests = [];
    waits = [];
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests.push({
          headers: request.headers,
          body: await request.json().catch(() => null),
          path: new URL(request.url).pathname,
        });
        const reply = replies.shift();
        return reply ? reply(request) : new Response("no reply left", { status: 599 });
      },
    });
  });
  afterEach(() => {
    server.stop(true);
  });

  const options = (extra: Partial<ExportApiOptions> = {}): ExportApiOptions => ({
    baseUrl: `http://127.0.0.1:${server.port}`,
    apiKey: "dd-api-key-secret",
    appKey: "dd-app-key-secret",
    fetch: (input, init) => fetch(input, init),
    signal: new AbortController().signal,
    sleep: async (ms) => {
      waits.push(ms);
    },
    ...extra,
  });
  const query = { from: new Date(0), to: new Date(60_000), limit: 10 };
  const json =
    (value: unknown, init: ResponseInit = {}) =>
    () =>
      Response.json(value, init);
  const ok = json({ data: [span("1")], meta: { status: "done", page: { after: "c2" } } });

  it("posts the search with both keys", async () => {
    replies.push(ok);
    const page = await searchPage(options(), { ...query, mlApp: "a", cursor: "c1" });
    expect(page).toMatchObject({ spans: [{ span_id: "1" }], next: "c2" });
    const [request] = requests;
    expect(request?.path).toBe(SEARCH_PATH);
    expect(request?.headers.get("dd-api-key")).toBe("dd-api-key-secret");
    expect(request?.headers.get("dd-application-key")).toBe("dd-app-key-secret");
    expect(request?.headers.get("content-type")).toBe("application/json");
    expect(request?.body).toMatchObject({
      data: { type: "spans", attributes: { filter: { ml_app: "a" }, page: { cursor: "c1" } } },
    });
  });

  it("waits as long as a 429 asks, then tries again", async () => {
    replies.push(
      () => new Response("slow down", { status: 429, headers: { "retry-after": "2" } }),
      () => new Response("", { status: 429, headers: { "x-ratelimit-reset": "5" } }),
      ok,
    );
    expect((await searchPage(options(), query)).spans).toHaveLength(1);
    expect(waits).toEqual([2000, 5000]);
  });

  it("gives up on a 429 that asks for too long, or comes too often", async () => {
    replies.push(() => new Response("", { status: 429, headers: { "retry-after": "3600" } }));
    await expect(searchPage(options(), query)).rejects.toMatchObject({
      name: "DatadogApiError",
      status: 429,
      message: expect.stringContaining("3600s"),
    });
    expect(waits).toEqual([]);
    for (let i = 0; i < 3; i++) replies.push(() => new Response("", { status: 429 }));
    await expect(searchPage(options({ rateLimitAttempts: 3 }), query)).rejects.toThrow(
      /3 times in a row/,
    );
    // No Retry-After: exponential backoff.
    expect(waits).toEqual([1000, 2000]);
  });

  it("retries 5xx answers and a query Datadog cut short", async () => {
    replies.push(
      () => new Response('{"errors":["Internal error"]}', { status: 502 }),
      json({ data: [], meta: { status: "timeout" } }),
      ok,
    );
    expect((await searchPage(options({ backoffMs: 10 }), query)).spans).toHaveLength(1);
    expect(waits).toEqual([10, 20]);
  });

  it("fails after its attempts, naming what Datadog said", async () => {
    for (let i = 0; i < 2; i++) {
      replies.push(() => new Response('{"errors":["Service unavailable"]}', { status: 503 }));
    }
    await expect(searchPage(options({ attempts: 2 }), query)).rejects.toMatchObject({
      status: 503,
      message: "Datadog answered 503: Service unavailable",
    });
    replies.push(json({ data: [], meta: { status: "timeout" } }));
    await expect(searchPage(options({ attempts: 1 }), query)).rejects.toThrow(/timeout/);
  });

  it("does not retry a refusal, and never echoes a key", async () => {
    replies.push(() => new Response('{"errors":["Forbidden"]}', { status: 403 }));
    const err = await searchPage(options(), query).catch((e) => e);
    expect(err).toBeInstanceOf(DatadogApiError);
    expect(err.status).toBe(403);
    expect(err.message).toContain("Forbidden");
    expect(err.message).toContain("app_key");
    expect(err.message).not.toContain("dd-api-key-secret");
    expect(err.message).not.toContain("dd-app-key-secret");
    expect(requests).toHaveLength(1);
    replies.push(() => new Response("x".repeat(1000), { status: 400 }));
    const bad = await searchPage(options(), query).catch((e) => e);
    expect(bad.status).toBe(400);
    expect(bad.message.length).toBeLessThan(400);
  });

  it("fails loudly on an answer that is not the documented shape", async () => {
    replies.push(() => new Response("<html>", { status: 200 }));
    await expect(searchPage(options(), query)).rejects.toThrow(/not JSON/);
    replies.push(json({ results: [] }));
    await expect(searchPage(options(), query)).rejects.toThrow(DatadogShapeError);
  });

  it("retries when Datadog cannot be reached, then says so", async () => {
    const unreachable = options({
      baseUrl: "http://127.0.0.1:1",
      attempts: 3,
    });
    await expect(searchPage(unreachable, query)).rejects.toThrow(/could not reach Datadog/);
    expect(waits).toEqual([1000, 2000]);
  });

  it("stops when the run is aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("shutting down"));
    await expect(searchPage(options({ signal: controller.signal }), query)).rejects.toThrow(
      "shutting down",
    );
    expect(requests).toHaveLength(0);
  });
});
