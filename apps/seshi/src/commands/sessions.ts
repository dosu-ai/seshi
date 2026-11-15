/** `seshi sessions`: list, read, export and delete sessions (F8.1), against a seshi server
 * with the credential `seshi login` stored, or in local mode against your own bucket (F8.3).
 * `--owner` reads another owner's sessions as far as visibility allows (X5.10).
 *
 *   seshi sessions ls [--owner <id>] [--limit N] [--after <cursor>] [--all]
 *   seshi sessions show <agent> <session-id> [--owner <id>] [--trace]
 *   seshi sessions export <agent> <session-id> [--format seshi|letta|otlp|atif] [--hash <h>]
 *                         [--output <file>|-o <file>] [--owner <id>]
 *   seshi sessions rm <agent> <session-id> [--owner <id>] [--yes]
 *   seshi sessions visibility <agent> <session-id> org|owner [--owner <id>]
 *
 * Each takes `--server <url>` and `--json`. A session is named `<agent> <session-id>` or
 * `<agent>/<session-id>`. `export` writes the trace itself to standard output (or the file),
 * whatever `--json` says. `rm` asks first on a terminal; elsewhere it needs `--yes`. With an
 * IdP a delete needs a session token from the last 10 minutes (X5.3), which `rm` renews on the
 * way.
 *
 * Exit 0; 2 usage; 4 no such session (or one you may not read); 5 not signed in or not
 * allowed; 7 the server cannot be reached. */

import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  isRenderFormat,
  RENDER_FORMATS,
  type RenderFormat,
  type SessionMetadata,
  type SessionsPage,
  type Trace,
} from "@seshi/model";
import { type Account, openAccount } from "../account/account";
import { type Backend, openBackend } from "../backend";
import { EXIT } from "../cli/exit";
import { failWith, Refused } from "../cli/failures";
import { emit, takeJson, usageError } from "../cli/output";
import { printable, type Style, styleFor } from "../cli/style";
import type { CommandContext } from "./index";

const USAGE = `usage: seshi sessions ls [--owner <id>] [--limit N] [--after <cursor>] [--all]
       seshi sessions show <agent> <session-id> [--owner <id>] [--trace]
       seshi sessions export <agent> <session-id> [--format seshi|letta|otlp|atif] [--hash <h>] [-o <file>] [--owner <id>]
       seshi sessions rm <agent> <session-id> [--owner <id>] [--yes]
       seshi sessions visibility <agent> <session-id> org|owner [--owner <id>]
       (each also takes --server <url> and --json)`;

const OPTIONS = {
  server: { type: "string" },
  owner: { type: "string" },
  limit: { type: "string" },
  after: { type: "string" },
  all: { type: "boolean" },
  trace: { type: "boolean" },
  format: { type: "string" },
  hash: { type: "string" },
  output: { type: "string", short: "o" },
  yes: { type: "boolean", short: "y" },
} as const;

interface Values {
  server?: string;
  owner?: string;
  limit?: string;
  after?: string;
  all?: boolean;
  trace?: boolean;
  format?: string;
  hash?: string;
  output?: string;
  yes?: boolean;
}

const SUBCOMMANDS = ["ls", "list", "show", "export", "rm", "visibility"] as const;

class UsageError extends Error {}

/** `<agent> <session-id>` or `<agent>/<session-id>`, and what is left. */
export function sessionRef(args: readonly string[]): {
  agent: string;
  sessionId: string;
  rest: string[];
} {
  const [first, second, ...more] = args;
  if (first === undefined) throw new UsageError("name a session: <agent> <session-id>");
  const slash = first.indexOf("/");
  if (slash > 0 && slash < first.length - 1) {
    return {
      agent: first.slice(0, slash),
      sessionId: first.slice(slash + 1),
      rest: second === undefined ? more : [second, ...more],
    };
  }
  if (second === undefined) throw new UsageError("name a session: <agent> <session-id>");
  return { agent: first, sessionId: second, rest: more };
}

function positiveInt(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 1000) {
    throw new UsageError(`--${name} must be a whole number from 1 to 1000`);
  }
  return n;
}

/** How many records the session's log holds. */
function recordCount(m: SessionMetadata): number | undefined {
  if (m.normalized) return m.normalized.records;
  return m.traces.find((t) => t.content_hash === m.head)?.records;
}

