import { type CaptureState, readState, StateUnreadable } from "@seshi/capture";
import { parseDuration } from "@seshi/config";
import { type Account, openAccount } from "../account/account";
import { type Backend, openBackend, ServerlessBackend } from "../backend";
import { allCaptureAgents } from "../capture-agents";
import { EXIT, type ExitCode } from "../cli/exit";
import { emit, fail, helpOrUsageError, takeJson } from "../cli/output";
import { hookCommand } from "../cli/spawn";
import { printable, type Role, type Style, styleFor } from "../cli/style";
import {
  type CheckResult,
  type CheckStatus,
  failureOf,
  gatherEvidence,
  realDeps,
  runChecks,
  type SessionEvidence,
  type Target,
  worst,
} from "../doctor/index";
import { serverlessChecks } from "../doctor/serverless";
import { resolveSession } from "./capture";
import { hostOf, pathsOf } from "./capture-host";
import type { CommandContext } from "./index";

const USAGE = `usage: seshi doctor [--session [<id>]] [--agent <agent>] [--since <duration>] [--deep]
                    [--server <url>] [--json]`;

const DAY_MS = 24 * 60 * 60 * 1000;

interface Args {
  session?: string | true;
  agent?: string;
  since?: string;
  deep?: boolean;
  server?: string;
}

export function parseDoctorArgs(argv: readonly string[]): Args | string {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i] as string;
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) return undefined;
      i++;
      return next;
    };
    switch (word) {
      case "--session":
        args.session = value() ?? true;
        break;
      case "--deep":
        args.deep = true;
        break;
      case "--agent":
      case "--since":
      case "--server": {
        const v = value();
        if (!v) return `${word} needs a value`;
        args[word.slice(2) as "agent" | "since" | "server"] = v;
        break;
      }
      default:
        return word.startsWith("-") ? `unknown option ${word}` : `unexpected ${word}`;
    }
  }
  if (args.session !== undefined && args.since !== undefined) {
    return "--since is for checking every recent session; leave it out with --session";
  }
  return args;
}

export interface SessionReport {
  agent: string;
  session_id: string;
  evidence: SessionEvidence;
  checks: CheckResult[];
}

export function forJson(evidence: SessionEvidence): SessionEvidence {
  return {
    ...evidence,
    server: {
      ...evidence.server,
      traces: evidence.server.traces.map(({ records: _records, ...rest }) => rest),
    },
  };
}

const ROLE: Record<CheckStatus, Role | undefined> = {
  ok: "success",
  warn: "warn",
  fail: "error",
  skip: undefined,
};

function word(style: Style, status: CheckStatus): string {
  const padded = status.padEnd(4);
  const role = ROLE[status];
  return role ? style.status(padded, role) : style.muted(padded);
}

function sessionLines(report: SessionReport, style: Style): string[] {
  const { evidence: ev } = report;
  const uid = ev.server.upload_id;
  const lines = [
    `${style.bold(printable(`${ev.agent} ${ev.session_id}`))}${uid && uid !== ev.session_id ? ` (uploads as ${printable(uid)})` : ""}`,
  ];
  const width = Math.max(...report.checks.map((c) => c.title.length));
  for (const check of report.checks) {
    lines.push(
      `  ${word(style, check.status)}  ${check.title.padEnd(width)}  ${printable(check.summary)}`,
    );
    if (check.status === "warn" || check.status === "fail") {
      for (const d of check.detail ?? [])
        lines.push(`        ${" ".repeat(width)}  ${style.muted(`· ${printable(d)}`)}`);
      if (check.hint)
        lines.push(
          `        ${" ".repeat(width)}  ${style.muted(`hint: ${printable(check.hint)}`)}`,
        );
    }
  }
  return lines;
}

/** An agent whose hooks are only partly installed: one installed before seshi took more of its
 * events (Cursor's tool-result hooks), or one whose config someone edited. What its missing hooks
 * would capture is not. */
