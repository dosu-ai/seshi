import { parseArgs } from "node:util";
import type { HttpSessionDB, RecordsPage } from "@seshi/client";
import type { AssembleRun, Instance, PruneRun } from "@seshi/instance";
import { UPLOAD_SOURCE } from "@seshi/model";
import { type RunReport, SourceError, type SourceStatus } from "@seshi/sources";
import {
  type DroppedRecord,
  type FailedRecord,
  listRecords,
  sourcesWithRecords,
} from "@seshi/store";
import { EXIT, type ExitCode } from "../cli/exit";
import { failWith, Refused } from "../cli/failures";
import { emit, fail, takeJson, usageError } from "../cli/output";
import { printable } from "../cli/style";
import { adminTarget } from "./admin-target";
import type { CommandContext } from "./index";
import { openServer, SERVER_OPTIONS, serverFailure } from "./server-instance";

const USAGE = `usage: seshi sync run <source> [--force] [--json]
       seshi sync assemble [--json]
       seshi sync prune [--json]
       seshi sync status [<source>] [--days N] [--json]
       seshi sync failed <source> [--since <time>] [--limit N] [--json]
       seshi sync dropped <source> [--since <time>] [--limit N] [--json]
       (each also takes --config <file> and --set path=value;
        status, failed and dropped take --server <url> instead)`;

const SUBCOMMANDS = ["run", "assemble", "prune", "status", "failed", "dropped"];
const ONE_SHOTS = new Set(["assemble", "prune"]);

const OPTIONS = {
  ...SERVER_OPTIONS,
  server: { type: "string" },
  force: { type: "boolean" },
  days: { type: "string" },
  since: { type: "string" },
  limit: { type: "string" },
} as const;

interface Values {
  config?: string;
  set?: string[];
  server?: string;
  force?: boolean;
  days?: string;
  since?: string;
  limit?: string;
}

class UsageError extends Error {}

function positiveInt(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`--${name} must be a whole number ≥ 1`);
  return n;
}

function sourceCode(err: SourceError): ExitCode {
  if (err.code === "unknown_source") return EXIT.notFound;
  if (err.code === "busy") return EXIT.conflict;
  return EXIT.failure;
}

function reportLines(report: RunReport): string[] {
  const outcomes = Object.entries(report.outcomes)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ");
  const lines = [
    `source ${report.source}: ${report.outcome}, ${report.submitted} envelope(s) submitted${outcomes ? ` (${outcomes})` : ""}, checkpoint ${report.checkpoint_saved ? "saved" : "not saved"}`,
  ];
  if (report.more) lines.push("more is waiting: run it again");
  if (report.error) lines.push(`${report.outcome === "error" ? "error" : "note"}: ${report.error}`);
  return lines;
}

function statusLine(s: SourceStatus): string {
  const health = Object.entries(s.health)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  const state = s.polled ? `polled every ${Math.round((s.interval_ms ?? 0) / 1000)}s` : s.note;
  return `${s.id.padEnd(20)} ${s.type.padEnd(8)} ${state}; checkpoint ${s.checkpoint ? s.checkpoint.updated_at : "none"}; ${s.dropped} dropped, ${s.failed} failed${health ? `; ${health}` : ""}`;
}

async function runSource(
  ctx: CommandContext,
  json: boolean,
  instance: Instance,
  id: string,
  values: Values,
) {
  const report = await instance.sources.run(id, { force: values.force === true });
  emit(ctx, json, report, () => reportLines(report));
  if (report.outcome === "discarded") return EXIT.conflict;
  return report.outcome === "error" ? EXIT.failure : EXIT.ok;
}

function assembleLines(run: AssembleRun): string[] {
  const outcomes = Object.entries(run.outcomes)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ");
  const lines = [
    `assembler: ${run.published} session(s) published${outcomes ? ` (${outcomes})` : ""}, ${run.waiting} waiting for quiet, ${run.failed} failed, ${run.errors} error(s)`,
  ];
  if (run.retouched > 0)
    lines.push(`${run.retouched} got new spans while publishing: run it again`);
  else if (run.more) lines.push("more is waiting: run it again");
  if (run.error) lines.push(`error: ${printable(run.error)}`);
  return lines;
}

async function assemble(ctx: CommandContext, json: boolean, instance: Instance) {
  const result = await instance.assemble();
  emit(ctx, json, result, () => assembleLines(result));
  return result.errors > 0 ? EXIT.failure : EXIT.ok;
}

async function prune(ctx: CommandContext, json: boolean, instance: Instance) {
  const result: PruneRun = await instance.prune();
  emit(ctx, json, result, () => [
    `retention: ${result.dropped} drop record(s), ${result.failed} failure record(s) and ${result.health} health shard(s) removed`,
    ...(result.error ? [`error: ${printable(result.error)}`] : []),
  ]);
  return result.error ? EXIT.failure : EXIT.ok;
}

async function status(
  ctx: CommandContext,
  json: boolean,
  instance: Instance,
  id: string | undefined,
  values: Values,
) {
  const days = positiveInt(values.days, "days", 7);
  const ids =
    id !== undefined ? [id] : [...instance.config.sources.map((s) => s.id), UPLOAD_SOURCE];
  const statuses: SourceStatus[] = [];
  for (const each of ids) statuses.push(await instance.sources.status(each, { days }));
  emit(ctx, json, id !== undefined ? statuses[0] : { sources: statuses }, () => [
    `last ${days} day(s):`,
    ...statuses.map(statusLine),
  ]);
  return EXIT.ok;
}

