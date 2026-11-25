import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { HttpSeshi, ServerError } from "@seshi/client";
import { findServerConfig } from "@seshi/config";
import type { Instance } from "@seshi/instance";
import {
  Forbidden,
  type SqlRequest,
  type SqlResult,
  type SqlSchema,
  StoreError,
} from "@seshi/model";
import {
  IndexUnavailable,
  LOCAL_VIEWER,
  SearchUnavailable,
  SqlBusy,
  type SqlCaller,
  SqlFailed,
  SqlRequestError,
  SqlUnavailable,
} from "@seshi/search";
import { openAccount } from "../account/account";
import { normalizeServer } from "../account/logins";
import { type Backend, openBackend, ServerBackend } from "../backend";
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
  'usage: seshi sql "<statement>" [--since <time|30d>] [--until <time|age>] [--max-rows <n>]',
  "                 [--server <url>] [--token <t> [--user <name>]] [--config <file>] [--set path=value]… [--json]",
  "       seshi sql --schema [--since …] [--until …] [… the same connection options]",
  "",
  "One read-only SELECT over the views sessions, events and llm_calls (seshi sql --schema shows",
  "their columns and the dialect). Needs the sql scope on a server (admins, service tokens); on a",
  'serverless laptop it reads the laptop\'s own index. "-" reads the statement from stdin.',
].join("\n");

const OPTIONS = {
  since: { type: "string" },
  until: { type: "string" },
  "max-rows": { type: "string" },
  schema: { type: "boolean" },
  server: { type: "string" },
  token: { type: "string" },
  user: { type: "string" },
  config: { type: "string" },
  set: { type: "string", multiple: true },
} as const;

type Values = {
  [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K]["type"] extends "boolean"
    ? boolean
    : (typeof OPTIONS)[K] extends { multiple: true }
      ? string[]
      : string;
};

/** How wide a cell is printed at most; the rest is cut with `…`. */
const CELL_WIDTH = 60;

function cell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  const text = printable(
    (typeof value === "string" ? value : JSON.stringify(value)).replace(/\s+/g, " "),
  );
  return text.length > CELL_WIDTH ? `${text.slice(0, CELL_WIDTH - 1)}…` : text;
}

/** The answer as a table, then one muted line: how many rows, how long, and who it was answered
 * as over which window. */
export function resultLines(result: SqlResult, style: Style = Style.plain()): string[] {
  const head = result.columns.map((c) => printable(c.name));
  const body = result.rows.map((row) => row.map(cell));
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((r) => (r[i] ?? "").length)));
  const line = (cells: readonly string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join(" │ ")
      .trimEnd();
  const lines =
    result.columns.length === 0
      ? []
      : [
          style.bold(line(head)),
          style.muted(widths.map((w) => "─".repeat(w)).join("─┼─")),
          ...body.map(line),
        ];
  const count = `${result.rows.length} ${result.rows.length === 1 ? "row" : "rows"}`;
  const scope = result.scope;
  lines.push(
    style.muted(
      `${result.truncated ? `truncated at ${count}: add LIMIT or aggregate` : count} · ${result.elapsed_ms} ms · as ${printable(scope.as)} (${scope.role === "local" ? "local index" : scope.role}) · sessions ${scope.since.slice(0, 10)} → ${scope.until.slice(0, 10)}`,
    ),
  );
  return lines;
}

export function schemaLines(schema: SqlSchema): string[] {
  return [
    schema.hint,
    "",
    schema.ddl,
    "",
    "Examples:",
    ...schema.examples.flatMap((e) => ["", e]),
    "",
    `Limits: ${schema.limits.max_rows} rows, ${schema.limits.max_bytes} bytes of rows, ${schema.limits.timeout_ms / 1000} s, ${schema.limits.max_sql_bytes} bytes of statement.`,
  ];
}

