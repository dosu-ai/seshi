/** `seshi capture`: the agent integrations on this machine (F9).
 *
 *   seshi capture install [<agent>…] [--service] [--command <program>]
 *   seshi capture uninstall [<agent>…] [--service] [--command <program>]
 *   seshi capture status [--session [<id>]] [--agent <agent>]
 *   seshi capture pause [<duration>]
 *   seshi capture resume
 *   seshi capture off|on [--session [<id>]] [--agent <agent>]
 *   seshi capture off|on --path <folder>
 *   seshi capture resend --all | --session [<id>] [--agent <agent>]
 *
 * `install` merges seshi's hooks into each agent's own config (F9.6), keeping every hook there;
 * with no agent named it installs for every agent found on this machine. `uninstall` takes out
 * only seshi's entries. `--service` adds (or removes) a launchd, systemd or Task Scheduler entry
 * that keeps the uploader running between sessions.
 *
 * `off` and `on` set a capture rule (F9.5): for one session (`--session`; with no id, the
 * session the agent's environment names, else the one seen in this folder), for a folder
 * (`--path`, a `[[capture.paths]]` rule in the CLI config), or for everything (the CLI config's
 * `capture.enabled`). Turning a session off stops its uploads and retracts what was uploaded
 * (F9.7). `pause` stops sessions where they are (F9.5, revised 15 Nov 2026): every session
 * running when it starts, or seen while it lasts, keeps what it uploaded and sends nothing more,
 * ever, and a session started during it is not captured; nothing is retracted. `resume` (or the
 * pause running out) lets new sessions be captured again; a stopped session stays stopped until
 * `on --session` turns it on, which uploads all of it.
 *
 * `resend` sends sessions this machine uploaded again, whole, with `rebuild` (X4.9): the server
 * builds and reviews each again even when its log only extends what is stored, so a session an
 * older normalizer built, or one whose envelopes review skipped or dropped, is redone. The
 * uploader does the same by itself for the sessions the server says are stale. Sessions turned
 * off, never uploaded, or whose transcript is gone are left out.
 *
 * Every subcommand takes `--json`. Exit codes: 0; 2 usage; 3 a config or state file it cannot
 * use; 4 no agent to install for; 8 (`status`) something needs action. */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  appendSpool,
  type CaptureState,
  captureRules,
  decide,
  endPause,
  freeze,
  isPaused,
  otherFolders,
  placeOf,
  readSpool,
  readState,
  rebuildKey,
  type SessionState,
  StateUnreadable,
  sessionKey,
  sessionToggle,
  sessionWord,
  spoolCount,
  stateFacts,
  subsessionKeys,
  updateState,
  uploadedOffset,
  uploaderRunning,
  uploadId,
  within,
} from "@seshi/capture";
import { parseDuration } from "@seshi/config";
import type { CaptureAgent, InstallStatus } from "@seshi/kit";
import { expandTilde } from "@seshi/kit";
import { type Account, openAccount } from "../account/account";
import { allCaptureAgents, CAPTURE_AGENTS, captureAgent } from "../capture-agents";
import {
  readCliText,
  rulePath,
  setCapturePath,
  setTableKey,
  writeCliConfig,
} from "../capture-config";
import {
  installService,
  exec as realExec,
  serviceInstalled,
  uninstallService,
} from "../capture-service";
import { EXIT, type ExitCode } from "../cli/exit";
import { failWith } from "../cli/failures";
import { emit, fail, takeJson, usageError } from "../cli/output";
import { hookCommand, inNpxCache, isCompiled } from "../cli/spawn";
import { printable, type Style, styleFor } from "../cli/style";
import { hostOf, pathsOf, startUploader } from "./capture-host";
import type { CommandContext } from "./index";

const USAGE = [
  "usage: seshi capture install [<agent>…] [--service] [--command <program>]",
  "       seshi capture uninstall [<agent>…] [--service] [--command <program>]",
  "       seshi capture status [--session [<id>]] [--agent <agent>]",
  "       seshi capture pause [<duration>]",
  "       seshi capture resume",
  "       seshi capture off|on [--session [<id>]] [--agent <agent>]",
  "       seshi capture off|on --path <folder>",
  "       seshi capture resend --all | --session [<id>] [--agent <agent>]",
].join("\n");

