import { S3Connector, type S3ConnectorOptions } from "./s3/connector";

export {
  AzureSourceBucket,
  type AzureSourceOptions,
  FolderSourceBucket,
  GcsSourceBucket,
  type GcsSourceOptions,
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

export function builtinConnectors(options: S3ConnectorOptions): S3Connector[] {
  return [new S3Connector(options)];
}
