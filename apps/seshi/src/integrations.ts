import { BUILTIN_FORMATS, FormatRegistry } from "@seshi/formats";
import { claudeCode } from "@seshi/integration-claude-code";
import { claudePlatform } from "@seshi/integration-claude-platform";
import { codex } from "@seshi/integration-codex";
import { cursor } from "@seshi/integration-cursor";
import { datadogTrajectory } from "@seshi/integration-datadog-trajectory";
import { geminiCli } from "@seshi/integration-gemini-cli";
import { opencode } from "@seshi/integration-opencode";
import { pi } from "@seshi/integration-pi";
import { formatsOf, type Integration } from "@seshi/kit";

export const INTEGRATIONS: readonly Integration[] = [
  claudeCode,
  cursor,
  codex,
  opencode,
  pi,
  geminiCli,
  datadogTrajectory,
  claudePlatform,
];

/** The format registry for `integrations`: their formats, then the built-in ones. */
export function buildFormats(integrations: readonly Integration[] = INTEGRATIONS): FormatRegistry {
  return new FormatRegistry([...formatsOf(integrations), ...BUILTIN_FORMATS]);
}