/** Where a refused statement goes wrong: its line, and a caret under the character. */
export function caret(sql: string, at: number): string[] {
  const start = sql.lastIndexOf("\n", at - 1) + 1;
  const end = sql.indexOf("\n", at);
  const text = sql.slice(start, end === -1 ? undefined : end);
  return [`  ${printable(text)}`, `  ${" ".repeat(Math.max(0, at - start))}^`];
}

function serverConfigHere(ctx: CommandContext): boolean {
  if (ctx.env.SESHI_STORE__URL) return true;
  return (
    findServerConfig({ env: ctx.env, cwd: process.cwd(), exists: (p) => existsSync(p) }).path !==
    undefined
  );
}

interface Run {
  sql(request: SqlRequest): Promise<SqlResult>;
  schema(window: { since?: string; until?: string }): Promise<SqlSchema>;
}

function backendRun(ctx: CommandContext, json: boolean, backend: Backend): Run {
  const hooks = {
    building: () => {
      if (!json) ctx.stderr("seshi: building the search index from the change feed (first use)…");
    },
  };
  return {
    sql: (request) => backend.sql(request, hooks),
    schema: (window) => backend.sqlSchema(window, hooks),
  };
}

/** On the server's own host (`--config`): its index in this process, as its admin. */
function instanceRun(ctx: CommandContext, json: boolean, instance: Instance): Run {
  const caller: SqlCaller = { viewer: LOCAL_VIEWER, as: "local", role: "local", key: "local" };
  const ready = async () => {
    const search = instance.search;
    if (!search) return;
    // A shared index is the worker's to keep current; this process only reads it.
    if (!search.shared) {
      if (!json && !(await search.ready())) {
        ctx.stderr("seshi: building the search index from the change feed (first use)…");
      }
      await search.catchUp();
    }
  };
  const sql = () => {
    if (!instance.sql) {
      throw new SqlUnavailable("search is turned off in this config ([search] enabled = false)");
    }
    return instance.sql;
  };
  return {
    sql: async (request) => {
      const service = sql();
      await ready();
      return service.query(caller, request);
    },
    schema: async (window) => {
      const service = sql();
      await ready();
      return service.schema(caller, window);
    },
  };
}

