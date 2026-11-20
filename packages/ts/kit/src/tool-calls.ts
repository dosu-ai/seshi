/** Redacting tool calls (`capture.redact_tool_calls`): the pieces each capture agent's pass is
 * built from. A pass keeps what the person and the agent said, and each call's name, id, order
 * and whether it failed; it replaces every string in a call's input and in its result with
 * `TOOL_CALL_MARKER`.
 *
 * A pass names, per record kind of its format, the fields it keeps and the ones it walks into;
 * every other field is replaced whole (`reshape`, `blankUnknown`). So a record kind or a field the
 * format adds later loses its text instead of leaking a tool's output: a miss shows up as a marker
 * where text was, never as tool output that went out. Inside a call's input and its result, which
 * a pass knows, the structure stays (keys, numbers, booleans) and only strings go
 * (`blankStrings`). */

export const TOOL_CALL_MARKER = "[redacted:tool-call]";

type Json = Record<string, unknown>;

const NOTHING: ReadonlySet<string> = new Set();

export const isJsonObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `value` with every non-empty string in it replaced by `TOOL_CALL_MARKER`; object keys, numbers,
 * booleans and null stay, and so does the value of any key in `keep`, at any depth. */
export function blankStrings(value: unknown, keep: ReadonlySet<string> = NOTHING): unknown {
  if (typeof value === "string") return value === "" ? value : TOOL_CALL_MARKER;
  if (Array.isArray(value)) return value.map((v) => blankStrings(v, keep));
  if (isJsonObject(value)) {
    const next: Json = {};
    for (const [k, v] of Object.entries(value)) next[k] = keep.has(k) ? v : blankStrings(v, keep);
    return next;
  }
  return value;
}

const TYPE_ONLY: ReadonlySet<string> = new Set(["type"]);

/** A field a pass does not know: a string or a non-empty object or array is replaced by the marker
 * whole (its keys can be data too: a map keyed by file path); numbers, booleans, null and empty
 * values stay. */
export function blankUnknown(value: unknown): unknown {
  if (typeof value === "string") return value === "" ? value : TOOL_CALL_MARKER;
  if (Array.isArray(value)) return value.length === 0 ? value : TOOL_CALL_MARKER;
  if (isJsonObject(value)) return Object.keys(value).length === 0 ? value : TOOL_CALL_MARKER;
  return value;
}

/** A tool's result: its strings replaced, its blocks' `type` kept, so a result that was a list of
 * text and image blocks still is one. */
export function blankResult(value: unknown): unknown {
  return blankStrings(value, TYPE_ONLY);
}

/** A JSON-encoded input or output (Codex's `arguments`): the value it encodes with its strings
 * replaced, encoded again; a string that is not JSON is replaced whole. */
export function blankEncoded(value: unknown): unknown {
  if (typeof value !== "string") return blankStrings(value);
  const text = value.trim();
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      return JSON.stringify(blankStrings(JSON.parse(text)));
    } catch {}
  }
  return blankStrings(value);
}

/** How a pass treats one kind of record: the fields it keeps as they are, and the ones it rewrites
 * with a function of their own. */
export interface RecordShape {
  keep?: readonly string[];
  walk?: Readonly<Record<string, (value: unknown) => unknown>>;
}

/** `value` rewritten by `shape`, field by field; any field the shape does not name is replaced
 * (`blankUnknown`), and so is a value that is not an object. */
export function reshape(value: unknown, shape: RecordShape): unknown {
  if (!isJsonObject(value)) return blankUnknown(value);
  const next: Json = {};
  for (const [k, v] of Object.entries(value)) {
    const walk = shape.walk?.[k];
    next[k] = walk ? walk(v) : shape.keep?.includes(k) ? v : blankUnknown(v);
  }
  return next;
}

/** `text` with each record (a JSONL line, or the one JSON document) rewritten by `redact`. A
 * JSONL log keeps one line out per line in (blank lines stay), so a log and its chunks redact
 * alike; a line that does not parse is replaced by the marker, as a JSON string. A record
 * `redact` leaves as it was keeps its bytes. */
export function redactRecords(
  text: string,
  encoding: "jsonl" | "json",
  redact: (record: unknown) => unknown,
): string {
  const one = (line: string): string => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return JSON.stringify(TOOL_CALL_MARKER);
    }
    const before = JSON.stringify(parsed);
    const after = JSON.stringify(redact(parsed));
    return after === before ? line : after;
  };
  if (encoding === "json") return text.trim() ? one(text) : text;
  return text
    .split("\n")
    .map((line) => (line.trim() ? one(line) : line))
    .join("\n");
}
