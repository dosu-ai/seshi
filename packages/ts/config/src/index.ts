/** `@seshi/config` (layer 1, F1): the TOML and env loader, the server's and the CLI's schemas,
 * value provenance and secret references. Nothing here keeps state between calls: each load
 * returns its own config. */

export { type CheckReport, checkServerConfig } from "./check";
export { type CapturePath, type CliConfig, cliConfigSchema, THEMES } from "./cli";
export {
  type CliLoadOptions,
  loadCliConfig,
  loadServerConfig,
  type ServerLoadOptions,
} from "./configs";
export { ENV_PREFIX, envKey, isSettingName } from "./layers";
export {
  ConfigError,
  type ConfigFs,
  type FlagValue,
  type Loaded,
  type LoadOptions,
  loadConfig,
  nodeFs,
  secretsIn,
  shapeOf,
} from "./load";
export { describeOrigin, formatPath, type Origin, Origins, type PathSegment } from "./origins";
export {
  CONFIG_ENV,
  cliConfigPath,
  findServerConfig,
  NOT_SETTINGS_ENV,
  SERVER_CONFIG_NAME,
  SYSTEM_CONFIG_PATH,
} from "./paths";
export { describeSecret, Secret, type SecretRef, type SecretSources, secret } from "./secret";
export * from "./server/index";
export type { JsonSchema } from "./shape";
export { type ConfigEntry, configEntries, displayTree } from "./show";
export { bytes, duration, formatBytes, formatDuration, parseBytes, parseDuration } from "./units";

import { toJSONSchema } from "zod";
import { cliConfigSchema } from "./cli";
import { serverConfigSchema } from "./server/index";

/** The JSON Schemas for editors (F1.4): `spec/config.schema.json` and
 * `spec/cli-config.schema.json` are these, written by `bun run schema`. */
export function configJsonSchemas(): { server: object; cli: object } {
  const generate = (schema: typeof serverConfigSchema | typeof cliConfigSchema, id: string) => ({
    $id: id,
    ...toJSONSchema(schema, { io: "input", unrepresentable: "any" }),
  });
  return {
    server: generate(
      serverConfigSchema,
      "https://github.com/dosu-ai/sessiondb/spec/config.schema.json",
    ),
    cli: generate(
      cliConfigSchema,
      "https://github.com/dosu-ai/sessiondb/spec/cli-config.schema.json",
    ),
  };
}
