import { appendLog, runHook } from "@seshi/capture/fast";
import { captureAgent } from "../capture-agents";
import { EXIT } from "../cli/exit";
import { pathsOf, startUploader } from "./capture-host";
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
  const [agentName, event, ...rest] = ctx.argv;
  const log = (line: string) =>
    appendLog(paths.log, `hook ${agentName ?? "?"} ${event ?? "?"}: ${line}`);
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

  const load = captureAgent(agentName);
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
  const outcome = await runHook({ agent: await load, event, payload, host, paths });
  if (outcome.ignored) log(outcome.ignored);
  if (outcome.announced) ctx.stdout(JSON.stringify({ systemMessage: notice(outcome.announced) }));
  if (outcome.spooled.length > 0) await startUploader(ctx, paths);
}

/** What a session that just started is told (Codex shows it as a notice). */
export function notice({ decision }: { decision: { capture: boolean; reason: string } }): string {
  return decision.capture
    ? "Session Capture ◉ · this session is uploaded to your team's session store as you work; $seshi off stops it"
    : `Session Capture ⏸ · ${decision.reason}`;
}
