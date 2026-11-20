import { readState, sessionKey, subsessionKeys, uploadId } from "@seshi/capture";
import type { SessionMetadata, Visibility } from "@seshi/model";
import { openAccount } from "../account/account";
import { type Backend, openBackend } from "../backend";
import { captureAgent } from "../capture-agents";
import { EXIT } from "../cli/exit";
import { failWith, Refused } from "../cli/failures";
import { emit, helpOrUsageError, takeJson } from "../cli/output";
import { printable, styleFor } from "../cli/style";
import { resolveSession } from "./capture";
import { pathsOf } from "./capture-host";
import type { CommandContext } from "./index";
import { changeVisibility, sessionRef, whoReads } from "./sessions";

const usage = (verb: "share" | "unshare") =>
  `usage: seshi ${verb} [--session [<id>]] [--agent <agent>]
       seshi ${verb} <format> <session-id> [--owner <id>]
       (each also takes --server <url> and --json; with no session named, the one this agent
        runs, else the one seen in this folder in the past day)`;

interface Args {
  positionals: string[];
  session?: string | true;
  agent?: string;
  owner?: string;
  server?: string;
}

/** The flags, by hand: `--session` takes an optional value, as in `seshi capture`. */
function parseArgs(argv: readonly string[]): Args | string {
  const args: Args = { positionals: [] };
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i] as string;
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) return undefined;
      i++;
      return v;
    };
    switch (word) {
      case "--session":
        args.session = next() ?? true;
        break;
      case "--agent":
      case "--owner":
      case "--server": {
        const v = next();
        if (!v) return `${word} needs a value`;
        args[word.slice(2) as "agent" | "owner" | "server"] = v;
        break;
      }
      default:
        if (word.startsWith("--")) return `unknown option ${word}`;
        args.positionals.push(word);
    }
  }
  if (args.positionals.length > 0 && (args.session !== undefined || args.agent !== undefined)) {
    return "name a session either as <format> <session-id> or with --session, not both";
  }
  if (args.positionals.length === 0 && args.owner !== undefined) {
    return "--owner goes with a named session: <format> <session-id> --owner <id>";
  }
  return args;
}

interface Target {
  format: string;
  sessionId: string;
  /** Its subagents' sessions, as this machine uploaded them. */
  subagents: string[];
  /** This agent's session, found in this machine's capture state rather than named. */
  current: boolean;
}

/** The session the arguments name, else the one this agent runs (or the one seen in this
 * folder), as this machine uploaded it: its format, its upload id (`<id>~<n>` after a capture
 * off and on) and its subagents'. */
async function targetOf(ctx: CommandContext, args: Args): Promise<Target | string> {
  if (args.positionals.length > 0) {
    let ref: ReturnType<typeof sessionRef>;
    try {
      ref = sessionRef(args.positionals);
    } catch (err) {
      return (err as Error).message;
    }
    if (ref.rest.length > 0) return "name one session: <format> <session-id>";
    return { format: ref.format, sessionId: ref.sessionId, subagents: [], current: false };
  }
  const { paths } = pathsOf(ctx);
  const state = readState(paths);
  const which = resolveSession(
    {
      positionals: [],
      session: args.session ?? true,
      ...(args.agent ? { agent: args.agent } : {}),
    },
    state,
    ctx.env,
    process.cwd(),
    new Date(),
  );
  if (typeof which === "string") return which;
  const entry = state.sessions[sessionKey(which.agent, which.id)];
  if (entry?.toggle === "off") {
    throw new Refused(
      EXIT.failure,
      "capture_off",
      `Session Capture is off for ${which.agent} ${which.id}, so nothing of it is in the session store to share: turn it on first (seshi capture on --session ${which.id} --agent ${which.agent})`,
    );
  }
  const agent = await captureAgent(which.agent);
  const subagents = subsessionKeys(state, which.agent, which.id)
    .map((key) => state.sessions[key])
    .filter((s) => s?.sent && s.toggle !== "off")
    .map((s) => uploadId(s as NonNullable<typeof s>));
  return {
    format: agent?.format ?? which.agent,
    sessionId: entry ? uploadId(entry) : which.id,
    subagents,
    current: true,
  };
}

/** Its subagents' sessions too, each where it is stored; one not stored (never uploaded, or
 * since deleted) is left out. */
async function changeSubagents(
  backend: Backend,
  format: string,
  ids: readonly string[],
  visibility: Visibility,
): Promise<string[]> {
  const changed: string[] = [];
  for (const id of ids) {
    const metadata = await backend.setVisibility(format, id, visibility);
    if (metadata) changed.push(id);
  }
  return changed;
}

export async function run(ctx: CommandContext, verb: "share" | "unshare"): Promise<number> {
  const { json, rest } = takeJson(ctx.argv);
  const parsed = parseArgs(rest);
  if (typeof parsed === "string") return helpOrUsageError(ctx, json, parsed, usage(verb));
  const visibility: Visibility = verb === "share" ? "org" : "owner";
  let backend: Backend | undefined;
  try {
    const target = await targetOf(ctx, parsed);
    if (typeof target === "string") return helpOrUsageError(ctx, json, target, usage(verb));
    const account = openAccount(ctx);
    const style = await styleFor(ctx, { json, theme: account.cli.theme });
    backend = await openBackend(ctx, account, {
      ...(parsed.server ? { server: parsed.server } : {}),
      purpose: "read",
    });
    let metadata: SessionMetadata;
    try {
      metadata = await changeVisibility(backend, target, visibility, parsed.owner);
    } catch (err) {
      if (target.current && err instanceof Refused && err.code === "not_found") {
        throw new Refused(
          EXIT.notFound,
          "not_found",
          `${target.format}/${target.sessionId} is not in the session store yet: seshi uploads it as it runs, so try again after its next turn (seshi capture status --session shows why not)`,
        );
      }
      throw err;
    }
    const subagents = await changeSubagents(backend, target.format, target.subagents, visibility);
    const name = printable(`${target.format}/${target.sessionId}`);
    const also =
      subagents.length > 0
        ? `, with its ${subagents.length} subagent session${subagents.length === 1 ? "" : "s"}`
        : "";
    emit(ctx, json, { ...metadata, subagents }, () => [
      `${style.status(verb === "share" ? "Shared" : "Unshared", "success")} ${name}${also}: visibility is ${visibility}, so ${whoReads(visibility, backend as Backend)}.`,
    ]);
    return EXIT.ok;
  } catch (err) {
    return failWith(ctx, json, err);
  } finally {
    await backend?.close();
  }
}
