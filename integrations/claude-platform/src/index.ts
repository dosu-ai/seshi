import { OTLP_GENAI, otlpGenAiFormat } from "@seshi/formats";
import { defineIntegration, type FormatAdapter } from "@seshi/kit";
import { anthropicAttributes } from "./anthropic";

export { anthropicAttributes } from "./anthropic";

export const OTLP_GENAI_FORMAT: FormatAdapter = otlpGenAiFormat({
  name: OTLP_GENAI,
  mappers: [anthropicAttributes],
});

export const claudePlatform = defineIntegration({
  name: "claude-platform",
  formats: [OTLP_GENAI_FORMAT],
});
