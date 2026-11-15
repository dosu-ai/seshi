/** The real providers against a local server that imitates their APIs (`fakeProviderServer`);
 * no test reaches a real API. */

import { afterEach, describe, expect, it } from "vitest";
import { AnthropicProvider } from "./anthropic";
import { OpenAiCompatibleProvider } from "./openai";
import { DECISION_SCHEMA } from "./prompts";
import { type CompletionRequest, ProviderError, parseAnswer, retryableStatus } from "./provider";
import { type FakeServer, fakeProviderServer, type ServerReply } from "./testing";

const servers: FakeServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

function serve(reply: () => ServerReply | Promise<ServerReply>): FakeServer {
  const server = fakeProviderServer({ reply });
  servers.push(server);
  return server;
}

const REQUEST: CompletionRequest = {
  system: "judge these",
  user: '{"records":[]}',
  schema: DECISION_SCHEMA,
  schemaName: "decision",
  maxTokens: 512,
  timeoutMs: 5_000,
};

async function failure(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ProviderError) return err;
    throw err;
  }
  throw new Error("expected a ProviderError");
}

/** A port nothing listens on. */
async function closedPort(): Promise<string> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const url = `http://127.0.0.1:${server.port}`;
  await server.stop(true);
  return url;
}

describe("AnthropicProvider", () => {
  const provider = (server: FakeServer, extra: { effort?: "low" } = {}) =>
    new AnthropicProvider({
      model: "claude-haiku-5-5",
      apiKey: "sk-ant-test",
      baseUrl: server.url,
      ...extra,
    });

  it("calls the Messages API with the schema as structured output", async () => {
    const server = serve(() => ({ answer: { label: "redact" } }));
    expect(await provider(server, { effort: "low" }).complete(REQUEST)).toEqual({
      label: "redact",
    });
    const [request] = server.requests;
    expect(request?.path).toBe("/v1/messages");
    expect(request?.body).toMatchObject({
      model: "claude-haiku-5-5",
      max_tokens: 512,
      system: "judge these",
      messages: [{ role: "user", content: '{"records":[]}' }],
      output_config: { format: { type: "json_schema", schema: DECISION_SCHEMA }, effort: "low" },
    });
    expect(request?.body).not.toHaveProperty("temperature");
    expect(request?.headers["anthropic-version"]).toBeTruthy();
    const auth = `${request?.headers["x-api-key"] ?? ""} ${request?.headers.authorization ?? ""}`;
    expect(auth).toContain("sk-ant-test");
  });

  it("sends no effort unless the step sets one", async () => {
    const server = serve(() => ({ answer: { label: "allow" } }));
    await provider(server).complete(REQUEST);
    expect(server.requests[0]?.body.output_config).not.toHaveProperty("effort");
  });

  it("reads neither the endpoint nor the key from the environment", async () => {
    const server = serve(() => ({ answer: { label: "allow" } }));
    const saved = { url: process.env.ANTHROPIC_BASE_URL, key: process.env.ANTHROPIC_API_KEY };
    process.env.ANTHROPIC_BASE_URL = await closedPort();
    process.env.ANTHROPIC_API_KEY = "sk-from-env";
    try {
      await provider(server).complete(REQUEST);
    } finally {
      if (saved.url === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = saved.url;
      if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved.key;
    }
    expect(server.requests).toHaveLength(1);
    expect(JSON.stringify(server.requests[0]?.headers)).not.toContain("sk-from-env");
  });

  it("maps statuses to retryable and permanent failures, and never retries itself", async () => {
    for (const [status, retryable] of [
      [429, true],
      [529, true],
      [500, true],
      [401, false],
      [400, false],
    ] as const) {
      const server = serve(() => ({ status }));
      const err = await failure(provider(server).complete(REQUEST));
      expect(err).toMatchObject({ code: `http_${status}`, retryable });
      // F3.4's retries are the reviewer's: the SDK sends once.
      expect(server.requests).toHaveLength(1);
    }
  });

  it("treats a refusal as permanent and a cut-off answer as retryable", async () => {
    const refused = serve(() => ({ answer: "", stop: "refusal" }));
    expect(await failure(provider(refused).complete(REQUEST))).toMatchObject({
      code: "refusal",
      retryable: false,
    });
    const cut = serve(() => ({ answer: '{"label": "al', stop: "max_tokens" }));
    expect(await failure(provider(cut).complete(REQUEST))).toMatchObject({
      code: "truncated",
      retryable: true,
    });
  });

  it("times out", async () => {
    const server = serve(() => ({ status: 200, delayMs: 1_000 }));
    const err = await failure(provider(server).complete({ ...REQUEST, timeoutMs: 50 }));
    expect(err).toMatchObject({ code: "timeout", retryable: true });
  });

  it("fails as network when the endpoint cannot be reached", async () => {
    const p = new AnthropicProvider({ model: "m", apiKey: "k", baseUrl: await closedPort() });
    expect(await failure(p.complete(REQUEST))).toMatchObject({ code: "network", retryable: true });
  });

  it("refuses redirects, so content goes to the configured endpoint only", async () => {
    const elsewhere = serve(() => ({ answer: { label: "allow" } }));
    const server = serve(() => ({
      status: 307,
      headers: { location: `${elsewhere.url}/v1/messages` },
    }));
    const err = await failure(provider(server).complete(REQUEST));
    expect(err).toBeInstanceOf(ProviderError);
    expect(elsewhere.requests).toEqual([]);
  });

  it("says nothing about the content in its errors", async () => {
    const server = serve(() => ({
      status: 400,
      body: { type: "error", error: { type: "invalid_request_error", message: "echo: hunter2" } },
    }));
    const err = await failure(provider(server).complete(REQUEST));
    expect(err.message).not.toContain("hunter2");
  });
});

describe("OpenAiCompatibleProvider", () => {
  const provider = (server: FakeServer, apiKey?: string) =>
    new OpenAiCompatibleProvider({
      model: "llama-guard",
      baseUrl: `${server.url}/v1/`,
      ...(apiKey ? { apiKey } : {}),
    });

  it("calls Chat Completions with a strict JSON schema", async () => {
    const server = serve(() => ({ answer: { label: "allow" } }));
    expect(await provider(server, "sk-local").complete(REQUEST)).toEqual({ label: "allow" });
    const [request] = server.requests;
    expect(request?.path).toBe("/v1/chat/completions");
    expect(request?.headers.authorization).toBe("Bearer sk-local");
    expect(request?.body).toEqual({
      model: "llama-guard",
      max_tokens: 512,
      messages: [
        { role: "system", content: "judge these" },
        { role: "user", content: '{"records":[]}' },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "decision", strict: true, schema: DECISION_SCHEMA },
      },
    });
  });

  it("sends no Authorization header without a key (a local model)", async () => {
    const server = serve(() => ({ answer: { label: "allow" } }));
    await provider(server).complete(REQUEST);
    expect(server.requests[0]?.headers).not.toHaveProperty("authorization");
  });

  it("maps failures", async () => {
    const down = serve(() => ({ status: 503 }));
    expect(await failure(provider(down).complete(REQUEST))).toMatchObject({
      code: "http_503",
      retryable: true,
    });
    const denied = serve(() => ({ status: 403 }));
    expect(await failure(provider(denied).complete(REQUEST))).toMatchObject({
      code: "http_403",
      retryable: false,
    });
    const cut = serve(() => ({ answer: '{"label":', stop: "length" }));
    expect(await failure(provider(cut).complete(REQUEST))).toMatchObject({ code: "truncated" });
    const garbled = serve(() => ({ answer: "I think it is fine." }));
    expect(await failure(provider(garbled).complete(REQUEST))).toMatchObject({
      code: "invalid_json",
      retryable: true,
    });
    const slow = serve(() => ({ status: 200, delayMs: 1_000 }));
    expect(await failure(provider(slow).complete({ ...REQUEST, timeoutMs: 50 }))).toMatchObject({
      code: "timeout",
    });
  });

  it("refuses redirects", async () => {
    const elsewhere = serve(() => ({ answer: { label: "allow" } }));
    const server = serve(() => ({
      status: 302,
      headers: { location: `${elsewhere.url}/v1/chat/completions` },
    }));
    await failure(provider(server).complete(REQUEST));
    expect(elsewhere.requests).toEqual([]);
  });

  it("treats a refusal as permanent", async () => {
    const server = serve(() => ({
      status: 200,
      body: {
        id: "x",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: null, refusal: "no" } }],
      },
    }));
    expect(await failure(provider(server).complete(REQUEST))).toMatchObject({
      code: "refusal",
      retryable: false,
    });
  });
});

describe("parseAnswer", () => {
  it("reads JSON, tolerating a fence or prose around one object", () => {
    expect(parseAnswer('{"label":"drop"}')).toEqual({ label: "drop" });
    expect(parseAnswer('```json\n{"label":"drop"}\n```')).toEqual({ label: "drop" });
    expect(parseAnswer('Answer: {"label":"drop"}')).toEqual({ label: "drop" });
    expect(() => parseAnswer("")).toThrow(ProviderError);
    expect(() => parseAnswer("drop")).toThrow(ProviderError);
  });

  it("knows which statuses are worth retrying", () => {
    expect([408, 409, 429, 500, 502, 529].every(retryableStatus)).toBe(true);
    expect([400, 401, 403, 404, 413, 422].some(retryableStatus)).toBe(false);
  });
});
