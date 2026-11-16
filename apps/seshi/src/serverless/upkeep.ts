import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UPLOAD_SOURCE } from "@seshi/model";
import { pruneRecords, sweepTraces } from "@seshi/store";
import { writePrivateFile } from "../account/secrets";
import { runStorageTest, type ServerlessBucket, STORAGE_TEST_MAX_AGE_MS } from "./open";

const HOUR_MS = 60 * 60 * 1000;

/** The daemon's jobs in serverless mode (F11, "The daemon in serverless mode"), by name, with
 * how often each runs. Uploads and the shared settings refresh are the uploader's. */
export const UPKEEP_JOBS = {
  /** Read the change feed into this machine's index; only with `[search] enabled`. Its period
   * is `search.interval`. */
  search: 0,
  /** Delete trace objects in the owner's folder that nothing names, over an hour old; only when
   * the storage test confirmed conditional deletes. */
  sweep: 24 * HOUR_MS,
  /** Prune this machine's drop and failure records by `[records]` retention. */
  records: 6 * HOUR_MS,
  storage: STORAGE_TEST_MAX_AGE_MS,
} as const;

export type UpkeepJob = keyof typeof UPKEEP_JOBS;

export interface UpkeepRun {
  job: UpkeepJob;
  ok: boolean;
  summary: string;
}

interface UpkeepState {
  last: Partial<Record<UpkeepJob, string>>;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function stateFile(bucket: ServerlessBucket): string {
  return join(bucket.paths.dir, "upkeep.json");
}

function readUpkeep(bucket: ServerlessBucket): UpkeepState {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(bucket), "utf8")) as Partial<UpkeepState>;
    return { last: parsed.last ?? {} };
  } catch {
    return { last: {} };
  }
}

function periodOf(bucket: ServerlessBucket, job: UpkeepJob): number {
  return job === "search" ? bucket.instance.config.search.interval : UPKEEP_JOBS[job];
}

async function runJob(bucket: ServerlessBucket, job: UpkeepJob, now: Date): Promise<UpkeepRun> {
  const { instance, owner } = bucket;
  switch (job) {
    case "search": {
      const run = await instance.search?.catchUp();
      return {
        job,
        ok: true,
        summary: `indexed ${run?.indexed ?? 0}, removed ${run?.removed ?? 0}`,
      };
    }
    case "sweep": {
      if (bucket.storage?.conditionalDelete !== true) {
        return { job, ok: true, summary: "skipped: conditional deletes are not confirmed" };
      }
      const report = await sweepTraces(instance.store, { owners: [owner], now: () => now });
      return {
        job,
        ok: report.errors === 0,
        summary: `${report.deleted} unnamed trace(s) removed`,
      };
    }
    case "records": {
      const records = instance.pipeline.records;
      const retention = instance.config.records;
      const dropped = await pruneRecords(records, "dropped", UPLOAD_SOURCE, {
        retentionMs: retention.dropped_retention,
        now: () => now,
      });
      const failed = await pruneRecords(records, "failed", UPLOAD_SOURCE, {
        retentionMs: retention.failed_retention,
        now: () => now,
      });
      return { job, ok: true, summary: `${dropped} drop and ${failed} failure record(s) removed` };
    }
    case "storage": {
      const result = await runStorageTest(instance.store, owner, bucket.paths, () => now);
      bucket.storage = result;
      return {
        job,
        ok: result.conditionalWrites,
        summary: result.missing ?? "conditional uploads and deletes work",
      };
    }
  }
}

/** Run the jobs that are due, each at most once, and remember when. One that fails is logged
 * and tried again at its next period. */
export async function runUpkeep(
  bucket: ServerlessBucket,
  options: { now?: () => Date; log?: (line: string) => void; force?: readonly UpkeepJob[] } = {},
): Promise<UpkeepRun[]> {
  const now = (options.now ?? (() => new Date()))();
  const state = readUpkeep(bucket);
  const runs: UpkeepRun[] = [];
  for (const job of Object.keys(UPKEEP_JOBS) as UpkeepJob[]) {
    if (job === "search" && !bucket.instance.search) continue;
    const last = state.last[job];
    const due =
      options.force?.includes(job) ||
      last === undefined ||
      now.getTime() - Date.parse(last) >= periodOf(bucket, job);
    if (!due) continue;
    let run: UpkeepRun;
    try {
      run = await runJob(bucket, job, now);
    } catch (err) {
      run = { job, ok: false, summary: message(err) };
    }
    runs.push(run);
    options.log?.(`upkeep ${job}: ${run.ok ? "" : "failed: "}${run.summary}`);
    state.last[job] = now.toISOString();
  }
  if (runs.length > 0) {
    writePrivateFile(stateFile(bucket), `${JSON.stringify(state, null, 2)}\n`);
  }
  return runs;
}
