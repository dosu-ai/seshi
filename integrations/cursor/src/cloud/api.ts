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
}

const PAGE = 100;
const MAX_PAGES = 50;
const MAX_WAIT_MS = 60_000;

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

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
    let body: string;
    try {
      body = await response.text();
    } catch (err) {
      if (this.options.signal.aborted) throw err;
      throw new CursorApiError(`Cursor's stream broke off (${(err as Error).name})`);
    }
    const events: CursorStreamEvent[] = [];
    for (const event of parseSse(body)) {
      if (event.event === "heartbeat") continue;
      events.push(event);
      if (event.event === "done") break;
    }
    return events;
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
    return items;
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
