/** `seshi doctor`: check that agent sessions are captured right, end to end. A session has three
 * views: its transcript on this machine, this machine's capture state (the state file's entry,
 * the decision, the spool, the uploader's log), and what the server (or, in local mode, the
 * bucket) stored. Only this machine holds all three, so the checks run here.
 *
 *   seshi doctor [--session [<id>]] [--agent <agent>] [--since <duration>] [--deep]
 *                [--server <url>] [--json]
 *
 * With `--session`, one session: the id given, else `SESHI_SESSION_ID`, else the one session
 * seen in this folder in the past day (as `seshi capture` finds it). Without it, every session
 * this machine saw in the past day (`--since 7d` widens it): one line each with its worst
 * status, then the checks that failed. `--deep` also searches for each session. `--json`:
 * `{ sessions: [{ agent, session_id, evidence, checks }] }`, the stored traces' records left out.
 *
 * It changes nothing: no uploads, no state writes, no spool entries. Exit 0 when nothing
 * failed; 8 when a check failed; 2 usage; 3 the state file or config cannot be used; 5 not
 * signed in (or the credential may not read); 7 the server could not be reached. */

import { type CaptureState, readState, StateUnreadable } from "@seshi/capture";
import { parseDuration } from "@seshi/config";
import { type Account, openAccount } from "../account/account";
import { type Backend, openBackend } from "../backend";
import { EXIT, type ExitCode } from "../cli/exit";
import { emit, fail, takeJson, usageError } from "../cli/output";
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
import { resolveSession } from "./capture";
import { pathsOf } from "./capture-host";
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

/** The flags, by hand: `--session` takes an optional value. */
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

/** The evidence as `--json` prints it: the stored traces' records left out (`seshi sessions
 * export` prints a trace). */
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

/** A status word, padded before painting so columns line up; colour never alone (B1.4). */
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

/** The sessions to check: the one `--session` names, or every one seen since `since`. */
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
  if (typeof args === "string") return usageError(ctx, json, args, USAGE);
  const sinceMs = args.since === undefined ? DAY_MS : parseDuration(args.since);
  if (sinceMs === undefined) {
    return usageError(
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
  if (typeof targets === "string") return usageError(ctx, json, targets, USAGE);

  // Where to ask what was stored. Not being able to ask is recorded in each session's evidence
  // (the local checks still run) and decides the exit code.
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
      { sessions: reports.map((r) => ({ ...r, evidence: forJson(r.evidence) })) },
      () => {
        if (reports.length === 0) {
          return [
            `No sessions seen since ${since.toISOString()}${args.agent ? ` for ${printable(args.agent)}` : ""}.`,
          ];
        }
        if (args.session !== undefined) return sessionLines(reports[0] as SessionReport, style);
        return overviewLines(reports, since, where, style);
      },
    );
    if (!json && backendError)
      ctx.stderr(`seshi: could not ask the server: ${backendError.message}`);
    return exitCode(reports, backendError);
  } finally {
    await backend?.close();
  }
}

/** Not being able to ask the server (not signed in, the config, unreachable) comes first: the
 * result is incomplete. Then any failed check. */
function exitCode(reports: SessionReport[], backendError: { exit?: number } | undefined): ExitCode {
  if (backendError?.exit !== undefined && reports.length > 0) return backendError.exit as ExitCode;
  const codes = new Set(reports.map((r) => r.evidence.server.metadata_error?.code));
  if (codes.has("unauthorized") || codes.has("forbidden")) return EXIT.auth;
  if (codes.has("unavailable")) return EXIT.unavailable;
  const failed = reports.some((r) => r.checks.some((c) => c.status === "fail"));
  return failed ? EXIT.attention : EXIT.ok;
}
