import type { NormalizedRecord } from "@seshi/model";
import type { Attributes, Plain } from "./attributes";

type Json = { [key: string]: unknown };

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function jsonAttribute(value: Plain | undefined): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (text === "") return undefined;
  if (text[0] !== "[" && text[0] !== "{") return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

export function textOf(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const texts = value.map((item) => {
      if (typeof item === "string") return item;
      if (isObject(item)) {
        if (typeof item.text === "string") return item.text;
        if (typeof item.content === "string") return item.content;
        if (typeof item.type === "string" && Object.keys(item).length === 1)
          return `[${item.type}]`;
      }
      return undefined;
    });
    if (texts.every((t) => t !== undefined)) return texts.join("\n");
  }
  return JSON.stringify(value);
}

export function argsOf(value: unknown): string {
  if (value === undefined || value === null) return "{}";
  return typeof value === "string" ? value : JSON.stringify(value);
}

type Part =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "call"; id: string | undefined; name: string; args: string }
  | { kind: "result"; id: string | undefined; text: string; ok?: boolean };

function partOf(raw: unknown): Part | undefined {
  if (typeof raw === "string") return { kind: "text", text: raw };
  if (!isObject(raw)) return undefined;
  const type = typeof raw.type === "string" ? raw.type : undefined;
  const id = typeof raw.id === "string" && raw.id !== "" ? raw.id : undefined;
  switch (type) {
    case "text":
    case "input_text":
    case "output_text":
      return { kind: "text", text: textOf(raw.content ?? raw.text) };
    case "reasoning":
    case "thinking":
      return { kind: "reasoning", text: textOf(raw.content ?? raw.thinking ?? raw.text) };
    case "tool_call":
    case "tool_use":
    case "server_tool_use":
    case "mcp_tool_use":
    case "function_call": {
      const fn = isObject(raw.function) ? raw.function : undefined;
      const name = raw.name ?? fn?.name;
      if (typeof name !== "string" || name === "") return undefined;
      return {
        kind: "call",
        id: id ?? (typeof raw.call_id === "string" ? raw.call_id : undefined),
        name,
        args: argsOf(raw.arguments ?? raw.input ?? fn?.arguments),
      };
    }
    case "tool_call_response":
    case "tool_result":
    case "mcp_tool_result":
    case "function_call_output": {
      const callId =
        id ??
        (typeof raw.tool_use_id === "string" ? raw.tool_use_id : undefined) ??
        (typeof raw.call_id === "string" ? raw.call_id : undefined);
      const ok = raw.is_error === true ? false : undefined;
      return {
        kind: "result",
        id: callId,
        text: textOf(raw.response ?? raw.content ?? raw.output ?? raw.result),
        ...(ok === false ? { ok } : {}),
      };
    }
    default: {
      if (type?.endsWith("_tool_result")) {
        return { kind: "result", id: (raw.tool_use_id as string) ?? id, text: textOf(raw.content) };
      }
      if (type === undefined && typeof raw.content === "string") {
        return { kind: "text", text: raw.content };
      }
      if (type === undefined) return undefined;
      const modality = typeof raw.modality === "string" ? raw.modality : undefined;
      return { kind: "text", text: `[${modality ?? type.replace(/^anthropic_/, "")}]` };
    }
  }
}

function partsOf(message: Json): Part[] {
  const out: Part[] = [];
  const raw = Array.isArray(message.parts)
    ? message.parts
    : typeof message.content === "string"
      ? [message.content]
      : Array.isArray(message.content)
        ? message.content
        : [];
  for (const item of raw) {
    const part = partOf(item);
    if (part) out.push(part);
  }
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      const part = partOf({ type: "tool_call", ...(isObject(call) ? call : {}) });
      if (part) out.push(part);
    }
  }
  if (out.length === 0 && typeof message.tool_call_id === "string") {
    out.push({ kind: "result", id: message.tool_call_id, text: textOf(message.content) });
  } else if (typeof message.tool_call_id === "string") {
    for (const [i, part] of out.entries()) {
      if (part.kind === "text")
        out[i] = { kind: "result", id: message.tool_call_id, text: part.text };
    }
  }
  return out;
}

const joinText = (parts: Part[]) =>
  parts
    .filter((p): p is Extract<Part, { kind: "text" }> => p.kind === "text")
    .map((p) => p.text)
    .filter((t) => t !== "")
    .join("\n");

function anonymousId(prefix: string, n: number): string {
  return `${prefix}#${n}`;
}

export interface MessageContext {
  timestamp: string;
  idPrefix: string;
}