interface Args {
  positionals: string[];
  /** `--session` alone (true) or with an id. */
  session?: string | true;
  agent?: string;
  path?: string;
  service?: boolean;
  command?: string;
  /** `resend --all`. */
  all?: boolean;
}

/** The flags, by hand: `--session` takes an optional value, which `parseArgs` cannot. */
export function parseCaptureArgs(argv: readonly string[]): Args | string {
  const args: Args = { positionals: [] };
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
      case "--agent": {
        const v = value();
        if (!v) return "--agent needs an agent name";
        args.agent = v;
        break;
      }
      case "--path": {
        const v = value();
        if (!v) return "--path needs a folder";
        args.path = v;
        break;
      }
      case "--command": {
        const v = value();
        if (!v) return "--command needs a program";
        args.command = v;
        break;
      }
      case "--service":
        args.service = true;
        break;
      case "--all":
        args.all = true;
        break;
      default:
        if (word.startsWith("--")) return `unknown option ${word}`;
        args.positionals.push(word);
    }
  }
  return args;
}

/** A command line as words: spaces split, double quotes group. */
export function splitWords(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => (m[1] ?? m[2]) as string);
}

function accountOrNone(ctx: CommandContext): Account | undefined {
  try {
    return openAccount(ctx);
  } catch {
    return undefined;
  }
}

/** Which session `--session` names: the id given, else `SESHI_SESSION_ID` (set by the agent's
 * SessionStart hook), else the one session seen in this folder in the past day. With more than
 * one there (two agents open in the same repo), it refuses and lists them: picking the latest
 * could turn off, and retract, a session other than the one asking. Subagents are never
 * candidates; their parent's toggle covers them. */
export function resolveSession(
  args: Args,
  state: CaptureState,
  env: Record<string, string | undefined>,
  cwd: string,
  now: Date,
): { agent: string; id: string } | string {
  let id = args.session === true ? env.SESHI_SESSION_ID || undefined : args.session;
  let agent = args.agent ?? (args.session === true ? env.SESHI_AGENT || undefined : undefined);
  if (id && !agent) {
    const agents = new Set(
      Object.values(state.sessions)
        .filter((s) => s.session_id === id)
        .map((s) => s.agent),
    );
    if (agents.size === 1) agent = [...agents][0];
  }
  if (!id) {
    const candidates = Object.values(state.sessions)
      .filter(
        (s) =>
          (!agent || s.agent === agent) &&
          s.parent_session_id === undefined &&
          s.cwd !== undefined &&
          within(cwd, s.cwd, process.platform) &&
          now.getTime() - Date.parse(s.last_seen ?? s.first_seen) < 24 * 3600 * 1000,
      )
      .sort((a, b) => (b.last_seen ?? "").localeCompare(a.last_seen ?? ""));
    const recent = candidates[0];
    if (!recent) {
      return "which session? run it from inside the agent (the /seshi skill), or pass --session <id>";
    }
    if (candidates.length > 1) {
      const listed = candidates
        .slice(0, 5)
        .map((s) => `${s.agent} ${s.session_id} (last seen ${s.last_seen ?? s.first_seen})`)
        .join(", ");
      return `which session? more than one ran here in the past day: ${listed}${candidates.length > 5 ? ", …" : ""}; pass --session <id> (and --agent <agent>)`;
    }
    id = recent.session_id;
    agent = recent.agent;
  }
  agent ??= "claude-code";
  if (!Object.hasOwn(CAPTURE_AGENTS, agent)) {
    return `seshi does not capture '${agent}' (one of ${Object.keys(CAPTURE_AGENTS).join(", ")})`;
  }
  return { agent, id };
}

export async function run(ctx: CommandContext): Promise<number> {
  const { json, rest } = takeJson(ctx.argv);
  const [sub, ...argv] = rest;
  const parsed = parseCaptureArgs(argv);
  if (typeof parsed === "string") return usageError(ctx, json, parsed, USAGE);
  try {
    switch (sub) {
      case "install":
        return await install(ctx, json, parsed);
      case "uninstall":
        return await uninstall(ctx, json, parsed);
      case "status":
        return await status(ctx, json, parsed);
      case "pause":
        return await pause(ctx, json, parsed);
      case "resume":
        return await resume(ctx, json, parsed);
      case "off":
      case "on":
        return await toggle(ctx, json, parsed, sub);
      case "resend":
        return await resend(ctx, json, parsed);
      default:
        return usageError(
          ctx,
          json,
          sub === undefined ? "capture needs a subcommand" : `unknown subcommand '${sub}'`,
          USAGE,
        );
    }
  } catch (err) {
    if (err instanceof StateUnreadable) return fail(ctx, json, EXIT.config, "state", err.message);
    return failWith(ctx, json, err);
  }
}

