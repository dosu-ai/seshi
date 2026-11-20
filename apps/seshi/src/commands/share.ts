import { readState, type SessionState, sessionKey, uploadId } from "@seshi/capture";
import { ServerError } from "@seshi/client";
import type { SessionMetadata, Visibility } from "@seshi/model";
import { openAccount } from "../account/account";
import { type Backend, openBackend } from "../backend";
import { captureAgent } from "../capture-agents";
import { EXIT } from "../cli/exit";
import { failWith, Refused } from "../cli/failures";
import { emit, helpOrUsageError, takeJson } from "../cli/output";
import { printable, styleFor } from "../cli/style";
import { parseCaptureArgs, resolveSession } from "./capture";
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

/** `seshi capture`'s flags (`--session` with an optional id, `--agent`), plus `--owner` and
 * `--server`. */
function parseArgs(argv: readonly string[]): Args | string {
  const rest: string[] = [];
  const own: { owner?: string; server?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i] as string;
    if (word !== "--owner" && word !== "--server") {
      rest.push(word);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) return `${word} needs a value`;
    own[word === "--owner" ? "owner" : "server"] = value;
    i++;
  }
  const parsed = parseCaptureArgs(rest);
  if (typeof parsed === "string") return parsed;
  if (parsed.path !== undefined || parsed.service || parsed.command !== undefined || parsed.all) {
    return "share and unshare take --session, --agent, --owner and --server";
  }
  const args: Args = {
    positionals: parsed.positionals,
    ...(parsed.session !== undefined ? { session: parsed.session } : {}),
    ...(parsed.agent !== undefined ? { agent: parsed.agent } : {}),
    ...own,
  };
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
  /** This machine's capture state says it was uploaded. */
  sent: boolean;
}

/** The sessions `id` started (its subagents), and theirs in turn, whatever their own toggles. */
function subagentsOf(
  sessions: Readonly<Record<string, SessionState>>,
  agent: string,
  id: string,
): SessionState[] {
  const found: SessionState[] = [];
  const parents = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of Object.values(sessions)) {
      if (s.agent !== agent || parents.has(s.session_id)) continue;
      if (s.parent_session_id === undefined || !parents.has(s.parent_session_id)) continue;
      parents.add(s.session_id);
      found.push(s);
      grew = true;
    }
  }
  return found;
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
    return {
      format: ref.format,
      sessionId: ref.sessionId,
      subagents: [],
      current: false,
      sent: false,
    };
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
    const agent = printable(which.agent);
    const id = printable(which.id);
    throw new Refused(
      EXIT.failure,
      "capture_off",
      `Session Capture is off for ${agent} ${id}, so nothing of it is in the session store to share: turn it on first (seshi capture on --session ${id} --agent ${agent})`,
    );
  }
  const agent = await captureAgent(which.agent);
  const subagents = subagentsOf(state.sessions, which.agent, which.id)
    .filter((s) => s.sent && s.toggle !== "off")
    .map(uploadId);
  return {
    format: agent?.format ?? which.agent,
    sessionId: entry ? uploadId(entry) : which.id,
    subagents,
    current: true,
    sent: entry?.sent === true,
  };
}

/** Its subagents' sessions too, all at once, each where it is stored; one not stored (never
 * uploaded, or since deleted) is left out, and one the server refuses is reported, not
 * thrown: the session itself has changed by then. */
async function changeSubagents(
  backend: Backend,
  format: string,
  ids: readonly string[],
  visibility: Visibility,
): Promise<{ changed: string[]; failed: { session_id: string; error: string }[] }> {
  const results = await Promise.allSettled(
    ids.map((id) => backend.setVisibility(format, id, visibility)),
  );
  const changed: string[] = [];
  const failed: { session_id: string; error: string }[] = [];
  results.forEach((result, i) => {
    const id = ids[i] as string;
    if (result.status === "rejected") {
      failed.push({ session_id: id, error: (result.reason as Error).message });
    } else if (result.value) {
      changed.push(id);
    }
  });
  return { changed, failed };
}

/** What a refusal of the session itself means, said for this command. */
function refusal(err: unknown, target: Target): unknown {
  const name = printable(`${target.format}/${target.sessionId}`);
  if (target.current && err instanceof Refused && err.code === "not_found") {
    return new Refused(
      EXIT.notFound,
      "not_found",
      target.sent
        ? `${name} is not in the session store this CLI reads, though this machine uploaded it: the CLI may be signed in as someone other than the uploader, or to another server (seshi whoami, seshi capture status --session)`
        : `${name} is not in the session store yet: seshi uploads it as it runs, so try again after its next turn (seshi capture status --session shows why not)`,
    );
  }
  if (err instanceof ServerError && err.status === 403 && /sessions:read scope/.test(err.message)) {
    return new Refused(
      EXIT.auth,
      "forbidden",
      `${err.message}. Servers older than seshi 0.23 let only a sign-in that reads, or an admin, change a session's visibility: ask an admin to upgrade the server, or to share it for you (seshi share ${name} --owner <you>)`,
    );
  }
  return err;
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
      // Another owner's session is an admin's to change, with the sign-in; one's own, with the
      // device token the uploader sends with, so no renewal through the IdP is needed.
      purpose: parsed.owner ? "read_others" : "share",
    });
    let metadata: SessionMetadata;
    try {
      metadata = await changeVisibility(backend, target, visibility, parsed.owner);
    } catch (err) {
      throw refusal(err, target);
    }
    const { changed, failed } = await changeSubagents(
      backend,
      target.format,
      target.subagents,
      visibility,
    );
    const name = printable(`${target.format}/${target.sessionId}`);
    const also =
      changed.length > 0
        ? `, with its ${changed.length} subagent session${changed.length === 1 ? "" : "s"}`
        : "";
    const readers = whoReads(visibility, backend);
    emit(ctx, json, { ...metadata, subagents: changed, failed, readers }, () => [
      `${style.status(verb === "share" ? "Shared" : "Unshared", "success")} ${name}${also}: visibility is ${visibility}, so ${readers}.`,
      ...failed.map(
        (f) =>
          `  ${style.warn("not changed")}: subagent ${printable(`${target.format}/${f.session_id}`)}: ${printable(f.error)}`,
      ),
    ]);
    return failed.length > 0 ? EXIT.attention : EXIT.ok;
  } catch (err) {
    return failWith(ctx, json, err);
  } finally {
    await backend?.close();
  }
}
