import { appendLog, runHook } from "@seshi/capture/fast";
import { CAPTURE_COMMAND, type CaptureRequest, hookHandler } from "@seshi/kit";
import { captureAgent } from "../capture-agents";
import { EXIT } from "../cli/exit";
import { pathsOf, startUploader } from "./capture-host";
import type { CommandContext } from "./index";

const STDIN_TIMEOUT_MS = 5000;
const STALE_CLOUD_FLAG = "--cloud";

async function readInput(ctx: CommandContext): Promise<string> {
  if (ctx.tty?.stdin || !ctx.stdin) return "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(""), STDIN_TIMEOUT_MS);
  });
  try {
    return await Promise.race([ctx.stdin(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function run(ctx: CommandContext): Promise<number> {
  const { paths } = pathsOf(ctx);
  const [agentName, event, ...rest] = ctx.argv;
  const log = (line: string) =>
    appendLog(paths.log, `hook ${agentName ?? "?"} ${event ?? "?"}: ${line}`);
  // A Cursor hook an earlier seshi committed to a repository for Cursor Cloud passes `--cloud`.
  // seshi no longer captures Cursor Cloud through hooks, so such a hook does nothing.
  if (agentName === "cursor" && rest.includes(STALE_CLOUD_FLAG)) {
    log(
      "a Cursor Cloud hook committed to a repository; seshi no longer captures through it (remove it: docs/capture.md#cursor-cloud-agents)",
    );
    return EXIT.ok;
  }
  try {
    await hook(ctx, agentName, event, rest, log);
  } catch (err) {
    log(err instanceof Error ? err.message : String(err));
  }
  return EXIT.ok;
}

async function hook(
  ctx: CommandContext,
  agentName: string | undefined,
  event: string | undefined,
  rest: string[],
  log: (line: string) => void,
): Promise<void> {
  if (!agentName || !event) {
    log("usage: seshi hook <agent> <event>");
    return;
  }
  const load = captureAgent(agentName);
  // After `--`, the program Codex's `notify` named before seshi, run with the same payload:
  // Codex runs only one `notify` program.
  const dash = rest.indexOf("--");
  const args = dash === -1 ? rest : rest.slice(0, dash);
  const after = dash === -1 ? [] : rest.slice(dash + 1);
  // Codex appends the payload as the last argument, after whatever the installer wrote.
  let text: string;
  let chain: string[] = [];
  if (after.length > 0 && (after.at(-1) ?? "").trimStart().startsWith("{")) {
    text = after.at(-1) as string;
    chain = after.slice(0, -1);
  } else if (args.length > 0) {
    text = args.at(-1) as string;
    chain = after;
  } else {
    text = await readInput(ctx);
    chain = after;
  }
  if (chain.length > 0 && ctx.spawn) {
    await ctx.spawn(text ? [...chain, text] : chain).catch((err: unknown) => {
      log(`could not run ${chain[0]}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
  if (!text.trim()) return;

  if (!load) {
    log(`this seshi does not capture '${agentName}'`);
    return;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    log("the hook payload is not JSON");
    return;
  }
  const { host, paths } = pathsOf(ctx);
  const agent = await load;
  const outcome = await runHook({ agent, event, payload, host, paths });
  if (outcome.ignored) log(outcome.ignored);
  for (const problem of outcome.problems ?? []) log(problem);
  const reply = (message: string) =>
    ctx.stdout(
      JSON.stringify(hookHandler(agent, event)?.reply?.(message) ?? { systemMessage: message }),
    );
  if (outcome.said) reply(outcome.said);
  if (outcome.announced) reply(notice(outcome.announced, agentName));
  if (outcome.requested) reply(await carryOut(ctx, agentName, outcome.requested));
  if (outcome.spooled.length > 0) await startUploader(ctx, paths);
}

/** What a session is told when it starts or the person asks (Codex shows it as a notice,
 * Cursor in place of the message it stopped). */
export function notice(
  { decision }: { decision: { capture: boolean; reason: string } },
  agent: string,
): string {
  const off = `${agent === "codex" ? "$" : "/"}${CAPTURE_COMMAND} off`;
  return decision.capture
    ? `Session Capture ◉ · this session is uploaded to your team's session store as you work; ${off} stops it`
    : `Session Capture ⏸ · ${decision.reason}`;
}

/** Turn capture off or on for the session the person asked about, as `seshi capture off|on
 * --session <id>` would, or share or unshare it, as `seshi share|unshare --session <id>` would,
 * and say what happened. */
async function carryOut(
  ctx: CommandContext,
  agent: string,
  { action, session }: { action: CaptureRequest; session: { session_id: string } },
): Promise<string> {
  if (action === "share" || action === "unshare") return shareOut(ctx, agent, action, session);
  const { run } = await import("./capture");
  let out = "";
  let err = "";
  const code = await run({
    ...ctx,
    argv: [action, "--session", session.session_id, "--agent", agent, "--json"],
    stdout: (line) => {
      out += line;
    },
    stderr: (line) => {
      err += line;
    },
  });
  let said: {
    retracting?: boolean;
    fresh?: boolean;
    unfrozen?: boolean;
    error?: { message?: string };
  } = {};
  try {
    said = JSON.parse(out || err);
  } catch {}
  if (code !== 0) {
    return `Session Capture could not be turned ${action}: ${said.error?.message ?? (err.trim() || `exit ${code}`)}`;
  }
  if (action === "off") {
    return `Session Capture ⏸ · turned off for this session; ${said.retracting ? "what it uploaded is being retracted" : "nothing of it was uploaded"}`;
  }
  const more = [
    ...(said.fresh ? ["it is uploaded again from its start"] : []),
    ...(said.unfrozen ? ["a pause had stopped it, so all of it is uploaded now"] : []),
  ];
  return `Session Capture ◉ · turned on for this session${more.length > 0 ? `; ${more.join("; ")}` : ""}`;
}

/** Share or unshare the session the person asked about, as `seshi share|unshare --session <id>`
 * would, and say what it said: its own line when it did (with any subagent it could not change),
 * its own refusal when it did not (not uploaded yet, capture off, signed out). */
async function shareOut(
  ctx: CommandContext,
  agent: string,
  action: "share" | "unshare",
  { session_id }: { session_id: string },
): Promise<string> {
  const { run } = await import("./share");
  const out: string[] = [];
  const err: string[] = [];
  let code: number;
  try {
    code = await run(
      {
        ...ctx,
        argv: ["--session", session_id, "--agent", agent],
        tty: { stdout: false, stdin: false },
        noColor: true,
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
      },
      action,
    );
  } catch (error) {
    code = EXIT.failure;
    err.push(error instanceof Error ? error.message : String(error));
  }
  const said = (lines: string[]) =>
    lines
      .flatMap((l) => l.split("\n"))
      .map((l) => l.trim().replace(/^seshi: /, ""))
      .filter((l) => l !== "");
  if (code === EXIT.ok) return `Session Capture ◉ · ${said(out).join(" ")}`;
  // The session changed, but not every subagent's: what it says names each one left as it was.
  if (code === EXIT.attention) return `Session Capture · ${said(out).join("; ")}`;
  // A usage error goes on to print the usage, which says nothing to the person here.
  const why = said(err)[0] ?? `exit ${code}`;
  return `Session Capture · could not ${action} this session: ${why}`;
}
