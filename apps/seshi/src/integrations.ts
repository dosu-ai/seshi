/** The integration registry (X3.11): every integration this binary is built with, in the order
 * their formats are listed. It is static data; the parts that run integrations (the format
 * registry today, the instance and `@seshi/capture` later) are built from it and passed down.
 * Only this app imports integrations.
 *
 * Later branches add integrations here, one entry each. */

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
