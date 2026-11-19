import type { DocumentHead, FormatAdapter, HeadValue, JsonObject } from "@seshi/model";

type Json = JsonObject;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

/** The keys of the object at `from` in `text` (read no further than `end`) and what each holds.
 * An array's first element, when an object, is read too, one level down only (`first`). */
function documentHead(
  text: string,
  from = 0,
  end = text.length,
  nested = false,
): DocumentHead | null {
  let at = skipSpace(text, from, end);
  if (text[at] !== "{") return null;
  const head = new Map<string, HeadValue>();
  const array = (start: number, stop: number): HeadValue => {
    const element = skipSpace(text, start + 1, stop);
    const first = nested || text[element] !== "{" ? null : documentHead(text, element, stop, true);
    return first && first.size > 0 ? { kind: "array", first } : { kind: "array" };
  };
  at += 1;
  for (;;) {
    at = skipSpace(text, at, end);
    if (text[at] === ",") at = skipSpace(text, at + 1, end);
    if (at >= end || text[at] !== '"') return head;
    const keyEnd = skipValue(text, at, end);
    if (keyEnd < 0) return head;
    const key = JSON.parse(text.slice(at, keyEnd)) as string;
    at = skipSpace(text, keyEnd, end);
    if (text[at] !== ":") return head;
    at = skipSpace(text, at + 1, end);
    const valueEnd = skipValue(text, at, end);
    if (valueEnd < 0) {
      if (text[at] === "{") head.set(key, { kind: "object" });
      else if (text[at] === "[") head.set(key, array(at, end));
      return head;
    }
    const first = text[at];
    if (first === '"') {
      head.set(key, { kind: "string", text: JSON.parse(text.slice(at, valueEnd)) });
    } else if (first === "{") head.set(key, { kind: "object" });
    else if (first === "[") head.set(key, array(at, valueEnd));
    else head.set(key, { kind: "scalar" });
    at = valueEnd;
  }
}

function skipSpace(text: string, at: number, end = text.length): number {
  while (at < end && /\s/.test(text[at])) at += 1;
  return at;
}

function skipValue(text: string, at: number, end = text.length): number {
  let depth = 0;
  let inString = false;
  for (let i = at; i < end; i += 1) {
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
