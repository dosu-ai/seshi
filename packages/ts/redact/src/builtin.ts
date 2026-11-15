/** The built-in rule pack (F2.1): `packs/builtin.toml`, carried in the binary as
 * `generated/builtin-pack.ts` (`bun run packs`). It is parsed by the same parser and validator
 * as an operator's packs. Parsing takes well under a millisecond; it happens when a rule set is
 * built, never at import, so `seshi hook` pays nothing for it until it redacts. */

import { BUILTIN_PACK_TOML } from "./generated/builtin-pack";
import { parsePackToml, type RulePack } from "./pack";

/** The built-in pack's `version`: it names the built-in rules in every rule-set hash, so it is
 * bumped whenever what they match changes (a test checks it equals the TOML's). */
export const BUILTIN_RULES_VERSION = "seshi/rules/3";

export const BUILTIN_PACK_ID = "builtin";

/** The built-in pack, parsed and validated. */
export function builtinPack(): RulePack {
  return parsePackToml(BUILTIN_PACK_TOML, { source: "builtin.toml", builtin: true });
}

export { BUILTIN_PACK_TOML };
