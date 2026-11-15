/** `@seshi/formats`: vendor-neutral transcript formats (ATIF, trajectory-v1), the OTLP GenAI
 * renderer, the `@letta-ai/trajectory` adapter builder integrations use, and the format
 * registry that detection and normalization go through. Layer 1: it imports only
 * `@seshi/model`, never an integration (X3.2). */

import { ATIF_FORMAT } from "./atif";
import { TRAJECTORY_FORMAT } from "./trajectory";

export {
  ATIF,
  ATIF_FORMAT,
  asAdapterVersion,
  atifSource,
  unsupportedAtifVersion,
  withAtifDetails,
} from "./atif";
export { detectFormat } from "./detect";
export {
  type LettaAdapterOptions,
  type LettaSource,
  lettaAdapter,
  TRAJECTORY_VERSION,
} from "./letta";
export { fromOtlp, isOtlpTrace, otlpMeta, otlpResource, toOtlp } from "./otlp";
export {
  FormatRegistry,
  NORMALIZER,
  NormalizeError,
  type NormalizeInput,
  type NormalizeOptions,
  type NormalizeOutcome,
} from "./registry";
export { TRAJECTORY, TRAJECTORY_FORMAT, trajectoryRecords } from "./trajectory";

/** The formats every deployment reads whatever integrations it has, in the order the registry
 * lists them after the integrations' own. */
export const BUILTIN_FORMATS = [ATIF_FORMAT, TRAJECTORY_FORMAT] as const;