async function records(
  ctx: CommandContext,
  json: boolean,
  instance: Instance,
  kind: "failed" | "dropped",
  id: string,
  values: Values,
) {
  const known =
    id === UPLOAD_SOURCE ||
    instance.source(id) !== undefined ||
    (await sourcesWithRecords(instance.store)).includes(id);
  if (!known) instance.sources.get(id);
  const limit = positiveInt(values.limit, "limit", 50);
  const since = sinceOf(values);
  const page = await listRecords(instance.store, kind, id, {
    limit,
    ...(since ? { since } : {}),
  });
  const result = { source: id, kind, ...page };
  emit(ctx, json, result, () => recordLines(result));
  return EXIT.ok;
}

function sinceOf(values: Values): string | undefined {
  if (values.since === undefined) return undefined;
  const at = new Date(values.since);
  if (Number.isNaN(at.getTime())) throw new UsageError("--since must be a date or time");
  return at.toISOString();
}

function recordLines(page: {
  source: string;
  kind: "failed" | "dropped";
  records: { record: unknown }[];
  truncated: boolean;
}): string[] {
  if (page.records.length === 0) return [`no ${page.kind} records for ${page.source}`];
  const lines = page.records.map(({ record }) => {
    const r = record as FailedRecord | DroppedRecord;
    const why = "code" in r ? `${r.code}: ${r.message}` : `${r.reason} (${r.policy})`;
    return printable(`${r.at}  ${r.session_key ?? "-"}  ${why}`);
  });
  if (page.truncated) {
    const last = page.records.at(-1)?.record as { at?: string } | undefined;
    lines.push(`… more: --since ${last?.at}`);
  }
  return lines;
}

async function remoteSync(
  ctx: CommandContext,
  json: boolean,
  db: HttpSessionDB,
  sub: "status" | "failed" | "dropped",
  id: string | undefined,
  values: Values,
): Promise<number> {
  const unknown = (source: string) =>
    new Refused(EXIT.notFound, "unknown_source", `no source '${source}' on ${db.server}`);
  if (sub === "status") {
    const days = positiveInt(values.days, "days", 7);
    if (id !== undefined) {
      const status = await db.source(id, { days });
      if (!status) throw unknown(id);
      emit(ctx, json, status, () => [`last ${days} day(s):`, statusLine(status as SourceStatus)]);
      return EXIT.ok;
    }
    const sources = await db.sources({ days });
    emit(ctx, json, { sources }, () => [
      `last ${days} day(s):`,
      ...sources.map((s) => statusLine(s as SourceStatus)),
    ]);
    return EXIT.ok;
  }
  const limit = positiveInt(values.limit, "limit", 50);
  const since = sinceOf(values);
  const page: RecordsPage | null = await db.records(sub, id as string, {
    limit,
    ...(since ? { since } : {}),
  });
  if (!page) throw unknown(id as string);
  emit(ctx, json, page, () => recordLines(page));
  return EXIT.ok;
}

export async function run(ctx: CommandContext): Promise<number> {
  const { json, rest } = takeJson(ctx.argv);
  const [sub, ...args] = rest;
  if (!sub || !SUBCOMMANDS.includes(sub)) {
    return usageError(
      ctx,
      json,
      sub === undefined ? "sync needs a subcommand" : `unknown sync command '${sub}'`,
      USAGE,
    );
  }
  let values: Values;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args,
      options: OPTIONS,
      strict: true,
      allowPositionals: true,
    }));
  } catch (err) {
    return usageError(ctx, json, (err as Error).message, USAGE);
  }
  const id = positionals[0];
  if (ONE_SHOTS.has(sub) && (positionals.length > 0 || values.force !== undefined)) {
    return usageError(
      ctx,
      json,
      sub === "assemble"
        ? "sync assemble takes no source id: it publishes every source's quiet span sessions"
        : "sync prune takes no source id: it prunes every source's old records",
      USAGE,
    );
  }
  if (positionals.length > 1 || (sub !== "status" && !ONE_SHOTS.has(sub) && id === undefined)) {
    return usageError(ctx, json, `sync ${sub} takes one source id`, USAGE);
  }
  if (values.server !== undefined && (values.config !== undefined || values.set !== undefined)) {
    return usageError(ctx, json, "give --server, or --config and --set, not both", USAGE);
  }
  try {
    const target = await adminTarget(ctx, values);
    if (target.kind === "remote") {
      if (sub === "run" || ONE_SHOTS.has(sub)) {
        const does = { run: "polls", assemble: "assembles", prune: "prunes" }[sub];
        throw new UsageError(
          `sync ${sub} runs from where the server config is (X7.1); ${target.server}'s worker ${does} on its own`,
        );
      }
      return await remoteSync(
        ctx,
        json,
        target.db,
        sub as "status" | "failed" | "dropped",
        id,
        values,
      );
    }
    const local = target.config ? { ...values, config: target.config } : values;
    const { instance } = await openServer(ctx, local, {
      roles: [],
      probe: [],
      initialize: sub === "run" || ONE_SHOTS.has(sub),
    });
    try {
      if (sub === "run") return await runSource(ctx, json, instance, id as string, values);
      if (sub === "assemble") return await assemble(ctx, json, instance);
      if (sub === "prune") return await prune(ctx, json, instance);
      if (sub === "status") return await status(ctx, json, instance, id, values);
      return await records(ctx, json, instance, sub as "failed" | "dropped", id as string, values);
    } finally {
      await instance.close();
    }
  } catch (err) {
    if (err instanceof UsageError) return usageError(ctx, json, err.message, USAGE);
    if (err instanceof SourceError) return fail(ctx, json, sourceCode(err), err.code, err.message);
    const code = serverFailure(ctx, json, err);
    if (code !== undefined) return code;
    return failWith(ctx, json, err);
  }
}