/** The agents a subcommand names (all known names), or a usage error. */
async function namedAgents(
  ctx: CommandContext,
  json: boolean,
  names: string[],
): Promise<CaptureAgent[] | ExitCode> {
  const agents = await allCaptureAgents();
  const unknown = names.filter((n) => !agents.some((a) => a.name === n));
  if (unknown.length > 0) {
    return usageError(
      ctx,
      json,
      `seshi does not capture ${unknown.map((n) => `'${n}'`).join(", ")} (one of ${agents.map((a) => a.name).join(", ")})`,
      USAGE,
    );
  }
  return names.length > 0 ? agents.filter((a) => names.includes(a.name)) : agents;
}

function serviceContext(ctx: CommandContext, command: readonly string[]) {
  const { host, paths } = pathsOf(ctx);
  return {
    home: host.home,
    platform: host.platform,
    command,
    logFile: paths.log,
    exec: ctx.exec ?? realExec,
    env: host.env,
  };
}

/** The program a service entry runs: an absolute path, since service managers have a bare
 * PATH. */
function serviceCommand(hook: readonly string[]): string[] {
  if (hook.length === 1 && hook[0] === "seshi" && !isCompiled()) {
    return [Bun.which("seshi") ?? "seshi"];
  }
  return [...hook];
}

async function install(ctx: CommandContext, json: boolean, args: Args): Promise<number> {
  const agents = await namedAgents(ctx, json, args.positionals);
  if (typeof agents === "number") return agents;
  const host = hostOf(ctx);
  const { paths } = pathsOf(ctx);
  const command = args.command ? splitWords(args.command) : hookCommand();
  const targets =
    args.positionals.length > 0 ? agents : agents.filter((a) => a.installer?.detect(host));
  if (targets.length === 0) {
    return fail(
      ctx,
      json,
      EXIT.notFound,
      "no_agent",
      `found no agent to install for (looked for ${agents.map((a) => a.name).join(", ")}); name one: seshi capture install claude-code`,
    );
  }
  if (command[0] !== undefined && inNpxCache(command[0])) {
    ctx.stderr(
      `seshi: warning: this seshi runs from npx's cache (${command[0]}), which npx may delete; hooks would stop working. Install seshi (npm install -g seshi, or the install script) and run seshi capture install again`,
    );
  }
  const results: { agent: string; changed: string[]; notes: string[] }[] = [];
  // One agent's config it cannot read does not stop the others; it is reported, exit 1.
  const failed: { agent: string; error: string }[] = [];
  for (const agent of targets) {
    if (!agent.installer) continue;
    try {
      const report = await agent.installer.install({ ...host, command });
      results.push({ agent: agent.name, ...report });
    } catch (err) {
      failed.push({ agent: agent.name, error: (err as Error).message });
    }
  }
  const now = new Date().toISOString();
  await updateState(paths, (state) => {
    for (const r of results) state.agents[r.agent] ??= { installed_at: now };
  });
  const service = args.service
    ? await installService(serviceContext(ctx, serviceCommand(command)))
    : undefined;
  const account = accountOrNone(ctx);
  const target = account?.cli.local ? "local" : account?.cli.server;
  const style = await styleFor(ctx, { json, ...(account ? { theme: account.cli.theme } : {}) });
  emit(
    ctx,
    json,
    {
      installed: results,
      ...(failed.length > 0 ? { failed } : {}),
      ...(service ? { service } : {}),
      target: target ?? null,
    },
    () => [
      ...results.flatMap((r) => [
        `${style.status("installed", "success")} ${r.agent}: ${r.changed.join(", ")}`,
        ...r.notes.map((n) => `  ${style.warn("note")}: ${n}`),
      ]),
      ...failed.map((f) => `${style.status("not installed", "error")} ${f.agent}: ${f.error}`),
      ...(service
        ? [
            `${style.status(service.problems.length > 0 ? "service failed" : "service installed", service.problems.length > 0 ? "error" : "success")}: ${service.entry}`,
            ...service.problems.map((p) => `  ${p}`),
            ...(service.notes ?? []).map((n) => `  ${style.warn("note")}: ${n}`),
          ]
        : []),
      target
        ? `Sessions from now on are uploaded to ${target === "local" ? "the local bucket" : target}.`
        : `Not signed in yet: run ${style.bold("seshi login --server <url>")}; sessions wait until then.`,
    ],
  );
  return failed.length > 0 || (service && service.problems.length > 0) ? EXIT.failure : EXIT.ok;
}

