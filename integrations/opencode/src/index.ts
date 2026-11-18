import { lettaAdapter, OMITTED_TEXT, omitRequested, type RecordLabels } from "@seshi/formats";
import { defineIntegration, type FormatAdapter, type JsonObject } from "@seshi/kit";
import { OPENCODE_CAPTURE } from "./capture";

export { OPENCODE_CAPTURE } from "./capture";

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parse(transcript: string): JsonObject | undefined {
  try {
    const document: unknown = JSON.parse(transcript);
    return isObject(document) ? document : undefined;
  } catch {
    return undefined;
  }
}

/** The text parts of the export's user messages: the only parts the flag and the label apply
 * to. An assistant message's parts (its text, reasoning, tool calls and their results) are the
 * model's and the tools', never left out. */
function* userTextParts(document: JsonObject): Generator<JsonObject> {
  const messages = Array.isArray(document.messages) ? document.messages : [];
  for (const message of messages) {
    if (!isObject(message) || !isObject(message.info) || message.info.role !== "user") continue;
    for (const part of Array.isArray(message.parts) ? message.parts : []) {
      if (isObject(part) && part.type === "text") yield part;
    }
  }
}

/** The export with the text of every part an integrator flagged (`metadata.session_capture.omit`)
 * replaced, so it never reaches the library, redaction or the store. The part stays, so its
 * record can say something was left out. */
function withoutOmitted(transcript: string): string {
  const document = parse(transcript);
  if (!document) return transcript;
  let changed = false;
  for (const part of userTextParts(document)) {
    if (!omitRequested(part.metadata)) continue;
    part.text = OMITTED_TEXT;
    changed = true;
  }
  return changed ? JSON.stringify(document) : transcript;
}

/** OpenCode marks text it added to a user message (a file it read for an `@` mention, a
 * plugin's context) `synthetic`; its UI hides it, the model sees it. Kept, labelled. */
function labels(transcript: string): Map<string, RecordLabels> {
  const out = new Map<string, RecordLabels>();
  const document = parse(transcript);
  if (!document) return out;
  for (const part of userTextParts(document)) {
    if (typeof part.id !== "string" || part.id === "") continue;
    const label: RecordLabels = {};
    if (part.synthetic === true) label.synthetic = true;
    if (omitRequested(part.metadata)) label.omitted = 1;
    if (label.synthetic || label.omitted) out.set(part.id, label);
  }
  return out;
}

export const OPENCODE_FORMAT: FormatAdapter = lettaAdapter({
  source: "opencode",
  // 2: synthetic parts labelled, flagged parts left out.
  revision: 2,
  // One JSON document, re-exported whole after every turn: never appended to.
  chunkable: false,
  detect: {
    document: (head) =>
      head.get("info")?.kind === "object" && head.get("messages")?.kind === "array",
  },
  prepare: withoutOmitted,
  label: labels,
});

export const opencode = defineIntegration({
  name: "opencode",
  formats: [OPENCODE_FORMAT],
  capture: OPENCODE_CAPTURE,
});
