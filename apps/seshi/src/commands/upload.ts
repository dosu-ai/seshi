/** `seshi upload`: send transcripts by hand (F8.1), through the same capture rules, state and
 * uploader as hooks (F9.3), so a manual upload can be retracted like any other (F9.7).
 *
 *   seshi upload <path>… [--agent <agent>] [--json]
 *   seshi upload --since <duration> [--agent <agent>] [--json]
 *
 * A path is a transcript, or a folder searched for them; which agent wrote each is read from
 * the file (or `--agent`). `--since 30d` backfills on purpose: every session of the installed
 * agents that started in the last 30 days, which the sweep alone never reaches back for. If the
 * background uploader is running it does the work and this command waits for it.
 *
 * Exit codes: 0 everything sent (or nothing new); 1 a session was refused; 2 usage; 3 a config
 * or state file it cannot use; 5 not signed in; 7 the server could not be reached. */

import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  acquireUploaderLock,
  appendLog,
  appendSpool,
  captureRules,
  decide,
  isPaused,
  placeOf,
  readHead,
  readState,
  type SessionState,
  StateUnreadable,
  sessionKey,
  sessionWord,
  sweepAgent,
  updateState,
} from "@seshi/capture";
import { parseDuration } from "@seshi/config";
import type { CaptureAgent, TranscriptInfo } from "@seshi/kit";
import { allCaptureAgents } from "../capture-agents";
import { captureRuntime } from "../capture-runtime";
import { EXIT } from "../cli/exit";
import { failWith } from "../cli/failures";
import { emit, fail, takeJson, usageError } from "../cli/output";
import { printable, styleFor } from "../cli/style";
import { pathsOf } from "./capture-host";
import type { CommandContext } from "./index";

const USAGE = [
  "usage: seshi upload <path>… [--agent <agent>] [--json]",
  "       seshi upload --since <duration> [--agent <agent>] [--json]",
].join("\n");

/** How long to wait for a running uploader to send what this command queued. */
const WAIT_MS = 120_000;

/** Transcript files under `path`: itself, or the `.jsonl` and `.json` files in a folder. */
export function transcriptsUnder(path: string, depth = 8): string[] {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    return [];
  }
  if (stat.isFile()) return [path];
  if (!stat.isDirectory() || depth === 0) return [];
  const out: string[] = [];
  for (const name of readdirSync(path).sort()) {
    if (name.startsWith(".")) continue;
    const full = join(path, name);
    let entry: ReturnType<typeof statSync>;
    try {
      entry = statSync(full);
    } catch {
      continue;
    }
    if (entry.isDirectory()) out.push(...transcriptsUnder(full, depth - 1));
    else if (/\.jsonl?$/.test(name)) out.push(full);
  }
  return out;
}

interface Candidate {
  path: string;
  agent: CaptureAgent;
  info: TranscriptInfo;
}

interface Outcome {
  path: string;
  key?: string;
  result: string;
  reason?: string;
}

export async function run(ctx: CommandContext): Promise<number> {
  const { json, rest } = takeJson(ctx.argv);
  let values: { agent?: string; since?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: rest,
      options: { agent: { type: "string" }, since: { type: "string" } },
      strict: true,
      allowPositionals: true,
    }));
  } catch (err) {
    return usageError(ctx, json, (err as Error).message, USAGE);
  }
  if (positionals.length === 0 && values.since === undefined) {
    return usageError(ctx, json, "name a transcript or a folder, or --since <duration>", USAGE);
  }
  const sinceMs = values.since === undefined ? undefined : parseDuration(values.since);
  if (values.since !== undefined && sinceMs === undefined) {
    return usageError(
      ctx,
      json,
      `--since takes a duration (7d, 30d), not '${values.since}'`,
      USAGE,
    );
  }
  let agents = await allCaptureAgents();
  if (values.agent !== undefined) {
    agents = agents.filter((a) => a.name === values.agent);
    if (agents.length === 0) {
      return usageError(ctx, json, `seshi does not capture '${values.agent}'`, USAGE);
    }
  }
  const { host, paths } = pathsOf(ctx);
  const log = (line: string) => appendLog(paths.log, `upload: ${line}`);
  try {
    const runtime = await captureRuntime(ctx, { log });
    try {
      return await upload(ctx, json, { agents, positionals, sinceMs, runtime, host, paths });
    } finally {
      await runtime.close();
    }
  } catch (err) {
    if (err instanceof StateUnreadable) return fail(ctx, json, EXIT.config, "state", err.message);
    return failWith(ctx, json, err);
  }
}

