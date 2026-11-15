/** The Anthropic provider: Claude through the Messages API (`POST /v1/messages`), with the
 * official SDK. The answer is constrained to the step's schema with structured outputs
 * (`output_config.format`), and thinking is left as the model's default (adaptive on current
 * models); `effort` is sent only when the step sets it.
 *
 * The client is built so that nothing comes from the environment: the key and the endpoint are
 * the step's (the SDK would otherwise read `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` and local
 * profiles), the SDK's own retries are off (F3.4's retries are the reviewer's), its
 * OpenTelemetry spans are off (they could carry content to a tracer), and redirects are refused
 * (content goes to the configured endpoint only). */

import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "@anthropic-ai/sdk";
import {
  type CompletionRequest,
  isTimeout,
  type ModelProvider,
  originOf,
  ProviderError,
  parseAnswer,
  statusError,
} from "./provider";

export interface AnthropicProviderOptions {
  model: string;
  apiKey: string;
  baseUrl: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  fetch?: typeof fetch;
}

export class AnthropicProvider implements ModelProvider {
  readonly kind = "anthropic";
  readonly model: string;
  readonly endpoint: string;
  private readonly client: Anthropic;
  private readonly effort: AnthropicProviderOptions["effort"];

  constructor(options: AnthropicProviderOptions) {
    this.model = options.model;
    this.endpoint = originOf(options.baseUrl);
    this.effort = options.effort;
    this.client = new Anthropic({
      apiKey: options.apiKey,
      baseURL: options.baseUrl,
      maxRetries: 0,
      openTelemetry: false,
      fetchOptions: { redirect: "error" },
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  async complete(request: CompletionRequest): Promise<unknown> {
    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: request.maxTokens,
          system: request.system,
          messages: [{ role: "user", content: request.user }],
          output_config: {
            format: { type: "json_schema", schema: { ...request.schema } },
            ...(this.effort ? { effort: this.effort } : {}),
          },
        },
        { timeout: request.timeoutMs, ...(request.signal ? { signal: request.signal } : {}) },
      );
    } catch (err) {
      throw mapError(err);
    }
    if (message.stop_reason === "refusal") {
      throw new ProviderError("refusal", false, "the model declined the request");
    }
    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (message.stop_reason === "max_tokens") {
      throw new ProviderError("truncated", true, "the answer was cut off at max_tokens");
    }
    return parseAnswer(text);
  }
}

function mapError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof APIConnectionTimeoutError) {
    return new ProviderError("timeout", true, "the call timed out");
  }
  if (err instanceof APIUserAbortError) return new ProviderError("aborted", false, "aborted");
  if (err instanceof APIConnectionError) {
    return new ProviderError("network", true, "the provider could not be reached");
  }
  if (err instanceof APIError && typeof err.status === "number") return statusError(err.status);
  if (isTimeout(err)) return new ProviderError("timeout", true, "the call timed out");
  return new ProviderError("network", true, "the call failed");
}
