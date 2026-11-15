/** `seshi search <query>`: keyword search over the sessions you may read (F10.5).
 *
 *   seshi search <words…> [--owner <id>] [--agent <a>] [--repo <r>] [--branch <b>]
 *                [--source <id>] [--since <time|7d>] [--until <time|7d>]
 *                [--sort relevance|recent] [--limit <n>] [--matches <n>] [--cursor <c>]
 *                [--server <url>] [--token <t> [--user <name>]] [--config <file>] [--set k=v]… [--json]
 *   seshi search --status [--config <file>]    the local index: where it is, how much it holds
 *   seshi search --rebuild [--config <file>]   drop the local index and build it again from the change feed
 *
 * It goes through the same backend as `seshi sessions` (F8.3, `openBackend`): a seshi server
 * (`GET /v1/search`) when the CLI config names one (`server`, or `--server`), with the
 * credential `seshi login` stored (`--token`, with `--user` for the org key, overrides it); or
 * in-process, with `[local] config` in the CLI config. `--config` / `--set`, or a server config
 * where `seshi serve` would find one (`SESHI_CONFIG`, `./seshi.toml`, `/etc/seshi/seshi.toml`),
 * also search in-process. In-process, whoever holds the bucket keys reads everything (X5.6), so
 * nothing is filtered by owner; the local index is brought up to date with the change feed
 * before every search (built from scratch the first time).
 *
 * Output is a line per session and a line per matching record, in the search colour (B1.4:
 * lilac) for the session and the matched words (`SearchMatch.highlights`) on a terminal; plain
 * with `NO_COLOR`, `--no-color` or off a terminal. Stored text is printed through `printable`.
 * `--json` prints the API's `SearchResults` as is.
 *
 * Exit codes: 0 (also when nothing matches), 2 for a query that cannot be run, 3 when nothing
 * is configured or search is off, 5 when not signed in or not allowed, 7 when the server or
 * bucket cannot answer (or the server's index is still being built). */

import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { HttpSessionDB, ServerError } from "@seshi/client";
import { findServerConfig, parseDuration } from "@seshi/config";
import type { Instance } from "@seshi/instance";
import {
  Forbidden,
  type SearchRequest,
  type SearchResult,
  type SearchResults,
  type SearchSort,
  StoreError,
} from "@seshi/model";
import { SearchQueryError, type SearchStatus, SearchUnavailable } from "@seshi/search";
import { openAccount } from "../account/account";
import { normalizeServer } from "../account/logins";
import { type Backend, LocalBackend, openBackend, ServerBackend } from "../backend";
import { EXIT } from "../cli/exit";
import { failWith } from "../cli/failures";
import { emit, fail, takeJson, usageError } from "../cli/output";
import { printable, Style, styleFor } from "../cli/style";
import { NotConnected } from "../connect";
import type { CommandContext } from "./index";
import { openServer, serverFailure } from "./server-instance";

