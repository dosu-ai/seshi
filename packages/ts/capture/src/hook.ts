import { randomBytes } from "node:crypto";
import { appendFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import {
  type CaptureAgent,
  type CaptureHost,
  type HookCapture,
  handedTranscriptPath,
  hookHandler,
  keptSessionDir,
} from "@seshi/kit";
import { writeRecent } from "./current";
import { writePrivateFile } from "./files";
import { resolveLabels } from "./labels";
import type { CapturePaths } from "./paths";
import { placeOf } from "./place";
import { type Decision, decide, type Place, turnedOff } from "./rules";
import { captureRules } from "./rules-cache";
import { appendSpool } from "./spool";
import { otherFolders, readState, type SessionState, sessionKey, stateFacts } from "./state";

export interface HookRun {
  agent: CaptureAgent;
  event: string;
  payload: unknown;
  host: CaptureHost;
  paths: CapturePaths;
  now?: Date;
}

export interface HookOutcome {
  spooled: HookCapture[];
  skipped: { session_id: string; decision: Decision }[];
  envFileWritten?: string;
  ignored?: string;
  /** For a session the hook announced: whether it is captured, and why. */
  announced?: { session_id: string; decision: Decision };
  /** What the person asked the hook to do for their session (the command carries it out). */
  requested?: { action: "off" | "on"; session: HookCapture };
  /** What the handler asked to tell the person. */
  said?: string;
  /** Why a captured session's transcript could not be read (it is spooled all the same, and a
   * sweep finds it where the agent keeps it). */
  problems?: string[];
  /** Where a tool's result was kept, for a captured session (`HookResult.toolResult`). */
  kept?: string;
}

/** A value as one shell word: single-quoted, with any single quote in it closed and escaped. */
export function shellWord(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Run one hook. Throws on a payload the handler cannot read or a state file that cannot be
 * read (the command logs it and still exits 0). */
export async function runHook(run: HookRun): Promise<HookOutcome> {
  const handler = hookHandler(run.agent, run.event);
  if (!handler) {
    return { spooled: [], skipped: [], ignored: `${run.agent.name} has no '${run.event}' hook` };
  }
  const result = handler.parse(run.payload, run.host);
  const outcome: HookOutcome = { spooled: [], skipped: [] };
  if (result.exportEnv) {
    const lines = Object.entries(result.exportEnv.vars)
      .map(([name, value]) => `export ${name}=${shellWord(value)}\n`)
      .join("");
    appendFileSync(result.exportEnv.file, lines);
    outcome.envFileWritten = result.exportEnv.file;
  }
  if (result.active?.cwd) {
    writeRecent(run.paths, {
      agent: run.agent.name,
      session_id: result.active.session_id,
      cwd: result.active.cwd,
      at: (run.now ?? new Date()).toISOString(),
    });
  }
  if (result.request) outcome.requested = result.request;
  if (result.say) outcome.said = result.say;
  if (result.captures.length === 0 && !result.announce && !result.toolResult) return outcome;

  const now = run.now ?? new Date();
  const [{ rules, error, labels }, state] = [
    await captureRules(run.host, run.paths),
    readState(run.paths),
  ];
  const judge = (capture: HookCapture) => {
    const known = state.sessions[sessionKey(run.agent.name, capture.session_id)];
    const cwd = capture.cwd ?? known?.cwd;
    const place = placeOf(cwd);
    const decision = decide(
      {
        rules,
        ...(error !== undefined ? { rulesError: error } : {}),
        place,
        ...stateFacts(state, run.agent.name, known, now, capture.parent_session_id),
        seen: otherFolders(state, run.agent.name, known, cwd, capture.parent_session_id).map(
          placeOf,
        ),
      },
      run.host.platform,
    );
    return { known, decision, place };
  };
  // Labels are resolved here, in the agent's environment (the uploader runs in its own), when
  // the session is first seen, and kept in its state: every later upload sends the same ones.
  const labelsOf = (known: SessionState | undefined, place: Place) => {
    if (known?.labels !== undefined) return undefined;
    const resolved = resolveLabels(labels, place, run.host.env, run.host.platform);
    if (resolved.problems.length > 0) {
      outcome.problems = [
        ...(outcome.problems ?? []),
        ...resolved.problems.map((p) => `labels: left out ${p}`),
      ];
    }
    return resolved.labels;
  };
  if (result.announce) {
    outcome.announced = {
      session_id: result.announce.session_id,
      decision: judge(result.announce).decision,
    };
  }
  for (const capture of result.captures) {
    const { known, decision, place } = judge(capture);
    if (!decision.capture) {
      if (capture.transcript !== undefined || capture.read)
        forgetHandedTranscript(run.host, run.agent, capture.session_id);
      outcome.skipped.push({ session_id: capture.session_id, decision });
      if (respoolPausedSession(run, capture, known, decision, now)) continue;
      if ((decision.level === "org" || decision.level === "repo") && capture.cwd) {
        appendSpool(
          run.paths,
          {
            v: 1,
            kind: "seen",
            at: now.toISOString(),
            agent: run.agent.name,
            session_id: capture.session_id,
            cwd: capture.cwd,
            ...(capture.transcript_path ? { transcript_path: capture.transcript_path } : {}),
            ...(capture.parent_session_id ? { parent_session_id: capture.parent_session_id } : {}),
          },
          now,
        );
      }
      continue;
    }
    const path =
      capture.transcript === undefined && !capture.read
        ? capture.transcript_path
        : await keep(run, capture, outcome);
    const sessionLabels = labelsOf(known, place);
    appendSpool(
      run.paths,
      {
        v: 1,
        kind: "capture",
        at: now.toISOString(),
        agent: run.agent.name,
        event: run.event,
        session_id: capture.session_id,
        ...(path ? { transcript_path: path } : {}),
        ...(capture.cwd ? { cwd: capture.cwd } : {}),
        ...(capture.parent_session_id ? { parent_session_id: capture.parent_session_id } : {}),
        ...(capture.final ? { final: true } : {}),
        ...(sessionLabels ? { labels: sessionLabels } : {}),
      },
      now,
    );
    const { transcript: _, read: _read, ...spooled } = capture;
    outcome.spooled.push(path ? { ...spooled, transcript_path: path } : spooled);
  }
  if (result.toolResult) {
    // Judged like the session's own captures: a session turned off or paused, or in a folder the
    // rules exclude, keeps nothing of what its tools return.
    const { session, entry } = result.toolResult;
    const { decision } = judge(session);
    if (decision.capture) outcome.kept = keepToolResult(run, session.session_id, entry, now);
    else {
      outcome.skipped.push({ session_id: session.session_id, decision });
      // Turned off by a rule since (a folder, the repo): what was kept of it goes too.
      if (turnedOff(decision)) forgetHandedTranscript(run.host, run.agent, session.session_id);
    }
  }
  return outcome;
}

/** One tool result, as a file of its own beside the session (parallel tools finish at once),
 * readable only by this user; named so that a listing sorts them in the order they came, to the
 * microsecond (each hook is a process of its own, and two can finish in one millisecond). */
function keepToolResult(
  run: HookRun,
  sessionId: string,
  entry: Record<string, unknown>,
  now: Date,
): string {
  const dir = keptSessionDir(run.host, run.agent.name, sessionId);
  if (!dir) throw new Error(`${run.agent.name}: unusable session id '${sessionId}'`);
  const micros = Math.floor((performance.timeOrigin + performance.now()) * 1000);
  const name = `${micros.toString().padStart(17, "0")}-${randomBytes(6).toString("hex")}.json`;
  const path = join(dir, "results", name);
  writePrivateFile(path, JSON.stringify({ ...entry, at: now.toISOString() }));
  return path;
}

/** A transcript the hook was handed whole, or read once the session is captured, written where
 * the uploader reads it, readable only by this user. Only a captured session's is written: one
 * turned off never reaches the disk. A transcript that cannot be read now (the agent's store
 * busy, or the session not in it yet) is left to the uploader, which finds it there (`locate`,
 * the sweep): the session is spooled all the same, and the problem said. */
async function keep(
  run: HookRun,
  capture: HookCapture,
  outcome: HookOutcome,
): Promise<string | undefined> {
  const path = handedTranscriptPath(run.host, run.agent, capture.session_id);
  if (!path) throw new Error(`${run.agent.name}: unusable session id '${capture.session_id}'`);
  if (capture.transcript !== undefined) {
    writePrivateFile(path, capture.transcript);
    return path;
  }
  let read: Awaited<ReturnType<NonNullable<HookCapture["read"]>>>;
  try {
    read = await (capture.read as NonNullable<HookCapture["read"]>)();
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    outcome.problems = [
      ...(outcome.problems ?? []),
      `${run.agent.name}: could not read session ${capture.session_id} yet: ${why}`,
    ];
    return undefined;
  }
  writePrivateFile(path, read.transcript);
  if (read.changedMs !== undefined) {
    const changed = new Date(read.changedMs);
    utimesSync(path, changed, changed);
  }
  return path;
}

/** Remove seshi's copy of a session it was handed whole, and whatever its hooks kept beside it
 * (tool results, and the file built from them): a session turned off keeps none. */
export function forgetHandedTranscript(
  host: CaptureHost,
  agent: Pick<CaptureAgent, "name" | "encoding">,
  sessionId: string,
): void {
  const path = handedTranscriptPath(host, agent, sessionId);
  if (path) rmSync(path, { force: true });
  const kept = keptSessionDir(host, agent.name, sessionId);
  if (kept) rmSync(kept, { recursive: true, force: true });
}

function respoolPausedSession(
  run: HookRun,
  capture: HookCapture,
  known: SessionState | undefined,
  decision: Decision,
  now: Date,
): boolean {
  if (decision.frozen === undefined) return false;
  const pausedTranscriptMoved =
    known?.frozen !== undefined &&
    known.path !== undefined &&
    capture.transcript_path !== undefined &&
    capture.transcript_path !== known.path;
  if (known?.frozen !== undefined && !pausedTranscriptMoved) return false;
  appendSpool(
    run.paths,
    {
      v: 1,
      kind: "paused",
      at: now.toISOString(),
      agent: run.agent.name,
      session_id: capture.session_id,
      ...(capture.cwd ? { cwd: capture.cwd } : {}),
      ...(capture.transcript_path ? { transcript_path: capture.transcript_path } : {}),
      ...(capture.parent_session_id ? { parent_session_id: capture.parent_session_id } : {}),
    },
    now,
  );
  return true;
}
