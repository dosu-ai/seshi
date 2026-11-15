/** `seshi sync` (X7.1, X4.8, X6.4): the pollers as one-shot commands, and what they left
 * behind. Run where the server's config and bucket keys are.
 *
 *   seshi sync run <source> [--force] [--json]       poll a source once (for cron, X7.1)
 *   seshi sync status [<source>] [--days N] [--json] checkpoints, record counts, health
 *   seshi sync failed <source> [--since <time>] [--limit N] [--json]
 *   seshi sync dropped <source> [--since <time>] [--limit N] [--json]
 *
 * Each also takes `--config <file>` and `--set path=value`. `failed` and `dropped` list the
 * records of envelopes that were not stored and why, never their content; `upload` is the
 * source id of hooks and `seshi upload`.
 *
 * `status`, `failed` and `dropped` also run from a machine signed in with `seshi login` as an
 * admin, through the server's `/v1/admin/sources` routes: `--server <url>`, or the CLI config's
 * `server` when no server config is here (`admin-target.ts`). `run` polls from where the
 * server config is only; on a server the worker polls on its own.
 *
 * `run` exits 0 when the run finished, 6 (`conflict`) when another worker moved the checkpoint
 * and the run was discarded (X7.3), 1 when the connector failed. */

import { parseArgs } from "node:util";
import type { HttpSessionDB, RecordsPage } from "@seshi/client";
import type { Instance } from "@seshi/instance";
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
       seshi sync status [<source>] [--days N] [--json]
       seshi sync failed <source> [--since <time>] [--limit N] [--json]
       seshi sync dropped <source> [--since <time>] [--limit N] [--json]
       (each also takes --config <file> and --set path=value;
        status, failed and dropped take --server <url> instead)`;

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
  // A source no longer in [[sources]] keeps its records until retention prunes them, and
  // status still lists it, so they can be read; an id with neither is unknown.
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

/** `--since` as an ISO time. */
function sinceOf(values: Values): string | undefined {
  if (values.since === undefined) return undefined;
  const at = new Date(values.since);
  if (Number.isNaN(at.getTime())) throw new UsageError("--since must be a date or time");
  return at.toISOString();
}

/** A page of records as lines: when, which session, why; never content. */
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
    // Records come from the bucket (and over HTTP, from a server): made printable.
    return printable(`${r.at}  ${r.session_key ?? "-"}  ${why}`);
  });
  if (page.truncated) {
    const last = page.records.at(-1)?.record as { at?: string } | undefined;
    lines.push(`… more: --since ${last?.at}`);
  }
  return lines;
}

/** `status`, `failed` and `dropped` through a server's admin routes. */
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
  if (!sub || !["run", "status", "failed", "dropped"].includes(sub)) {
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
  if (positionals.length > 1 || (sub !== "status" && id === undefined)) {
    return usageError(ctx, json, `sync ${sub} takes one source id`, USAGE);
  }
  if (values.server !== undefined && (values.config !== undefined || values.set !== undefined)) {
    return usageError(ctx, json, "give --server, or --config and --set, not both", USAGE);
  }
  try {
    const target = await adminTarget(ctx, values);
    if (target.kind === "remote") {
      if (sub === "run") {
        throw new UsageError(
          `sync run polls from where the server config is (X7.1); ${target.server}'s worker polls on its own`,
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
    // Only `run` writes; the others refuse a bucket no server has used rather than claim it.
    const local = target.config ? { ...values, config: target.config } : values;
    const { instance } = await openServer(ctx, local, {
      roles: [],
      probe: [],
      initialize: sub === "run",
    });
    try {
      if (sub === "run") return await runSource(ctx, json, instance, id as string, values);
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
