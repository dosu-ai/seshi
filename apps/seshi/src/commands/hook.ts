import { appendLog, runHook, sessionKey } from "@seshi/capture/fast";
import { CAPTURE_COMMAND, CLOUD_FLAG, hookHandler } from "@seshi/kit";
import { captureAgent } from "../capture-agents";
import { EXIT } from "../cli/exit";
import { hostOf, NO_UPLOADER_ENV, pathsOf, startUploader } from "./capture-host";
import type { CommandContext } from "./index";

const STDIN_TIMEOUT_MS = 5000;

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
  const [agentName, event, ...argv] = ctx.argv;
  // `--cloud` comes before any `--`, after which Codex's own program and payload follow.
  const dash = argv.indexOf("--");
  const flag = argv.indexOf(CLOUD_FLAG);
  const cloud = flag !== -1 && (dash === -1 || flag < dash);
  const rest = cloud ? argv.filter((_, i) => i !== flag) : argv;
  const log = (line: string) =>
    appendLog(paths.log, `hook ${agentName ?? "?"} ${event ?? "?"}: ${line}`);
  try {
    await hook(ctx, agentName, event, rest, log, cloud);
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
  cloud: boolean,
): Promise<void> {
  if (!agentName || !event) {
    log("usage: seshi hook <agent> <event>");
    return;
  }
  const load = captureAgent(agentName);
  // A hook committed to a repository acts only on the agent's cloud VM, and a user-level one
  // stands aside there: on every other machine the committed one does nothing at all, so a
  // conversation is never captured by both.
  const marker = load ? (await load).installer?.cloud : undefined;
  if (cloud !== (marker?.is(hostOf(ctx)) ?? false)) return;
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
  const reply = (message: string) =>
    ctx.stdout(
      JSON.stringify(hookHandler(agent, event)?.reply?.(message) ?? { systemMessage: message }),
    );
  if (outcome.said) reply(outcome.said);
  if (outcome.announced) reply(notice(outcome.announced, agentName));
  // On a cloud VM nothing is left to a background uploader: the VM can be gone once the run
  // ends, so the hook uploads (or retracts) before it returns.
  const toggled = cloud ? { ...ctx, env: { ...ctx.env, [NO_UPLOADER_ENV]: "1" } } : ctx;
  if (outcome.requested) reply(await carryOut(toggled, agentName, outcome.requested));
  if (cloud && marker) {
    const keys = [
      ...outcome.spooled.map((c) => sessionKey(agent.name, c.session_id)),
      ...(outcome.requested ? [sessionKey(agent.name, outcome.requested.session.session_id)] : []),
    ];
    if (keys.length > 0) {
      const { uploadNow } = await import("./upload-now");
      await uploadNow(ctx, paths, keys, { deadlineMs: marker.budgetMs(event) });
    }
    return;
  }
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
 * --session <id>` would, and say what happened. */
async function carryOut(
  ctx: CommandContext,
  agent: string,
  { action, session }: { action: "off" | "on"; session: { session_id: string } },
): Promise<string> {
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
