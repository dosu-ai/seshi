/** OTLP ingest end to end (F4): a Claude Console destination's spans, as protobuf or JSON,
 * through `POST /otlp/v1/traces` into the span store, then the worker's assembler into a
 * session of the destination's service account, read back through the API. The fixtures are
 * hand-built from Anthropic's published span reference
 * (`integrations/claude-platform/testdata/otlp/README.md`). */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createApp, encodeExportRequest, METADATA_ONLY_MESSAGE } from "@seshi/api";
import type { Instance } from "@seshi/instance";
import type { Trace } from "@seshi/model";
import { archiveId, keys, listSpans, readHealth, readMetadata, readPending } from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootInstance } from "../tooling/instance";
import { ROOT } from "../tooling/testdata";

const FIXTURES = join(ROOT, "integrations", "claude-platform", "testdata", "otlp");
// biome-ignore lint/suspicious/noExplicitAny: fixtures are OTLP JSON, walked by path
const fixture = (name: string): any =>
  JSON.parse(readFileSync(join(FIXTURES, `${name}.otlp.json`), "utf8"));

const SESSION = "sesn_01JZexample";
const OWNER = "svc:console";
const ARCHIVE = archiveId(OWNER, "otlp-genai", SESSION);
const MESSAGES_TRACE = "8f3d6b5a4c7e4f1a9b2c3d4e5f6a7b8c";
const GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwx0123456789";
const UPLOADER = "acme-token-0123456789abcdef";

let booted: Awaited<ReturnType<typeof bootInstance>>;
let instance: Instance;
let app: ReturnType<typeof createApp>;
let clock: Date;
let admin: string;
let destination: string;

beforeEach(async () => {
  clock = new Date("2026-11-01T10:03:00Z");
  booted = await bootInstance(
    [
      `[auth.tokens]\nacme = "${UPLOADER}"`,
      // The fixtures are short conversations: the session filter (X4.10) would drop them.
      '[[sources]]\nid = "console"\ntype = "otlp"\nquiet_period = "10m"\nfilter = { min_chars = 50 }',
      '[[sources]]\nid = "private-console"\ntype = "otlp"\nvisibility = "owner"\nfilter = { min_chars = 50 }',
      '[[sources]]\nid = "strict-console"\ntype = "otlp"',
    ].join("\n"),
    { now: () => clock, roles: ["api", "worker"] },
  );
  instance = booted.instance;
  app = createApp(instance);
  const init = await instance.auth.initAdmin({ owner: "ops" });
  admin = init.admin?.token as string;
  destination = await serviceToken("console");
});
afterEach(() => booted.cleanup());

async function serviceToken(service: string): Promise<string> {
  const response = await app.fetch(
    new Request("http://seshi.test/v1/tokens", {
      method: "POST",
      headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
      body: JSON.stringify({ kind: "service", service, scopes: ["sessions:write"] }),
    }),
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { token: string }).token;
}

/** POST a request to the receiver, as protobuf (gzipped, like the Console) or JSON. */
async function send(
  request: unknown,
  options: { encoding?: "protobuf" | "json"; token?: string; gzip?: boolean } = {},
): Promise<Response> {
  const encoding = options.encoding ?? "protobuf";
  let body: Uint8Array =
    encoding === "protobuf"
      ? encodeExportRequest(request as { resourceSpans: Record<string, unknown>[] })
      : new TextEncoder().encode(JSON.stringify(request));
  const headers: Record<string, string> = {
    authorization: `Bearer ${options.token ?? destination}`,
    "content-type": encoding === "protobuf" ? "application/x-protobuf" : "application/json",
  };
  if (options.gzip ?? encoding === "protobuf") {
    body = gzipSync(body);
    headers["content-encoding"] = "gzip";
  }
  return app.fetch(
    new Request("http://seshi.test/otlp/v1/traces", {
      method: "POST",
      headers,
      body: body as Uint8Array<ArrayBuffer>,
    }),
  );
}

async function assemble() {
  const record = await instance.jobs.runNow("assembler");
  expect(record.last_error).toBeUndefined();
  return record.last_summary ?? {};
}

