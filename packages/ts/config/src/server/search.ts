import * as z from "zod";
import { duration } from "../units";

export const SEARCH_EVENT_ROLES = [
  "user",
  "assistant",
  "tool_call",
  "tool_result",
  "system",
  "observation",
  "reasoning",
] as const;

export const searchSection = z
  .strictObject({
    enabled: z
      .boolean()
      .default(true)
      .describe(
        "Serve search (GET /v1/search, seshi search) from a local index built from the change feed.",
      ),
    backend: z.enum(["sqlite"]).default("sqlite").describe("The index backend (F10.3)."),
    path: z
      .string()
      .min(1)
      .optional()
      .describe(
        'The index file on local disk; ":memory:" keeps it in memory. Default: seshi/search/<deployment>.sqlite in the user cache folder.',
      ),
    interval: duration()
      .refine((ms) => ms > 0, "must be above 0")
      .prefault("15s")
      .describe("How long the indexer waits after catching up before it reads the feed again."),
    events: z
      .array(z.enum(SEARCH_EVENT_ROLES))
      .min(1)
      .default(["user", "assistant", "tool_call"])
      .describe(
        "Which trace events are indexed, by role: prompts, assistant text, and tool calls (names and inputs, so file paths and commands) by default (F10.1).",
      ),
  })
  .prefault({})
  .describe("Session search (F10).");

export type SearchSection = z.output<typeof searchSection>;
