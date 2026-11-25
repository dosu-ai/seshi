import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { HttpSeshi, ServerError } from "@seshi/client";
import { findServerConfig, parseDuration } from "@seshi/config";
import type { Instance } from "@seshi/instance";
import {
  type EventRole,
  Forbidden,
  labelPairs,
  type SearchRequest,
  type SearchResult,
  type SearchResults,
  type SearchSort,
  StoreError,
} from "@seshi/model";
import {
  IndexUnavailable,
  LOCAL_VIEWER,
  SearchQueryError,
  type SearchService,
  type SearchStatus,
  SearchUnavailable,
} from "@seshi/search";
import { openAccount } from "../account/account";
import { normalizeServer } from "../account/logins";
import { type Backend, openBackend, ServerBackend, type ServerlessBackend } from "../backend";
import { EXIT } from "../cli/exit";
import { failWith } from "../cli/failures";
import { emit, fail, helpOrUsageError, takeJson } from "../cli/output";
import { printable, Style, styleFor } from "../cli/style";
import { NotConnected } from "../connect";
import { isServerless } from "../serverless/settings";
import { USER_AGENT } from "../user-agent";
import type { CommandContext } from "./index";
import { cwdConfigHint, openServer, serverFailure } from "./server-instance";

const USAGE = [
  "usage: seshi search <words…> [--owner <id>] [--agent <a>] [--repo <r>] [--branch <b>] [--source <id>]",
  "                    [--harness <h>] [--harness-version <v>] [--model <m>] [--role <r,…>]",
  "                    [--label key=value]…",
  "                    [--since <time|7d>] [--until <time|7d>] [--sort relevance|recent]",
  "                    [--limit <n>] [--matches <n>] [--cursor <c>]",
  "                    [--server <url>] [--token <t> [--user <name>]] [--config <file>] [--set path=value]… [--json]",
  "                    [--include-private]   serverless mode: owner-only sessions too",
  "       seshi search --status | --rebuild [--wait] | --scrub [--config <file>] [--set path=value]… [--json]",
].join("\n");

const OPTIONS = {
  owner: { type: "string" },
  agent: { type: "string" },
  repo: { type: "string" },
  branch: { type: "string" },
  harness: { type: "string" },
  "harness-version": { type: "string" },
  model: { type: "string" },
  label: { type: "string", multiple: true },
  source: { type: "string" },
  role: { type: "string" },
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
  wait: { type: "boolean" },
  scrub: { type: "boolean" },
  "include-private": { type: "boolean" },
} as const;

type Values = {
  [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K]["type"] extends "boolean"
    ? boolean
    : (typeof OPTIONS)[K] extends { multiple: true }
      ? string[]
      : string;
};

class UsageProblem extends Error {}

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

function labelArgs(given: readonly string[] | undefined): Record<string, string> | undefined {
  if (!given || given.length === 0) return undefined;
  const parsed = labelPairs(given);
  if ("problem" in parsed) throw new UsageProblem(`--label: ${parsed.problem}`);
  return parsed.labels;
}

/** `--role tool_result,observation`: the server checks the roles. */
function roleArg(value: string): EventRole[] {
  const roles = value
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r !== "");
  if (roles.length === 0) throw new UsageProblem("--role must name a role (tool_result, user, …)");
  return roles as EventRole[];
}

export function requestOf(query: string, values: Values, now: Date): SearchRequest {
  const labels = labelArgs(values.label);
  return {
    q: query,
    ...(values.owner !== undefined ? { owner: values.owner } : {}),
    ...(values.agent !== undefined ? { agent: values.agent } : {}),
    ...(values.repo !== undefined ? { repo: values.repo } : {}),
    ...(values.branch !== undefined ? { branch: values.branch } : {}),
    ...(values.harness !== undefined ? { harness: values.harness } : {}),
    ...(values["harness-version"] !== undefined
      ? { agent_version: values["harness-version"] }
      : {}),
    ...(values.model !== undefined ? { model: values.model } : {}),
    ...(labels ? { labels } : {}),
    ...(values.source !== undefined ? { source: values.source } : {}),
    ...(values.role !== undefined ? { role: roleArg(values.role) } : {}),
    ...(values.since !== undefined ? { since: timeArg(values.since, "since", now) } : {}),
    ...(values.until !== undefined ? { until: timeArg(values.until, "until", now) } : {}),
    ...(values.sort !== undefined ? { sort: values.sort as SearchSort } : {}),
    ...(values.limit !== undefined ? { limit: intArg(values.limit, "limit") } : {}),
    ...(values.matches !== undefined ? { matches: intArg(values.matches, "matches") } : {}),
    ...(values.cursor !== undefined ? { cursor: values.cursor } : {}),
  };
}

