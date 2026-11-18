import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  appendSpool,
  type CapturePaths,
  type CaptureState,
  captureRules,
  decide,
  endPause,
  forgetHandedTranscript,
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
import { expandTilde, handedTranscriptDir } from "@seshi/kit";
import { VERSION } from "@seshi/model";
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
import { failWith, Refused } from "../cli/failures";
import { emit, fail, helpOrUsageError, takeJson } from "../cli/output";
import { hookCommand, inNpxCache, isCompiled } from "../cli/spawn";
import { printable, type Style, styleFor } from "../cli/style";
import { isServerless } from "../serverless/settings";
import { hostOf, pathsOf, startUploader } from "./capture-host";
import type { CommandContext } from "./index";

const USAGE = [
  "usage: seshi capture install [<agent>…] [--service] [--command <program>]",
  "       seshi capture install cursor --project [<dir>] | --cloud",
  "       seshi capture uninstall [<agent>…] [--service] [--command <program>]",
  "       seshi capture uninstall cursor --project [<dir>] | --cloud",
  "       seshi capture status [--session [<id>]] [--agent <agent>] [--project [<dir>]]",
  "       seshi capture pause [<duration>]",
  "       seshi capture resume",
  "       seshi capture off|on [--session [<id>]] [--agent <agent>]",
  "       seshi capture off|on --path <folder>",
  "       seshi capture resend --all | --session [<id>] [--agent <agent>]",
].join("\n");

