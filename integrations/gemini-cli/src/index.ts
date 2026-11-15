/** Gemini CLI (X3.11): its session document, normalized by `@letta-ai/trajectory` as it is. */

import { lettaAdapter } from "@seshi/formats";
import { defineIntegration, type FormatAdapter } from "@seshi/kit";

export const GEMINI_CLI_FORMAT: FormatAdapter = lettaAdapter({
  source: "gemini-cli",
  // `{ sessionId, projectHash, startTime, lastUpdated, messages[] }`: a Gemini CLI session.
  detect: {
    document: (head) =>
      head.get("projectHash")?.kind === "string" && head.get("messages")?.kind === "array",
  },
});

export const geminiCli = defineIntegration({
  name: "gemini-cli",
  formats: [GEMINI_CLI_FORMAT],
});
