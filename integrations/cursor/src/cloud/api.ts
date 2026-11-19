/** The Cloud Agents API calls the Cursor Cloud poller makes (F7): list agents, list a run's
 * agent's runs, read a run and its usage, and replay a run's event stream. */

import type { CursorStreamEvent } from "./format";

export const CURSOR_API_URL = "https://api.cursor.com";

export class CursorApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "CursorApiError";
  }
}

/** The run's events are past Cursor's retention (`410`): they cannot be had any more. */
export class StreamExpired extends CursorApiError {
  constructor() {
    super("the run's events are past Cursor's retention (410)", 410);
    this.name = "StreamExpired";
  }
}

export interface CursorAgent {
  id: string;
  name?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  latestRunId?: string;
  repos?: { url?: string }[];
  [key: string]: unknown;
}

export interface CursorRun {
  id: string;
  agentId?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  durationMs?: number;
  git?: unknown;
  [key: string]: unknown;
}

/** Runs that have ended: their streams end too. */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "FINISHED",
  "ERROR",
  "CANCELLED",
  "EXPIRED",
]);

export interface CursorApiOptions {
  apiKey: string;
  baseUrl?: string;
  fetch(input: string, init: RequestInit): Promise<Response>;
  signal: AbortSignal;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** How many times a 429 or 5xx is tried again (default 2). */
  retries?: number;
  /** The wait before a retry when Cursor names none (default 2 s, doubling). */
  backoffMs?: number;
  /** How long a stream may send nothing before it counts as stalled (default 60 s). */
  readTimeoutMs?: number;
}

const PAGE = 100;
/** Pages read for one listing: 20,000 items. Past it the listing fails rather than leave the
 * rest out unsaid. */
const MAX_PAGES = 200;
const MAX_WAIT_MS = 60_000;

function retryAfter(response: Response, fallback: number): number {
  const header = response.headers.get("retry-after");
  const seconds = header !== null ? Number(header) : Number.NaN;
  return Math.min(
    Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : fallback,
    MAX_WAIT_MS,
  );
}

export class CursorApi {
  private readonly base: string;

  constructor(private readonly options: CursorApiOptions) {
    this.base = (options.baseUrl ?? CURSOR_API_URL).replace(/\/+$/, "");
  }

