/** `cursor-cloud-api`: a Cursor Cloud agent's runs as the Cloud Agents API streams them (F7).
 *
 * The log is JSONL, one line per run, appended in run order as each run finishes: the run as
 * Get A Run describes it, its token usage, and its stream events as Cursor sent them (`GET
 * /v1/agents/{id}/runs/{runId}/stream`), minus the deltas that repeat other events (below). A
 * line is a whole run, so the log cuts at run boundaries and every chunk normalizes on its own:
 * the chunks' records, concatenated, are the whole log's.
 *
 * The events are kept as Cursor sent them because what this adapter makes of them is all that
 * is kept (X6.3): the stream is gone 24 hours after the run. Cursor's own local transcript format
 * would drop event times, tool results and call ids.
 *
 * What the stream carries: the user message (`interaction_update` `user-message-appended`), the
 * agent's words (`assistant`) and thinking (`thinking`) as deltas, and each tool call
 * (`tool_call`, `running` then `completed`) with its arguments and result. Event ids are
 * `<epoch ms>-<n>`, which dates every record. What it does not carry: the contents of a file the
 * agent read (a `read_file` result has its path, size and line count only), and shell output
 * past its last ~5,000 characters (`interleavedOutput` keeps the tail after an "earlier output
 * omitted" note). */

import type {
  AssistantMessageRecord,
  AssistantToolCallRecord,
  MetaRecord,
  NormalizedRecord,
  ReasoningRecord,
  ToolResultRecord,
  UserRecord,
} from "@seshi/model";

export const CURSOR_CLOUD_API = "cursor-cloud-api" as const;

/** One stream event: Cursor's SSE `id`, `event` and parsed `data`. */
export interface CursorStreamEvent {
  id?: string;
  event: string;
  data: Record<string, unknown>;
}

/** One line of the log: one run. */
export interface CursorRunLine {
  type: "cursor_cloud_run";
  agent_id: string;
  run_id: string;
  /** The run from Get A Run (`status`, `createdAt`, `durationMs`, `git`, …), as Cursor sent it. */
  run: Record<string, unknown>;
  /** The run's entry of `GET /v1/agents/{id}/usage`, when Cursor gave one. */
  usage?: Record<string, unknown>;
  events: CursorStreamEvent[];
}

/** `interaction_update` types that repeat what other events carry: the text and thinking
 * deltas (also sent as `assistant` and `thinking` events) and running token counts. Left out of
 * the log, they would be most of a run's events. */
export const REPEATED_UPDATES: ReadonlySet<string> = new Set([
  "text-delta",
  "thinking-delta",
  "token-delta",
]);

/** Fields Cursor adds to a call's arguments about the call itself: its ids, the agent's id and
 * its own parse of a shell command. */
const ARG_NOISE = new Set([
  "toolCallId",
  "conversationId",
  "requestId",
  "simpleCommands",
  "parsingResult",
  "hasOutputRedirect",
]);

type Json = Record<string, unknown>;

class CursorCloudFormatError extends Error {
  constructor(
    readonly code: "invalid_input" | "missing_user_records" | "missing_assistant_records",
    message: string,
  ) {
    super(message);
    this.name = "CursorCloudFormatError";
  }
}

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** Whether a parsed line is a run line: what detection looks for. */
export function isRunLine(row: Json): boolean {
  return (
    row.type === "cursor_cloud_run" &&
    typeof row.agent_id === "string" &&
    typeof row.run_id === "string" &&
    Array.isArray(row.events)
  );
}

function parseLines(transcript: string): CursorRunLine[] {
  const lines: CursorRunLine[] = [];
  const raw = transcript.split("\n");
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i] as string;
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new CursorCloudFormatError("invalid_input", `line ${i + 1} is not JSON`);
    }
    if (!isObject(value) || !isRunLine(value)) {
      throw new CursorCloudFormatError("invalid_input", `line ${i + 1} is not a Cursor Cloud run`);
    }
    lines.push(value as unknown as CursorRunLine);
  }
  return lines;
}

