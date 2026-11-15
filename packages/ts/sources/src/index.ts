/** `@seshi/sources`, layer 3 (X3.2): the connector scheduler and checkpoints (X7, X7.4). The
 * instance builds one `Sources` from `[[sources]]` and the connectors its integrations provide
 * (X3.11); the worker role runs each polled source on its interval, and `seshi sync run`,
 * `sync status` and `reprocess` use the same object. The generic S3 poller (F6) is a built-in
 * connector (`builtinConnectors`). */

import { S3Connector, type S3ConnectorOptions } from "./s3/connector";

export {
  FolderSourceBucket,
  ObjectChanged,
  ObjectDenied,
  S3SourceBucket,
  type SourceBucket,
  type SourceListing,
  type SourceObject,
  type SourceRead,
} from "./s3/bucket";
export {
  completeLines,
  DEFAULT_BATCH,
  S3Connector,
  type S3ConnectorOptions,
  type S3SourceConfig,
  sourcePrefix,
  TAIL_WINDOW,
} from "./s3/connector";
export { type KeyFields, KeyFilter, metadataFields, PathTemplate } from "./s3/keys";
export { type Manifest, type ObjectEntry, readManifest, rewindManifest } from "./s3/manifest";
export {
  DEFAULT_INTERVAL_MS,
  type RewindReport,
  type RunReport,
  SourceError,
  type SourceInfo,
  type SourceStatus,
  Sources,
  type SourcesOptions,
  type Submitter,
} from "./sources";

/** The connectors every binary has, whatever its integrations (X3.11): the vendor-neutral S3
 * poller (F6). One set per instance (X1.2). */
export function builtinConnectors(options: S3ConnectorOptions): S3Connector[] {
  return [new S3Connector(options)];
}
