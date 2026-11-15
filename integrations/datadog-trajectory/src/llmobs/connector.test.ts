/** The poller against a local HTTP server that answers like the Export API, with hand-built
 * pages from `testdata/llmobs/` (see its README): no request leaves the machine. The context is
 * a fake: what it submits and the checkpoints it writes are recorded. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConnectorContext, Cursor, SubmitOutcome } from "@seshi/kit";
import type { Envelope, ReceivedSpan } from "@seshi/model";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  batchKey,
  DATADOG_CONNECTOR,
  type DatadogConnectorOptions,
  datadogConnector,
  nextWindow,
  readDatadogConfig,
  readDatadogCursor,
  serviceEnvelopeIdentity,
} from "./connector";

const FIXTURES = join(import.meta.dirname, "..", "..", "testdata", "llmobs");
const page = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
const SESSION = "8f14e45f-ceea-4e7a-9d1b-2b6a1f0c3d11";
const NOW = new Date("2026-11-14T12:00:00Z");
const HOUR = 3_600_000;

interface Seen {
  body: {
    data: {
      attributes: {
        filter: { from: string; to: string; ml_app?: string; tags?: Record<string, string> };
        page: { limit: number; cursor?: string };
      };
    };
  };
  headers: Headers;
}

let server: ReturnType<typeof Bun.serve>;
let requests: Seen[];
/** Answers by page cursor: `undefined` is the first page. */
let pages: Map<string | undefined, () => Response>;

beforeEach(() => {
  requests = [];
  pages = new Map();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Seen["body"];
      requests.push({ body, headers: request.headers });
      const answer = pages.get(body.data.attributes.page.cursor);
      return answer ? answer() : Response.json({ errors: ["unknown cursor"] }, { status: 400 });
    },
  });
});
afterEach(() => {
  server.stop(true);
});

const serve = (cursor: string | undefined, name: string) =>
  pages.set(cursor, () => Response.json(page(name)));
const TWO_PAGES = () => {
  serve(undefined, "trajectory-session.page1.json");
  serve("eyJhZnRlciI6InBhZ2UtMiJ9", "trajectory-session.page2.json");
};

interface Fake {
  ctx: ConnectorContext;
  submitted: Envelope[];
  written: Cursor[];
  logs: string[];
}

function fake(
  options: {
    cursor?: Cursor | null;
    config?: Record<string, unknown>;
    now?: Date;
    submit?: (envelope: Envelope) => Promise<SubmitOutcome>;
  } = {},
): Fake {
  const submitted: Envelope[] = [];
  const written: Cursor[] = [];
  const logs: string[] = [];
  const ctx: ConnectorContext = {
    source: {
      id: "dd-prod",
      type: "datadog",
      config: {
        type: "datadog",
        id: "dd-prod",
        site: "datadoghq.com",
        api_url: `http://127.0.0.1:${server.port}`,
        api_key: { reveal: () => "the-api-key" },
        app_key: { reveal: () => "the-app-key" },
        ml_app: "coding-agents",
        tags: ["env:prod"],
        interval: 300_000,
        overlap: 600_000,
        lag: 120_000,
        backfill: 7 * 24 * HOUR,
        page_size: 100,
        quiet_period: 600_000,
        ...options.config,
      },
    },
    async submit(envelope) {
      submitted.push(envelope);
      if (options.submit) return options.submit(envelope);
      const spans = (envelope.payload as { spans: unknown[] }).spans.length;
      return { status: "accepted", archive_id: "a".repeat(64), spans };
    },
    checkpoint: {
      read: () => (options.cursor === undefined ? null : options.cursor),
      async write(cursor) {
        written.push(structuredClone(cursor));
      },
    },
    fetch: (input, init) => fetch(input, init),
    log: {
      info: (line) => logs.push(`info ${line}`),
      warn: (line) => logs.push(`warn ${line}`),
      error: (line) => logs.push(`error ${line}`),
    },
    signal: new AbortController().signal,
    now: () => options.now ?? NOW,
  };
  return { ctx, submitted, written, logs };
}

const noWait: DatadogConnectorOptions = { sleep: async () => {}, backoffMs: 1 };
const spansIn = (e: Envelope) => (e.payload as unknown as { spans: ReceivedSpan[] }).spans;

