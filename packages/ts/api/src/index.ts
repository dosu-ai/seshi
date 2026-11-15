/** `@seshi/api`: the HTTP surface, one `fetch(Request) → Response` over an Instance
 * (`@seshi/instance`), with identity and access from the instance's `Auth` (X5), and the OTLP
 * trace receiver (F4). Layer 5 (X3.2). */

export { type App, createApp, maxBodyBytes, type StorageView } from "./app";
export {
  decodeExportRequest,
  encodeExportRequest,
  encodeExportResponse,
  encodeStatus,
  ProtobufError,
} from "./otlp/protobuf";
export { encodingOf, METADATA_ONLY_MESSAGE, otlpTraces } from "./otlp/receiver";