const later = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

async function trace(owner = OWNER, sessionId = SESSION): Promise<Trace> {
  const response = await app.fetch(
    new Request(
      `http://seshi.test/v1/sessions/otlp-genai/${sessionId}/trace?owner=${encodeURIComponent(owner)}`,
      { headers: { authorization: `Bearer ${admin}` } },
    ),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Trace;
}

describe("POST /otlp/v1/traces", () => {
  it("stores a Managed Agents session's spans and publishes it as the destination", async () => {
    const response = await send(fixture("managed-agents-session"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-protobuf");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array());

    // In the span store, normalized; the marker says who sent them and that the session ended.
    const spans = await listSpans(booted.store, OWNER, ARCHIVE);
    expect(spans).toHaveLength(10);
    expect(spans.every((s) => s.source_id === "console" && s.format === "otlp-genai")).toBe(true);
    const marker = await readPending(booted.store, ARCHIVE);
    expect(marker?.value).toMatchObject({
      owner: OWNER,
      source_id: "console",
      final: true,
      envelope: { source: "otlp", owner_basis: "service", session_key: SESSION },
    });
    expect(JSON.stringify(marker?.value)).not.toContain("resourceSpans");
    // Not readable yet: nothing is published before the assembler runs.
    expect(await readMetadata(booted.store, OWNER, ARCHIVE)).toBeNull();

    // Inside the grace after a final span, it waits; then it is published.
    later(1000);
    expect(await assemble()).toMatchObject({ waiting: 1, published: 0 });
    later(20_000);
    expect(await assemble()).toMatchObject({ published: 1, stored: 1 });
    expect(await readPending(booted.store, ARCHIVE)).toBeNull();

    const metadata = await readMetadata(booted.store, OWNER, ARCHIVE);
    expect(metadata).toMatchObject({
      owner_basis: "service",
      visibility: "org",
      writer: { kind: "service", principal: OWNER, source_id: "console" },
      provenance: { source: "otlp", source_id: "console", format: "otlp-genai" },
      claims: {
        account_ids: {
          "anthropic-org": "org_01Hx7Example",
          "anthropic-workspace": "wrkspc_01Hx7Example",
        },
      },
    });
    const stored = await trace();
    const said = stored.records.slice(1).map((r) => [r.role, "content" in r ? r.content : null]);
    expect(said).toEqual([
      ["system", "You are a careful coding agent."],
      ["user", "The auth test fails with 403 instead of 401. Please fix it."],
      ["assistant", "I'll run the test first."],
      ["tool", "1 fail: expected 401, got 403 (src/auth.ts:42)"],
      [
        "assistant",
        "The guard returned 403 for a missing token. I changed it to 401 and the test passes.",
      ],
      ["user", "Thanks. Add a regression test for the missing-token case too."],
      ["assistant", "Added a test that sends no token and expects 401; the suite passes."],
    ]);
    expect(stored.records[0]).toMatchObject({
      role: "meta",
      source: "otlp-genai",
      model: "claude-sonnet-5",
    });
    expect(stored.llm_calls?.map((c) => c.usage?.input_tokens)).toEqual([4200, 4600, 5100]);
    expect(stored.records[4]).toMatchObject({ role: "tool", duration_ms: 4400 });
  });

  it("is searchable once published, as the destination's session, never from its span records (12)", async () => {
    // The assembler runs before the indexer, so a run of both indexes what was just published.
    expect(instance.jobs.list().map((j) => j.name)).toEqual([
      "heartbeat",
      "retention",
      "assembler",
      "search-index",
    ]);
    const search = async (query: string, token = UPLOADER) => {
      await instance.search?.catchUp();
      const response = await app.fetch(
        new Request(`http://seshi.test/v1/search?${query}`, {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      expect(response.status).toBe(200);
      return (await response.json()) as {
        total: number;
        results: { owner: string; agent: string; session_id: string; source_id?: string }[];
      };
    };
    expect((await send(fixture("managed-agents-session"))).status).toBe(200);
    // Stored as span records under spans/, and not published: nothing to find.
    expect(await listSpans(booted.store, OWNER, ARCHIVE)).toHaveLength(10);
    expect(await search("q=regression")).toMatchObject({ total: 0, results: [] });

    later(21_000);
    expect(await assemble()).toMatchObject({ published: 1 });
    // A member finds the org-visible session of the service account (svc:console).
    const found = await search("q=regression&agent=otlp-genai&source=console&owner=svc%3Aconsole");
    expect(found.results).toEqual([
      expect.objectContaining({
        owner: OWNER,
        agent: "otlp-genai",
        session_id: SESSION,
        source_id: "console",
      }),
    ]);
    expect(found.total).toBe(1);
  });

  it("takes JSON, keeps a span sent twice once, and drops the SDK's copy of a response", async () => {
    const request = fixture("messages-tool-runner");
    expect((await send(request, { encoding: "json" })).status).toBe(200);
    const response = await send(request, { encoding: "json", gzip: true });
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({});
    const archive = archiveId(OWNER, "otlp-genai", MESSAGES_TRACE);
    expect(await listSpans(booted.store, OWNER, archive)).toHaveLength(8);
    later(20_000);
    await assemble();
    const stored = await trace(OWNER, MESSAGES_TRACE);
    expect(stored.records.map((r) => r.role)).toEqual([
      "meta",
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    // One call per request, from the API's server span: not the SDK's, not the model requests.
    expect(stored.llm_calls?.map((c) => c.id)).toEqual(["b000000000000002", "b000000000000004"]);
    expect(stored.llm_calls?.[0]).toMatchObject({
      model: "claude-haiku-5-5",
      provider: "anthropic",
      stop_reason: "tool_use",
      request_id: "msg_01first",
      usage: { input_tokens: 310, output_tokens: 42 },
      parameters: { max_tokens: 1024 },
    });
  });

  it("rejects a metadata-only batch through partial_success and stores nothing (F4.5)", async () => {
    const response = await send(fixture("managed-agents-metadata-only"), { encoding: "json" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      partialSuccess: { rejectedSpans: "10", errorMessage: METADATA_ONLY_MESSAGE },
    });
    expect(await listSpans(booted.store, OWNER, ARCHIVE)).toEqual([]);
    expect(await readPending(booted.store, ARCHIVE)).toBeNull();
    await instance.health.flush();
    const health = await readHealth(booted.store, "console");
    expect(health.map((d) => d.counts.rejected)).toEqual([1]);
  });

  it("answers metadata-only in protobuf as partial_success too", async () => {
    const response = await send(fixture("managed-agents-metadata-only"));
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body[0]).toBe(0x0a); // partial_success
    expect(new TextDecoder().decode(body)).toContain("Full content");
  });

  it("redacts spans on arrival and the trace on publish", async () => {
    const request = fixture("managed-agents-session");
    const spans = request.resourceSpans[0].scopeSpans[0].spans;
    const tool = spans.find((s: { name: string }) => s.name === "anthropic.tool_use bash");
    for (const kv of tool.attributes) {
      if (kv.key === "anthropic.tool_result.content") {
        kv.value.stringValue = JSON.stringify([{ type: "text", text: `token ${GITHUB_TOKEN}` }]);
      }
    }
    const turn = spans.find((s: { spanId: string }) => s.spanId === "10a1b2c3d4e5f602");
    for (const kv of turn.attributes) {
      if (kv.key === "gen_ai.output.messages") {
        kv.value.stringValue = kv.value.stringValue.replace(
          "1 fail: expected 401, got 403 (src/auth.ts:42)",
          `token ${GITHUB_TOKEN}`,
        );
      }
    }
    // And in a user message, which is stored once as one of the session's messages (22).
    for (const span of spans) {
      for (const kv of span.attributes ?? []) {
        if (kv.key === "gen_ai.input.messages") {
          kv.value.stringValue = kv.value.stringValue.replace(
            "Please fix it.",
            `Please fix it. token ${GITHUB_TOKEN}`,
          );
        }
      }
    }
    expect((await send(request)).status).toBe(200);
    const atRest = JSON.stringify(await listSpans(booted.store, OWNER, ARCHIVE));
    expect(atRest).not.toContain(GITHUB_TOKEN);
    expect(atRest).toContain("[redacted:github-token]");
    // Nothing under the session's spans/ holds it, the stored messages included.
    const objects = (await booted.store.list(keys.spans(OWNER, ARCHIVE), { limit: 1000 })).keys;
    expect(objects.some((k) => k.startsWith(keys.spanMessages(OWNER, ARCHIVE)))).toBe(true);
    for (const key of objects) {
      const text = new TextDecoder().decode((await booted.store.get(key))?.body);
      expect(text).not.toContain(GITHUB_TOKEN);
    }
    later(20_000);
    await assemble();
    expect(JSON.stringify(await trace())).not.toContain(GITHUB_TOKEN);
    const metadata = await readMetadata(booted.store, OWNER, ARCHIVE);
    expect(metadata?.redaction?.counts["github-token"]).toBe(3);
  });

  it("republishes a session when late spans arrive, extending it", async () => {
    const request = fixture("managed-agents-session");
    const all = request.resourceSpans[0].scopeSpans[0].spans;
    // The first two turns now; the last turn and the archive later.
    const late = all.filter((s: { traceId: string }) =>
      ["6d1b4f3e2e5c4d9fab8e7c6d5e4f3b2a", "7e2c5a4f3f6d4eaf8c9d8e7f6a5b4c3d"].includes(s.traceId),
    );
    request.resourceSpans[0].scopeSpans[0].spans = all.filter((s: unknown) => !late.includes(s));
    expect((await send(request)).status).toBe(200);
    later(5 * 60_000);
    expect(await assemble()).toMatchObject({ waiting: 1 });
    later(6 * 60_000);
    expect(await assemble()).toMatchObject({ published: 1 });
    const first = await readMetadata(booted.store, OWNER, ARCHIVE);
    expect(first?.traces).toHaveLength(1);

    request.resourceSpans[0].scopeSpans[0].spans = late;
    later(60_000);
    expect((await send(request)).status).toBe(200);
    later(20_000);
    expect(await assemble()).toMatchObject({ published: 1, stored: 1 });
    const second = await readMetadata(booted.store, OWNER, ARCHIVE);
    expect(second?.traces).toHaveLength(2);
    expect(second?.head).not.toBe(first?.head);
    const head = await trace();
    expect(head.metadata?.continuation?.from_record).toBeGreaterThan(0);
    expect(JSON.stringify(head)).toContain("regression test");
  });

  it("files a destination's sessions under its source's visibility", async () => {
    const token = await serviceToken("private-console");
    expect((await send(fixture("managed-agents-session"), { token })).status).toBe(200);
    later(20_000);
    await assemble();
    const owner = "svc:private-console";
    const metadata = await readMetadata(
      booted.store,
      owner,
      archiveId(owner, "otlp-genai", SESSION),
    );
    expect(metadata?.visibility).toBe("owner");
  });

  it("judges an assembled session by the session filter, keeping its spans for later", async () => {
    const token = await serviceToken("strict-console");
    expect((await send(fixture("managed-agents-session"), { token })).status).toBe(200);
    later(20_000);
    expect(await assemble()).toMatchObject({ published: 1, filtered: 1 });
    const owner = "svc:strict-console";
    const archive = archiveId(owner, "otlp-genai", SESSION);
    expect(await readMetadata(booted.store, owner, archive)).toBeNull();
    expect(await readPending(booted.store, archive)).toBeNull();
    // The spans stay, so later spans can make the session long enough to keep.
    expect(await listSpans(booted.store, owner, archive)).toHaveLength(10);
    await instance.health.flush();
    const health = await readHealth(booted.store, "strict-console");
    expect(health.map((d) => d.counts.filtered)).toEqual([1]);
  });

  it("deletes the span records with the session", async () => {
    expect((await send(fixture("managed-agents-session"))).status).toBe(200);
    later(20_000);
    await assemble();
    // The inputs' messages, stored once each (22), go with the records.
    const messages = keys.spanMessages(OWNER, ARCHIVE);
    expect((await booted.store.list(messages)).keys.length).toBeGreaterThan(0);
    const response = await app.fetch(
      new Request(`http://seshi.test/v1/sessions/otlp-genai/${SESSION}?owner=svc%3Aconsole`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${admin}` },
      }),
    );
    expect(response.status).toBe(200);
    expect(await listSpans(booted.store, OWNER, ARCHIVE)).toEqual([]);
    expect((await booted.store.list(messages)).keys).toEqual([]);
    // A late batch for a deleted session is refused, and nothing of it is kept.
    const again = await send(fixture("managed-agents-session"), { encoding: "json" });
    expect(await again.json()).toMatchObject({ partialSuccess: { rejectedSpans: "10" } });
    expect(await listSpans(booted.store, OWNER, ARCHIVE)).toEqual([]);
    expect(await booted.store.get(keys.pending(ARCHIVE))).toBeNull();
  });

  it("refuses callers that are not an enabled otlp destination", async () => {
    const request = fixture("managed-agents-session");
    expect((await send(request, { token: "nope" })).status).toBe(401);
    expect((await send(request, { token: admin })).status).toBe(403);
    const reader = await app.fetch(
      new Request("http://seshi.test/v1/tokens", {
        method: "POST",
        headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
        body: JSON.stringify({ kind: "service", service: "console" }),
      }),
    );
    const readToken = ((await reader.json()) as { token: string }).token;
    expect((await send(request, { token: readToken })).status).toBe(403);
    expect(await listSpans(booted.store, OWNER, ARCHIVE)).toEqual([]);
  });

  it("rejects spans it cannot read and keeps the rest", async () => {
    const request = fixture("messages-tool-runner");
    request.resourceSpans[0].scopeSpans[0].spans[0].traceId = "0".repeat(32);
    request.resourceSpans[0].scopeSpans[0].spans[1].startTimeUnixNano = "0";
    const response = await send(request, { encoding: "json" });
    expect(await response.json()).toEqual({
      partialSuccess: { rejectedSpans: "2", errorMessage: "a span has no valid traceId" },
    });
    const archive = archiveId(OWNER, "otlp-genai", MESSAGES_TRACE);
    expect(await listSpans(booted.store, OWNER, archive)).toHaveLength(6);
  });

  it("takes an OTLP/JSON export uploaded whole as a document session", async () => {
    // Not the receiver: POST /v1/sessions with the export as a JSON document (an S3 object, a
    // file). It is one session, assembled the same way; a log carries no LLM calls.
    const transcript = JSON.stringify(fixture("managed-agents-session")).replace(
      "The guard returned",
      `${"In detail: ".repeat(200)}The guard returned`,
    );
    const response = await app.fetch(
      new Request("http://seshi.test/v1/sessions", {
        method: "POST",
        headers: { authorization: `Bearer ${UPLOADER}`, "content-type": "application/json" },
        body: JSON.stringify({
          agent: "otlp-genai",
          format: "json",
          session_id: "export-1",
          transcript,
        }),
      }),
    );
    expect(response.status).toBe(201);
    const stored = await trace("acme", "export-1");
    expect(stored.records.map((r) => r.role)).toEqual([
      "meta",
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
      "assistant",
    ]);
    // The LLM calls the spans name are kept as on the span path (X6.2).
    expect(stored.llm_calls?.length).toBeGreaterThan(0);
    const named = new Set(stored.records.map((r) => (r as { llm_call?: string }).llm_call));
    for (const call of stored.llm_calls ?? []) expect(named.has(call.id)).toBe(true);
  });

  it("answers garbage with 400 in the request's encoding", async () => {
    const response = await app.fetch(
      new Request("http://seshi.test/otlp/v1/traces", {
        method: "POST",
        headers: {
          authorization: `Bearer ${destination}`,
          "content-type": "application/x-protobuf",
        },
        body: Uint8Array.from([0x0a, 0x09, 0x01]),
      }),
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("application/x-protobuf");
    expect(new TextDecoder().decode(await response.arrayBuffer())).toContain("past the end");
  });
});

describe("the OTLP body caps (F4.1, [limits])", () => {
  /** A server with `[limits]` `limits`, its destination's token, and a POST of `body`. */
  async function capped(limits: string) {
    const server = await bootInstance(
      `[limits]\n${limits}\n[[sources]]\nid = "console"\ntype = "otlp"\nfilter = { min_chars = 50 }`,
      { now: () => clock, roles: ["api", "worker"] },
    );
    const served = createApp(server.instance);
    const init = await server.instance.auth.initAdmin({ owner: "ops" });
    const minted = await served.fetch(
      new Request("http://seshi.test/v1/tokens", {
        method: "POST",
        headers: {
          authorization: `Bearer ${init.admin?.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ kind: "service", service: "console", scopes: ["sessions:write"] }),
      }),
    );
    const { token } = (await minted.json()) as { token: string };
    const post = (body: Uint8Array, gzip: boolean) =>
      served.fetch(
        new Request("http://seshi.test/otlp/v1/traces", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/x-protobuf",
            ...(gzip ? { "content-encoding": "gzip" } : {}),
          },
          body: body as Uint8Array<ArrayBuffer>,
        }),
      );
    return { server, post };
  }

  const raw = () => encodeExportRequest(fixture("managed-agents-session"));
  const message = async (response: Response) =>
    new TextDecoder().decode(await response.arrayBuffer());

  it("defaults to 64 MiB sent and 256 MiB inflated", () => {
    expect(instance.config.limits.max_otlp_bytes).toBe(64 * 1024 * 1024);
    expect(instance.config.limits.max_otlp_inflated_bytes).toBe(256 * 1024 * 1024);
  });

  it("takes a body of exactly limits.max_otlp_bytes and answers 413 naming the key one byte past it", async () => {
    const body = raw();
    for (const [cap, status] of [
      [body.length, 200],
      [body.length - 1, 413],
    ] as const) {
      const { server, post } = await capped(`max_otlp_bytes = ${cap}`);
      try {
        const response = await post(body, false);
        expect(response.status).toBe(status);
        if (status === 413) {
          expect(response.headers.get("content-type")).toBe("application/x-protobuf");
          expect(await message(response)).toContain("limits.max_otlp_bytes");
          expect(await listSpans(server.store, OWNER, ARCHIVE)).toEqual([]);
        } else {
          expect(await listSpans(server.store, OWNER, ARCHIVE)).toHaveLength(10);
        }
      } finally {
        await server.cleanup();
      }
    }
  });

  it("holds a gzipped body to max_otlp_bytes as sent and max_otlp_inflated_bytes inflated", async () => {
    const body = raw();
    const sent = gzipSync(body);
    for (const [limits, status, key] of [
      [`max_otlp_bytes = ${sent.length}\nmax_otlp_inflated_bytes = ${body.length}`, 200, ""],
      [`max_otlp_bytes = ${sent.length - 1}`, 413, "limits.max_otlp_bytes"],
      [`max_otlp_inflated_bytes = ${body.length - 1}`, 413, "limits.max_otlp_inflated_bytes"],
    ] as const) {
      const { server, post } = await capped(limits);
      try {
        const response = await post(sent, true);
        expect(response.status).toBe(status);
        if (key) expect(await message(response)).toContain(key);
      } finally {
        await server.cleanup();
      }
    }
  });

  it("answers a gzip bomb 413 at the inflated cap", async () => {
    // 32 MiB of zeros in about 32 KB, far under the wire cap.
    const bomb = gzipSync(new Uint8Array(32 * 1024 * 1024));
    const { server, post } = await capped(`max_otlp_inflated_bytes = "1MiB"`);
    try {
      const response = await post(bomb, true);
      expect(response.status).toBe(413);
      expect(await message(response)).toContain("limits.max_otlp_inflated_bytes");
    } finally {
      await server.cleanup();
    }
  });
});
