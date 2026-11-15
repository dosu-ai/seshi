/** The provider interface both review steps call (F3.3, F3.5): one request with a system prompt,
 * one user message and the JSON Schema of the answer; one parsed JSON value back. Each provider
 * maps its API onto it (`anthropic.ts`, `openai.ts`); tests use `FakeProvider`
 * (`testing.ts`).
 *
 * Who may see content (the data-flow rule): a provider sends what it is given to the one
 * endpoint its step names, and nowhere else. Providers never read the environment for an
 * endpoint or a key, refuse redirects, and never put content in an error: a failure is a code
 * (`ProviderError.code`), so what a review record, drop record or log line says about it cannot
 * carry the session's text. */

export interface CompletionRequest {
  /** The system prompt: the operator's prompt with seshi's wrapping. */
  system: string;
  /** The user message: the records, as JSON. */
  user: string;
  /** The answer's JSON Schema; providers that can constrain output to it do. */
  schema: Readonly<Record<string, unknown>>;
  /** A short name for the schema (`decision`, `findings`). */
  schemaName: string;
  maxTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ModelProvider {
  /** The provider kind (`anthropic`, `openai-compatible`, `fake`). */
  readonly kind: string;
  /** The model, as review records name it. */
  readonly model: string;
  /** Where content goes: the endpoint's origin, for `config check` and logs. */
  readonly endpoint: string;
  /** One call; the answer parsed as JSON (not yet checked against the schema). Throws
   * `ProviderError` on any failure. */
  complete(request: CompletionRequest): Promise<unknown>;
}

/** A failed call. `code` is what records keep: `timeout`, `network`, `http_<status>`,
 * `refusal`, `truncated`, `invalid_json`, `invalid_answer`, `empty`. `retryable` says whether
 * sending the same request again could succeed (F3.4 retries those; the rest go straight to the
 * policy's `on_failure`). The message never holds content. */
export class ProviderError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ProviderError";
  }
}

/** Statuses worth sending again: timeouts, conflicts, rate limits, overload and server errors. */
export function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/** The error a status answers. */
export function statusError(status: number): ProviderError {
  return new ProviderError(
    `http_${status}`,
    retryableStatus(status),
    `the provider answered ${status}`,
  );
}

/** Parse a model's text answer as JSON. Tolerates a fenced block or prose around one object,
 * which models without constrained output sometimes add; anything else is `invalid_json`,
 * which is retried (F3.4: an answer that does not fit). */
export function parseAnswer(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") throw new ProviderError("empty", true, "the model answered nothing");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        // fall through
      }
    }
    throw new ProviderError("invalid_json", true, "the model's answer is not JSON");
  }
}

/** Whether `err` is a timeout or abort raised by fetch or `AbortSignal.timeout`. */
export function isTimeout(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "TimeoutError" || err.name === "AbortError" || /timed? ?out/i.test(err.name))
  );
}

/** An origin for display: scheme, host and port, never a path that might hold a key. */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "invalid-url";
  }
}