async function answer(
  ctx: CommandContext,
  json: boolean,
  run: Run,
  values: Values,
  statement: string | undefined,
  style: Style,
): Promise<number> {
  const window = {
    ...(values.since !== undefined ? { since: values.since } : {}),
    ...(values.until !== undefined ? { until: values.until } : {}),
  };
  if (values.schema) {
    const schema = await run.schema(window);
    emit(ctx, json, schema, () => schemaLines(schema));
    return EXIT.ok;
  }
  const maxRows = values["max-rows"];
  if (maxRows !== undefined && !/^\d+$/.test(maxRows)) {
    return helpOrUsageError(ctx, json, "--max-rows must be a whole number", USAGE);
  }
  try {
    const result = await run.sql({
      sql: statement as string,
      ...window,
      ...(maxRows !== undefined ? { max_rows: Number(maxRows) } : {}),
    });
    emit(ctx, json, result, () => resultLines(result, style));
    return EXIT.ok;
  } catch (err) {
    const at = err instanceof SqlFailed ? err.at : err instanceof ServerError ? err.at : undefined;
    if (at !== undefined && !json) {
      const code = fail(ctx, json, EXIT.usage, "sql_refused", (err as Error).message);
      for (const line of caret(statement as string, at)) ctx.stderr(line);
      return code;
    }
    throw err;
  }
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
  if (values.schema && positionals.length > 0) {
    return helpOrUsageError(ctx, json, "--schema takes no statement", USAGE);
  }
  if (!values.schema && positionals.length !== 1) {
    return helpOrUsageError(
      ctx,
      json,
      positionals.length === 0
        ? "sql needs a statement (quote it as one argument)"
        : "give the statement as one quoted argument",
      USAGE,
    );
  }
  let statement = positionals[0];
  if (statement === "-") {
    if (!ctx.stdin)
      return helpOrUsageError(ctx, json, "no stdin to read the statement from", USAGE);
    statement = await ctx.stdin();
  }

  let backend: Backend | undefined;
  try {
    if (values.config !== undefined || values.set !== undefined) {
      return await withServer(ctx, json, values, statement, await styleFor(ctx, { json }));
    }
    const account = openAccount(ctx);
    const cli = account.cli;
    const style = await styleFor(ctx, { json, theme: cli.theme });
    const server = values.server ?? cli.server;
    if (server !== undefined && (values.server !== undefined || !isServerless(cli))) {
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
        backend = await openBackend(ctx, account, { server, purpose: "read" });
      }
      return await answer(ctx, json, backendRun(ctx, json, backend), values, statement, style);
    }
    if (isServerless(cli)) {
      backend = await openBackend(ctx, account);
      return await answer(ctx, json, backendRun(ctx, json, backend), values, statement, style);
    }
    if (serverConfigHere(ctx)) {
      return await withServer(ctx, json, values, statement, style);
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
  statement: string | undefined,
  style: Style,
): Promise<number> {
  const { instance } = await openServer(
    ctx,
    {
      ...(values.config !== undefined ? { config: values.config } : {}),
      ...(values.set ? { set: values.set } : {}),
    },
    { roles: [], probe: [], claimUnmarkedBucket: false },
  );
  try {
    return await answer(ctx, json, instanceRun(ctx, json, instance), values, statement, style);
  } finally {
    await instance.close();
  }
}

function failure(ctx: CommandContext, json: boolean, err: unknown): number {
  const config = serverFailure(ctx, json, err);
  if (config !== undefined) return config;
  if (err instanceof NotConnected) {
    return fail(ctx, json, EXIT.config, "not_configured", err.message);
  }
  if (err instanceof SqlFailed) {
    return fail(
      ctx,
      json,
      err.kind === "internal" ? EXIT.failure : EXIT.usage,
      err.code,
      err.message,
    );
  }
  if (err instanceof SqlRequestError) return helpOrUsageError(ctx, json, err.message, USAGE);
  if (err instanceof SqlBusy) return fail(ctx, json, EXIT.unavailable, err.code, err.message);
  if (err instanceof SqlUnavailable) {
    return fail(ctx, json, EXIT.notImplemented, err.code, err.message);
  }
  if (err instanceof SearchUnavailable || err instanceof IndexUnavailable) {
    return fail(ctx, json, EXIT.unavailable, err.code, err.message);
  }
  if (err instanceof Forbidden) return fail(ctx, json, EXIT.auth, "forbidden", err.message);
  if (err instanceof ServerError) {
    if (err.status === 400) return fail(ctx, json, EXIT.usage, err.code, err.message);
    if (err.status === 401) {
      return fail(ctx, json, EXIT.auth, err.code, `${err.message}: run seshi login`);
    }
    if (err.status === 403) return fail(ctx, json, EXIT.auth, err.code, err.message);
    if (err.status === 404 && err.code === "search_disabled") {
      return fail(ctx, json, EXIT.config, err.code, err.message);
    }
    if (err.status === 404 && err.code === "not_found") {
      return fail(
        ctx,
        json,
        EXIT.notImplemented,
        "sql_unavailable",
        "this server has no sql: it runs a seshi older than the sql endpoint",
      );
    }
    if (err.status === 501) return fail(ctx, json, EXIT.notImplemented, err.code, err.message);
    if (err.status === 429 || err.status === 503) {
      return fail(ctx, json, EXIT.unavailable, err.code, err.message);
    }
    return fail(
      ctx,
      json,
      EXIT.unavailable,
      err.code,
      `the server answered ${err.status}: ${err.message}`,
    );
  }
  if (err instanceof StoreError) {
    return fail(ctx, json, EXIT.unavailable, "unavailable", err.message);
  }
  return failWith(ctx, json, err);
}
