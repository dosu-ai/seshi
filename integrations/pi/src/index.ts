/** Pi (X3.11): its session log, normalized by `@letta-ai/trajectory` as it is. */

import { lettaAdapter } from "@seshi/formats";
import { defineIntegration, type FormatAdapter, type JsonObject } from "@seshi/kit";

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const PI_FORMAT: FormatAdapter = lettaAdapter({
  source: "pi",
  // A `{ type: "session", id, cwd }` header, then `{ type: "message", id, message: { role } }`.
  detect: {
    record: (row) =>
      (row.type === "session" && typeof row.id === "string" && typeof row.cwd === "string") ||
      (row.type === "message" && isObject(row.message) && typeof row.message.role === "string"),
  },
});

export const pi = defineIntegration({
  name: "pi",
  formats: [PI_FORMAT],
});
