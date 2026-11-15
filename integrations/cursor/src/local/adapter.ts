/** Cursor's local agent transcripts, normalized by `@letta-ai/trajectory` as they are. */

import { lettaAdapter } from "@seshi/formats";
import type { FormatAdapter, JsonObject } from "@seshi/kit";

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const CURSOR_FORMAT: FormatAdapter = lettaAdapter({
  source: "cursor",
  // `{ role, message: { content } }`, no `type`.
  detect: {
    record: (row) =>
      (row.role === "user" || row.role === "assistant") &&
      isObject(row.message) &&
      !("type" in row),
  },
});