function when(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function listLines(page: SessionsPage, owner: string, style: Style): string[] {
  if (page.sessions.length === 0) return [`No sessions for ${printable(owner)}.`];
  const sorted = [...page.sessions].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  const refs = sorted.map((m) => printable(`${m.agent}/${m.session_id}`));
  const width = Math.min(60, Math.max(...refs.map((r) => r.length)));
  const lines = [style.muted(`${printable(owner)}: ${sorted.length} session(s), newest first`)];
  sorted.forEach((m, i) => {
    const records = recordCount(m);
    // Padded before painting, so colour codes do not throw the columns out.
    const state =
      m.status === "redacted"
        ? style.status("deleted".padEnd(11), "warn")
        : `${records ?? "?"} records`.padEnd(11);
    const where = printable(
      [m.project, m.branch ? `(${m.branch})` : undefined].filter(Boolean).join(" "),
    );
    lines.push(
      `${(refs[i] as string).padEnd(width)}  ${when(m.updated_at)}  ${state}  ${m.visibility.padEnd(5)}  ${style.muted(where)}`.trimEnd(),
    );
  });
  if (page.truncated && page.cursor) {
    lines.push(style.muted(`… more: seshi sessions ls --after ${page.cursor}`));
  }
  return lines;
}

function showLines(m: SessionMetadata, style: Style): string[] {
  // `row`: the session's (other people's) text, made printable; `line`: our own.
  const line = (label: string, value: string) => [`  ${label.padEnd(11)} ${value}`];
  const row = (label: string, value: string | undefined) =>
    value === undefined || value === "" ? [] : line(label, printable(value));
  const records = recordCount(m);
  const status =
    m.status === "redacted"
      ? style.status("deleted (redacted)", "warn")
      : style.status("stored", "success");
  const counts = m.redaction?.counts ?? {};
  const matches = Object.values(counts).reduce((a, b) => a + b, 0);
  const claims = Object.entries(m.claims ?? {})
    .filter(([, v]) => typeof v === "string")
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  return [
    style.bold(printable(`${m.agent}/${m.session_id}`)),
    ...row("owner", `${m.owner} (${m.owner_basis})`),
    ...line("status", status),
    ...row("visibility", m.visibility),
    ...row("project", m.project),
    ...row("branch", m.branch),
    ...row("created", m.created_at),
    ...row("updated", m.updated_at),
    ...row(
      "records",
      records === undefined
        ? undefined
        : `${records} in ${m.traces.length} trace(s)${m.head ? `, head ${m.head.slice(0, 12)}` : ""}`,
    ),
    ...row(
      "writer",
      `${m.writer.kind} ${m.writer.principal} via ${m.writer.source_id}${m.writer.credential_id ? ` (credential ${m.writer.credential_id})` : ""}`,
    ),
    ...row(
      "redaction",
      m.redaction
        ? `${matches} match(es)${
            matches
              ? ` (${Object.entries(counts)
                  .map(([k, v]) => `${k} ${v}`)
                  .join(", ")})`
              : ""
          }`
        : undefined,
    ),
    ...row("claims", claims),
    ...row("origin", m.origin_agent),
  ];
}

/** One line per record: the role and the first line of what it says. */
export function traceLines(trace: Trace, style: Style, width = 100): string[] {
  const clip = (text: string) => {
    const line = printable(text.split("\n").find((l) => l.trim() !== "") ?? "");
    return line.length > width ? `${line.slice(0, width - 1)}…` : line;
  };
  const lines: string[] = [];
  for (const record of trace.records) {
    if (record.role === "meta") continue;
    if (record.role === "assistant") {
      if (record.content) lines.push(`${style.brand("assistant")}  ${clip(record.content)}`);
      for (const call of record.tool_calls ?? []) {
        lines.push(
          `${style.muted("tool call")}  ${clip(call.name)} ${style.muted(clip(call.args))}`,
        );
      }
    } else if (record.role === "tool") {
      const note = record.withheld
        ? style.status(`withheld (${printable(String(record.withheld))})`, "warn")
        : clip(record.content);
      lines.push(`${style.muted("tool")}       ${note}`);
    } else {
      lines.push(`${record.role.padEnd(10)} ${clip(record.content)}`);
    }
  }
  return lines;
}

async function ls(
  ctx: CommandContext,
  json: boolean,
  backend: Backend,
  values: Values,
  style: Style,
) {
  const limit = positiveInt(values.limit, "limit", 50);
  const owner = values.owner ?? (await backend.me()).owner;
  let page = await backend.listSessions({
    ...(values.owner ? { owner: values.owner } : {}),
    ...(values.after ? { after: values.after } : {}),
    limit,
  });
  if (values.all) {
    const sessions = [...page.sessions];
    while (page.truncated && page.cursor) {
      page = await backend.listSessions({
        ...(values.owner ? { owner: values.owner } : {}),
        after: page.cursor,
        limit,
      });
      sessions.push(...page.sessions);
    }
    page = { sessions, cursor: undefined, truncated: false };
  }
  emit(ctx, json, page, () => listLines(page, owner, style));
  return EXIT.ok;
}

async function found(
  backend: Backend,
  agent: string,
  sessionId: string,
  owner: string | undefined,
): Promise<SessionMetadata> {
  const metadata = await backend.getSession(agent, sessionId, owner ? { owner } : {});
  if (!metadata) {
    throw new Refused(
      EXIT.notFound,
      "not_found",
      `no session ${agent}/${sessionId}${owner ? ` for ${owner}` : ""}`,
    );
  }
  return metadata;
}

async function show(
  ctx: CommandContext,
  json: boolean,
  backend: Backend,
  ref: { agent: string; sessionId: string },
  values: Values,
  style: Style,
) {
  const metadata = await found(backend, ref.agent, ref.sessionId, values.owner);
  let trace: Trace | null = null;
  if (values.trace && metadata.status !== "redacted") {
    trace = (await backend.getTrace(ref.agent, ref.sessionId, {
      ...(values.owner ? { owner: values.owner } : {}),
      format: "seshi",
    })) as Trace | null;
  }
  emit(ctx, json, values.trace ? { metadata, trace } : metadata, () => {
    const lines = showLines(metadata, style);
    if (trace)
      lines.push(
        "",
        style.muted(`head trace, ${trace.records.length} records:`),
        ...traceLines(trace, style),
      );
    return lines;
  });
  return EXIT.ok;
}

async function exportTrace(
  ctx: CommandContext,
  json: boolean,
  backend: Backend,
  ref: { agent: string; sessionId: string },
  values: Values,
) {
  const format = (values.format ?? "seshi") as RenderFormat;
  if (!isRenderFormat(format)) {
    throw new UsageError(`--format must be one of ${RENDER_FORMATS.join(", ")}`);
  }
  if (values.hash !== undefined && !/^[0-9a-f]{64}$/.test(values.hash)) {
    throw new UsageError("--hash must be a trace's 64-character content hash");
  }
  const metadata = await found(backend, ref.agent, ref.sessionId, values.owner);
  if (metadata.status === "redacted") {
    throw new Refused(
      EXIT.notFound,
      "redacted",
      `${ref.agent}/${ref.sessionId} was deleted; it has no trace`,
    );
  }
  const hash = values.hash ?? metadata.head;
  const trace = await backend.getTrace(ref.agent, ref.sessionId, {
    ...(values.owner ? { owner: values.owner } : {}),
    ...(values.hash ? { hash: values.hash } : {}),
    format,
  });
  if (!trace) {
    throw new Refused(
      EXIT.notFound,
      "not_found",
      `no trace ${hash ? hash.slice(0, 12) : ""} for ${ref.agent}/${ref.sessionId}`,
    );
  }
  const text = `${JSON.stringify(trace, null, 2)}\n`;
  if (values.output === undefined || values.output === "-") {
    ctx.stdout(text.trimEnd());
    return EXIT.ok;
  }
  let path = values.output;
  let isDir = path.endsWith("/");
  try {
    isDir ||= statSync(path).isDirectory();
  } catch {
    // A file to create.
  }
  if (isDir) {
    const name =
      `${ref.agent}-${ref.sessionId}-${(hash ?? "").slice(0, 12)}.${format}.json`.replace(
        /[^A-Za-z0-9._-]/g,
        "_",
      );
    path = join(path, name);
  }
  writeFileSync(path, text);
  const bytes = Buffer.byteLength(text);
  emit(ctx, json, { path, format, hash, bytes }, () => [
    `Wrote ${path} (${format}, ${bytes} bytes).`,
  ]);
  return EXIT.ok;
}

async function confirm(ctx: CommandContext, question: string): Promise<boolean> {
  if (!ctx.terminal || !ctx.tty?.stdin) return false;
  const answer = await (await ctx.terminal()).ask(`${question} [y/N] `);
  return /^y(es)?$/i.test(answer.trim());
}

async function rm(
  ctx: CommandContext,
  json: boolean,
  backend: Backend,
  ref: { agent: string; sessionId: string },
  values: Values,
  style: Style,
) {
  const name = printable(
    `${ref.agent}/${ref.sessionId}${values.owner ? ` of ${values.owner}` : ""}`,
  );
  if (!values.yes) {
    if (!ctx.terminal || !ctx.tty?.stdin) {
      throw new UsageError(`deleting ${name} cannot be undone: add --yes`);
    }
    if (!(await confirm(ctx, `Delete ${name}? Its traces are removed and it cannot be undone.`))) {
      ctx.stderr("seshi: nothing deleted");
      return EXIT.failure;
    }
  }
  const result = await backend.tombstone(
    ref.agent,
    ref.sessionId,
    values.owner ? { owner: values.owner } : {},
  );
  if (!result) throw new Refused(EXIT.notFound, "not_found", `no session ${name}`);
  emit(ctx, json, { agent: ref.agent, session_id: ref.sessionId, ...result }, () => [
    `${style.status("Deleted", "success")} ${name} (${result.removed} object(s) removed).`,
  ]);
  return EXIT.ok;
}

async function visibility(
  ctx: CommandContext,
  json: boolean,
  backend: Backend,
  ref: { agent: string; sessionId: string },
  value: string | undefined,
  values: Values,
  style: Style,
) {
  if (value !== "org" && value !== "owner") throw new UsageError("visibility is org or owner");
  const metadata = await backend.setVisibility(
    ref.agent,
    ref.sessionId,
    value,
    values.owner ? { owner: values.owner } : {},
  );
  if (!metadata) {
    throw new Refused(EXIT.notFound, "not_found", `no session ${ref.agent}/${ref.sessionId}`);
  }
  emit(ctx, json, metadata, () => [
    `${style.status("Visibility", "success")} of ${ref.agent}/${ref.sessionId} is ${value}: ${value === "org" ? "every member may read it" : "only its owner (and admins) may read it"}.`,
  ]);
  return EXIT.ok;
}

export async function run(ctx: CommandContext): Promise<number> {
  const { json, rest } = takeJson(ctx.argv);
  const [sub, ...args] = rest;
  if (!sub || !(SUBCOMMANDS as readonly string[]).includes(sub)) {
    return usageError(
      ctx,
      json,
      sub === undefined ? "sessions needs a subcommand" : `unknown sessions command '${sub}'`,
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
  let account: Account | undefined;
  let backend: Backend | undefined;
  try {
    let ref: { agent: string; sessionId: string; rest: string[] } | undefined;
    if (sub === "ls" || sub === "list") {
      if (positionals.length > 0) throw new UsageError("sessions ls takes no arguments");
    } else {
      ref = sessionRef(positionals);
      const extra = sub === "visibility" ? 1 : 0;
      if (ref.rest.length !== extra) {
        throw new UsageError(
          sub === "visibility"
            ? "sessions visibility <agent> <session-id> org|owner"
            : `sessions ${sub} takes one session`,
        );
      }
    }
    account = openAccount(ctx);
    const style = await styleFor(ctx, { json, theme: account.cli.theme });
    backend = await openBackend(ctx, account, {
      ...(values.server ? { server: values.server } : {}),
      purpose: sub === "rm" ? "delete" : "read",
    });
    switch (sub) {
      case "ls":
      case "list":
        return await ls(ctx, json, backend, values, style);
      case "show":
        return await show(ctx, json, backend, ref as NonNullable<typeof ref>, values, style);
      case "export":
        return await exportTrace(ctx, json, backend, ref as NonNullable<typeof ref>, values);
      case "rm":
        return await rm(ctx, json, backend, ref as NonNullable<typeof ref>, values, style);
      default:
        return await visibility(
          ctx,
          json,
          backend,
          ref as NonNullable<typeof ref>,
          ref?.rest[0],
          values,
          style,
        );
    }
  } catch (err) {
    if (err instanceof UsageError) return usageError(ctx, json, err.message, USAGE);
    return failWith(ctx, json, err);
  } finally {
    await backend?.close();
  }
}
