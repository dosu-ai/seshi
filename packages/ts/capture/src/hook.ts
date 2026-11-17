import { appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type CaptureAgent,
  type CaptureHost,
  type HookCapture,
  handedTranscriptDir,
  hookHandler,
} from "@seshi/kit";
import { writeRecent } from "./current";
import { writePrivateFile } from "./files";
import type { CapturePaths } from "./paths";
import { placeOf } from "./place";
import { type Decision, decide } from "./rules";
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
  if (result.captures.length === 0 && !result.announce) return outcome;

  const now = run.now ?? new Date();
  const [{ rules, error }, state] = [await captureRules(run.host, run.paths), readState(run.paths)];
  const judge = (capture: HookCapture) => {
    const known = state.sessions[sessionKey(run.agent.name, capture.session_id)];
    const cwd = capture.cwd ?? known?.cwd;
    const decision = decide(
      {
        rules,
        ...(error !== undefined ? { rulesError: error } : {}),
        place: placeOf(cwd),
        ...stateFacts(state, run.agent.name, known, now, capture.parent_session_id),
        seen: otherFolders(state, run.agent.name, known, cwd, capture.parent_session_id).map(
          placeOf,
        ),
      },
      run.host.platform,
    );
    return { known, decision };
  };
  if (result.announce) {
    outcome.announced = {
      session_id: result.announce.session_id,
      decision: judge(result.announce).decision,
    };
  }
  for (const capture of result.captures) {
    const { known, decision } = judge(capture);
    if (!decision.capture) {
      if (capture.transcript !== undefined)
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
    const path = capture.transcript === undefined ? capture.transcript_path : keep(run, capture);
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
      },
      now,
    );
    const { transcript: _, ...spooled } = capture;
    outcome.spooled.push(path ? { ...spooled, transcript_path: path } : spooled);
  }
  return outcome;
}

/** Where a transcript the hook was handed whole is kept; undefined for an unusable session id. */
function handedTranscriptPath(
  host: CaptureHost,
  agent: Pick<CaptureAgent, "name" | "encoding">,
  sessionId: string,
): string | undefined {
  if (!/^[\w.-]+$/.test(sessionId)) return undefined;
  const ext = agent.encoding === "json" ? "json" : "jsonl";
  return join(handedTranscriptDir(host, agent.name), `${sessionId}.${ext}`);
}

/** A transcript the hook was handed whole, written where the uploader reads it, readable only by
 * this user. Only a captured session's is written: one turned off never reaches the disk. */
function keep(run: HookRun, capture: HookCapture): string {
  const path = handedTranscriptPath(run.host, run.agent, capture.session_id);
  if (!path) throw new Error(`${run.agent.name}: unusable session id '${capture.session_id}'`);
  writePrivateFile(path, capture.transcript as string);
  return path;
}

/** Remove seshi's copy of a session it was handed whole (a session turned off keeps none). */
export function forgetHandedTranscript(
  host: CaptureHost,
  agent: Pick<CaptureAgent, "name" | "encoding">,
  sessionId: string,
): void {
  const path = handedTranscriptPath(host, agent, sessionId);
  if (path) rmSync(path, { force: true });
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