export async function hookChecks(ctx: CommandContext): Promise<CheckResult[]> {
  const host = hostOf(ctx);
  const checks: CheckResult[] = [];
  for (const agent of await allCaptureAgents()) {
    const status = await agent.installer
      ?.status({ ...host, command: hookCommand() })
      .catch(() => undefined);
    if (!status || status.installed || !status.files.some((f) => f.ours)) continue;
    const missing = status.notes.filter((n) => n.startsWith("hooks missing"));
    if (missing.length === 0) continue;
    checks.push({
      id: `hooks-${agent.name}`,
      title: agent.name,
      status: "warn",
      summary: missing.join("; "),
      hint: `seshi capture install ${agent.name} adds them, keeping everything else`,
    });
  }
  return checks;
}

function bucketLines(
  checks: readonly CheckResult[],
  style: Style,
  heading = "Serverless bucket",
): string[] {
  if (checks.length === 0) return [];
  const width = Math.max(...checks.map((c) => c.title.length));
  const lines = [style.bold(heading)];
  for (const check of checks) {
    lines.push(
      `  ${word(style, check.status)}  ${check.title.padEnd(width)}  ${printable(check.summary)}`,
    );
    if (check.status === "warn" || check.status === "fail") {
      for (const d of check.detail ?? [])
        lines.push(`        ${" ".repeat(width)}  ${style.muted(`· ${printable(d)}`)}`);
      if (check.hint)
        lines.push(
          `        ${" ".repeat(width)}  ${style.muted(`hint: ${printable(check.hint)}`)}`,
        );
    }
  }
  lines.push("");
  return lines;
}

function overviewLines(
  reports: SessionReport[],
  since: Date,
  where: string,
  style: Style,
): string[] {
  const lines = [
    `${reports.length} session${reports.length === 1 ? "" : "s"} seen since ${since.toISOString()}, checked against ${printable(where)}:`,
  ];
  const width = Math.max(...reports.map((r) => `${r.agent} ${r.session_id}`.length));
  for (const r of reports) {
    const status = worst(r.checks.map((c) => c.status));
    const first = r.checks.find((c) => c.status === status && status !== "ok" && status !== "skip");
    lines.push(
      `  ${word(style, status)}  ${printable(`${r.agent} ${r.session_id}`).padEnd(width)}${first ? `  ${first.title.toLowerCase()}: ${printable(first.summary)}` : ""}`,
    );
  }
  const failing = reports.flatMap((r) =>
    r.checks.filter((c) => c.status === "fail").map((c) => ({ r, c })),
  );
  if (failing.length > 0) {
    lines.push("", "Failed checks:");
    for (const { r, c } of failing) {
      lines.push(
        `  ${printable(`${r.agent} ${r.session_id}`)} · ${c.title}: ${printable(c.summary)}`,
      );
      for (const d of c.detail ?? []) lines.push(`      ${style.muted(`· ${printable(d)}`)}`);
      if (c.hint) lines.push(`      ${style.muted(`hint: ${printable(c.hint)}`)}`);
    }
  }
  return lines;
}

function targetsOf(
  ctx: CommandContext,
  args: Args,
  state: CaptureState,
  now: Date,
  since: Date,
): Target[] | string {
  if (args.session !== undefined) {
    const which = resolveSession(
      { positionals: [], session: args.session, ...(args.agent ? { agent: args.agent } : {}) },
      state,
      ctx.env,
      process.cwd(),
      now,
    );
    return typeof which === "string" ? which : [{ agent: which.agent, session_id: which.id }];
  }
  return Object.values(state.sessions)
    .filter(
      (s) =>
        (!args.agent || s.agent === args.agent) &&
        Date.parse(s.last_seen ?? s.first_seen) >= since.getTime(),
    )
    .sort((a, b) => (b.last_seen ?? b.first_seen).localeCompare(a.last_seen ?? a.first_seen))
    .map((s) => ({ agent: s.agent, session_id: s.session_id }));
}