export function messageRecords(message: unknown, ctx: MessageContext, counter: { n: number }) {
  const records: NormalizedRecord[] = [];
  if (!isObject(message)) return records;
  const role = typeof message.role === "string" ? message.role.toLowerCase() : "user";
  const parts = partsOf(message);
  const { timestamp } = ctx;
  const resultRecord = (part: Extract<Part, { kind: "result" }>): NormalizedRecord => ({
    role: "tool",
    tool_call_id: part.id ?? anonymousId(ctx.idPrefix, counter.n++),
    content: part.text,
    ...(part.ok !== undefined ? { ok: part.ok } : {}),
    timestamp,
  });

  if (role === "system" || role === "developer") {
    const text = joinText(parts);
    if (text !== "") records.push({ role: "system", content: text, timestamp });
    return records;
  }
  if (role === "assistant" || role === "model") {
    for (const part of parts) {
      if (part.kind === "reasoning" && part.text !== "") {
        records.push({ role: "reasoning", content: part.text, timestamp });
      }
    }
    const text = joinText(parts);
    const calls = parts
      .filter((p): p is Extract<Part, { kind: "call" }> => p.kind === "call")
      .map((p) => ({
        id: p.id ?? anonymousId(ctx.idPrefix, counter.n++),
        name: p.name,
        args: p.args,
      }));
    if (calls.length > 0) {
      records.push({
        role: "assistant",
        content: text === "" ? null : text,
        tool_calls: calls,
        timestamp,
      });
    } else if (text !== "") {
      records.push({ role: "assistant", content: text, timestamp });
    }
    for (const part of parts) if (part.kind === "result") records.push(resultRecord(part));
    return records;
  }
  let pending: Part[] = [];
  const flush = () => {
    const text = joinText(pending);
    if (text !== "") {
      records.push(
        role === "tool"
          ? { role: "observation", content: text, timestamp }
          : { role: "user", content: text, timestamp },
      );
    }
    pending = [];
  };
  for (const part of parts) {
    if (part.kind === "result") {
      flush();
      records.push(resultRecord(part));
    } else if (part.kind === "call") {
      flush();
      records.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: part.id ?? anonymousId(ctx.idPrefix, counter.n++),
            name: part.name,
            args: part.args,
          },
        ],
        timestamp,
      });
    } else if (part.kind === "reasoning") {
      flush();
      if (part.text !== "") records.push({ role: "reasoning", content: part.text, timestamp });
    } else {
      pending.push(part);
    }
  }
  flush();
  return records;
}

export function messagesRecords(value: unknown, ctx: MessageContext, counter = { n: 0 }) {
  const parsed = jsonAttribute(value as Plain);
  if (parsed === undefined) return [];
  if (typeof parsed === "string") {
    return parsed.trim() === ""
      ? []
      : messageRecords({ role: "user", content: parsed }, ctx, counter);
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.flatMap((message) => messageRecords(message, ctx, counter));
}

export function systemRecords(value: unknown, timestamp: string): NormalizedRecord[] {
  const parsed = jsonAttribute(value as Plain);
  if (parsed === undefined) return [];
  const text =
    typeof parsed === "string"
      ? parsed
      : joinText(
          (Array.isArray(parsed) ? parsed : [parsed]).map(partOf).filter((p) => !!p) as Part[],
        );
  return text.trim() === "" ? [] : [{ role: "system", content: text, timestamp }];
}

type SparseIndex<T> = Map<number, T>;

function inIndexOrder<T>(index: SparseIndex<T>): T[] {
  return [...index.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value);
}

export function flattenedMessages(attrs: Attributes, prefix: string): Json[] {
  const byIndex: SparseIndex<Json> = new Map();
  const callsOf = new Map<Json, SparseIndex<Json>>();
  const lead = `${prefix}.`;
  for (const key of attrs.keysWith(lead)) {
    const rest = key.slice(lead.length);
    const match = /^(\d+)\.(.+)$/.exec(rest);
    if (!match) continue;
    const index = Number(match[1]);
    const field = match[2] as string;
    const message = byIndex.get(index) ?? {};
    byIndex.set(index, message);
    const value = attrs.get(key);
    const call = /^tool_calls\.(\d+)\.(id|name|arguments)$/.exec(field);
    if (call) {
      const calls: SparseIndex<Json> = callsOf.get(message) ?? new Map();
      callsOf.set(message, calls);
      const at = Number(call[1]);
      calls.set(at, { ...(calls.get(at) ?? {}), [call[2] as string]: value });
    } else if (field === "role" || field === "content" || field === "tool_call_id") {
      message[field] = value;
    }
  }
  return inIndexOrder(byIndex).map((message) => {
    const calls = callsOf.get(message);
    if (calls) message.tool_calls = inIndexOrder(calls);
    if (typeof message.content === "string") {
      const parsed = jsonAttribute(message.content);
      if (Array.isArray(parsed)) message.content = parsed;
    }
    return message;
  });
}