async function uninstall(ctx: CommandContext, json: boolean, args: Args): Promise<number> {
  const agents = await namedAgents(ctx, json, args.positionals);
  if (typeof agents === "number") return agents;
  const host = hostOf(ctx);
  const { paths } = pathsOf(ctx);
  // The program an install was given with --command (a wrapper): its entries are seshi's too.
  const command = args.command ? splitWords(args.command) : hookCommand();
  const results: { agent: string; changed: string[]; notes: string[] }[] = [];
  // As install: one agent's config it cannot read does not stop the others; it is reported, its
  // agent stays in the state (its hooks are still there), exit 1.
  const failed: { agent: string; error: string }[] = [];
  for (const agent of agents) {
    if (!agent.installer) continue;
    try {
      const report = await agent.installer.uninstall({ ...host, command });
      if (report.changed.length > 0 || args.positionals.length > 0)
        results.push({ agent: agent.name, ...report });
    } catch (err) {
      failed.push({ agent: agent.name, error: (err as Error).message });
    }
  }
  await updateState(paths, (state) => {
    for (const agent of agents) {
      if (!failed.some((f) => f.agent === agent.name)) delete state.agents[agent.name];
    }
  });
  const service = args.service
    ? await uninstallService(serviceContext(ctx, serviceCommand(command)))
    : undefined;
  const style = await styleFor(ctx, { json });
  emit(
    ctx,
    json,
    {
      uninstalled: results,
      ...(failed.length > 0 ? { failed } : {}),
      ...(service ? { service } : {}),
    },
    () => [
      ...(results.length === 0 && failed.length === 0
        ? ["seshi was not installed in any agent's config"]
        : []),
      ...results.map(
        (r) =>
          `${style.status("removed", "success")} ${r.agent}${r.changed.length > 0 ? `: ${r.changed.join(", ")}` : " (nothing of seshi's was there)"}`,
      ),
      ...failed.map((f) => `${style.status("not removed", "error")} ${f.agent}: ${f.error}`),
      ...(service
        ? [`${service.changed ? "service removed" : "no service entry"}: ${service.entry}`]
        : []),
      "Sessions already uploaded stay on the server; seshi capture off --session <id> still retracts one.",
    ],
  );
  return failed.length > 0 ? EXIT.failure : EXIT.ok;
}