describe("a first run", () => {
  it("backfills, grouping each page's spans by session, as the source's service account", async () => {
    TWO_PAGES();
    const { ctx, submitted, written, logs } = fake();
    const result = await datadogConnector(noWait).run(ctx);

    // The window: now minus backfill to now minus lag, oldest first.
    expect(requests).toHaveLength(2);
    expect(requests[0]?.body.data.attributes).toMatchObject({
      filter: {
        from: "2026-11-07T12:00:00.000Z",
        to: "2026-11-14T11:58:00.000Z",
        ml_app: "coding-agents",
        tags: { env: "prod" },
      },
      page: { limit: 100 },
      sort: "timestamp",
    });
    expect(requests[1]?.body.data.attributes.page.cursor).toBe("eyJhZnRlciI6InBhZ2UtMiJ9");
    expect(requests[0]?.headers.get("dd-api-key")).toBe("the-api-key");
    expect(requests[0]?.headers.get("dd-application-key")).toBe("the-app-key");

    // One batch per page for the session; the oversight trace and the span of no session are
    // left out, and page 2's repeat of a page 1 span too.
    expect(submitted.map((e) => [e.session_key, spansIn(e).length])).toEqual([
      [SESSION, 9],
      [SESSION, 6],
    ]);
    const [first] = submitted;
    expect(first).toMatchObject({
      schema: "seshi/envelope/1",
      source: "datadog",
      source_id: "dd-prod",
      format: "datadog-llmobs",
      caller: { kind: "service", principal: "svc:dd-prod" },
      owner: "svc:dd-prod",
      owner_basis: "service",
      provenance: { cursor: "2026-11-07T12:00:00.000Z/2026-11-14T11:58:00.000Z" },
      received_at: NOW.toISOString(),
      project: "payments-api",
      claims: {
        email: "jdoe@example.com",
        git_email: "jdoe@users.noreply.example.com",
        username: "jdoe",
        account_ids: { github: "jdoe-dev" },
      },
    });
    expect(first?.idempotency_key).toBe(batchKey(spansIn(first as Envelope)));
    expect(spansIn(first as Envelope)[0]).toMatchObject({
      traceId: "6916fdc000000000a1b2c3d4e5f60718",
      spanId: expect.stringMatching(/^[0-9a-f]{16}$/),
    });

    // A checkpoint after each page: the first mid-window, the second at its end.
    expect(written).toHaveLength(2);
    expect(written[0]).toMatchObject({
      v: 1,
      window: {
        from: "2026-11-07T12:00:00.000Z",
        to: "2026-11-14T11:58:00.000Z",
        page: "eyJhZnRlciI6InBhZ2UtMiJ9",
      },
    });
    expect(written[0]?.until).toBeUndefined();
    // A backfill keeps no ids it will not read again: these are far from either overlap.
    expect(written[0]?.seen).toBeUndefined();
    expect(written[1]).toMatchObject({ v: 1, until: "2026-11-14T11:58:00.000Z" });
    expect(written[1]?.window).toBeUndefined();
    // Spans before the next window's overlap are forgotten: these fixtures are older.
    expect(written[1]?.seen).toBeUndefined();
    expect(result).toEqual({ lag_ms: 2 * 60_000 });
    expect(logs.at(-1)).toMatch(
      /read 18 spans in 2 page\(s\).*submitted 15 in 2 session batch\(es\); 1 already submitted; 2 without a session tag/,
    );
  });

  it("remembers the spans it submitted inside the next window's overlap", async () => {
    TWO_PAGES();
    // The fixtures' spans start between 10:00 and 10:02:31; with the window ending at 10:05 and
    // a 10 minute overlap, all of them are inside the next window.
    const { ctx, written } = fake({ now: new Date("2026-11-14T10:07:00Z") });
    await datadogConnector(noWait).run(ctx);
    const seen = written.at(-1)?.seen as Record<string, number>;
    expect(Object.keys(seen)).toHaveLength(15);
    expect(Math.min(...Object.values(seen))).toBe(Date.parse("2026-11-14T10:00:00Z"));
  });
});

describe("a later run", () => {
  it("reads from the checkpoint minus the overlap and leaves out what it already submitted", async () => {
    TWO_PAGES();
    const first = fake({ now: new Date("2026-11-14T10:07:00Z") });
    await datadogConnector(noWait).run(first.ctx);
    const saved = first.written.at(-1) as Cursor;

    // Datadog answers the same spans again (they are inside the overlap), plus nothing new.
    requests = [];
    const second = fake({ cursor: saved, now: new Date("2026-11-14T10:20:00Z") });
    const result = await datadogConnector(noWait).run(second.ctx);
    expect(requests[0]?.body.data.attributes.filter).toMatchObject({
      from: "2026-11-14T09:55:00.000Z",
      to: "2026-11-14T10:18:00.000Z",
    });
    expect(second.submitted).toEqual([]);
    expect(second.written.at(-1)).toMatchObject({ until: "2026-11-14T10:18:00.000Z" });
    expect(second.logs.at(-1)).toMatch(/16 already submitted/);
    expect(result).toEqual({ lag_ms: 120_000 });
  });

  it("asks nothing when no new window is due", async () => {
    const { ctx, written } = fake({
      cursor: { v: 1, until: "2026-11-14T11:58:00.000Z" },
      now: new Date("2026-11-14T12:00:00Z"),
    });
    expect(await datadogConnector(noWait).run(ctx)).toEqual({ lag_ms: 120_000 });
    expect(requests).toHaveLength(0);
    expect(written).toHaveLength(0);
  });
});