export async function run(ctx: CommandContext): Promise<number> {
  const { json, rest } = takeJson(ctx.argv);
  const args = parseDoctorArgs(rest);
  if (typeof args === "string") return helpOrUsageError(ctx, json, args, USAGE);
  const sinceMs = args.since === undefined ? DAY_MS : parseDuration(args.since);
  if (sinceMs === undefined) {
    return helpOrUsageError(
      ctx,
      json,
      `--since takes a duration (2h, 1d, 7d), not '${args.since}'`,
      USAGE,
    );
  }
  const now = new Date();
  const since = new Date(now.getTime() - sinceMs);
  const { host, paths } = pathsOf(ctx);

  let state: CaptureState;
  try {
    state = readState(paths);
  } catch (err) {
    if (err instanceof StateUnreadable) return fail(ctx, json, EXIT.config, "state", err.message);
    throw err;
  }
  const targets = targetsOf(ctx, args, state, now, since);
  if (typeof targets === "string") return helpOrUsageError(ctx, json, targets, USAGE);

  let account: Account | undefined;
  let backend: Backend | undefined;
  let backendError: (ReturnType<typeof failureOf> & { exit?: number }) | undefined;
  try {
    account = openAccount(ctx);
    backend = await openBackend(ctx, account, {
      ...(args.server ? { server: args.server } : {}),
      purpose: "read",
    });
  } catch (err) {
    backendError = failureOf(err);
    if (backendError.exit === undefined) throw err;
  }
  try {
    const style = await styleFor(ctx, { json, ...(account ? { theme: account.cli.theme } : {}) });
    const deps = await realDeps(ctx, {
      host,
      paths,
      ...(backend ? { backend } : {}),
      ...(backendError ? { backendError } : {}),
      ...(account ? { account } : {}),
    });
    const bucket =
      backend instanceof ServerlessBackend && account
        ? await serverlessChecks(backend.bucket, account.cli.search.scope, now)
        : [];
    const hooks = await hookChecks(ctx);
    const reports: SessionReport[] = [];
    for (const target of targets) {
      const evidence = await gatherEvidence(target, deps, { deep: args.deep === true });
      reports.push({
        agent: target.agent,
        session_id: target.session_id,
        evidence,
        checks: runChecks(evidence, deps),
      });
    }
    const where = backend?.where ?? `nowhere (${backendError?.message ?? "no server"})`;
    emit(
      ctx,
      json,
      {
        ...(bucket.length > 0 ? { bucket } : {}),
        ...(hooks.length > 0 ? { hooks } : {}),
        sessions: reports.map((r) => ({ ...r, evidence: forJson(r.evidence) })),
      },
      () => {
        const head = [...bucketLines(bucket, style), ...bucketLines(hooks, style, "Hooks")];
        if (reports.length === 0) {
          return [
            ...head,
            `No sessions seen since ${since.toISOString()}${args.agent ? ` for ${printable(args.agent)}` : ""}.`,
          ];
        }
        if (args.session !== undefined) {
          return [...head, ...sessionLines(reports[0] as SessionReport, style)];
        }
        return [...head, ...overviewLines(reports, since, where, style)];
      },
    );
    if (!json && backendError)
      ctx.stderr(`seshi: could not ask the server: ${backendError.message}`);
    const code = exitCode(reports, backendError);
    if (code === EXIT.ok && bucket.some((c) => c.status === "fail")) return EXIT.attention;
    return code;
  } finally {
    await backend?.close();
  }
}

function exitCode(reports: SessionReport[], backendError: { exit?: number } | undefined): ExitCode {
  if (backendError?.exit !== undefined && reports.length > 0) return backendError.exit as ExitCode;
  const codes = new Set(reports.map((r) => r.evidence.server.metadata_error?.code));
  if (codes.has("unauthorized") || codes.has("forbidden")) return EXIT.auth;
  if (codes.has("unavailable")) return EXIT.unavailable;
  const failed = reports.some((r) => r.checks.some((c) => c.status === "fail"));
  return failed ? EXIT.attention : EXIT.ok;
}