async function status(ctx: CommandContext, json: boolean, args: Args): Promise<number> {
  const { host, paths } = pathsOf(ctx);
  const now = new Date();
  const state = readState(paths);
  const snapshot = await captureRules(host, paths);
  const cwd = process.cwd();
  const paused = isPaused(state, now);
  const judge = (
    folder: string | undefined,
    facts: ReturnType<typeof stateFacts>,
    seen?: string[],
  ) =>
    decide(
      {
        rules: snapshot.rules,
        ...(snapshot.error ? { rulesError: snapshot.error } : {}),
        place: placeOf(folder),
        ...facts,
        ...(seen ? { seen: seen.map(placeOf) } : {}),
      },
      host.platform,
    );
  // A new session here: no toggle, nothing uploaded, so only the pause in force applies.
  const here = judge(cwd, stateFacts(state, "", undefined, now));
  let session:
    | { agent: string; id: string; state?: SessionState; decision: ReturnType<typeof judge> }
    | undefined;
  if (args.session !== undefined) {
    const which = resolveSession(args, state, ctx.env, cwd, now);
    if (typeof which === "string") return usageError(ctx, json, which, USAGE);
    const known = state.sessions[sessionKey(which.agent, which.id)];
    session = {
      ...which,
      ...(known ? { state: known } : {}),
      decision: judge(
        known?.cwd ?? cwd,
        stateFacts(state, which.agent, known, now),
        otherFolders(state, which.agent, known, known?.cwd ?? cwd),
      ),
    };
  }
  const agents = await allCaptureAgents();
  const installs: { agent: string; installed: boolean; since?: string; status?: InstallStatus }[] =
    [];
  for (const agent of agents) {
    const status = agent.installer
      ? await agent.installer.status({ ...host, command: hookCommand() }).catch(() => undefined)
      : undefined;
    installs.push({
      agent: agent.name,
      installed: status?.installed ?? false,
      ...(state.agents[agent.name] ? { since: state.agents[agent.name]?.installed_at } : {}),
      ...(status ? { status } : {}),
    });
  }
  const account = accountOrNone(ctx);
  const target = state.uploader?.target ?? (account?.cli.local ? "local" : account?.cli.server);
  const service = await serviceInstalled(serviceContext(ctx, hookCommand())).catch(() => false);
  const queued = (state.uploader?.queued ?? 0) + spoolCount(paths);
  const running = uploaderRunning(paths, now);
  // Sessions a pause stopped: they send nothing more until turned on (F9.5).
  const stopped = stoppedCount(state);
  const recent = Object.entries(state.sessions)
    .sort(([, a], [, b]) => (b.last_seen ?? "").localeCompare(a.last_seen ?? ""))
    .slice(0, 5);
  const problems = state.problems ?? {};
  const attention =
    problems.sign_in !== undefined || problems.upload !== undefined || here.level === "config";
  const style = await styleFor(ctx, { json, ...(account ? { theme: account.cli.theme } : {}) });
  const word = (capture: boolean) =>
    capture ? style.status("capturing", "success") : style.status("not capturing", "warn");
  emit(
    ctx,
    json,
    {
      here: { folder: cwd, ...here },
      ...(session
        ? {
            session: {
              agent: session.agent,
              session_id: session.id,
              ...session.decision,
              ...(session.state
                ? { state: sessionWord(session.state), upload_id: uploadId(session.state) }
                : {}),
            },
          }
        : {}),
      // A pause that ran out is still in the file until `resume`: it no longer applies.
      paused: paused && state.paused ? state.paused : null,
      stopped,
      agents: installs,
      target: target ?? null,
      uploader: { running, queued, service, last_run: state.uploader?.last_run ?? null },
      problems,
      sessions: recent.map(([key, s]) => ({
        key,
        state: sessionWord(s),
        last_seen: s.last_seen ?? s.first_seen,
      })),
    },
    () => [
      `Session Capture: ${word(session ? session.decision.capture : here.capture)}`,
      ...(session
        ? [
            `  session ${printable(session.agent)} ${printable(session.id)}: ${session.decision.reason} (${session.decision.level})${session.state ? `; ${sessionWord(session.state)}` : ""}`,
          ]
        : []),
      `  here (${printable(cwd)}): ${here.reason} (${here.level})`,
      ...(paused && state.paused
        ? [
            `  ${style.warn("paused")} ${state.paused.until ? `until ${state.paused.until}` : "until seshi capture resume"}: sessions stop where they are; new ones are not captured`,
          ]
        : []),
      ...(stopped > 0
        ? [
            `  ${style.warn("stopped")}: ${stopped} session${stopped === 1 ? "" : "s"} stopped by a pause send nothing more; seshi capture on --session <id> uploads one in full`,
          ]
        : []),
      `  uploads go to: ${target ? printable(target) : "nowhere yet (seshi login --server <url>)"}`,
      `  uploader: ${running ? "running" : "not running"}${service ? " (service)" : ""} · ${queued} queued${state.uploader?.last_run ? ` · last ran ${state.uploader.last_run}` : ""}`,
      ...(problems.sign_in
        ? [`  ${style.status("sign in", "warn")}: ${printable(problems.sign_in.message)}`]
        : []),
      ...(problems.upload
        ? [`  ${style.status("upload failing", "error")}: ${printable(problems.upload.message)}`]
        : []),
      "agents:",
      ...installs.map(
        (i) =>
          `  ${i.agent.padEnd(12)} ${i.installed ? style.status("installed", "success") : "not installed"}${i.since ? ` (since ${i.since})` : ""}${i.status?.notes.length ? ` · ${i.status.notes.join("; ")}` : ""}`,
      ),
      ...(recent.length > 0
        ? [
            "recent sessions:",
            ...recent.map(([key, s]) => `  ${printable(key)}  ${sessionWord(s)}`),
          ]
        : []),
    ],
  );
  return attention ? EXIT.attention : EXIT.ok;
}