function when(iso: string | undefined): string {
  return iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : "";
}

function fold(text: string): string {
  return printable(text.replace(/\s+/g, " "));
}

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

export function resultLines(result: SearchResult, style: Style = Style.plain()): string[] {
  const where = printable(
    [result.repo ?? result.project, result.branch].filter(Boolean).join(" @ "),
  );
  const head = [
    style.search(printable(`${result.format}/${result.session_id}`)),
    printable(result.owner),
    ...(where ? [style.muted(where)] : []),
    style.muted(when(result.ended_at ?? result.updated_at)),
    `${result.hits} ${result.hits === 1 ? "match" : "matches"}`,
  ];
  const lines = [head.join("  ")];
  for (const match of result.matches) {
    const label = printable(
      [
        ...(typeof match.seq === "number" ? [`#${match.seq}`] : []),
        match.role,
        ...(match.tool_name ? [match.tool_name] : []),
      ].join(" "),
    );
    lines.push(
      `  ${style.muted(`${label}:`)} ${highlighted(match.snippet, match.highlights, style)}`,
    );
  }
  return lines;
}

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
  const caughtUp = results.index?.caught_up_at;
  lines.push(
    style.muted(
      `${
        results.cursor
          ? `${shown} of ${results.capped ? "at least " : ""}${results.total} sessions shown; more with --cursor ${results.cursor}`
          : `${results.capped ? "At least " : ""}${results.total} ${results.total === 1 && !results.capped ? "session" : "sessions"} match.`
      }${caughtUp ? ` Index caught up ${when(caughtUp)}.` : ""}`,
    ),
  );
  return lines;
}

export function statusLines(status: SearchStatus): string[] {
  const shared = status.backend === "lance";
  return [
    `index ${status.location}${shared ? " (LanceDB, kept by the worker)" : ""}`,
    status.ready
      ? `ready since ${when(status.ready_at)}; last caught up ${when(status.caught_up_at)}`
      : shared
        ? "not built yet: the worker is building it from the change feed"
        : "not built yet: the next search builds it from the change feed",
    `${status.sessions} sessions, ${status.events} records indexed${
      status.generation ? ` (generation ${status.generation})` : ""
    }`,
    ...(status.building
      ? [
          `rebuilding: generation ${status.building.generation}, read through ${
            when(status.building.read_through) || "the start"
          }; the live generation answers until it has caught up`,
        ]
      : []),
    ...(status.requested?.rebuild
      ? [
          `rebuild asked for ${when(status.requested.rebuild)}: the worker starts it on its next pass`,
        ]
      : []),
    ...(status.requested?.scrub
      ? [`scrub asked for ${when(status.requested.scrub)}: the worker runs it on its next pass`]
      : []),
  ];
}

type Mode = "query" | "status" | "rebuild" | "scrub";

/** How often `--rebuild --wait` reads the index's state. */
export const WAIT_POLL_MS = 2_000;
/** How long `--rebuild --wait` waits with nothing moving before it asks whether a worker is
 * running (at least; 20 indexer intervals when that is longer). */
export const STALL_MS = 15 * 60_000;

