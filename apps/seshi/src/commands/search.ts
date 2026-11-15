/** `seshi search <query>`: keyword search over the sessions you may read (F10.5).
 *
 *   seshi search <words…> [--owner <id>] [--agent <a>] [--repo <r>] [--branch <b>]
 *                [--source <id>] [--since <time|7d>] [--until <time|7d>]
 *                [--sort relevance|recent] [--limit <n>] [--matches <n>] [--cursor <c>]
 *                [--server <url> --token <t> [--user <name>]] [--config <file>] [--set k=v]… [--json]
 *   seshi search --status [--config <file>]    the local index: where it is, how much it holds
 *   seshi search --rebuild [--config <file>]   drop the local index and build it again from the change feed
 *
 * It asks a seshi server (`GET /v1/search` through `@seshi/client`) when the CLI config names
 * one (`server`, or `--server`), or searches in-process (F8.3): with `[local] config` in the CLI
 * config, with `--config`, or where the server's own config is (`SESHI_CONFIG`, `./seshi.toml`,
 * `/etc/seshi/seshi.toml`). In-process, whoever holds the bucket keys reads everything (X5.6),
 * so nothing is filtered by owner; the local index is brought up to date with the change feed
 * before every search (built from scratch the first time).
 *
 * Output is plain text: a line per session and a line per matching record. Branch 13 styles it
 * (B1.4: lilac for search results); `resultLines` is the seam. `--json` prints the API's
 * `SearchResults` as is.
 *
 * Exit codes: 0 (also when nothing matches), 2 for a query that cannot be run, 3 when nothing
 * is configured or search is off, 5 when not signed in or not allowed, 7 when the server or
 * bucket cannot answer (or the server's index is still being built). */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { HttpSessionDB, ServerError } from "@seshi/client";
import { findServerConfig, loadCliConfig, parseDuration } from "@seshi/config";
import type { Instance } from "@seshi/instance";
import {
  Forbidden,
  type SearchRequest,
  type SearchResult,
  type SearchResults,
  type SearchSort,
  StoreError,
} from "@seshi/model";
import {
  LOCAL_VIEWER,
  SearchQueryError,
  type SearchStatus,
  SearchUnavailable,
} from "@seshi/search";
import { EXIT } from "../cli/exit";
import { emit, fail, takeJson, usageError } from "../cli/output";
import { connect, NotConnected } from "../connect";
import type { CommandContext } from "./index";
import { openServer, serverFailure } from "./server-instance";

const USAGE = [
  "usage: seshi search <words…> [--owner <id>] [--agent <a>] [--repo <r>] [--branch <b>] [--source <id>]",
  "                    [--since <time|7d>] [--until <time|7d>] [--sort relevance|recent]",
  "                    [--limit <n>] [--matches <n>] [--cursor <c>]",
  "                    [--server <url> --token <t> [--user <name>]] [--config <file>] [--set path=value]… [--json]",
  "       seshi search --status | --rebuild [--config <file>] [--set path=value]… [--json]",
].join("\n");

const OPTIONS = {
  owner: { type: "string" },
  agent: { type: "string" },
  repo: { type: "string" },
  branch: { type: "string" },
  source: { type: "string" },
  since: { type: "string" },
  until: { type: "string" },
  sort: { type: "string" },
  limit: { type: "string" },
  matches: { type: "string" },
  cursor: { type: "string" },
  server: { type: "string" },
  token: { type: "string" },
  user: { type: "string" },
  config: { type: "string" },
  set: { type: "string", multiple: true },
  status: { type: "boolean" },
  rebuild: { type: "boolean" },
} as const;

type Values = {
  [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K]["type"] extends "boolean"
    ? boolean
    : (typeof OPTIONS)[K] extends { multiple: true }
      ? string[]
      : string;
};

class UsageProblem extends Error {}

/** `--since 7d`, `--since 2026-11-01` or an RFC 3339 time, as RFC 3339. */
export function timeArg(value: string, name: string, now: Date): string {
  const ago = parseDuration(value);
  if (ago !== undefined) return new Date(now.getTime() - ago).toISOString();
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new UsageProblem(
      `--${name} must be a time (2026-11-01, an RFC 3339 time) or an age (7d, 12h)`,
    );
  }
  return new Date(ms).toISOString();
}

function intArg(value: string, name: string): number {
  if (!/^\d+$/.test(value)) throw new UsageProblem(`--${name} must be a whole number`);
  return Number.parseInt(value, 10);
}

