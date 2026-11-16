import { lettaAdapter } from "@seshi/formats";
import { defineIntegration, type FormatAdapter } from "@seshi/kit";

export const GEMINI_CLI_FORMAT: FormatAdapter = lettaAdapter({
  source: "gemini-cli",
  detect: {
    document: (head) =>
      head.get("projectHash")?.kind === "string" && head.get("messages")?.kind === "array",
  },
});

export const geminiCli = defineIntegration({
  name: "gemini-cli",
  formats: [GEMINI_CLI_FORMAT],
});