export interface WaitOptions {
  pollMs: number;
  /** Nothing moved for this long: give up when no worker is running, else say so once. */
  stallMs: number;
  workerAlive: () => Promise<boolean>;
  progress: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const NO_WORKER =
  "no worker is running to carry out the rebuild: see seshi workers status, or, for a deployment that runs the worker's jobs from cron, run seshi sync search";

/** Follow a requested rebuild of a shared index until a generation other than `from` is live
 * and nothing more is being built or asked for. It gives up when nothing has moved (the
 * request, the generation being built, how far it has read) for `stallMs` and no worker is
 * running. */
export async function waitForRebuild(
  search: Pick<SearchService, "status">,
  from: string,
  options: WaitOptions,
): Promise<{ status: SearchStatus } | { stalled: string }> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  if (!(await options.workerAlive())) options.progress(`warning: ${NO_WORKER}`);
  let seen = "";
  let moved = now();
  let warned = false;
  for (;;) {
    const status = await search.status();
    if (
      status.generation !== undefined &&
      status.generation !== from &&
      status.ready &&
      !status.building &&
      !status.requested?.rebuild
    ) {
      return { status };
    }
    const at = JSON.stringify([
      status.generation,
      status.building?.generation,
      status.building?.read_through,
      status.requested?.rebuild,
    ]);
    if (at !== seen) {
      if (seen !== "") {
        options.progress(
          status.building
            ? `building generation ${status.building.generation}, read through ${when(status.building.read_through) || "the start"}`
            : "the worker took the request",
        );
      }
      seen = at;
      moved = now();
      warned = false;
    } else if (now() - moved >= options.stallMs) {
      if (!(await options.workerAlive())) {
        return {
          stalled: `the rebuild has not moved for ${Math.round((now() - moved) / 60_000)} min and ${NO_WORKER}`,
        };
      }
      if (!warned) {
        options.progress(
          "the rebuild has not moved for a while; the worker is running (building a large generation's indexes takes minutes)",
        );
        warned = true;
      }
    }
    await sleep(options.pollMs);
  }
}

function serverConfigHere(ctx: CommandContext): boolean {
  if (ctx.env.SESHI_STORE__URL) return true;
  return (
    findServerConfig({ env: ctx.env, cwd: process.cwd(), exists: (p) => existsSync(p) }).path !==
    undefined
  );
}

