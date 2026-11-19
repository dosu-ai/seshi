import {
  type CompletionRequest,
  isTimeout,
  type ModelProvider,
  originOf,
  ProviderError,
  parseAnswer,
  statusError,
} from "./provider";

export interface OpenAiCompatibleOptions {
  model: string;
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof fetch;
}

interface ChatCompletion {
  choices?: {
    finish_reason?: string | null;
    message?: { content?: string | null; refusal?: string | null };
  }[];
}

export class OpenAiCompatibleProvider implements ModelProvider {
  readonly kind = "openai-compatible";
  readonly model: string;
  readonly endpoint: string;
  private readonly url: string;
  private readonly apiKey: string | undefined;
  private readonly fetcher: typeof fetch;

  constructor(options: OpenAiCompatibleOptions) {
    this.model = options.model;
    this.url = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    this.endpoint = originOf(options.baseUrl);
    this.apiKey = options.apiKey;
    this.fetcher = options.fetch ?? fetch;
  }

  async complete(request: CompletionRequest): Promise<unknown> {
    const timeout = AbortSignal.timeout(request.timeoutMs);
    const signal = request.signal ? AbortSignal.any([timeout, request.signal]) : timeout;
    let response: Response;
    try {
      response = await this.fetcher(this.url, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: request.maxTokens,
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.user },
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name: request.schemaName, strict: true, schema: request.schema },
          },
        }),
      });
    } catch (err) {
      if (request.signal?.aborted) throw new ProviderError("aborted", false, "aborted");
      if (isTimeout(err)) throw new ProviderError("timeout", true, "the call timed out");
      throw new ProviderError("network", true, "the provider could not be reached");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw statusError(response.status);
    }
    let body: ChatCompletion;
    try {
      body = (await response.json()) as ChatCompletion;
    } catch (err) {
      if (isTimeout(err)) throw new ProviderError("timeout", true, "the call timed out");
      throw new ProviderError("invalid_response", true, "the provider's answer is not JSON");
    }
    const choice = body.choices?.[0];
    if (!choice?.message) {
      throw new ProviderError("invalid_response", true, "the provider's answer has no message");
    }
    if (choice.message.refusal) {
      throw new ProviderError("refusal", false, "the model declined the request");
    }
    if (choice.finish_reason === "length") {
      throw new ProviderError("truncated", true, "the answer was cut off at max_tokens");
    }
    if (choice.finish_reason === "content_filter") {
      throw new ProviderError("refusal", false, "the provider filtered the answer");
    }
    return parseAnswer(choice.message.content ?? "");
  }
}