  private async request(path: string, accept: string): Promise<Response> {
    const retries = this.options.retries ?? 2;
    let wait = this.options.backoffMs ?? 2000;
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.options.fetch(`${this.base}${path}`, {
          headers: { Authorization: `Bearer ${this.options.apiKey}`, Accept: accept },
          signal: this.options.signal,
        });
      } catch (err) {
        if (this.options.signal.aborted) throw err;
        throw new CursorApiError(`Cursor could not be reached (${(err as Error).name})`);
      }
      if ((response.status === 429 || response.status >= 500) && attempt < retries) {
        await response.body?.cancel();
        await this.options.sleep(retryAfter(response, wait), this.options.signal);
        wait *= 2;
        continue;
      }
      return response;
    }
  }

  private async json<T>(path: string): Promise<T> {
    const response = await this.request(path, "application/json");
    if (!response.ok) throw await failure(response);
    try {
      return (await response.json()) as T;
    } catch {
      throw new CursorApiError(`Cursor's answer to ${path} is not JSON`, response.status);
    }
  }

  /** Every agent the key can see, archived ones too, newest first. */
  async listAgents(): Promise<CursorAgent[]> {
    return this.pages<CursorAgent>("/v1/agents");
  }

  /** The agent's runs, oldest first. */
  async listRuns(agentId: string): Promise<CursorRun[]> {
    const runs = await this.pages<CursorRun>(`/v1/agents/${encodeURIComponent(agentId)}/runs`);
    return runs.sort((a, b) =>
      (a.createdAt ?? "") === (b.createdAt ?? "")
        ? a.id.localeCompare(b.id)
        : (a.createdAt ?? "").localeCompare(b.createdAt ?? ""),
    );
  }

  async getRun(agentId: string, runId: string): Promise<CursorRun> {
    return this.json<CursorRun>(
      `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`,
    );
  }

  /** The run's entry of the agent's usage, or undefined when Cursor has none for it. */
  async runUsage(agentId: string, runId: string): Promise<Record<string, unknown> | undefined> {
    const answer = await this.json<{ runs?: { id?: string }[] }>(
      `/v1/agents/${encodeURIComponent(agentId)}/usage?runId=${encodeURIComponent(runId)}`,
    );
    const entry = (answer.runs ?? []).find((r) => r?.id === runId);
    return entry as Record<string, unknown> | undefined;
  }

  /** Every event of the run, replayed from its start, without heartbeats. Ends at `done`, or
   * where Cursor closed the stream. */
  async stream(agentId: string, runId: string): Promise<CursorStreamEvent[]> {
    const response = await this.request(
      `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/stream`,
      "text/event-stream",
    );
    if (response.status === 410) {
      await response.body?.cancel();
      throw new StreamExpired();
    }
    if (!response.ok) throw await failure(response);
    return this.readEvents(response, runId);
  }

  /** The stream's events as they arrive, up to `done`. Cursor closes the stream after `done`,
   * but the read does not wait for that, and a stream that sends nothing (not even a
   * heartbeat) for `readTimeoutMs` counts as stalled. */
  private async readEvents(response: Response, runId: string): Promise<CursorStreamEvent[]> {
    const events: CursorStreamEvent[] = [];
    if (!response.body) return events;
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    const timeout = this.options.readTimeoutMs ?? 60_000;
    let buffer = "";
    const take = (text: string): boolean => {
      for (const event of parseSse(text)) {
        if (event.event === "heartbeat") continue;
        events.push(event);
        if (event.event === "done") return true;
      }
      return false;
    };
    try {
      for (;;) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const stalled = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new CursorApiError(
                  `Cursor's stream for ${runId} sent nothing for ${timeout / 1000} s`,
                ),
              ),
            timeout,
          );
        });
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await Promise.race([reader.read(), stalled]);
        } finally {
          clearTimeout(timer);
        }
        if (chunk.done) break;
        buffer = (buffer + chunk.value).replace(/\r\n/g, "\n");
        const cut = buffer.lastIndexOf("\n\n");
        if (cut === -1) continue;
        if (take(buffer.slice(0, cut + 2))) return events;
        buffer = buffer.slice(cut + 2);
      }
      take(buffer);
      return events;
    } catch (err) {
      if (this.options.signal.aborted || err instanceof CursorApiError) throw err;
      throw new CursorApiError(`Cursor's stream broke off (${(err as Error).name})`);
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  private async pages<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({ limit: String(PAGE) });
      if (cursor) query.set("cursor", cursor);
      const answer = await this.json<{ items?: T[]; nextCursor?: string }>(`${path}?${query}`);
      items.push(...(answer.items ?? []));
      cursor = answer.nextCursor;
      if (!cursor) return items;
    }
    throw new CursorApiError(
      `${path} lists more than ${MAX_PAGES * PAGE} items; seshi reads at most that many`,
    );
  }
}

async function failure(response: Response): Promise<CursorApiError> {
  let detail = "";
  try {
    const body = (await response.json()) as { error?: { message?: unknown } | unknown };
    const message =
      typeof body === "object" && body !== null && "error" in body
        ? (body.error as { message?: unknown })?.message
        : undefined;
    if (typeof message === "string") detail = `: ${message.slice(0, 200)}`;
  } catch {
    // no JSON body
  }
  if (response.status === 401 || response.status === 403) {
    return new CursorApiError(
      `Cursor refused the API key (${response.status})${detail}`,
      response.status,
    );
  }
  return new CursorApiError(`Cursor answered ${response.status}${detail}`, response.status);
}

/** Server-sent events as Cursor sends them: an `id:`, an `event:` and a JSON `data:` per event,
 * events separated by a blank line. An event whose data is not a JSON object keeps `{}`. */
export function parseSse(body: string): CursorStreamEvent[] {
  const events: CursorStreamEvent[] = [];
  let event = "message";
  let id: string | undefined;
  let data: string[] = [];
  const flush = () => {
    if (data.length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.join("\n"));
      } catch {
        parsed = undefined;
      }
      const value =
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
      events.push({ ...(id !== undefined ? { id } : {}), event, data: value });
    }
    event = "message";
    id = undefined;
    data = [];
  };
  for (const raw of body.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const name = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (name === "event") event = value;
    else if (name === "id") id = value;
    else if (name === "data") data.push(value);
  }
  flush();
  return events;
}