async function upload(
  ctx: CommandContext,
  json: boolean,
  options: {
    agents: CaptureAgent[];
    positionals: string[];
    sinceMs: number | undefined;
    runtime: Awaited<ReturnType<typeof captureRuntime>>;
    host: ReturnType<typeof pathsOf>["host"];
    paths: ReturnType<typeof pathsOf>["paths"];
  },
): Promise<number> {
  const { agents, runtime, host, paths } = options;
  const now = new Date();
  const outcomes: Outcome[] = [];
  const candidates: Candidate[] = [];
  for (const given of options.positionals) {
    const files = transcriptsUnder(resolve(given));
    if (files.length === 0)
      outcomes.push({ path: given, result: "skipped", reason: "no transcript there" });
    for (const path of files) {
      const head = readHead(path);
      let found: Candidate | undefined;
      for (const agent of agents) {
        const info = agent.identify(path, head);
        if (info) {
          found = { path, agent, info };
          break;
        }
      }
      if (found) candidates.push(found);
      else
        outcomes.push({
          path,
          result: "skipped",
          reason: "not a transcript of an agent seshi captures",
        });
    }
  }
  if (options.sinceMs !== undefined) {
    const floor = now.getTime() - options.sinceMs;
    for (const agent of agents) {
      for (const f of sweepAgent(agent, host, floor))
        candidates.push({ path: f.path, agent, info: f.info });
    }
  }

  // The same decision as a hook's (F9.3).
  const snapshot = await captureRules(host, paths);
  const state = readState(paths);
  const keys = new Map<string, string>();
  const additions: SessionState[] = [];
  for (const { path, agent, info } of candidates) {
    const key = sessionKey(agent.name, info.session_id);
    if (keys.has(key)) continue;
    const known = state.sessions[key];
    const decision = decide(
      {
        rules: snapshot.rules,
        ...(snapshot.error ? { rulesError: snapshot.error } : {}),
        place: placeOf(info.cwd ?? known?.cwd),
        ...(known?.toggle ? { toggle: known.toggle } : {}),
        paused: isPaused(state, now),
      },
      host.platform,
    );
    if (!decision.capture) {
      outcomes.push({ path, key, result: "skipped", reason: decision.reason });
      continue;
    }
    keys.set(key, path);
    additions.push({
      agent: agent.name,
      session_id: info.session_id,
      path,
      ...(info.cwd ? { cwd: info.cwd } : {}),
      ...(info.parent_session_id ? { parent_session_id: info.parent_session_id } : {}),
      first_seen: now.toISOString(),
      last_seen: now.toISOString(),
    });
  }
  await updateState(paths, (st) => {
    for (const addition of additions) {
      const key = sessionKey(addition.agent, addition.session_id);
      const session = st.sessions[key] ?? addition;
      session.path = addition.path;
      if (addition.cwd) session.cwd = addition.cwd;
      // Asked for by hand: try again what was refused or held back.
      delete session.error;
      delete session.next_attempt_at;
      delete session.failures;
      delete session.held_at_size;
      st.sessions[key] = session;
    }
  });

  let signIn: string | undefined;
  if (keys.size > 0) {
    const only = new Set(keys.keys());
    const lock = acquireUploaderLock(paths);
    if (lock) {
      try {
        for (let i = 0; i < 50; i++) {
          const summary = await runtime.uploader.pass({ only });
          if (summary.signIn) {
            signIn = summary.signIn;
            break;
          }
          if (summary.uploaded === 0) break;
        }
      } finally {
        lock.release();
      }
    } else {
      // The background uploader has the lock: hand it the work and wait for it.
      appendSpool(paths, { v: 1, kind: "wake", at: now.toISOString() });
      const deadline = Date.now() + WAIT_MS;
      while (Date.now() < deadline) {
        const st = readState(paths);
        const settled = [...only].every((key) => {
          const s = st.sessions[key];
          if (!s?.path) return true;
          if (s.error || s.toggle === "off") return true;
          const size = statSync(s.path, { throwIfNoEntry: false })?.size ?? 0;
          return s.stored ? (s.file_offset ?? 0) >= size : s.held_at_size === size;
        });
        if (settled) break;
        await Bun.sleep(250);
      }
      signIn = readState(paths).problems?.sign_in?.message;
    }
  }

  const after = readState(paths);
  let refused = false;
  let unreachable = false;
  for (const [key, path] of keys) {
    const s = after.sessions[key];
    const word = s ? sessionWord(s) : "forgotten";
    if (s?.error?.permanent) refused = true;
    else if (s?.error) unreachable = true;
    outcomes.push({ path, key, result: word, ...(s?.error ? { reason: s.error.message } : {}) });
  }
  const style = await styleFor(ctx, { json });
  emit(ctx, json, { sessions: outcomes, ...(signIn ? { sign_in: signIn } : {}) }, () => [
    ...(outcomes.length === 0 ? ["nothing to upload"] : []),
    ...outcomes.map((o) => {
      const role =
        o.result === "uploaded"
          ? "success"
          : o.result === "skipped"
            ? "warn"
            : o.result.startsWith("refused")
              ? "error"
              : "progress";
      return `${style.status(o.result, role)} ${printable(o.key ?? o.path)}${o.reason ? `: ${printable(o.reason)}` : ""}`;
    }),
    ...(signIn ? [`${style.status("sign in", "warn")}: ${printable(signIn)}`] : []),
  ]);
  if (signIn) return EXIT.auth;
  if (refused) return EXIT.failure;
  if (unreachable) return EXIT.unavailable;
  return EXIT.ok;
}
