/** Tool results in Cursor sessions. Cursor's agent transcript records each tool call, never what
 * it returned. Its hooks see the results: `postToolUse` (and `postToolUseFailure` for a call that
 * failed) gets every tool's output, and `beforeReadFile` gets the text of a file the agent reads,
 * which `postToolUse` leaves out of a Read (it gives only the file's length). So seshi keeps each
 * result beside the session as the hook sees it, and at upload builds the file it sends: the
 * transcript's lines with each result added after the call it answers.
 *
 * What Cursor sends (recorded with Cursor 2026.11, docs/capture.md#tool-results-in-cursor):
 * every tool hook carries a `tool_use_id`, but the transcript's calls carry no id, and the hook's
 * tool name and input often differ from the transcript's (a StrReplace is a Read and a Write
 * under one id; an MCP call is `MCP:<tool>` there and `CallDynamicTool` here). Cursor runs a
 * call's `postToolUse` before it writes the line that holds the call, so the results for a line are
 * all kept by the time the line can be read. A line's calls are matched to results in the order the
 * results came, each to the first one of the same kind of tool (and the same command, path, search
 * or MCP arguments, when both say).
 *
 * Loaded alone by `seshi hook cursor <event>`, so it imports only `@seshi/kit` and `node:`
 * modules (X3.3). */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type CaptureHost, keptSessionDir, type TranscriptComposer } from "@seshi/kit";

/** The most of one result kept, in characters: the head and the tail, with the cut marked. The
 * normalizer keeps less of each result in the stored session (2,500 characters); this bounds what
 * waits on the machine and what is redacted before upload. */
export const RESULT_MAX_CHARS = 32_000;

/** The hook events that keep a result. */
export const RESULT_EVENTS = ["postToolUse", "postToolUseFailure", "beforeReadFile"] as const;

/** One kept result: what `compose` reads back. */
export interface KeptResult {
  v: 1;
  event: (typeof RESULT_EVENTS)[number];
  /** Cursor's `tool_use_id`. */
  id: string;
  /** The hook's tool name (`Shell`, `Read`, `MCP:<tool>`), absent for `beforeReadFile`. */
  tool?: string;
  /** What the call ran on (a command, a path, a search, MCP arguments), to tell calls apart. */
  key?: string;
  text: string;
  /** Characters cut from the middle of `text`. */
  cut?: number;
  error?: true;
  at?: string;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `text` at most `max` characters long: its head and tail around a marker saying how much went. */
export function capText(text: string, max = RESULT_MAX_CHARS): { text: string; cut?: number } {
  if (text.length <= max) return { text };
  const half = Math.floor(max / 2);
  let head = half;
  let tail = text.length - half;
  // Never split a surrogate pair.
  if (/[\ud800-\udbff]/.test(text[head - 1] ?? "")) head--;
  if (/[\udc00-\udfff]/.test(text[tail] ?? "")) tail++;
  const cut = tail - head;
  return {
    text: `${text.slice(0, head)}\n[… ${cut} characters cut by seshi …]\n${text.slice(tail)}`,
    cut,
  };
}

/** Which kind of tool a name is, the same for the hook's name and the transcript's. */
function family(name: string): string {
  if (name.startsWith("MCP:")) return `mcp:${name.slice(4)}`;
  switch (name) {
    case "Shell":
      return "shell";
    case "Read":
      return "read";
    case "Write":
    case "StrReplace":
    case "Edit":
    case "MultiEdit":
    case "EditNotebook":
    case "ApplyPatch":
      return "edit";
    case "Delete":
      return "delete";
    case "Grep":
    case "Glob":
      return "search";
    default:
      return name.toLowerCase();
  }
}

/** Object keys in order, so the same arguments read the same from the hook and the transcript. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

const PATH_KINDS = new Set(["read", "edit", "delete"]);

/** A path as `/`-separated, without a leading `./`. */
const slashed = (path: string) => path.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");

/** A digest of a key that can be long (a command, MCP arguments): it tells calls apart as well,
 * and keeps no second copy of the command line beside the session. */
const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32);

/** What a call ran on, for its kind: the same value from the hook's input and the transcript's. */
function keyOf(kind: string, input: unknown): string | undefined {
  if (!isObject(input)) return undefined;
  if (kind.startsWith("mcp:")) return digest(canonical(input));
  switch (kind) {
    case "shell": {
      const command = str(input.command);
      return command ? digest(command) : undefined;
    }
    case "read":
    case "edit":
    case "delete": {
      const path = str(input.file_path) ?? str(input.path);
      return path ? slashed(path) : undefined;
    }
    case "search": {
      // A Glob is a Grep with no pattern to its hook; only a real pattern tells calls apart.
      const pattern = str(input.pattern);
      return pattern ? digest(pattern) : undefined;
    }
    default:
      return undefined;
  }
}

