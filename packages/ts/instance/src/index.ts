/** `@seshi/instance`, layer 4 (X3.2): an Instance built from one config, with everything that
 * hangs off it (X1.2), and the background jobs its worker role runs (X7). */

export {
  BUILTIN_JOBS,
  heartbeatFresh,
  heartbeatJob,
  type JobFactory,
  type JobHost,
  pollerJobs,
  RETENTION_INTERVAL_MS,
  retentionJob,
  STALE_HEARTBEATS,
} from "./builtin-jobs";
export {
  type BuildOptions,
  buildInstance,
  defaultInstanceId,
  Instance,
  InstanceError,
  type InstanceParts,
  type Role,
  readRedactionPacks,
  type SessionIdentity,
  storeOptions,
} from "./instance";
export {
  type Job,
  type JobPlacement,
  type JobResult,
  JobRunner,
  type JobRunnerOptions,
  RETRY_BASE_MS,
} from "./jobs";
export { type Logger, lineLogger, quietLogger } from "./log";
export {
  assessWorker,
  type InstanceStatus,
  instanceStatus,
  type JobStatus,
  type WorkerView,
} from "./status";