async function pause(ctx: CommandContext, json: boolean, args: Args): Promise<number> {
  const [length, ...extra] = args.positionals;
  if (extra.length > 0) return usageError(ctx, json, `unexpected ${extra.join(" ")}`, USAGE);
  const ms = length === undefined ? undefined : parseDuration(length);
  if (length !== undefined && ms === undefined) {
    return usageError(ctx, json, `pause takes a duration (30m, 2h, 1d), not '${length}'`, USAGE);
  }
  const { paths } = pathsOf(ctx);
  const now = new Date();
  const at = now.toISOString();
  const until = ms === undefined ? undefined : new Date(now.getTime() + ms).toISOString();
  // Sessions a hook named that the uploader has not taken in yet are running too.
  const spooled = readSpool(paths).items.flatMap(({ entry }) =>
    entry.kind === "capture" ? [entry] : [],
  );
  let stopped = 0;
  await updateState(paths, (state) => {
    // Pausing again while paused moves the end only: a session turned on since it began stays on.
    const since = isPaused(state, now) && state.paused ? state.paused.at : at;
    if (since === at) endPause(state, now);
    state.paused = { at: since, ...(until ? { until } : {}) };
    for (const entry of spooled) {
      const key = sessionKey(entry.agent, entry.session_id);
      state.sessions[key] ??= {
        agent: entry.agent,
        session_id: entry.session_id,
        first_seen: entry.at,
        ...(entry.transcript_path ? { path: entry.transcript_path } : {}),
        ...(entry.cwd ? { cwd: entry.cwd } : {}),
        ...(entry.parent_session_id ? { parent_session_id: entry.parent_session_id } : {}),
      };
    }
    // F9.5 (revised 15 Nov 2026): every session running now stops where it is. It keeps what it
    // uploaded, nothing is retracted, and nothing past that offset is ever sent. A session turned
    // on during the pause being extended is the person's own choice, and stays on.
    for (const session of Object.values(state.sessions)) {
      if (session.frozen || session.toggle === "off") continue;
      if (
        session.toggle === "on" &&
        session.toggled_at !== undefined &&
        Date.parse(session.toggled_at) >= Date.parse(since)
      ) {
        continue;
      }
      freeze(session, at, uploadedOffset(session));
    }
    stopped = stoppedCount(state);
  });
  const style = await styleFor(ctx, { json });
  emit(ctx, json, { paused: true, until: until ?? null, stopped }, () => [
    `${style.status("paused", "warn")}: sessions stop where they are ${until ? `until ${until}` : "until seshi capture resume"}.`,
    `  ${stopped} session${stopped === 1 ? "" : "s"} keep${stopped === 1 ? "s" : ""} what was uploaded and send${stopped === 1 ? "s" : ""} nothing more, even after the pause; sessions started during it are not captured. Nothing is retracted.`,
    "  To upload a stopped session in full: seshi capture on --session <id>",
  ]);
  return EXIT.ok;
}

/** Sessions a pause stopped that are not off anyway. */
function stoppedCount(state: CaptureState): number {
  return Object.values(state.sessions).filter((s) => s.frozen && s.toggle !== "off").length;
}

async function resume(ctx: CommandContext, json: boolean, _args: Args): Promise<number> {
  const { paths } = pathsOf(ctx);
  const now = new Date();
  let was = false;
  let stopped = 0;
  await updateState(paths, (state) => {
    was = state.paused !== undefined;
    stopped = stoppedCount(state);
    // Kept as an ended pause: a session that started during it stays off when first seen after.
    endPause(state, now);
    return was;
  });
  appendSpool(paths, { v: 1, kind: "wake", at: now.toISOString() });
  await startUploader(ctx, paths);
  const style = await styleFor(ctx, { json });
  // Resuming does not undo the pause: the sessions it stopped stay stopped (F9.5).
  emit(ctx, json, { paused: false, was_paused: was, stopped }, () => [
    was
      ? `${style.status("resumed", "success")}: sessions started from now on are captured`
      : "capture was not paused",
    ...(stopped > 0
      ? [
          `  ${stopped} session${stopped === 1 ? "" : "s"} a pause stopped stay${stopped === 1 ? "s" : ""} stopped; seshi capture on --session <id> uploads one in full`,
        ]
      : []),
  ]);
  return EXIT.ok;
}