/** Two keys name the same thing: equal, or for a path, one the other's tail (the transcript keeps
 * the path as the model wrote it, relative or not; the hooks give it absolute). */
function sameKey(kind: string, a: string, b: string): boolean {
  if (a === b) return true;
  return PATH_KINDS.has(kind) && (a.endsWith(`/${b}`) || b.endsWith(`/${a}`));
}

/** A result's text from what `postToolUse` gives, a JSON string for most tools. */
function outputText(kind: string, output: unknown): { text: string; error?: true } {
  if (typeof output !== "string") return { text: output === undefined ? "" : canonical(output) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return { text: output };
  }
  if (!isObject(parsed)) return { text: output };
  if (kind === "shell" && typeof parsed.output === "string") {
    const code = parsed.exitCode;
    return {
      text: parsed.output,
      ...(typeof code === "number" && code !== 0 ? { error: true as const } : {}),
    };
  }
  if (kind.startsWith("mcp:") && Array.isArray(parsed.content)) {
    const text = parsed.content
      .map((part) =>
        isObject(part) && part.type === "text" && typeof part.text === "string"
          ? part.text
          : canonical(part),
      )
      .join("\n");
    return { text, ...(parsed.isError === true ? { error: true as const } : {}) };
  }
  return { text: output };
}

/** What a result hook's payload keeps, or undefined for one that carries none (no tool id: a file
 * Cursor reads for itself, not for a call). */
export function keptResult(event: string, payload: Json): KeptResult | undefined {
  const id = str(payload.tool_use_id);
  if (!id) return undefined;
  if (event === "beforeReadFile") {
    const content = payload.content;
    if (typeof content !== "string") return undefined;
    const path = str(payload.file_path);
    return { v: 1, event, id, ...(path ? { key: slashed(path) } : {}), ...capText(content) };
  }
  if (event !== "postToolUse" && event !== "postToolUseFailure") return undefined;
  const tool = str(payload.tool_name) ?? "unknown";
  const kind = family(tool);
  const key = keyOf(kind, payload.tool_input);
  const out =
    event === "postToolUseFailure"
      ? {
          text: str(payload.error_message) ?? str(payload.failure_type) ?? "failed",
          error: true as const,
        }
      : outputText(kind, payload.tool_output);
  const { text, cut } = capText(out.text);
  return {
    v: 1,
    event,
    id,
    tool,
    ...(key ? { key } : {}),
    text,
    ...(cut ? { cut } : {}),
    ...(out.error ? { error: true as const } : {}),
  };
}

/** The results kept under one tool id, in the order they came: one call's, though Cursor fires
 * more than one hook for some calls (a StrReplace reads the file, then writes it). */
interface Group {
  id: string;
  /** Order of its first result. */
  order: number;
  kind: string;
  key?: string;
  text: string;
  cut?: number;
  error?: true;
  files: string[];
}

function groupsOf(kept: readonly { file: string; result: KeptResult }[]): Group[] {
  const byId = new Map<string, { file: string; result: KeptResult }[]>();
  for (const item of kept) {
    const list = byId.get(item.result.id) ?? [];
    list.push(item);
    byId.set(item.result.id, list);
  }
  const groups: Group[] = [];
  let order = 0;
  for (const [id, items] of byId) {
    // The call's own result is its last postToolUse(Failure) but for a Read: a StrReplace or a
    // Write reads the file first, under the same id (a Read's text comes from beforeReadFile).
    const posts = items.filter((i) => i.result.event !== "beforeReadFile");
    const last = (posts.filter((i) => i.result.tool !== "Read").at(-1) ?? posts.at(-1))?.result;
    const read = items.filter((i) => i.result.event === "beforeReadFile").at(-1)?.result;
    const kind = last?.tool ? family(last.tool) : "read";
    const own = kind === "read" && read && !last?.error ? read : (last ?? read);
    if (!own) continue;
    groups.push({
      id,
      order: order++,
      kind,
      ...((last?.key ?? read?.key) ? { key: last?.key ?? read?.key } : {}),
      text: own.text,
      ...(own.cut ? { cut: own.cut } : {}),
      ...(own.error ? { error: true as const } : {}),
      files: items.map((i) => i.file),
    });
  }
  return groups;
}

/** A transcript call's kind and key, as a result's: Cursor's own tools called through
 * `CallDynamicTool` are named in its input, and any other namespace is an MCP server. */
