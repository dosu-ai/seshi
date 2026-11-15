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
    expect((await send(request)).status).toBe(200);
    const atRest = JSON.stringify(await listSpans(booted.store, OWNER, ARCHIVE));
    expect(atRest).not.toContain(GITHUB_TOKEN);
    expect(atRest).toContain("[redacted:github-token]");
    later(20_000);
    await assemble();
    expect(JSON.stringify(await trace())).not.toContain(GITHUB_TOKEN);
    const metadata = await readMetadata(booted.store, OWNER, ARCHIVE);
    expect(metadata?.redaction?.counts["github-token"]).toBe(2);
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
    const response = await app.fetch(
      new Request(`http://seshi.test/v1/sessions/otlp-genai/${SESSION}?owner=svc%3Aconsole`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${admin}` },
      }),
    );
    expect(response.status).toBe(200);
    expect(await listSpans(booted.store, OWNER, ARCHIVE)).toEqual([]);
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
    expect(stored.llm_calls).toBeUndefined();
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
