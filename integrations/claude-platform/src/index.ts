/** Claude Platform (X3.11): the `otlp-genai` span format with Anthropic's attributes, which the
 * OTLP receiver (F4) uses for what a Claude Console destination sends. The format itself (the
 * GenAI conventions, assembly) is vendor-neutral and lives in `@seshi/formats`; other GenAI
 * producers' spans read through the same format. */

import { OTLP_GENAI, otlpGenAiFormat } from "@seshi/formats";
import { defineIntegration, type FormatAdapter } from "@seshi/kit";
import { anthropicAttributes } from "./anthropic";

export { anthropicAttributes } from "./anthropic";

/** `otlp-genai`: OTLP spans by the GenAI conventions, with `anthropic.*` read as well. */
export const OTLP_GENAI_FORMAT: FormatAdapter = otlpGenAiFormat({
  name: OTLP_GENAI,
  mappers: [anthropicAttributes],
});

export const claudePlatform = defineIntegration({
  name: "claude-platform",
  formats: [OTLP_GENAI_FORMAT],
});
