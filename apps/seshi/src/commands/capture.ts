/** `seshi capture`: the agent integrations on this machine (F9).
 *
 *   seshi capture install [<agent>…] [--service] [--command <program>]
 *   seshi capture uninstall [<agent>…] [--service]
 *   seshi capture status [--session [<id>]] [--agent <agent>]
 *   seshi capture pause [<duration>]
 *   seshi capture resume
 *   seshi capture off|on [--session [<id>]] [--agent <agent>]
 *   seshi capture off|on --path <folder>
 *
 * `install` merges seshi's hooks into each agent's own config (F9.6), keeping every hook there;
 * with no agent named it installs for every agent found on this machine. `uninstall` takes out
 * only seshi's entries. `--service` adds (or removes) a launchd, systemd or Task Scheduler entry
 * that keeps the uploader running between sessions.
 *
 * `off` and `on` set a capture rule (F9.5): for one session (`--session`; with no id, the
 * session the agent's environment names, else the latest seen in this folder), for a folder
 * (`--path`, a `[[capture.paths]]` rule in the CLI config), or for everything (the CLI config's
 * `capture.enabled`). Turning a session off stops its uploads and retracts what was uploaded
 * (F9.7). `pause` stops everything for a while, or until `resume`.
 *
 * Every subcommand takes `--json`. Exit codes: 0; 2 usage; 3 a config or state file it cannot
 * use; 4 no agent to install for; 8 (`status`) something needs action. */

import { resolve } from "node:path";
import {
  appendSpool,
  type CaptureState,
  captureRules,
  decide,
  isPaused,
  placeOf,
  readState,
  type SessionState,
  StateUnreadable,
  sessionKey,
  sessionWord,
  spoolCount,
  updateState,
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
import { hookCommand, isCompiled } from "../cli/spawn";
import { printable, type Style, styleFor } from "../cli/style";
import { hostOf, pathsOf, startUploader } from "./capture-host";
import type { CommandContext } from "./index";

const USAGE = [
  "usage: seshi capture install [<agent>…] [--service] [--command <program>]",
  "       seshi capture uninstall [<agent>…] [--service]",
  "       seshi capture status [--session [<id>]] [--agent <agent>]",
  "       seshi capture pause [<duration>]",
  "       seshi capture resume",
  "       seshi capture off|on [--session [<id>]] [--agent <agent>]",
  "       seshi capture off|on --path <folder>",
].join("\n");

interface Args {
  positionals: string[];
  /** `--session` alone (true) or with an id. */
  session?: string | true;
  agent?: string;
  path?: string;
  service?: boolean;
  command?: string;
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
 * SessionStart hook), else the session seen last in this folder in the past day. */
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
    const recent = Object.values(state.sessions)
      .filter(
        (s) =>
          (!agent || s.agent === agent) &&
          s.cwd !== undefined &&
          within(cwd, s.cwd, process.platform) &&
          now.getTime() - Date.parse(s.last_seen ?? s.first_seen) < 24 * 3600 * 1000,
      )
      .sort((a, b) => (b.last_seen ?? "").localeCompare(a.last_seen ?? ""))[0];
    if (!recent) {
      return "which session? run it from inside the agent (the /seshi skill), or pass --session <id>";
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
  const command = hookCommand();
  const results: { agent: string; changed: string[]; notes: string[] }[] = [];
  for (const agent of agents) {
    if (!agent.installer) continue;
    const report = await agent.installer.uninstall({ ...host, command });
    if (report.changed.length > 0 || args.positionals.length > 0)
      results.push({ agent: agent.name, ...report });
  }
  await updateState(paths, (state) => {
    for (const agent of agents) delete state.agents[agent.name];
  });
  const service = args.service
    ? await uninstallService(serviceContext(ctx, serviceCommand(command)))
    : undefined;
  const style = await styleFor(ctx, { json });
  emit(ctx, json, { uninstalled: results, ...(service ? { service } : {}) }, () => [
    ...(results.length === 0 ? ["seshi was not installed in any agent's config"] : []),
    ...results.map(
      (r) =>
        `${style.status("removed", "success")} ${r.agent}${r.changed.length > 0 ? `: ${r.changed.join(", ")}` : " (nothing of seshi's was there)"}`,
    ),
    ...(service
      ? [`${service.changed ? "service removed" : "no service entry"}: ${service.entry}`]
      : []),
    "Sessions already uploaded stay on the server; seshi capture off --session <id> still retracts one.",
  ]);
  return EXIT.ok;
}

async function status(ctx: CommandContext, json: boolean, args: Args): Promise<number> {
  const { host, paths } = pathsOf(ctx);
  const now = new Date();
  const state = readState(paths);
  const snapshot = await captureRules(host, paths);
  const cwd = process.cwd();
  const paused = isPaused(state, now);
  const judge = (folder: string | undefined, toggle?: SessionState["toggle"]) =>
    decide(
      {
        rules: snapshot.rules,
        ...(snapshot.error ? { rulesError: snapshot.error } : {}),
        place: placeOf(folder),
        ...(toggle ? { toggle } : {}),
        paused,
      },
      host.platform,
    );
  const here = judge(cwd);
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
      decision: judge(known?.cwd ?? cwd, known?.toggle),
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
      paused: state.paused ?? null,
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
      ...(state.paused
        ? [
            `  ${style.warn("paused")} ${state.paused.until ? `until ${state.paused.until}` : "until seshi capture resume"}`,
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
  const until = ms === undefined ? undefined : new Date(now.getTime() + ms).toISOString();
  await updateState(paths, (state) => {
    state.paused = { at: now.toISOString(), ...(until ? { until } : {}) };
  });
  const style = await styleFor(ctx, { json });
  emit(ctx, json, { paused: true, until: until ?? null }, () => [
    `${style.status("paused", "warn")}: nothing is captured ${until ? `until ${until}` : "until seshi capture resume"}`,
  ]);
  return EXIT.ok;
}

async function resume(ctx: CommandContext, json: boolean, _args: Args): Promise<number> {
  const { paths } = pathsOf(ctx);
  let was = false;
  await updateState(paths, (state) => {
    was = state.paused !== undefined;
    delete state.paused;
    return was;
  });
  appendSpool(paths, { v: 1, kind: "wake", at: new Date().toISOString() });
  await startUploader(ctx, paths);
  const style = await styleFor(ctx, { json });
  emit(ctx, json, { paused: false, was_paused: was }, () => [
    was ? `${style.status("resumed", "success")}: capture is on again` : "capture was not paused",
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
    if (which === "off") {
      if (session.sent) session.retract = "pending";
      retracting = session.sent === true;
    } else {
      // A retraction not yet done is called off: nothing was removed, capture goes on.
      if (session.retract === "pending") delete session.retract;
      fresh = (session.generation ?? 0) > 0 && !session.stored;
    }
    state.sessions[key] = session;
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
        ];
  emit(
    ctx,
    json,
    { agent, session_id: id, capture: which === "on", retracting, fresh },
    () => lines,
  );
  return EXIT.ok;
}
