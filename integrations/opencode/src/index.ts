/** OpenCode (X3.11): its session export document, normalized by `@letta-ai/trajectory` as it
 * is. */

import { lettaAdapter } from "@seshi/formats";
import { defineIntegration, type FormatAdapter } from "@seshi/kit";

export const OPENCODE_FORMAT: FormatAdapter = lettaAdapter({
  source: "opencode",
  // `{ info, messages[] }`: an OpenCode session export.
  detect: {
    document: (head) =>
      head.get("info")?.kind === "object" && head.get("messages")?.kind === "array",
  },
});

export const opencode = defineIntegration({
  name: "opencode",
  formats: [OPENCODE_FORMAT],
});
