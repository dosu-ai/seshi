import { lettaAdapter } from "@seshi/formats";
import { defineIntegration, type FormatAdapter } from "@seshi/kit";
import { OPENCODE_CAPTURE } from "./capture";

export { OPENCODE_CAPTURE } from "./capture";

export const OPENCODE_FORMAT: FormatAdapter = lettaAdapter({
  source: "opencode",
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
});

export const opencode = defineIntegration({
  name: "opencode",
  formats: [OPENCODE_FORMAT],
  capture: OPENCODE_CAPTURE,
});