function callOf(block: Json): { kind: string; key?: string } {
  const name = str(block.name) ?? "";
  const input = block.input;
  if ((name === "CallDynamicTool" || name === "CallMcpTool") && isObject(input)) {
    const tool = str(input.toolName) ?? "";
    const namespace = str(input.namespace);
    const kind = namespace === "cursor" ? family(tool) : `mcp:${tool}`;
    const args = input.arguments ?? input.args;
    const key = kind.startsWith("mcp:") ? digest(canonical(args ?? {})) : keyOf(kind, args);
    return { kind, ...(key ? { key } : {}) };
  }
  const kind = family(name);
  const key = keyOf(kind, input);
  return { kind, ...(key ? { key } : {}) };
}

const fits = (call: { kind: string; key?: string }, group: Group): boolean =>
  call.kind === group.kind &&
  (call.key === undefined || group.key === undefined || sameKey(call.kind, call.key, group.key));

/** One transcript line as uploaded: as it is, or, when results answer its calls, with each answered
 * call given its tool id, followed by the results, one line each. */
function composeLine(
  line: string,
  open: Group[],
  used: Set<Group>,
): { text: string; matched: Group[] } {
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return { text: `${line}\n`, matched: [] };
  }
  if (!isObject(row) || row.role !== "assistant" || !isObject(row.message)) {
    return { text: `${line}\n`, matched: [] };
  }
  const content = row.message.content;
  if (!Array.isArray(content)) return { text: `${line}\n`, matched: [] };
  const matched: Group[] = [];
  const blocks = content.map((block) => {
    if (!isObject(block) || block.type !== "tool_use" || str(block.id)) return block;
    const call = callOf(block);
    const group = open.find((g) => !used.has(g) && fits(call, g));
    if (!group) return block;
    used.add(group);
    matched.push(group);
    const { type, ...rest } = block;
    return { type, id: group.id, ...rest };
  });
  if (matched.length === 0) return { text: `${line}\n`, matched };
  let text = `${JSON.stringify({ ...row, message: { ...row.message, content: blocks } })}\n`;
  for (const g of matched) {
    text += `${JSON.stringify({
      role: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: g.id,
            content: g.text,
            ...(g.error ? { is_error: true } : {}),
          },
        ],
      },
    })}\n`;
  }
  return { text, matched };
}

interface ComposeState {
  v: 1;
  /** Bytes of the transcript composed so far; where the last of its lines starts, and its hash. */
  offset: number;
  tailAt: number;
  tail: string;
  /** Bytes of the composed file this state was saved with. */
  size: number;
  /** Result files taken (matched to a call, or let go), removed once this state is saved. */
  done: string[];
  /** Result files no call has taken yet, with when compose first saw them. */
  waiting: Record<string, number>;
  /** What was composed from: the transcript's size and the results folder's mtime, so a session
   * where neither changed is not read again. */
  seen?: { size: number; results: number };
}

/** How long a result no call takes is kept waiting for its call's line: Cursor writes the line as
 * soon as the hook returns, so one still waiting after this never gets one. */
export const WAIT_MS = 60_000;

const fresh = (): ComposeState => ({
  v: 1,
  offset: 0,
  tailAt: 0,
  tail: "",
  size: 0,
  done: [],
  waiting: {},
});

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function readState(path: string): ComposeState {
  try {
    const s = JSON.parse(readFileSync(path, "utf8")) as ComposeState;
    if (s?.v === 1 && Number.isSafeInteger(s.offset) && Number.isSafeInteger(s.tailAt)) {
      return { ...fresh(), ...s };
    }
  } catch {}
  return fresh();
}

function statOf(path: string): { size: number; mtimeMs: number } | undefined {
  try {
    const st = statSync(path);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return undefined;
  }
}

const sizeOf = (path: string) => statOf(path)?.size;

function readRange(path: string, start: number, end: number): Buffer {
  const length = Math.max(0, end - start);
  const buffer = Buffer.alloc(length);
  if (length === 0) return buffer;
  const fd = openSync(path, "r");
  let read = 0;
  try {
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, start + read);
      if (n === 0) break;
      read += n;
    }
  } finally {
    closeSync(fd);
  }
  return buffer.subarray(0, read);
}

/** The last line of the transcript composed so far still reads the same: the transcript only grew
 * since. */
function sameTail(transcript: string, state: ComposeState): boolean {
  if (state.offset === 0) return true;
  const last = readRange(transcript, state.tailAt, state.offset);
  return last.length === state.offset - state.tailAt && hash(last) === state.tail;
}

function writePrivate(path: string, text: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  renameSync(temp, path);
}

function readKept(dir: string): { file: string; result: KeptResult }[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: { file: string; result: KeptResult }[] = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    try {
      const result = JSON.parse(readFileSync(join(dir, name), "utf8")) as KeptResult;
      if (result?.v === 1 && typeof result.id === "string" && typeof result.text === "string") {
        out.push({ file: name, result });
      }
    } catch {}
  }
  return out;
}

