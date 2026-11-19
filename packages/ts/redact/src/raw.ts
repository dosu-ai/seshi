import type { RawFormat } from "@seshi/model";
import { redactSecrets } from "./secrets";

function redactString(text: string): string {
  return redactSecrets(text).text;
}

function redactStrings(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactStrings);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactStrings(v)]));
  }
  return value;
}

function redactJsonl(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (line.trim() === "") return line;
      try {
        return JSON.stringify(redactStrings(JSON.parse(line)));
      } catch {
        return redactString(line);
      }
    })
    .join("\n");
}

function redactJsonDocument(text: string): string {
  try {
    return JSON.stringify(redactStrings(JSON.parse(text)));
  } catch {
    return redactString(text);
  }
}

export function redactRaw(text: string, format: RawFormat): string {
  return format === "jsonl" ? redactJsonl(text) : redactJsonDocument(text);
}