describe("a window too large for one run", () => {
  it("hands over with `more` and the next run carries on from the saved page", async () => {
    TWO_PAGES();
    const connector = datadogConnector({ ...noWait, maxPagesPerRun: 1 });
    const first = fake();
    expect(await connector.run(first.ctx)).toMatchObject({ more: true });
    expect(first.written).toHaveLength(1);

    const second = fake({ cursor: first.written[0] as Cursor });
    const result = await connector.run(second.ctx);
    expect(requests.map((r) => r.body.data.attributes.page.cursor)).toEqual([
      undefined,
      "eyJhZnRlciI6InBhZ2UtMiJ9",
    ]);
    // The window started a run ago: the next one is due at once.
    expect(result).toMatchObject({ more: true });
    expect(second.written.at(-1)).toMatchObject({ until: "2026-11-14T11:58:00.000Z" });
    // The window's filter stays as it was saved.
    expect(requests[1]?.body.data.attributes.filter.to).toBe("2026-11-14T11:58:00.000Z");
  });

  it("reads the window again from its start when Datadog refuses a stale cursor", async () => {
    serve(undefined, "generic-app.json");
    const { ctx, submitted, written, logs } = fake({
      cursor: {
        v: 1,
        until: "2026-11-14T09:00:00.000Z",
        window: { from: "2026-11-14T08:50:00.000Z", to: "2026-11-14T11:00:00.000Z", page: "stale" },
      },
    });
    await datadogConnector(noWait).run(ctx);
    expect(requests.map((r) => r.body.data.attributes.page.cursor)).toEqual(["stale", undefined]);
    expect(logs.some((l) => l.startsWith("warn") && l.includes("from its start"))).toBe(true);
    expect(submitted.map((e) => e.session_key)).toEqual(["chat-42"]);
    expect(written.at(-1)).toMatchObject({ until: "2026-11-14T11:00:00.000Z" });
  });

  it("does not loop on a cursor refused twice", async () => {
    pages.set(undefined, () => Response.json({ errors: ["bad"] }, { status: 400 }));
    const { ctx } = fake({
      cursor: {
        v: 1,
        window: { from: "2026-11-14T08:50:00.000Z", to: "2026-11-14T11:00:00.000Z", page: "stale" },
      },
    });
    await expect(datadogConnector(noWait).run(ctx)).rejects.toThrow(/400/);
    expect(requests).toHaveLength(2);
  });
});

describe("failures", () => {
  it("leaves the checkpoint where it was when a submit fails", async () => {
    TWO_PAGES();
    const { ctx, written } = fake({
      submit: async () => {
        throw new Error("store down");
      },
    });
    await expect(datadogConnector(noWait).run(ctx)).rejects.toThrow("store down");
    expect(written).toEqual([]);
  });

  it("goes on past a batch the pipeline recorded as failed, and says so", async () => {
    TWO_PAGES();
    const { ctx, written, logs } = fake({
      submit: async () => ({ status: "failed", code: "x", message: "m", record: "r" }),
    });
    await datadogConnector(noWait).run(ctx);
    expect(written).toHaveLength(2);
    expect(logs.at(-1)).toMatch(/2 batch\(es\) failed/);
  });

  it("fails the run when Datadog refuses the keys", async () => {
    pages.set(undefined, () => Response.json({ errors: ["Forbidden"] }, { status: 403 }));
    const { ctx, written } = fake();
    await expect(datadogConnector(noWait).run(ctx)).rejects.toThrow(/403: Forbidden/);
    expect(written).toEqual([]);
  });

  it("fails loudly when the answer changed shape", async () => {
    pages.set(undefined, () => Response.json({ spans: [] }));
    const { ctx } = fake();
    await expect(datadogConnector(noWait).run(ctx)).rejects.toThrow(/changed shape/);
  });

  it("refuses a config without keys and a checkpoint it did not write", async () => {
    await expect(
      datadogConnector(noWait).run(fake({ config: { api_key: undefined } }).ctx),
    ).rejects.toThrow(/api_key/);
    await expect(datadogConnector(noWait).run(fake({ cursor: { next: 3 } }).ctx)).rejects.toThrow(
      /reprocess/,
    );
  });
});