interface Args {
  positionals: string[];
  session?: string | true;
  agent?: string;
  path?: string;
  service?: boolean;
  command?: string;
  all?: boolean;
  /** The repository whose committed hooks to work on; true: the one around this folder. */
  project?: string | true;
  cloud?: boolean;
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
      case "--project":
        args.project = value() ?? true;
        break;
      case "--cloud":
        args.cloud = true;
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

export function resolveSession(
  args: Args,
  state: CaptureState,
  env: Record<string, string | undefined>,
  cwd: string,
  now: Date,
): { agent: string; id: string } | string {
  let id = args.session === true ? env.SESHI_SESSION_ID || undefined : args.session;
  let agent = args.agent ?? (args.session === true ? env.SESHI_AGENT || undefined : undefined);
  if (args.session === true && !id && env.CODEX_THREAD_ID && (!agent || agent === "codex")) {
    id = env.CODEX_THREAD_ID;
    agent = "codex";
  }
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
      return "which session? run it from inside the agent (the /session-capture skill), or pass --session <id>";
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
  if (typeof parsed === "string") return helpOrUsageError(ctx, json, parsed, USAGE);
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
        return helpOrUsageError(
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

async function namedAgents(
  ctx: CommandContext,
  json: boolean,
  names: string[],
): Promise<CaptureAgent[] | ExitCode> {
  const agents = await allCaptureAgents();
  const unknown = names.filter((n) => !agents.some((a) => a.name === n));
  if (unknown.length > 0) {
    return helpOrUsageError(
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
  if (args.project !== undefined || args.cloud) return projectOrCloud(ctx, json, args, "install");
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
  const target = account && isServerless(account.cli) ? "serverless" : account?.cli.server;
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
        ? `Sessions from now on are uploaded to ${target === "serverless" ? "the bucket in [serverless], directly" : target}.`
        : `Not signed in yet: run ${style.bold("seshi login --server <url>")}; sessions wait until then.`,
    ],
  );
  return failed.length > 0 || (service && service.problems.length > 0) ? EXIT.failure : EXIT.ok;
}

async function uninstall(ctx: CommandContext, json: boolean, args: Args): Promise<number> {
  if (args.project !== undefined || args.cloud) {
    return projectOrCloud(ctx, json, args, "uninstall");
  }
  const agents = await namedAgents(ctx, json, args.positionals);
  if (typeof agents === "number") return agents;
  const host = hostOf(ctx);
  const { paths } = pathsOf(ctx);
  const command = args.command ? splitWords(args.command) : hookCommand();
  const results: { agent: string; changed: string[]; notes: string[] }[] = [];
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
  // seshi's own copies of sessions an agent handed it whole (OpenCode's) go with the agent.
  for (const agent of agents) {
    if (failed.some((f) => f.agent === agent.name)) continue;
    rmSync(handedTranscriptDir(host, agent.name), { recursive: true, force: true });
  }
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

/** The repository root around `from`: the nearest folder with a `.git`. */
export function repositoryRoot(from: string): string | undefined {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/** The repository `--project` names: the folder given, else the repository around this one.
 * Never the home folder, whose `.cursor` is the user-level config. */
function projectDir(ctx: CommandContext, args: Args): string {
  const dir =
    args.project === true || args.project === undefined
      ? repositoryRoot(process.cwd())
      : resolve(expandTilde(args.project, hostOf(ctx).home));
  if (!dir) {
    throw new Refused(
      EXIT.usage,
      "usage",
      "this folder is not in a git repository; name it: --project <dir>",
    );
  }
  if (resolve(dir) === resolve(hostOf(ctx).home)) {
    throw new Refused(
      EXIT.usage,
      "usage",
      "--project is a repository, not the home folder (whose .cursor is the user-level config: seshi capture install cursor)",
    );
  }
  return dir;
}

/** `install|uninstall <agent> --project` (the hooks committed to a repository, for the agent's
 * cloud VMs) and `--cloud` (marking this machine as one). */
async function projectOrCloud(
  ctx: CommandContext,
  json: boolean,
  args: Args,
  which: "install" | "uninstall",
): Promise<number> {
  if (args.project !== undefined && args.cloud) {
    return helpOrUsageError(ctx, json, "--project and --cloud cannot go together", USAGE);
  }
  if (args.service || args.command !== undefined) {
    return helpOrUsageError(
      ctx,
      json,
      `${args.cloud ? "--cloud" : "--project"} takes no --service or --command`,
      USAGE,
    );
  }
  const flag = args.cloud ? "--cloud" : "--project";
  const [name, ...extra] = args.positionals;
  if (!name || extra.length > 0) {
    return helpOrUsageError(
      ctx,
      json,
      `${flag} needs one agent: seshi capture ${which} cursor ${flag}`,
      USAGE,
    );
  }
  const agent = await captureAgent(name);
  const installer = agent?.installer;
  if (!agent || !installer)
    return helpOrUsageError(ctx, json, `seshi does not capture '${name}'`, USAGE);
  const style = await styleFor(ctx, { json });
  if (args.cloud) {
    if (!installer.cloud) {
      return helpOrUsageError(
        ctx,
        json,
        `${name} has no cloud agents seshi captures (only cursor)`,
        USAGE,
      );
    }
    const host = hostOf(ctx);
    const report = which === "install" ? installer.cloud.mark(host) : installer.cloud.unmark(host);
    emit(ctx, json, { agent: name, cloud: which === "install", ...report }, () => [
      which === "install"
        ? `${style.status("marked", "success")}: this machine is a ${name} cloud VM: the hooks committed to its repositories capture here, and seshi's user-level ${name} hooks stand aside`
        : `${style.status("unmarked", "success")}: this machine is not a ${name} cloud VM`,
    ]);
    return EXIT.ok;
  }
  if (!installer.project) {
    return helpOrUsageError(
      ctx,
      json,
      `${name} takes no hooks committed to a repository (only cursor)`,
      USAGE,
    );
  }
  const dir = projectDir(ctx, args);
  const report =
    which === "install"
      ? await installer.project.install({ dir, version: VERSION })
      : await installer.project.uninstall({ dir, version: VERSION });
  emit(ctx, json, { agent: name, project: dir, ...report }, () => [
    report.changed.length > 0
      ? `${style.status(which === "install" ? "installed" : "removed", "success")} ${name} (repository ${printable(dir)}): ${report.changed.map(printable).join(", ")}`
      : `${name} (repository ${printable(dir)}): ${which === "install" ? "already installed" : "nothing of seshi's was there"}`,
    ...report.notes.map((n) => `  ${style.warn("note")}: ${n}`),
    ...(which === "install" && report.changed.length > 0
      ? ["Commit the changed files. They hold no token or server URL."]
      : []),
  ]);
  return EXIT.ok;
}

async function status(ctx: CommandContext, json: boolean, args: Args): Promise<number> {
  if (args.project !== undefined) return projectStatus(ctx, json, args);
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
  const here = judge(cwd, stateFacts(state, "", undefined, now));
  let session:
    | { agent: string; id: string; state?: SessionState; decision: ReturnType<typeof judge> }
    | undefined;
  if (args.session !== undefined) {
    const which = resolveSession(args, state, ctx.env, cwd, now);
    if (typeof which === "string") return helpOrUsageError(ctx, json, which, USAGE);
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
    if (status && agent.installer?.cloud?.is(host)) {
      status.notes.push(
        `this machine is a ${agent.name} cloud VM: the hooks committed to its repositories capture here`,
      );
    }
    installs.push({
      agent: agent.name,
      installed: status?.installed ?? false,
      ...(state.agents[agent.name] ? { since: state.agents[agent.name]?.installed_at } : {}),
      ...(status ? { status } : {}),
    });
  }
  const account = accountOrNone(ctx);
  const target =
    state.uploader?.target ??
    (account && isServerless(account.cli) ? "serverless" : account?.cli.server);
  const service = await serviceInstalled(serviceContext(ctx, hookCommand())).catch(() => false);
  const queued = (state.uploader?.queued ?? 0) + spoolCount(paths);
  const running = uploaderRunning(paths, now);
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
      ...(session ? [] : [`  here (${printable(cwd)}): ${here.reason} (${here.level})`]),
      ...(paused && state.paused
        ? [
            `  ${style.warn("paused")} ${state.paused.until ? `until ${state.paused.until}` : "until seshi capture resume"}: sessions stop where they are; new ones are not captured`,
          ]
        : []),
      ...(stopped > 0 && !session
        ? [
            `  ${style.warn("stopped")}: ${stopped} session${stopped === 1 ? "" : "s"} stopped by a pause send nothing more; seshi capture on --session <id> uploads one in full`,
          ]
        : []),
      `  uploads go to: ${target ? printable(target) : "nowhere yet (seshi login --server <url>, or seshi init --serverless)"}`,
      `  uploader: ${running ? "running" : "not running"}${service ? " (service)" : ""} · ${queued} queued${state.uploader?.last_run ? ` · last ran ${state.uploader.last_run}` : ""}`,
      ...(problems.sign_in
        ? problems.sign_in.message
            .split("\n")
            .map((line, i) =>
              i === 0
                ? `  ${style.status(problems.sign_in?.word ?? "sign in", "warn")}: ${printable(line)}`
                : `    ${printable(line)}`,
            )
        : []),
      ...(problems.upload
        ? [`  ${style.status("upload failing", "error")}: ${printable(problems.upload.message)}`]
        : []),
      ...(session
        ? []
        : [
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
          ]),
    ],
  );
  return attention ? EXIT.attention : EXIT.ok;
}

/** `status --project`: whether the repository's committed hooks are in, for each agent that
 * takes them, and whether this machine is marked as that agent's cloud VM. */
async function projectStatus(ctx: CommandContext, json: boolean, args: Args): Promise<number> {
  const dir = projectDir(ctx, args);
  const host = hostOf(ctx);
  const agents = (await allCaptureAgents()).filter(
    (a) => a.installer?.project && (args.agent === undefined || a.name === args.agent),
  );
  const rows: { agent: string; cloud_vm: boolean; status: InstallStatus }[] = [];
  for (const agent of agents) {
    const installer = agent.installer as NonNullable<CaptureAgent["installer"]>;
    const status = await (installer.project as NonNullable<typeof installer.project>).status({
      dir,
      version: VERSION,
    });
    rows.push({ agent: agent.name, cloud_vm: installer.cloud?.is(host) ?? false, status });
  }
  const style = await styleFor(ctx, { json });
  emit(ctx, json, { project: dir, agents: rows }, () => [
    `repository ${printable(dir)}:`,
    ...rows.flatMap((r) => [
      `  ${r.agent.padEnd(12)} ${r.status.installed ? style.status("installed", "success") : "not installed"}${r.cloud_vm ? ` · this machine is a ${r.agent} cloud VM` : ""}`,
      ...r.status.files.map(
        (f) =>
          `    ${printable(f.path)}: ${f.present ? (f.ours ? "seshi's" : "not seshi's") : "missing"}`,
      ),
      ...r.status.notes.map((n) => `    ${style.warn("note")}: ${printable(n)}`),
    ]),
  ]);
  return EXIT.ok;
}

async function pause(ctx: CommandContext, json: boolean, args: Args): Promise<number> {
  const [length, ...extra] = args.positionals;
  if (extra.length > 0) return helpOrUsageError(ctx, json, `unexpected ${extra.join(" ")}`, USAGE);
  const ms = length === undefined ? undefined : parseDuration(length);
  if (length !== undefined && ms === undefined) {
    return helpOrUsageError(
      ctx,
      json,
      `pause takes a duration (30m, 2h, 1d), not '${length}'`,
      USAGE,
    );
  }
  const { paths } = pathsOf(ctx);
  const now = new Date();
  const at = now.toISOString();
  const until = ms === undefined ? undefined : new Date(now.getTime() + ms).toISOString();
  const spooled = readSpool(paths).items.flatMap(({ entry }) =>
    entry.kind === "capture" ? [entry] : [],
  );
  let stopped = 0;
  await updateState(paths, (state) => {
    const since = extendPause(state, now, until);
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
    freezeRunningSessions(state, since, at);
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

function extendPause(state: CaptureState, now: Date, until: string | undefined): string {
  const at = now.toISOString();
  const since = isPaused(state, now) && state.paused ? state.paused.at : at;
  if (since === at) endPause(state, now);
  state.paused = { at: since, ...(until ? { until } : {}) };
  return since;
}

function freezeRunningSessions(state: CaptureState, since: string, at: string): void {
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
}

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
    endPause(state, now);
    return was;
  });
  appendSpool(paths, { v: 1, kind: "wake", at: now.toISOString() });
  await startUploader(ctx, paths);
  const style = await styleFor(ctx, { json });
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
    return helpOrUsageError(ctx, json, `unexpected ${args.positionals.join(" ")}`, USAGE);
  }
  if (args.session !== undefined && args.path !== undefined) {
    return helpOrUsageError(ctx, json, "--session and --path cannot go together", USAGE);
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
  if (typeof which_ === "string") return helpOrUsageError(ctx, json, which_, USAGE);
  const { agent, id } = which_;
  const key = sessionKey(agent, id);
  let retracting = false;
  let fresh = false;
  let unfrozen = false;
  const located = await locateUnnamedTranscript(ctx, paths, agent, id);
  const turnedOff: string[] = [];
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
    for (const s of cascadeToSubagents(state, session, agent, id)) {
      if (which === "off") {
        turnedOff.push(s.session_id);
        if (s.sent) {
          s.retract = "pending";
          retracting = true;
        }
      } else {
        if (restartAfterRetraction(s)) fresh = true;
        if (unfreeze(s)) unfrozen = true;
      }
    }
  });
  // A session turned off keeps no copy here of what an agent handed seshi whole.
  const loaded = turnedOff.length > 0 ? await captureAgent(agent) : undefined;
  if (loaded) {
    for (const off of turnedOff) forgetHandedTranscript(hostOf(ctx), loaded, off);
  }
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
            ? "What was uploaded is being retracted from the session store."
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

async function locateUnnamedTranscript(
  ctx: CommandContext,
  paths: CapturePaths,
  agent: string,
  id: string,
): Promise<string | undefined> {
  const known = readState(paths).sessions[sessionKey(agent, id)];
  return known?.path ? undefined : (await captureAgent(agent))?.locate?.(id, hostOf(ctx));
}

function cascadeToSubagents(
  state: CaptureState,
  session: SessionState,
  agent: string,
  id: string,
): SessionState[] {
  return [session, ...subsessionKeys(state, agent, id).flatMap((k) => state.sessions[k] ?? [])];
}

function restartAfterRetraction(s: SessionState): boolean {
  if (s.retract === "failed") {
    delete s.retract;
    delete s.retract_error;
  }
  return s.retract === "pending" || ((s.generation ?? 0) > 0 && !s.stored);
}

function unfreeze(s: SessionState): boolean {
  if (!s.frozen) return false;
  delete s.frozen;
  return true;
}

function notResendable(state: CaptureState, s: SessionState): string | undefined {
  if (s.retract === "pending" || sessionToggle(state, s.agent, s) === "off") return "turned off";
  if (!s.sent) return "never uploaded from here";
  if (!s.path || !existsSync(s.path)) return "its transcript is gone";
  return undefined;
}

async function resend(ctx: CommandContext, json: boolean, args: Args): Promise<number> {
  if (args.positionals.length > 0) {
    return helpOrUsageError(ctx, json, `unexpected ${args.positionals.join(" ")}`, USAGE);
  }
  if (args.path !== undefined || args.service || args.command !== undefined) {
    return helpOrUsageError(ctx, json, "resend takes --all or --session [<id>]", USAGE);
  }
  if (args.all && args.session !== undefined) {
    return helpOrUsageError(ctx, json, "--all and --session cannot go together", USAGE);
  }
  if (!args.all && args.session === undefined) {
    return helpOrUsageError(ctx, json, "resend needs --all or --session [<id>]", USAGE);
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
    if (typeof which === "string") return helpOrUsageError(ctx, json, which, USAGE);
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
  if (!args.all && marked.length === 0) return EXIT.conflict;
  return EXIT.ok;
}
