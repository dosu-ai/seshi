/** `seshi workers status` (X7.5): whether the worker runs, whether a second one does, each
 * job's last run, last error and backlog, and each source's drop and failure counts. It runs
 * where the server's config and bucket keys are, and reads the bucket (the heartbeat, the
 * checkpoints, the records); `GET /v1/admin/jobs` answers the same over HTTP.
 *
 *   seshi workers status [--config <file>] [--set path=value]… [--json]
 *
 * Exit 0, or 8 (`attention`) when the worker stopped, two are running, or a job's last run
 * failed. */

import { parseArgs } from "node:util";
import type { InstanceStatus } from "@seshi/instance";
import { EXIT } from "../cli/exit";
import { emit, takeJson, usageError } from "../cli/output";
import type { CommandContext } from "./index";
import { openServer, SERVER_OPTIONS, serverFailure } from "./server-instance";

const USAGE = "usage: seshi workers status [--config <file>] [--set path=value]… [--json]";

function ago(iso: string | undefined, now: string): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.parse(now) - Date.parse(iso)) / 1000));
  if (s < 120) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 120) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

function counts(record: Record<string, number> | undefined): string {
  if (!record) return "";
  const parts = Object.entries(record).map(([k, v]) => `${k} ${v}`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

/** The status as lines for a terminal. */
export function statusLines(status: InstanceStatus): string[] {
  const { worker } = status;
  const lines: string[] = [];
  const workerLine =
    worker.state === "never"
      ? "worker: none has run against this bucket"
      : `worker: ${worker.state}, ${worker.instance}${worker.version ? ` (seshi ${worker.version})` : ""}, heartbeat ${ago(worker.last_heartbeat, status.at)}`;
  lines.push(`deployment ${status.deployment}`);
  lines.push(workerLine);
  for (const other of worker.others) {
    lines.push(`  also running: ${other.instance}, heartbeat ${ago(other.at, status.at)}`);
  }
  lines.push("", "jobs:");
  for (const job of status.jobs) {
    const last = job.last;
    const outcome = last?.last_outcome ?? "not run";
    const when = ago(last?.last_finished, status.at);
    const records =
      job.failed !== undefined ? `, ${job.dropped ?? 0} dropped, ${job.failed} failed` : "";
    lines.push(
      `  ${job.name.padEnd(24)} ${outcome}${last ? ` ${when}` : ""}${counts(job.backlog)}${records}`,
    );
    if (last?.last_error) {
      lines.push(
        `    last error ${ago(last.last_error.at, status.at)}: ${last.last_error.message}`,
      );
    }
  }
  lines.push("", "sources:");
  for (const source of status.sources) {
    const state = source.polled ? "polled" : (source.note ?? "not polled");
    const checkpoint = source.checkpoint
      ? `, checkpoint ${ago(source.checkpoint.updated_at, status.at)}`
      : "";
    lines.push(
      `  ${source.id.padEnd(24)} ${source.type}, ${state}${checkpoint}, ${source.dropped} dropped, ${source.failed} failed${counts(source.health as Record<string, number>)}`,
    );
  }
  if (status.warnings.length > 0) {
    lines.push("");
    for (const warning of status.warnings) lines.push(`warning: ${warning}`);
  }
  return lines;
}

/** Whether the status asks for an operator: a stopped or second worker, or a failed job. */
export function needsAttention(status: InstanceStatus): boolean {
  return (
    status.worker.state === "stopped" ||
    status.worker.state === "several" ||
    status.jobs.some((j) => j.last?.last_outcome === "error")
  );
}

export async function run(ctx: CommandContext): Promise<number> {
  const { json, rest } = takeJson(ctx.argv);
  const [sub, ...args] = rest;
  if (sub !== "status") {
    return usageError(
      ctx,
      json,
      sub === undefined ? "workers needs a subcommand" : `unknown workers command '${sub}'`,
      USAGE,
    );
  }
  let values: { config?: string; set?: string[] };
  try {
    ({ values } = parseArgs({ args, options: SERVER_OPTIONS, strict: true }));
  } catch (err) {
    return usageError(ctx, json, (err as Error).message, USAGE);
  }
  try {
    const { instance } = await openServer(ctx, values, { roles: [], probe: [] });
    try {
      const status = await instance.status();
      emit(ctx, json, status, () => statusLines(status));
      return needsAttention(status) ? EXIT.attention : EXIT.ok;
    } finally {
      await instance.close();
    }
  } catch (err) {
    const code = serverFailure(ctx, json, err);
    if (code === undefined) throw err;
    return code;
  }
}
