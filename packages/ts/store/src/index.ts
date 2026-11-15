/** `@seshi/store`: the bucket layout (`spec/layout.md`) and the drivers behind one `Store`
 * interface: a folder (`file://`) and S3-compatible buckets (`s3://`, `r2://`). Layer 1: it
 * imports only `@seshi/model` (X3.2). Branch 03 adds conditional writes (X6.5). */

export { type ChangesPage, type ReadChangesOptions, readChanges } from "./changes";
export { FsStore } from "./fs";
export { archiveId, assertOwner, changeStamp, keys, LAYOUT_KEY } from "./layout";
export { isStoreUrl, type OpenStoreOptions, openStore, type StorageView } from "./open";
export {
  appendChange,
  decodeJson,
  ensureLayout,
  gunzipJson,
  gzipJson,
  layoutFormat,
  markerFormat,
  type PublishMode,
  type PublishOutcome,
  probe,
  publishObject,
  readMetadata,
  sha256,
  swapMetadata,
} from "./publish";
export {
  parseS3Url,
  type S3Credentials,
  S3Store,
  type S3StoreOptions,
} from "./s3";
export {
  type ListOptions,
  type ListResult,
  type ObjectStat,
  type PutOptions,
  type Store,
  StoreError,
} from "./store";
