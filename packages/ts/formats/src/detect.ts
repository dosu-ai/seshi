/** Which format wrote a transcript, from the start of the file: for a caller that holds raw logs
 * and does not know which agent wrote them (a bucket of them, say). The rules are the adapters'
 * own (`FormatAdapter.detect`); this module only reads the sample.
 *
 * Two kinds of file. A document format (ATIF, an OpenCode export, a Gemini CLI session) is one
 * JSON object, told apart by its top-level keys, which a truncated sample still has: they are
 * read from the prefix without parsing the whole. A JSONL format is told apart by its records'
 * shape; each format has a predicate for a record only it writes, and the sample is that format's
 * when its records match one format's predicate and no other's. A sample whose records match
 * none, or more than one, is `null`: a guess would file a session under the wrong archive. */

import type { DocumentHead, FormatAdapter, HeadValue, JsonObject } from "@seshi/model";

type Json = JsonObject;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The format whose distinctive shape `sample` (the start of one file, any length; its last line
 * may be cut short) matches among `adapters`, or `null` when it matches none or more than one. */
export function detectFormat(adapters: readonly FormatAdapter[], sample: string): string | null {
  const text = sample.replace(/^\uFEFF/, "");
  const head = documentHead(text);
  if (head) {
    const documents = adapters.filter((adapter) => adapter.detect?.document?.(head) === true);
    if (documents.length > 0) return documents.length === 1 ? documents[0].source : null;
  }
  const rows = jsonLines(text);
  if (!rows) return null;
  const found = new Set<string>();
  for (const row of rows) {
    for (const adapter of adapters)
      if (adapter.detect?.record?.(row) === true) found.add(adapter.source);
  }
  return found.size === 1 ? [...found][0] : null;
}

/** The sample's lines as JSON objects, less a last line that does not parse (cut short), or
 * `null` when any other line is not a JSON object: then it is not JSONL. */
function jsonLines(text: string): Json[] | null {
  const lines = text.split("\n");
  const rows: Json[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      if (index === lines.length - 1) break;
      return null;
    }
    if (!isObject(value)) return null;
    rows.push(value);
  }
  return rows;
}

/** The top-level keys of the JSON object `text` starts with, as far as `text` goes, or `null`
 * when it does not start with one. A key whose value is cut short is left out. */
function documentHead(text: string): DocumentHead | null {
  let at = skipSpace(text, 0);
  if (text[at] !== "{") return null;
  const head = new Map<string, HeadValue>();
  at += 1;
  for (;;) {
    at = skipSpace(text, at);
    if (text[at] === ",") at = skipSpace(text, at + 1);
    if (text[at] !== '"') return head;
    const keyEnd = skipValue(text, at);
    if (keyEnd < 0) return head;
    const key = JSON.parse(text.slice(at, keyEnd)) as string;
    at = skipSpace(text, keyEnd);
    if (text[at] !== ":") return head;
    at = skipSpace(text, at + 1);
    const end = skipValue(text, at);
    if (end < 0) {
      // Cut short inside the value; its kind is still known.
      const kind = text[at] === "{" ? "object" : text[at] === "[" ? "array" : undefined;
      if (kind) head.set(key, { kind });
      return head;
    }
    const first = text[at];
    if (first === '"') head.set(key, { kind: "string", text: JSON.parse(text.slice(at, end)) });
    else if (first === "{") head.set(key, { kind: "object" });
    else if (first === "[") head.set(key, { kind: "array" });
    else head.set(key, { kind: "scalar" });
    at = end;
  }
}

function skipSpace(text: string, at: number): number {
  while (at < text.length && /\s/.test(text[at])) at += 1;
  return at;
}

/** The index just past the JSON value starting at `at`, or -1 when the text ends inside it. */
function skipValue(text: string, at: number): number {
  let depth = 0;
  let inString = false;
  for (let i = at; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i += 1;
      else if (c === '"') {
        inString = false;
        if (depth === 0) return i + 1;
      }
    } else if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth += 1;
    else if (c === "}" || c === "]") {
      depth -= 1;
      if (depth === 0) return i + 1;
      if (depth < 0) return i;
    } else if (depth === 0 && (c === "," || /\s/.test(c))) return i;
  }
  return -1;
}