/** The search the command line asks for. */
export function requestOf(query: string, values: Values, now: Date): SearchRequest {
  return {
    q: query,
    ...(values.owner !== undefined ? { owner: values.owner } : {}),
    ...(values.agent !== undefined ? { agent: values.agent } : {}),
    ...(values.repo !== undefined ? { repo: values.repo } : {}),
    ...(values.branch !== undefined ? { branch: values.branch } : {}),
    ...(values.source !== undefined ? { source: values.source } : {}),
    ...(values.since !== undefined ? { since: timeArg(values.since, "since", now) } : {}),
    ...(values.until !== undefined ? { until: timeArg(values.until, "until", now) } : {}),
    ...(values.sort !== undefined ? { sort: values.sort as SearchSort } : {}),
    ...(values.limit !== undefined ? { limit: intArg(values.limit, "limit") } : {}),
    ...(values.matches !== undefined ? { matches: intArg(values.matches, "matches") } : {}),
    ...(values.cursor !== undefined ? { cursor: values.cursor } : {}),
  };
}

/** `2026-11-14 09:05` (UTC). */
function when(iso: string | undefined): string {
  return iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : "";
}

/** One line of text: newlines and runs of space folded. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The lines for one result: the session, then each matching record. */
export function resultLines(result: SearchResult): string[] {
  const where = [result.project, result.branch].filter(Boolean).join(" @ ");
  const head = [
    `${result.agent}/${result.session_id}`,
    result.owner,
    ...(where ? [where] : []),
    when(result.ended_at ?? result.updated_at),
    `${result.hits} ${result.hits === 1 ? "match" : "matches"}`,
  ];
  const lines = [head.join("  ")];
  for (const match of result.matches) {
    const label = match.tool_name ? `${match.role} ${match.tool_name}` : match.role;
    lines.push(`  ${label}: ${flat(match.snippet)}`);
  }
  return lines;
}

/** Every line `seshi search` prints for an answer. */
export function searchLines(results: SearchResults): string[] {
  if (results.results.length === 0) {
    return [results.total === 0 ? "No sessions match." : "No more sessions match."];
  }
  const lines: string[] = [];
  for (const result of results.results) {
    if (lines.length > 0) lines.push("");
    lines.push(...resultLines(result));
  }
  lines.push("");
  const shown = results.results.length;
  lines.push(
    results.cursor
      ? `${shown} of ${results.total} sessions shown; more with --cursor ${results.cursor}`
      : `${results.total} ${results.total === 1 ? "session" : "sessions"} match.`,
  );
  return lines;
}

function statusLines(status: SearchStatus): string[] {
  return [
    `index ${status.path}`,
    status.ready
      ? `ready since ${when(status.ready_at)}; last caught up ${when(status.caught_up_at)}`
      : "not built yet: the next search builds it from the change feed",
    `${status.sessions} sessions, ${status.events} records indexed`,
  ];
}

/** Whether a server config is where `seshi serve` would look for one. */
function serverConfigHere(ctx: CommandContext): boolean {
  if (ctx.env.SESHI_STORE__URL) return true;
  return (
    findServerConfig({ env: ctx.env, cwd: process.cwd(), exists: (p) => existsSync(p) }).path !==
    undefined
  );
}

/** Run against an in-process Instance (local mode, or where the server's config is). */
async function inProcess(
  ctx: CommandContext,
  json: boolean,
  instance: Instance,
  mode: "query" | "status" | "rebuild",
  request: SearchRequest | undefined,
): Promise<number> {
  const search = instance.search;
  if (!search) {
    return fail(
      ctx,
      json,
      EXIT.config,
      "search_disabled",
      "search is turned off in this config ([search] enabled = false)",
    );
  }
  if (mode === "status") {
    const status = search.status();
    emit(ctx, json, status, () => statusLines(status));
    return EXIT.ok;
  }
  if (mode === "rebuild") {
    const run = await search.rebuild();
    const status = search.status();
    emit(ctx, json, { ...status, rebuilt: run }, () => [
      `Rebuilt the search index from ${run.entries} change entries: ${status.sessions} sessions.`,
      `index ${status.path}`,
    ]);
    return EXIT.ok;
  }
  if (!search.ready() && !json) {
    ctx.stderr("seshi: building the search index from the change feed (first use)…");
  }
  await search.catchUp();
  const results = await search.search(LOCAL_VIEWER, request as SearchRequest);
  emit(ctx, json, results, () => searchLines(results));
  return EXIT.ok;
}

