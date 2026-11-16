import { parseArgs } from "node:util";
import type { InstanceStatus } from "@seshi/instance";
import { EXIT } from "../cli/exit";
import { failWith } from "../cli/failures";
import { emit, fail, helpOrUsageError, takeJson } from "../cli/output";
import { printable, type Role, Style, styleFor } from "../cli/style";
import { adminTarget } from "./admin-target";
import type { CommandContext } from "./index";
import { openServer, SERVER_OPTIONS, serverFailure } from "./server-instance";

const USAGE =
  "usage: seshi workers status [--config <file>] [--set path=value]… [--server <url>] [--json]";

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

function roleOf(word: string): Role | undefined {
  if (word === "running" || word === "ok") return "success";
  if (word === "error") return "error";
  if (word === "stopped" || word === "several" || word === "discarded") return "warn";
  return undefined;
}

function painted(style: Style, word: string): string {
  const role = roleOf(word);
  return role ? style.status(word, role) : word;
}

export function statusLines(status: InstanceStatus, style: Style = Style.plain()): string[] {
  const { worker } = status;
  const lines: string[] = [];
  const workerLine =
    worker.state === "never"
      ? "worker: none has run against this bucket"
      : `worker: ${painted(style, worker.state)}, ${worker.instance}${worker.version ? ` (seshi ${worker.version})` : ""}, heartbeat ${ago(worker.last_heartbeat, status.at)}`;
  lines.push(`deployment ${status.deployment}`);
  lines.push(workerLine);
  for (const other of worker.others) {
    lines.push(`  also running: ${other.instance}, heartbeat ${ago(other.at, status.at)}`);
  }
  lines.push("", "jobs:");
  for (const job of status.jobs) {
    const last = job.last;
    const outcome = last?.last_outcome ? painted(style, last.last_outcome) : "not run";
    const when = ago(last?.last_finished, status.at);
    const records =
      job.failed !== undefined ? `, ${job.dropped ?? 0} dropped, ${job.failed} failed` : "";
    lines.push(
      `  ${job.name.padEnd(24)} ${outcome}${last ? ` ${when}` : ""}${counts(job.backlog)}${records}`,
    );
    const did = Object.entries(last?.last_summary ?? {}).filter(([, n]) => n !== 0);
    if (did.length > 0) {
      lines.push(`    last run: ${did.map(([k, n]) => `${k} ${n}`).join(", ")}`);
    }
    if (last?.last_error) {
      lines.push(
        `    last error ${ago(last.last_error.at, status.at)}: ${printable(last.last_error.message)}`,
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
    for (const warning of status.warnings) lines.push(`${style.warn("warning:")} ${warning}`);
  }
  return lines;
}

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
    return helpOrUsageError(
      ctx,
      json,
      sub === undefined ? "workers needs a subcommand" : `unknown workers command '${sub}'`,
      USAGE,
    );
  }
  let values: { config?: string; set?: string[]; server?: string };
  try {
    ({ values } = parseArgs({
      args,
      options: { ...SERVER_OPTIONS, server: { type: "string" } },
      strict: true,
    }));
  } catch (err) {
    return helpOrUsageError(ctx, json, (err as Error).message, USAGE);
  }
  if (values.server !== undefined && (values.config !== undefined || values.set !== undefined)) {
    return helpOrUsageError(ctx, json, "give --server, or --config and --set, not both", USAGE);
  }
  const style = await styleFor(ctx, { json });
  try {
    const target = await adminTarget(ctx, values);
    if (target.kind === "serverless") {
      return fail(
        ctx,
        json,
        EXIT.config,
        "needs_server",
        "serverless mode runs no workers: see seshi capture status and seshi doctor on each laptop",
      );
    }
    if (target.kind === "remote") {
      const status = (await target.db.jobs()) as unknown as InstanceStatus;
      emit(ctx, json, status, () => statusLines(status, style));
      return needsAttention(status) ? EXIT.attention : EXIT.ok;
    }
    const { instance } = await openServer(
      ctx,
      { ...values, ...(target.config ? { config: target.config } : {}) },
      {
        roles: [],
        probe: [],
        claimUnmarkedBucket: false,
      },
    );
    try {
      const status = await instance.status();
      emit(ctx, json, status, () => statusLines(status, style));
      return needsAttention(status) ? EXIT.attention : EXIT.ok;
    } finally {
      await instance.close();
    }
  } catch (err) {
    const code = serverFailure(ctx, json, err);
    if (code !== undefined) return code;
    return failWith(ctx, json, err);
  }
}
