import { BUILTIN_PACK_TOML } from "./generated/builtin-pack";
import { parsePackToml, type RulePack } from "./pack";

export const BUILTIN_RULES_VERSION = "seshi/rules/3";

export const BUILTIN_PACK_ID = "builtin";

export function builtinPack(): RulePack {
  return parsePackToml(BUILTIN_PACK_TOML, { source: "builtin.toml", builtin: true });
}

export { BUILTIN_PACK_TOML };
