import {
  type Injected,
  lettaAdapter,
  OMITTED_TEXT,
  omitRequested,
  type RecordLabels,
} from "@seshi/formats";
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

/** One pass over the export's user messages, the only ones the flag and the label apply to (an
 * assistant message's parts, its text, reasoning, tool calls and their results, are the model's
 * and the tools', never left out). OpenCode marks text it added to a user message (a file it
 * read for an `@` mention, a plugin's context) `synthetic`; its UI hides it, the model sees it:
 * kept, labelled. A text part an integrator flagged (`metadata.session_capture.omit`) has its
 * text replaced, so it never reaches the library, redaction or the store, and its record says it
 * was left out. A flagged part without an id, whose record could not be labelled, is removed. */
function injected(transcript: string): Injected {
  const labels = new Map<string, RecordLabels>();
  const document = parse(transcript);
  if (!document) return { transcript, labels };
  let changed = false;
  const messages = Array.isArray(document.messages) ? document.messages : [];
  for (const message of messages) {
    if (!isObject(message) || !isObject(message.info) || message.info.role !== "user") continue;
    if (!Array.isArray(message.parts)) continue;
    message.parts = message.parts.filter((part) => {
      if (!isObject(part) || part.type !== "text") return true;
      const id = typeof part.id === "string" && part.id !== "" ? part.id : undefined;
      const omit = omitRequested(part.metadata);
      if (omit) {
        changed = true;
        if (id === undefined) return false;
        part.text = OMITTED_TEXT;
      }
      if (id === undefined || (part.synthetic !== true && !omit)) return true;
      labels.set(id, {
        ...(part.synthetic === true ? { synthetic: true as const } : {}),
        ...(omit ? { omitted: 1 } : {}),
      });
      return true;
    });
  }
  return { transcript: changed ? JSON.stringify(document) : transcript, labels };
}

export const OPENCODE_FORMAT: FormatAdapter = lettaAdapter({
  source: "opencode",
  // 2: synthetic parts labelled, flagged parts left out.
  revision: 2,
  // One JSON document, re-exported whole after every turn: never appended to.
  chunkable: false,
  // OpenCode 1.x's export, `{info, messages: [{info, parts}]}`, which seshi keeps for both
  // releases. OpenCode 2.x's own export (`opencode session export`) has the same two keys with
  // flat message rows (`{id, type, …}`): it is not this, and would normalize to almost nothing.
  detect: {
    document: (head) =>
      head.get("info")?.kind === "object" &&
      head.get("messages")?.kind === "array" &&
      head.get("messages")?.first?.has("type") !== true,
  },
  inject: injected,
});

export const opencode = defineIntegration({
  name: "opencode",
  formats: [OPENCODE_FORMAT],
  capture: OPENCODE_CAPTURE,
});