describe("the connector", () => {
  it("polls datadog sources, and rewinds to a time", () => {
    expect(DATADOG_CONNECTOR.kind).toBe("datadog");
    expect(DATADOG_CONNECTOR.rewind?.(null, new Date("2026-11-01T00:00:00Z"), {})).toEqual({
      v: 1,
      until: "2026-11-01T00:00:00.000Z",
    });
  });

  it("keeps the previous window's ids while reading the overlap they may reappear in", async () => {
    TWO_PAGES();
    const from = Date.parse("2026-11-14T09:00:00Z");
    const { ctx, written } = fake({
      cursor: {
        v: 1,
        until: "2026-11-14T09:10:00.000Z",
        seen: { aaaaaaaaaaaaaaaa: from + 60_000, bbbbbbbbbbbbbbbb: from - 60_000 },
      },
    });
    await datadogConnector({ ...noWait, maxPagesPerRun: 1 }).run(ctx);
    // Mid-window: the id inside [from, from + overlap) stays; the older one goes.
    expect(written[0]?.seen).toEqual({ aaaaaaaaaaaaaaaa: from + 60_000 });
  });

  it("forgets the oldest ids past its limit", async () => {
    TWO_PAGES();
    const { ctx, written } = fake({ now: new Date("2026-11-14T10:07:00Z") });
    await datadogConnector({ ...noWait, maxSeen: 3 }).run(ctx);
    const seen = written.at(-1)?.seen as Record<string, number>;
    expect(Object.keys(seen)).toHaveLength(3);
    // The newest are kept.
    expect(Math.min(...Object.values(seen))).toBeGreaterThanOrEqual(
      Date.parse("2026-11-14T10:02:12Z"),
    );
  });
});

describe("nextWindow", () => {
  const config = { overlap: 10 * 60_000, lag: 2 * 60_000, backfill: 24 * HOUR };
  it("backfills on the first run, then overlaps the checkpoint", () => {
    expect(nextWindow({ v: 1 }, config, NOW)).toEqual({
      from: "2026-11-13T12:00:00.000Z",
      to: "2026-11-14T11:58:00.000Z",
    });
    expect(nextWindow({ v: 1, until: "2026-11-14T11:00:00.000Z" }, config, NOW)).toEqual({
      from: "2026-11-14T10:50:00.000Z",
      to: "2026-11-14T11:58:00.000Z",
    });
    expect(nextWindow({ v: 1, until: "2026-11-14T11:58:00.000Z" }, config, NOW)).toBeUndefined();
    expect(nextWindow({ v: 1 }, { ...config, backfill: 0 }, NOW)).toBeUndefined();
  });
});

describe("readDatadogConfig", () => {
  it("reveals the keys and takes the defaults", () => {
    expect(
      readDatadogConfig({ api_key: "k", app_key: { reveal: () => "a" }, tags: ["x:y", 3] }),
    ).toEqual({
      site: "datadoghq.com",
      api_key: "k",
      app_key: "a",
      tags: ["x:y"],
      overlap: 600_000,
      lag: 120_000,
      backfill: 7 * 86_400_000,
      page_size: 500,
    });
    expect(() => readDatadogConfig({ api_key: "k" })).toThrow(/app_key/);
    expect(() => readDatadogConfig({ api_key: "k", app_key: "a", page_size: 0 })).toThrow(
      /page_size/,
    );
    expect(() => readDatadogConfig({ api_key: "k", app_key: "a", lag: "2m" })).toThrow(/lag/);
  });
});

describe("readDatadogCursor", () => {
  it("reads what the connector wrote, and refuses anything else", () => {
    expect(readDatadogCursor(null)).toEqual({ v: 1 });
    const full = {
      v: 1,
      until: "2026-11-14T11:00:00.000Z",
      window: { from: "2026-11-14T10:00:00.000Z", to: "2026-11-14T11:00:00.000Z", page: "p" },
      seen: { abc: 1, bad: "x" },
    };
    expect(readDatadogCursor(full)).toEqual({ ...full, seen: { abc: 1 } });
    for (const bad of [
      { v: 2 },
      { v: 1, until: "yesterday" },
      { v: 1, window: { from: "x", to: "2026-11-14T11:00:00.000Z" } },
      { v: 1, window: { from: full.window.from, to: full.window.to, page: 3 } },
      { v: 1, seen: [] },
    ]) {
      expect(() => readDatadogCursor(bad as Cursor)).toThrow(/rewind/);
    }
  });
});

describe("serviceEnvelopeIdentity", () => {
  it("writes as svc:<source id>", () => {
    expect(serviceEnvelopeIdentity("dd-prod")).toEqual({
      caller: { kind: "service", principal: "svc:dd-prod" },
      owner: "svc:dd-prod",
      owner_basis: "service",
    });
  });
});
