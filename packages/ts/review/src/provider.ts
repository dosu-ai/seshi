export interface CompletionRequest {
  system: string;
  user: string;
  schema: Readonly<Record<string, unknown>>;
  schemaName: string;
  maxTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ModelProvider {
  readonly kind: string;
  readonly model: string;
  readonly endpoint: string;
  complete(request: CompletionRequest): Promise<unknown>;
}

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

export function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

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
      } catch {}
    }
    throw new ProviderError("invalid_json", true, "the model's answer is not JSON");
  }
}

export function isTimeout(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "TimeoutError" || err.name === "AbortError" || /timed? ?out/i.test(err.name))
  );
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "invalid-url";
  }
}
