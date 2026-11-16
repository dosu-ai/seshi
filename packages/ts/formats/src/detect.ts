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
