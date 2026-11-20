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
export { asTranscript, attachCalls, type CallSite, isoTimestamp, type SourceCalls } from "./calls";
export { detectFormat } from "./detect";
export {
  type Injected,
  OMITTED_TEXT,
  omitRequested,
  type RecordLabels,
  SESSION_CAPTURE_KEY,
} from "./injected";
export {
  firstJsonlField,
  type LettaAdapterOptions,
  type LettaSource,
  lettaAdapter,
  TRAJECTORY_VERSION,
  withAgentVersion,
} from "./letta";
export {
  compareNormalizerVersions,
  FormatRegistry,
  NORMALIZER,
  NormalizeError,
  type NormalizeInput,
  type NormalizeOptions,
  type NormalizeOutcome,
} from "./registry";
export {
  fromOtlp,
  isOtlpTrace,
  lettaRecord,
  lettaRecords,
  otlpMeta,
  otlpResource,
  renderTrace,
  toAtif,
  toLetta,
  toOtlp,
} from "./render";
export { assembleSpanParts, newInput } from "./spans/assemble";
export { Attributes, durationMs, isoFromNanos, type Plain, plainValue } from "./spans/attributes";
export {
  genAiSpanAdapter,
  OTLP_GENAI,
  otlpGenAiFormat,
  type SpanFormatOptions,
} from "./spans/format";
export {
  errorOf,
  genAiHasContent,
  genAiPart,
  genAiSessionKey,
  type SpanAttributeMapper,
  type SpanView,
  viewOf,
} from "./spans/genai";
export { argsOf, jsonAttribute, messagesRecords, systemRecords, textOf } from "./spans/messages";
export {
  hexId,
  nanosString,
  type ReadSpans,
  readAttributes,
  readExportRequest,
  readSpan,
  readValue,
  type SpanGroup,
} from "./spans/request";
export { TRAJECTORY, TRAJECTORY_FORMAT, trajectoryRecords } from "./trajectory";

export const BUILTIN_FORMATS = [ATIF_FORMAT, TRAJECTORY_FORMAT] as const;