async function toggle(
  ctx: CommandContext,
  json: boolean,
  args: Args,
  which: "on" | "off",
): Promise<number> {
  const on = which === "on";
  const style = await styleFor(ctx, { json });
  if (args.positionals.length > 0) {
    return usageError(ctx, json, `unexpected ${args.positionals.join(" ")}`, USAGE);
  }
  if (args.session !== undefined && args.path !== undefined) {
    return usageError(ctx, json, "--session and --path cannot go together", USAGE);
  }
  if (args.session !== undefined || args.agent !== undefined) {
    return toggleSession(ctx, json, args, which, style);
  }
  const account = openAccount(ctx);
  const text = readCliText(account.cliFile);
  if (args.path !== undefined) {
    const folder = resolve(expandTilde(args.path, account.home));
    const written = rulePath(folder, account.home);
    const next = setCapturePath(text, written, on, (a, b) => {
      const left = resolve(expandTilde(a, account.home));
      const right = resolve(expandTilde(b, account.home));
      return within(left, right, process.platform) && within(right, left, process.platform);
    });
    writeCliConfig(account.cliFile, next, account.env);
    emit(ctx, json, { path: folder, capture: on, file: account.cliFile }, () => [
      `${style.status(on ? "on" : "off", on ? "success" : "warn")}: sessions under ${printable(folder)} are ${on ? "captured" : "not captured"} (${account.cliFile})`,
    ]);
    return EXIT.ok;
  }
  const next = setTableKey(text, "capture", "enabled", String(on));
  writeCliConfig(account.cliFile, next, account.env);
  const overridden = account.env.SESHI_CAPTURE__ENABLED;
  emit(ctx, json, { capture: on, file: account.cliFile }, () => [
    `${style.status(on ? "on" : "off", on ? "success" : "warn")}: capture is ${on ? "on" : "off"} for this user (${account.cliFile})`,
    ...(overridden !== undefined
      ? [
          `  ${style.warn("note")}: SESHI_CAPTURE__ENABLED=${overridden} in the environment overrides it`,
        ]
      : []),
  ]);
  return EXIT.ok;
}

async function toggleSession(
  ctx: CommandContext,
  json: boolean,
  args: Args,
  which: "on" | "off",
  style: Style,
): Promise<number> {
  const { paths } = pathsOf(ctx);
  const now = new Date();
  const which_ = resolveSession(
    { ...args, session: args.session ?? true },
    readState(paths),
    ctx.env,
    process.cwd(),
    now,
  );
  if (typeof which_ === "string") return usageError(ctx, json, which_, USAGE);
  const { agent, id } = which_;
  const key = sessionKey(agent, id);
  let retracting = false;
  let fresh = false;
  let unfrozen = false;
  // A session turned off before any hook named its transcript (`/seshi capture off` as the
  // first prompt): find it now, so the toggle is kept as long as the transcript exists (F9.3)
  // and not forgotten as a session with nothing to show for it.
  const known = readState(paths).sessions[key];
  const located = known?.path ? undefined : (await captureAgent(agent))?.locate?.(id, hostOf(ctx));
  await updateState(paths, (state) => {
    const session: SessionState = state.sessions[key] ?? {
      agent,
      session_id: id,
      first_seen: now.toISOString(),
      ...(process.cwd() ? { cwd: process.cwd() } : {}),
    };
    if (located && !session.path) session.path = located;
    session.toggle = which;
    session.toggled_at = now.toISOString();
    state.sessions[key] = session;
    // The session's subagents with no toggle of their own go with it: their transcripts hold
    // its task prompts and tool output (F9.5), so what they uploaded is retracted too.
    for (const s of [session, ...subsessionKeys(state, agent, id).map((k) => state.sessions[k])]) {
      if (!s) continue;
      if (which === "off") {
        if (s.sent) {
          s.retract = "pending";
          retracting = true;
        }
      } else {
        // A retraction the server refused is called off: nothing was removed, capture goes on.
        // One still waiting is not: it may have landed with its answer lost, and the server
        // then refuses the session for good (422 redacted) while this machine thinks it live
        // (33). It is done, and the session is uploaded again from its start as a new one.
        if (s.retract === "failed") {
          delete s.retract;
          delete s.retract_error;
        }
        if (s.retract === "pending" || ((s.generation ?? 0) > 0 && !s.stored)) fresh = true;
        // A session a pause stopped goes on from where it stopped, so the server ends up with
        // all of it (F9.7), what it wrote while stopped included.
        if (s.frozen) {
          delete s.frozen;
          unfrozen = true;
        }
      }
    }
  });
  appendSpool(
    paths,
    which === "off"
      ? { v: 1, kind: "retract", at: now.toISOString(), agent, session_id: id }
      : { v: 1, kind: "wake", at: now.toISOString() },
  );
  await startUploader(ctx, paths);
  const lines =
    which === "off"
      ? [
          `${style.status("off", "warn")}: Session Capture is off for this session (${printable(agent)} ${printable(id)}).`,
          retracting
            ? "What was uploaded is being retracted from the server."
            : "Nothing of it was uploaded.",
        ]
      : [
          `${style.status("on", "success")}: Session Capture is on for this session (${printable(agent)} ${printable(id)}).`,
          ...(fresh ? ["It is uploaded again from its start, as a new session."] : []),
          ...(unfrozen
            ? ["A pause had stopped it: all of it is uploaded now, what it wrote since included."]
            : []),
        ];
  emit(
    ctx,
    json,
    { agent, session_id: id, capture: which === "on", retracting, fresh, unfrozen },
    () => lines,
  );
  return EXIT.ok;
}