const removeAll = (dir: string, names: readonly string[]) => {
  for (const name of names) rmSync(join(dir, name), { force: true });
};

export function composedPath(sessionId: string, host: CaptureHost): string | undefined {
  const dir = keptSessionDir(host, "cursor", sessionId);
  return dir ? join(dir, "transcript.jsonl") : undefined;
}

/** Nothing for `composeCursorTranscript` to do: the transcript and the kept results are as they
 * were when it last ran. */
export function composedIsCurrent(sessionId: string, transcript: string, host: CaptureHost) {
  const dir = keptSessionDir(host, "cursor", sessionId);
  if (!dir) return false;
  const state = readState(join(dir, "compose.json"));
  const total = sizeOf(transcript);
  return (
    state.seen !== undefined &&
    total === state.seen.size &&
    (statOf(join(dir, "results"))?.mtimeMs ?? 0) === state.seen.results &&
    sizeOf(join(dir, "transcript.jsonl")) === state.size
  );
}

/** Bring the file uploaded for a Cursor session up to date: the transcript's new complete lines,
 * each call in them that a kept result answers given that result's tool id and followed by it.
 * It only ever appends, except when the transcript no longer starts with what was composed (Cursor
 * rewrote it), when it starts over, as the transcript itself would have, with the results not yet
 * taken: a taken result is removed once composed. A result kept after its call was composed, or one
 * no call takes, is let go: Cursor runs the hook before it writes the call, so neither happens
 * unless the hook failed. */
export function composeCursorTranscript(
  sessionId: string,
  transcript: string,
  host: CaptureHost,
  now: number = Date.now(),
): string {
  const dir = keptSessionDir(host, "cursor", sessionId);
  if (!dir) return transcript;
  const out = join(dir, "transcript.jsonl");
  const statePath = join(dir, "compose.json");
  const resultsDir = join(dir, "results");
  const total = sizeOf(transcript);
  if (total === undefined) return sizeOf(out) === undefined ? transcript : out;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let state = readState(statePath);
  // Taken before a crash cut this short of removing them.
  removeAll(resultsDir, state.done);
  const size = sizeOf(out);
  if (
    size === undefined ||
    size < state.size ||
    total < state.offset ||
    !sameTail(transcript, state)
  ) {
    // Cursor rewrote the transcript, or the composed file is gone: start over.
    state = fresh();
    writeFileSync(out, "", { mode: 0o600 });
  } else if (size > state.size) {
    // Written but not recorded: nothing past the recorded size was uploaded (the uploader composes
    // and then reads, in turn), so it is written again.
    truncateSync(out, state.size);
  }
  const bytes = readRange(transcript, state.offset, total);
  const complete = bytes.subarray(0, bytes.lastIndexOf(0x0a) + 1);
  const groups = groupsOf(readKept(resultsDir));
  const used = new Set<Group>();
  let text = "";
  let tailAt = state.tailAt;
  let tail = state.tail;
  for (let start = 0; start < complete.length; ) {
    const end = complete.indexOf(0x0a, start);
    tailAt = state.offset + start;
    tail = hash(complete.subarray(start, end + 1));
    const line = complete.subarray(start, end).toString("utf8");
    start = end + 1;
    text +=
      line.trim() === "" || groups.length === 0
        ? `${line}\n`
        : composeLine(line, groups, used).text;
  }
  // Results that came before the last one taken were for calls already written, and one left
  // waiting past WAIT_MS has no call coming: none of the lines still to come is theirs.
  const latest = Math.max(-1, ...[...used].map((g) => g.order));
  const waiting: Record<string, number> = {};
  const done: string[] = [];
  for (const g of groups) {
    const since = Math.min(...g.files.map((f) => state.waiting[f] ?? now));
    if (used.has(g) || g.order < latest || now - since >= WAIT_MS) done.push(...g.files);
    else for (const f of g.files) waiting[f] = since;
  }
  if (text) appendFileSync(out, text, { mode: 0o600 });
  const next: ComposeState = {
    v: 1,
    offset: state.offset + complete.length,
    tailAt,
    tail,
    size: sizeOf(out) ?? 0,
    done,
    waiting,
  };
  writePrivate(statePath, JSON.stringify(next));
  removeAll(resultsDir, done);
  next.done = [];
  next.seen = { size: total, results: statOf(resultsDir)?.mtimeMs ?? 0 };
  writePrivate(statePath, JSON.stringify(next));
  return out;
}

export const cursorComposer: TranscriptComposer = {
  update: (sessionId, transcript, host) => composeCursorTranscript(sessionId, transcript, host),
  current: composedIsCurrent,
  path(sessionId, host) {
    const path = composedPath(sessionId, host);
    return path && sizeOf(path) !== undefined ? path : undefined;
  },
};
