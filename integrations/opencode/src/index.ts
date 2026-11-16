import { lettaAdapter } from "@seshi/formats";
import { defineIntegration, type FormatAdapter } from "@seshi/kit";

export const OPENCODE_FORMAT: FormatAdapter = lettaAdapter({
  source: "opencode",
  detect: {
    document: (head) =>
      head.get("info")?.kind === "object" && head.get("messages")?.kind === "array",
  },
});

export const opencode = defineIntegration({
  name: "opencode",
  formats: [OPENCODE_FORMAT],
});
