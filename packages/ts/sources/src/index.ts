/** `@seshi/sources`, layer 3 (X3.2): the connector scheduler and checkpoints (X7, X7.4). The
 * instance builds one `Sources` from `[[sources]]` and the connectors its integrations provide
 * (X3.11); the worker role runs each polled source on its interval, and `seshi sync run`,
 * `sync status` and `reprocess` use the same object. The generic S3 poller (F6) joins here as a
 * built-in connector. */

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
