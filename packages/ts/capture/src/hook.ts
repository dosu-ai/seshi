import { appendFileSync } from "node:fs";
import { type CaptureAgent, type CaptureHost, type HookCapture, hookHandler } from "@seshi/kit";
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
  if (result.captures.length === 0) return outcome;

  const now = run.now ?? new Date();
  const [{ rules, error }, state] = [await captureRules(run.host, run.paths), readState(run.paths)];
  for (const capture of result.captures) {
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
    if (!decision.capture) {
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
    appendSpool(
      run.paths,
      {
        v: 1,
        kind: "capture",
        at: now.toISOString(),
        agent: run.agent.name,
        event: run.event,
        session_id: capture.session_id,
        ...(capture.transcript_path ? { transcript_path: capture.transcript_path } : {}),
        ...(capture.cwd ? { cwd: capture.cwd } : {}),
        ...(capture.parent_session_id ? { parent_session_id: capture.parent_session_id } : {}),
        ...(capture.final ? { final: true } : {}),
      },
      now,
    );
    outcome.spooled.push(capture);
  }
  return outcome;
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