/** Why a session cannot be resent from here, or undefined when it can. */
function notResendable(state: CaptureState, s: SessionState): string | undefined {
  if (s.retract === "pending" || sessionToggle(state, s.agent, s) === "off") return "turned off";
  if (!s.sent) return "never uploaded from here";
  if (!s.path || !existsSync(s.path)) return "its transcript is gone";
  return undefined;
}

/** `seshi capture resend`: mark sessions for a whole resend with `rebuild` (X4.9), and wake the
 * uploader to send them. */
async function resend(ctx: CommandContext, json: boolean, args: Args): Promise<number> {
  if (args.positionals.length > 0) {
    return usageError(ctx, json, `unexpected ${args.positionals.join(" ")}`, USAGE);
  }
  if (args.path !== undefined || args.service || args.command !== undefined) {
    return usageError(ctx, json, "resend takes --all or --session [<id>]", USAGE);
  }
  if (args.all && args.session !== undefined) {
    return usageError(ctx, json, "--all and --session cannot go together", USAGE);
  }
  if (!args.all && args.session === undefined) {
    return usageError(ctx, json, "resend needs --all or --session [<id>]", USAGE);
  }
  const { paths } = pathsOf(ctx);
  const now = new Date();
  const state = readState(paths);
  let keys: string[];
  if (args.all) {
    keys = Object.keys(state.sessions)
      .filter((k) => !args.agent || state.sessions[k]?.agent === args.agent)
      .sort();
  } else {
    const which = resolveSession(args, state, ctx.env, process.cwd(), now);
    if (typeof which === "string") return usageError(ctx, json, which, USAGE);
    const key = sessionKey(which.agent, which.id);
    if (!state.sessions[key]) {
      return fail(
        ctx,
        json,
        EXIT.notFound,
        "not_found",
        `this machine has not seen ${which.agent} session ${which.id}`,
      );
    }
    keys = [key];
  }
  const marked: string[] = [];
  const skipped: { key: string; reason: string }[] = [];
  await updateState(paths, (st) => {
    for (const key of keys) {
      const session = st.sessions[key];
      if (!session) continue;
      const reason = notResendable(st, session);
      if (reason) {
        skipped.push({ key, reason });
        continue;
      }
      session.rebuild = { at: now.toISOString(), key: rebuildKey() };
      // Asked for by hand: a refusal that waits for the transcript to change does not hold it.
      if (session.error?.permanent) delete session.error;
      marked.push(key);
    }
    return marked.length > 0;
  });
  if (marked.length > 0) {
    appendSpool(paths, { v: 1, kind: "wake", at: now.toISOString() });
    await startUploader(ctx, paths);
  }
  const style = await styleFor(ctx, { json });
  emit(ctx, json, { resending: marked, skipped }, () => [
    marked.length > 0
      ? `${style.status("resending", "success")} ${marked.length} session(s) whole, to be built and reviewed again; seshi capture status shows them until they are sent.`
      : "Nothing to resend.",
    ...skipped.map((s) => `  ${printable(s.key)}: not resent, ${s.reason}`),
  ]);
  // One session asked for by name that cannot be resent is a refusal; --all reports and goes on.
  if (!args.all && marked.length === 0) return EXIT.conflict;
  return EXIT.ok;
}