export async function run(ctx: CommandContext): Promise<number> {
  const { json, rest } = takeJson(ctx.argv);
  let values: Values;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: rest,
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    }) as { values: Values; positionals: string[] });
  } catch (err) {
    return usageError(ctx, json, (err as Error).message, USAGE);
  }
  const mode = values.status ? "status" : values.rebuild ? "rebuild" : "query";
  if (values.status && values.rebuild) {
    return usageError(ctx, json, "--status and --rebuild are separate runs", USAGE);
  }
  if (mode === "query" && positionals.length === 0) {
    return usageError(ctx, json, "search needs words to look for", USAGE);
  }
  if (mode !== "query" && positionals.length > 0) {
    return usageError(ctx, json, `--${mode} takes no words`, USAGE);
  }
  let request: SearchRequest | undefined;
  try {
    if (mode === "query") request = requestOf(positionals.join(" "), values, new Date());
  } catch (err) {
    if (err instanceof UsageProblem) return usageError(ctx, json, err.message, USAGE);
    throw err;
  }

  try {
    // 1. A server config named on the command line: in-process, as the server commands do.
    if (values.config !== undefined || values.set !== undefined) {
      return await withServer(ctx, json, values, mode, request);
    }
    // 2. The CLI's own config: a server, or local mode.
    const home = ctx.env.HOME ?? ctx.env.USERPROFILE ?? homedir();
    const loaded = loadCliConfig({ home, env: ctx.env });
    for (const warning of loaded.warnings) ctx.stderr(`seshi: warning: ${warning}`);
    const cli = loaded.config;
    const server = values.server ?? cli.server;
    if (server !== undefined && (values.server !== undefined || cli.local === undefined)) {
      if (mode !== "query") {
        return usageError(
          ctx,
          json,
          `--${mode} works on a local index; run it where the index is (with --config)`,
          USAGE,
        );
      }
      return await overHttp(ctx, json, server, values, cli.user, request as SearchRequest);
    }
    if (cli.local !== undefined) {
      const connection = await connect({
        cli: { ...cli, server: undefined },
        env: ctx.env,
        home,
        integrations: await ctx.integrations(),
      });
      try {
        return await inProcess(ctx, json, connection.instance as Instance, mode, request);
      } finally {
        await connection.close();
      }
    }
    // 3. Where the server's own config is (a server host, a container).
    if (serverConfigHere(ctx)) return await withServer(ctx, json, values, mode, request);
    return fail(
      ctx,
      json,
      EXIT.config,
      "not_configured",
      "no server or local bucket configured: run seshi login --server <url> (or pass --server and --token), or set [local] config in the CLI config",
    );
  } catch (err) {
    return failure(ctx, json, err);
  }
}

async function withServer(
  ctx: CommandContext,
  json: boolean,
  values: Values,
  mode: "query" | "status" | "rebuild",
  request: SearchRequest | undefined,
): Promise<number> {
  const { instance } = await openServer(
    ctx,
    {
      ...(values.config !== undefined ? { config: values.config } : {}),
      ...(values.set ? { set: values.set } : {}),
    },
    { roles: [], probe: [], initialize: false },
  );
  try {
    return await inProcess(ctx, json, instance, mode, request);
  } finally {
    await instance.close();
  }
}

async function overHttp(
  ctx: CommandContext,
  json: boolean,
  server: string,
  values: Values,
  cliUser: string | undefined,
  request: SearchRequest,
): Promise<number> {
  if (values.token === undefined) {
    return fail(
      ctx,
      json,
      EXIT.auth,
      "unauthorized",
      `not signed in to ${server}: run seshi login, or pass --token`,
    );
  }
  const user = values.user ?? cliUser;
  const client = new HttpSessionDB({
    server,
    token: values.token,
    ...(user !== undefined ? { user } : {}),
  });
  const results = await client.search(request);
  emit(ctx, json, results, () => searchLines(results));
  return EXIT.ok;
}

/** The exit code for an error, printed; rethrows what no code covers. */
function failure(ctx: CommandContext, json: boolean, err: unknown): number {
  const config = serverFailure(ctx, json, err);
  if (config !== undefined) return config;
  if (err instanceof NotConnected)
    return fail(ctx, json, EXIT.config, "not_configured", err.message);
  if (err instanceof SearchQueryError) return usageError(ctx, json, err.message, USAGE);
  if (err instanceof SearchUnavailable) {
    return fail(ctx, json, EXIT.unavailable, err.code, err.message);
  }
  if (err instanceof Forbidden) return fail(ctx, json, EXIT.auth, "forbidden", err.message);
  if (err instanceof ServerError) {
    if (err.status === 400) return usageError(ctx, json, err.message, USAGE);
    if (err.status === 401) {
      return fail(ctx, json, EXIT.auth, err.code, `${err.message}: run seshi login`);
    }
    if (err.status === 403) return fail(ctx, json, EXIT.auth, err.code, err.message);
    if (err.status === 404 && err.code === "search_disabled") {
      return fail(ctx, json, EXIT.config, err.code, err.message);
    }
    if (err.status === 503) return fail(ctx, json, EXIT.unavailable, err.code, err.message);
    return fail(
      ctx,
      json,
      EXIT.unavailable,
      err.code,
      `the server answered ${err.status}: ${err.message}`,
    );
  }
  if (err instanceof StoreError)
    return fail(ctx, json, EXIT.unavailable, "unavailable", err.message);
  throw err;
}