const USAGE = [
  "usage: seshi search <words…> [--owner <id>] [--agent <a>] [--repo <r>] [--branch <b>] [--source <id>]",
  "                    [--since <time|7d>] [--until <time|7d>] [--sort relevance|recent]",
  "                    [--limit <n>] [--matches <n>] [--cursor <c>]",
  "                    [--server <url>] [--token <t> [--user <name>]] [--config <file>] [--set path=value]… [--json]",
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

/** Stored text on one line: runs of white space folded, control characters made harmless. */
function fold(text: string): string {
  return printable(text.replace(/\s+/g, " "));
}

/** A snippet on one line, with the matched words (`highlights`: `[start, end)` offsets into
 * the snippet) in the search colour. Offsets are taken on the snippet as stored, before white
 * space is folded, so folding never moves a highlight. */
export function highlighted(
  snippet: string,
  highlights: readonly (readonly [number, number])[] | undefined,
  style: Style,
): string {
  const spans = [...(highlights ?? [])]
    .filter(([start, end]) => Number.isInteger(start) && Number.isInteger(end) && end > start)
    .sort((a, b) => a[0] - b[0]);
  let out = "";
  let at = 0;
  for (const [start, end] of spans) {
    const from = Math.max(start, at);
    const to = Math.min(end, snippet.length);
    if (to <= from) continue;
    out += fold(snippet.slice(at, from)) + style.search(fold(snippet.slice(from, to)));
    at = to;
  }
  out += fold(snippet.slice(at));
  return out.replace(/^ +| +$/g, "");
}

/** The lines for one result: the session, then each matching record. */
export function resultLines(result: SearchResult, style: Style = Style.plain()): string[] {
  const where = printable([result.project, result.branch].filter(Boolean).join(" @ "));
  const head = [
    style.search(printable(`${result.agent}/${result.session_id}`)),
    printable(result.owner),
    ...(where ? [style.muted(where)] : []),
    style.muted(when(result.ended_at ?? result.updated_at)),
    `${result.hits} ${result.hits === 1 ? "match" : "matches"}`,
  ];
  const lines = [head.join("  ")];
  for (const match of result.matches) {
    const label = printable(match.tool_name ? `${match.role} ${match.tool_name}` : match.role);
    lines.push(
      `  ${style.muted(`${label}:`)} ${highlighted(match.snippet, match.highlights, style)}`,
    );
  }
  return lines;
}

/** Every line `seshi search` prints for an answer. An empty answer carries B1.3's state word
 * for a search, Exploring. */
export function searchLines(results: SearchResults, style: Style = Style.plain()): string[] {
  if (results.results.length === 0) {
    return [
      `${style.status("Exploring", "search")}: ${results.total === 0 ? "no sessions match." : "no more sessions match."}`,
    ];
  }
  const lines: string[] = [];
  for (const result of results.results) {
    if (lines.length > 0) lines.push("");
    lines.push(...resultLines(result, style));
  }
  lines.push("");
  const shown = results.results.length;
  lines.push(
    style.muted(
      results.cursor
        ? `${shown} of ${results.total} sessions shown; more with --cursor ${results.cursor}`
        : `${results.total} ${results.total === 1 ? "session" : "sessions"} match.`,
    ),
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
  style: Style,
): Promise<number> {
  if (mode === "query") {
    return query(ctx, json, new LocalBackend(instance, ""), request as SearchRequest, style);
  }
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
  return EXIT.ok;
}

/** One search through a backend, printed. */
async function query(
  ctx: CommandContext,
  json: boolean,
  backend: Backend,
  request: SearchRequest,
  style: Style,
): Promise<number> {
  const results = await backend.search(request, {
    building: () => {
      if (!json) ctx.stderr("seshi: building the search index from the change feed (first use)…");
    },
  });
  emit(ctx, json, results, () => searchLines(results, style));
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

  let backend: Backend | undefined;
  try {
    // 1. A server config named on the command line: in-process, as the server commands do.
    if (values.config !== undefined || values.set !== undefined) {
      return await withServer(ctx, json, values, mode, request, await styleFor(ctx, { json }));
    }
    // 2. The CLI's own config: a server, or local mode.
    const account = openAccount(ctx);
    const cli = account.cli;
    const style = await styleFor(ctx, { json, theme: cli.theme });
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
      // The stored credential (`seshi login`), unless --token names one for this run.
      if (values.token !== undefined) {
        const user = values.user ?? cli.user;
        backend = new ServerBackend(
          new HttpSessionDB({
            server: normalizeServer(server),
            token: values.token,
            ...(user !== undefined ? { user } : {}),
          }),
          user,
        );
      } else {
        backend = await openBackend(ctx, account, { server });
      }
      return await query(ctx, json, backend, request as SearchRequest, style);
    }
    if (cli.local !== undefined) {
      backend = await openBackend(ctx, account);
      if (mode === "query") return await query(ctx, json, backend, request as SearchRequest, style);
      return await inProcess(ctx, json, (backend as LocalBackend).instance, mode, request, style);
    }
    // 3. Where the server's own config is (a server host, a container).
    if (serverConfigHere(ctx)) {
      return await withServer(ctx, json, values, mode, request, style);
    }
    return fail(
      ctx,
      json,
      EXIT.config,
      "not_configured",
      "no server or local bucket configured: run seshi login --server <url> (or pass --server and --token), or set [local] config in the CLI config",
    );
  } catch (err) {
    return failure(ctx, json, err);
  } finally {
    await backend?.close();
  }
}

async function withServer(
  ctx: CommandContext,
  json: boolean,
  values: Values,
  mode: "query" | "status" | "rebuild",
  request: SearchRequest | undefined,
  style: Style,
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
    return await inProcess(ctx, json, instance, mode, request, style);
  } finally {
    await instance.close();
  }
}

/** The exit code for an error, printed; rethrows what no code covers. Search's own refusals
 * first, then the client commands' (`failWith`: not signed in, a refused credential). */
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
  return failWith(ctx, json, err);
}