async function inProcess(
  ctx: CommandContext,
  json: boolean,
  instance: Instance,
  mode: Mode,
  request: SearchRequest | undefined,
  style: Style,
  wait = false,
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
  if (mode === "query") {
    // A shared index is the worker's to keep current; this process only reads it.
    if (!search.shared) {
      if (!json && !(await search.ready())) {
        ctx.stderr("seshi: building the search index from the change feed (first use)…");
      }
      await search.catchUp();
    }
    const results = await search.search(LOCAL_VIEWER, request as SearchRequest);
    emit(ctx, json, results, () => searchLines(results, style));
    return EXIT.ok;
  }
  if (mode === "status") {
    const status = await search.status();
    emit(ctx, json, status, () => statusLines(status));
    return EXIT.ok;
  }
  if (mode === "scrub") {
    const asked = await search.requestScrub();
    emit(ctx, json, { scrub: asked ? "requested" : "not_needed" }, () => [
      asked
        ? "Asked the worker to scrub the search index on its next pass: deleted, retracted and redacted text leaves the bucket then."
        : "Nothing to scrub: SQLite removes deleted text from its file when it commits.",
    ]);
    return EXIT.ok;
  }
  if (mode === "rebuild" && search.shared) {
    // Only the worker writes a shared index (F10.8): this asks it to rebuild on its next pass.
    const { from } = await search.requestRebuild();
    if (!wait) {
      const status = await search.status();
      emit(ctx, json, { ...status, rebuild: "requested" }, () => [
        "Asked the worker to rebuild the search index: on its next pass it starts a new generation beside the live one, which keeps answering until the new one has caught up.",
        "Follow it with seshi search --status, or run with --wait.",
      ]);
      return EXIT.ok;
    }
    const { workerRunning } = await import("@seshi/instance");
    const outcome = await waitForRebuild(search, from, {
      pollMs: WAIT_POLL_MS,
      stallMs: Math.max(STALL_MS, 20 * instance.config.search.interval),
      workerAlive: () => workerRunning(instance),
      progress: (line) => {
        if (!json) ctx.stderr(`seshi: ${line}`);
      },
    });
    if ("stalled" in outcome) {
      return fail(ctx, json, EXIT.unavailable, "rebuild_stalled", outcome.stalled);
    }
    const status = outcome.status;
    emit(ctx, json, { ...status, rebuilt: status.generation }, () => [
      `Rebuilt the search index: generation ${status.generation} is live, ${status.sessions} sessions.`,
      `index ${status.location}`,
    ]);
    return EXIT.ok;
  }
  if (mode === "rebuild") {
    const run = await search.rebuild();
    const status = await search.status();
    emit(ctx, json, { ...status, rebuilt: run }, () => [
      `Rebuilt the search index from ${run.entries} change entries: ${status.sessions} sessions.`,
      `index ${status.location}`,
    ]);
    return EXIT.ok;
  }
  return EXIT.ok;
}

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
    return helpOrUsageError(ctx, json, (err as Error).message, USAGE);
  }
  const modes = (["status", "rebuild", "scrub"] as const).filter((m) => values[m]);
  if (modes.length > 1) {
    return helpOrUsageError(
      ctx,
      json,
      `${modes.map((m) => `--${m}`).join(" and ")} are separate runs`,
      USAGE,
    );
  }
  const mode: Mode = (modes[0] as Mode | undefined) ?? "query";
  if (values.wait && mode !== "rebuild") {
    return helpOrUsageError(ctx, json, "--wait goes with --rebuild", USAGE);
  }
  if (mode === "query" && positionals.length === 0) {
    return helpOrUsageError(ctx, json, "search needs words to look for", USAGE);
  }
  if (mode !== "query" && positionals.length > 0) {
    return helpOrUsageError(ctx, json, `--${mode} takes no words`, USAGE);
  }
  let request: SearchRequest | undefined;
  try {
    if (mode === "query") request = requestOf(positionals.join(" "), values, new Date());
  } catch (err) {
    if (err instanceof UsageProblem) return helpOrUsageError(ctx, json, err.message, USAGE);
    throw err;
  }

  let backend: Backend | undefined;
  try {
    if (values.config !== undefined || values.set !== undefined) {
      return await withServer(ctx, json, values, mode, request, await styleFor(ctx, { json }));
    }
    const account = openAccount(ctx);
    const cli = account.cli;
    const style = await styleFor(ctx, { json, theme: cli.theme });
    const server = values.server ?? cli.server;
    if (server !== undefined && (values.server !== undefined || !isServerless(cli))) {
      if (mode !== "query") {
        return helpOrUsageError(
          ctx,
          json,
          `--${mode} works on a local index; run it where the index is (with --config)`,
          USAGE,
        );
      }
      if (values.token !== undefined) {
        const user = values.user ?? cli.user;
        backend = new ServerBackend(
          new HttpSeshi({
            server: normalizeServer(server),
            token: values.token,
            userAgent: USER_AGENT,
            ...(user !== undefined ? { user } : {}),
          }),
          user,
        );
      } else {
        backend = await openBackend(ctx, account, {
          server,
          purpose: values.owner ? "read_others" : "read",
        });
      }
      return await query(ctx, json, backend, request as SearchRequest, style);
    }
    if (isServerless(cli)) {
      backend = await openBackend(ctx, account, {
        includePrivate: values["include-private"] === true,
      });
      if (mode === "query") return await query(ctx, json, backend, request as SearchRequest, style);
      return await inProcess(
        ctx,
        json,
        (backend as ServerlessBackend).instance,
        mode,
        request,
        style,
        values.wait === true,
      );
    }
    if (serverConfigHere(ctx)) {
      return await withServer(ctx, json, values, mode, request, style);
    }
    cwdConfigHint(ctx, undefined);
    return fail(
      ctx,
      json,
      EXIT.config,
      "not_configured",
      "no server or bucket configured: run seshi login --server <url> (or pass --server and --token), or seshi init --serverless",
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
  mode: Mode,
  request: SearchRequest | undefined,
  style: Style,
): Promise<number> {
  const { instance } = await openServer(
    ctx,
    {
      ...(values.config !== undefined ? { config: values.config } : {}),
      ...(values.set ? { set: values.set } : {}),
    },
    {
      roles: [],
      probe: [],
      claimUnmarkedBucket: false,
    },
  );
  try {
    return await inProcess(ctx, json, instance, mode, request, style, values.wait === true);
  } finally {
    await instance.close();
  }
}

function failure(ctx: CommandContext, json: boolean, err: unknown): number {
  const config = serverFailure(ctx, json, err);
  if (config !== undefined) return config;
  if (err instanceof NotConnected)
    return fail(ctx, json, EXIT.config, "not_configured", err.message);
  if (err instanceof SearchQueryError) return helpOrUsageError(ctx, json, err.message, USAGE);
  if (err instanceof SearchUnavailable || err instanceof IndexUnavailable) {
    return fail(ctx, json, EXIT.unavailable, err.code, err.message);
  }
  if (err instanceof Forbidden) return fail(ctx, json, EXIT.auth, "forbidden", err.message);
  if (err instanceof ServerError) {
    if (err.status === 400) return helpOrUsageError(ctx, json, err.message, USAGE);
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
