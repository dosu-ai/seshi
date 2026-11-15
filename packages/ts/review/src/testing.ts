/** Stand-ins for model providers, so no test calls a real API (`@seshi/review/testing`).
 *
 * - `KeywordModel`: a deterministic "model" that labels and finds by fixed strings. It answers
 *   from the same JSON the real providers are sent, so tests check what leaves the server too.
 * - `FakeProvider`: a `ModelProvider` in memory, answering from a script, a `KeywordModel` or a
 *   function, and keeping every request.
 * - `fakeProviderServer`: a local HTTP server that imitates the Anthropic Messages API
 *   (`POST /v1/messages`) and an OpenAI-compatible Chat Completions API
 *   (`POST /v1/chat/completions`), so the real providers are exercised over HTTP. Its response
 *   bodies are hand-written from the vendors' documented shapes (see `testdata/README.md`). */

import type { CompletionRequest, ModelProvider } from "./provider";
import { ProviderError } from "./provider";
import type { Entry } from "./render";

export interface KeywordRules {
  /** Text whose presence labels a part `drop`. */
  drop?: readonly string[];
  /** Text to find, with its category: labels a part `redact`, and the redactor reports it. */
  sensitive?: readonly { text: string; category: string; action?: "redact" | "withhold" }[];
}

/** Answers like a model that knows exactly which strings matter. */
export class KeywordModel {
  constructor(readonly rules: KeywordRules) {}

  /** The answer to a request for `schemaName` (`decision` or `findings`) over `user`. */
  answer(schemaName: string, user: string): unknown {
    const entries = (JSON.parse(user) as { records: Entry[] }).records;
    if (schemaName === "decision") {
      const has = (text: string) => entries.some((e) => e.text.includes(text));
      if ((this.rules.drop ?? []).some(has)) return { label: "drop" };
      if ((this.rules.sensitive ?? []).some((s) => has(s.text))) return { label: "redact" };
      return { label: "allow" };
    }
    const findings = [];
    for (const entry of entries) {
      for (const s of this.rules.sensitive ?? []) {
        if (entry.text.includes(s.text)) {
          findings.push({
            record: entry.record,
            field: entry.field,
            text: s.text,
            category: s.category,
            action: s.action ?? "redact",
          });
        }
      }
    }
    return { findings };
  }
}

/** One scripted step of a `FakeProvider`: an answer, an error to throw, or a function. */
export type Scripted =
  | { answer: unknown }
  | { error: ProviderError }
  | ((request: CompletionRequest) => unknown | Promise<unknown>);

export interface FakeProviderOptions {
  model?: string;
  kind?: string;
  /** Answers every request (after `script` runs out). */
  keywords?: KeywordModel;
  /** Answers to give in order; each is used once. */
  script?: Scripted[];
}

/** A provider in memory: answers from its script, then from its `KeywordModel`; with neither,
 * every call fails with `http_500`. */
export class FakeProvider implements ModelProvider {
  readonly kind: string;
  readonly model: string;
  readonly endpoint = "fake://provider";
  readonly requests: CompletionRequest[] = [];
  private readonly script: Scripted[];
  private readonly keywords: KeywordModel | undefined;

  constructor(options: FakeProviderOptions = {}) {
    this.kind = options.kind ?? "fake";
    this.model = options.model ?? "fake-model";
    this.script = [...(options.script ?? [])];
    this.keywords = options.keywords;
  }

  /** Requests whose schema is `name`. */
  calls(name: "decision" | "findings"): CompletionRequest[] {
    return this.requests.filter((r) => r.schemaName === name);
  }

  async complete(request: CompletionRequest): Promise<unknown> {
    this.requests.push(request);
    const next = this.script.shift();
    if (next !== undefined) {
      if (typeof next === "function") return next(request);
      if ("error" in next) throw next.error;
      return next.answer;
    }
    if (this.keywords) return this.keywords.answer(request.schemaName, request.user);
    throw new ProviderError("http_500", true);
  }
}

/** A request the fake server received. */
export interface ReceivedRequest {
  /** Which API the path is; `other` for any other path (answered 404). */
  api: "anthropic" | "openai" | "other";
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** What the fake server answers a request with: a model answer (serialized as the API's text),
 * or a raw HTTP status and body. */
export type ServerReply =
  | { answer: unknown; stop?: "end_turn" | "max_tokens" | "refusal" | "length" }
  | { status: number; body?: unknown; headers?: Record<string, string>; delayMs?: number };

export interface FakeServerOptions {
  /** Decides each reply; by default answers from `model`. */
  reply?: (
    request: ReceivedRequest,
    schemaName: string,
    user: string,
  ) => ServerReply | Promise<ServerReply>;
  model?: KeywordModel;
}

export interface FakeServer {
  /** `http://127.0.0.1:<port>`: the base URL for `anthropic`; add `/v1` for OpenAI. */
  url: string;
  requests: ReceivedRequest[];
  close(): Promise<void>;
}

function anthropicSchemaName(body: Record<string, unknown>): string {
  const schema = (body.output_config as { format?: { schema?: { properties?: object } } })?.format
    ?.schema;
  return schema?.properties && "label" in schema.properties ? "decision" : "findings";
}

function userText(messages: unknown): string {
  const list = Array.isArray(messages) ? (messages as { role: string; content: unknown }[]) : [];
  const user = list.find((m) => m.role === "user");
  return typeof user?.content === "string" ? user.content : "";
}

/** A local server that imitates both APIs well enough for the providers (see above). */
export function fakeProviderServer(options: FakeServerOptions = {}): FakeServer {
  const requests: ReceivedRequest[] = [];
  const decide =
    options.reply ??
    ((_request: ReceivedRequest, schemaName: string, user: string): ServerReply => {
      if (!options.model) return { status: 500, body: { error: "no model" } };
      return { answer: options.model.answer(schemaName, user) };
    });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const api = path.endsWith("/v1/messages")
        ? "anthropic"
        : path.endsWith("/chat/completions")
          ? "openai"
          : undefined;
      const headers: Record<string, string> = {};
      req.headers.forEach((value, key) => {
        headers[key] = value;
      });
      if (!api || req.method !== "POST") {
        requests.push({ api: "other", path, headers, body: {} });
        return new Response("not found", { status: 404 });
      }
      const body = (await req.json()) as Record<string, unknown>;
      const received: ReceivedRequest = { api, path, headers, body };
      requests.push(received);
      const schemaName =
        api === "anthropic"
          ? anthropicSchemaName(body)
          : String(
              (body.response_format as { json_schema?: { name?: string } })?.json_schema?.name,
            );
      const user = userText(body.messages);
      const reply = await decide(received, schemaName, user);
      if ("status" in reply) {
        if (reply.delayMs) await Bun.sleep(reply.delayMs);
        return Response.json(
          reply.body ?? { type: "error", error: { type: "api_error", message: "fake" } },
          { status: reply.status, ...(reply.headers ? { headers: reply.headers } : {}) },
        );
      }
      const text = typeof reply.answer === "string" ? reply.answer : JSON.stringify(reply.answer);
      if (api === "anthropic") {
        return Response.json({
          id: "msg_fake",
          type: "message",
          role: "assistant",
          model: body.model,
          content: [{ type: "text", text }],
          stop_reason: reply.stop ?? "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        });
      }
      return Response.json({
        id: "chatcmpl-fake",
        object: "chat.completion",
        created: 0,
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: text },
            finish_reason: reply.stop === "length" ? "length" : "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    close: () => server.stop(true),
  };
}