/** When an event happened, from its id (`<epoch ms>-<n>`); undefined without one. */
export function eventTime(event: CursorStreamEvent): string | undefined {
  const ms = (event.id ?? "").split("-")[0] ?? "";
  if (!/^\d+$/.test(ms)) return undefined;
  const date = new Date(Number(ms));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function cleanArgs(args: unknown): Json {
  if (!isObject(args)) return {};
  return Object.fromEntries(Object.entries(args).filter(([k]) => !ARG_NOISE.has(k)));
}

/** What a tool returned, as text, and whether it succeeded. Cursor wraps a result as
 * `{ success: {...} }`, or another single key for a failure (`error`, `failure`, `rejected`,
 * `spawnError`, …). A shell result's text is its output; anything else is its JSON. */
export function resultText(result: unknown, truncated: unknown): { content: string; ok: boolean } {
  let ok = true;
  let body: unknown = result;
  if (isObject(result)) {
    if ("success" in result) {
      body = result.success;
    } else {
      const key = Object.keys(result).find((k) => k !== "isBackground");
      if (key !== undefined) {
        ok = false;
        body = { [key]: result[key] };
      }
    }
  }
  let content: string;
  if (ok && isObject(body) && (text(body.interleavedOutput) ?? text(body.stdout)) !== undefined) {
    const output = text(body.interleavedOutput) ?? text(body.stdout) ?? "";
    const stderr = text(body.interleavedOutput) === undefined ? text(body.stderr) : undefined;
    content = stderr
      ? `${output}${output.endsWith("\n") || output === "" ? "" : "\n"}${stderr}`
      : output;
  } else if (typeof body === "string") {
    content = body;
  } else if (body === undefined || body === null) {
    content = "";
  } else {
    content = JSON.stringify(body);
  }
  if (truncated === true) content += "\n[truncated by Cursor]";
  return { content, ok };
}

function runRecords(line: CursorRunLine): NormalizedRecord[] {
  const records: NormalizedRecord[] = [];
  const created = text(line.run.createdAt) ?? new Date(0).toISOString();
  let last = created;
  const at = (event: CursorStreamEvent) => {
    const time = eventTime(event);
    if (time !== undefined && time >= last) last = time;
    return last;
  };
  let words: { role: "assistant" | "reasoning"; content: string; timestamp: string } | undefined;
  const settle = () => {
    if (!words) return;
    if (words.content !== "") {
      records.push(
        words.role === "assistant"
          ? ({
              role: "assistant",
              content: words.content,
              timestamp: words.timestamp,
            } as AssistantMessageRecord)
          : ({
              role: "reasoning",
              content: words.content,
              timestamp: words.timestamp,
            } as ReasoningRecord),
      );
    }
    words = undefined;
  };
  const say = (role: "assistant" | "reasoning", delta: string, timestamp: string) => {
    if (words && words.role !== role) settle();
    if (!words) words = { role, content: "", timestamp };
    words.content += delta;
  };
  const called = new Set<string>();
  const answered = new Set<string>();

  for (const event of line.events) {
    const data = isObject(event.data) ? event.data : {};
    if (event.event === "interaction_update" && data.type === "user-message-appended") {
      const message = isObject(data.userMessage) ? data.userMessage : {};
      const content = text(message.text);
      if (content === undefined) continue;
      settle();
      records.push({ role: "user", content, timestamp: at(event) } as UserRecord);
    } else if (event.event === "assistant") {
      say("assistant", text(data.text) ?? "", at(event));
    } else if (event.event === "thinking") {
      say("reasoning", text(data.text) ?? "", at(event));
    } else if (event.event === "tool_call") {
      const id = text(data.callId);
      if (!id) continue;
      const timestamp = at(event);
      if (!called.has(id)) {
        settle();
        called.add(id);
        records.push({
          role: "assistant",
          content: null,
          tool_calls: [
            { id, name: text(data.name) || "tool", args: JSON.stringify(cleanArgs(data.args)) },
          ],
          timestamp,
        } as AssistantToolCallRecord);
      }
      if (data.status === "completed" && !answered.has(id)) {
        answered.add(id);
        settle();
        const { content, ok } = resultText(data.result, data.truncated);
        records.push({
          role: "tool",
          tool_call_id: id,
          content,
          ok,
          timestamp,
        } as ToolResultRecord);
      }
    }
  }
  settle();
  return records;
}

function metaOf(first: CursorRunLine): MetaRecord {
  const meta: MetaRecord = { role: "meta", source: CURSOR_CLOUD_API };
  const git = isObject(first.run.git) ? first.run.git : {};
  const branches = Array.isArray(git.branches) ? git.branches : [];
  const branch = branches.map((b) => (isObject(b) ? text(b.branch) : undefined)).find((b) => !!b);
  if (branch) meta.git_branch = branch;
  return meta;
}

/** The log's records: a meta record (for the whole log, not a chunk), then each run's user
 * message, the agent's thinking and words, and its tool calls with their results. */
export function normalizeCursorCloud(
  transcript: string,
  options: { partial?: boolean } = {},
): NormalizedRecord[] {
  const lines = parseLines(transcript);
  const records: NormalizedRecord[] = [];
  for (const line of lines) records.push(...runRecords(line));
  if (!options.partial) {
    if (!records.some((r) => r.role === "user")) {
      throw new CursorCloudFormatError("missing_user_records", "no run has a user message yet");
    }
    if (!records.some((r) => r.role === "assistant")) {
      throw new CursorCloudFormatError("missing_assistant_records", "no run has an agent turn yet");
    }
    records.unshift(metaOf(lines[0] as CursorRunLine));
  }
  return records;
}
