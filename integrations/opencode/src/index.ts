import { lettaAdapter } from "@seshi/formats";
import { defineIntegration, type FormatAdapter } from "@seshi/kit";
import { OPENCODE_CAPTURE } from "./capture";

export { OPENCODE_CAPTURE } from "./capture";

export const OPENCODE_FORMAT: FormatAdapter = lettaAdapter({
  source: "opencode",
  // One JSON document, re-exported whole after every turn: never appended to.
  chunkable: false,
  detect: {
    document: (head) =>
      head.get("info")?.kind === "object" && head.get("messages")?.kind === "array",
  },
});

export const opencode = defineIntegration({
  name: "opencode",
  formats: [OPENCODE_FORMAT],
  capture: OPENCODE_CAPTURE,
});
