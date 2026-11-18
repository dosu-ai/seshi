import { lettaAdapter, OMITTED_TEXT, omitRequested, type RecordLabels } from "@seshi/formats";
import { defineIntegration, type FormatAdapter, type JsonObject } from "@seshi/kit";
import { PI_CAPTURE } from "./capture";

export { PI_CAPTURE } from "./capture";

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function entry(line: string): JsonObject | undefined {
  if (!line.includes('"custom_message"')) return undefined;
  try {
    const row: unknown = JSON.parse(line);
    return isObject(row) && row.type === "custom_message" ? row : undefined;
  } catch {
    return undefined;
  }
}

/** pi keeps what an extension adds to the model's context (`pi.sendMessage`, a
 * `before_agent_start` message) as a `custom_message` entry, which the model sees as a user
 * message and the library does not read. Each becomes the user message the model saw, with the
 * same id and time, so it is stored, labelled `synthetic`; one whose `details` flag it
 * (`session_capture.omit`) keeps none of its text. Line for line, so a chunk normalizes as the
 * whole log does. */
function withInjected(transcript: string): string {
  if (!transcript.includes('"custom_message"')) return transcript;
  return transcript
    .split("\n")
    .map((line) => {
      const row = entry(line);
      if (!row) return line;
      const content = omitRequested(row.details) ? OMITTED_TEXT : row.content;
      return JSON.stringify({
        type: "message",
        id: row.id,
        parentId: row.parentId,
        timestamp: row.timestamp,
        message: { role: "user", content },
      });
    })
    .join("\n");
}

function labels(transcript: string): Map<string, RecordLabels> {
  const out = new Map<string, RecordLabels>();
  if (!transcript.includes('"custom_message"')) return out;
  for (const line of transcript.split("\n")) {
    const row = entry(line);
    if (!row || typeof row.id !== "string" || row.id === "") continue;
    out.set(
      row.id,
      omitRequested(row.details) ? { synthetic: true, omitted: 1 } : { synthetic: true },
    );
  }
  return out;
}

export const PI_FORMAT: FormatAdapter = lettaAdapter({
  source: "pi",
  // 2: extensions' custom messages stored as synthetic user records, flagged ones left out.
  revision: 2,
  detect: {
    record: (row) =>
      (row.type === "session" && typeof row.id === "string" && typeof row.cwd === "string") ||
      (row.type === "message" && isObject(row.message) && typeof row.message.role === "string"),
  },
  prepare: withInjected,
  label: labels,
});

export const pi = defineIntegration({
  name: "pi",
  formats: [PI_FORMAT],
  capture: PI_CAPTURE,
});
