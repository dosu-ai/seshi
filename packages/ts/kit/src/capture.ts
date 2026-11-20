import { join, posix, win32 } from "node:path";
export interface CaptureHost {
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  platform: NodeJS.Platform;
}

export interface HookCapture {
  session_id: string;
  /** The transcript file, when the payload names it. Some agents leave it out early in a
   * session (Cursor's first prompt); the uploader then finds it with `locate`. */
  transcript_path?: string;
  cwd?: string;
  parent_session_id?: string;
  final?: boolean;
  /** What the hook payload says of the harness's version and the session's model, for an agent
   * whose transcript says neither (Cursor's): kept for the session and sent with its uploads as
   * hints, which the server uses only when the log names none. */
  harness_version?: string;
  model?: string;
  /** The whole transcript, for an agent that keeps none in a file of its own (OpenCode keeps
   * its sessions in a database): seshi writes it to `<capture dir>/transcripts/<agent>/` only
   * when the session is captured, and uploads it from there. */
  transcript?: string;
  /** For an agent whose hook names only the session (OpenCode 2.x, whose plugin cannot read a
   * whole session): reads the transcript from where the agent keeps it, only once the session is
   * captured, and seshi keeps it as it would `transcript`. `changedMs`, when the session last
   * changed, dates seshi's copy, so a sweep can tell when the agent's store holds more. */
  read?: () => Promise<{ transcript: string; changedMs?: number }>;
}

export interface HookResult {
  captures: HookCapture[];
  exportEnv?: { file: string; vars: Record<string, string> };
  /** A session that just started: the hook tells the agent whether it is captured, and spools
   * nothing (Codex shows it as a notice). */
  announce?: HookCapture;
  /** The person asked, in their own prompt, to turn capture off or on for this session: the
   * hook does it, outside any sandbox the agent's commands run in. */
  request?: { action: "off" | "on"; session: HookCapture };
  /** The person just prompted this session: recorded as the folder's current conversation, for
   * an editor that cannot say which one it shows. */
  active?: HookCapture;
  /** Something to tell the person as it is, such as a `/session-capture` it could not read. */
  say?: string;
  /** What a tool returned, for an agent whose transcript leaves it out (Cursor writes each call,
   * never its result). Kept beside the session, only while the session is captured, and added to
   * what is uploaded by the agent's `compose`. Nothing is spooled and no uploader starts. */
  toolResult?: HookToolResult;
}

export interface HookToolResult {
  /** The session it belongs to, judged by the capture rules like any capture. */
  session: HookCapture;
  /** What `compose` reads back: JSON, already as small as it is to be kept. */
  entry: Record<string, unknown>;
}

/** For an agent whose transcript leaves out what its hooks saw (`HookResult.toolResult`): the
 * file seshi uploads in place of the transcript. It only ever grows, so what was uploaded of it
 * stays as it was, and it holds the transcript's lines as they are except where it adds to them;
 * the session's place in it is kept as in the transcript (`file_offset`). */
export interface TranscriptComposer {
  /** Bring the file up to date from the agent's `transcript` and what was kept, and return its
   * path. Called by the uploader, which holds its lock, before it reads the session. */
  update(sessionId: string, transcript: string, host: CaptureHost): string;
  /** The file, without writing it; undefined until `update` wrote it. */
  path(sessionId: string, host: CaptureHost): string | undefined;
  /** Whether `update` would change nothing (neither the transcript nor what was kept changed since
   * it last ran), cheaply: the uploader then skips a session it has sent all of. */
  current?(sessionId: string, transcript: string, host: CaptureHost): boolean;
}

export interface HookHandler {
  readonly event: string;
  parse(payload: unknown, host: CaptureHost): HookResult;
  /** What the hook prints to tell the person `message` (an `announce` or a `request`'s
   * result), in the shape this agent shows to the person. */
  reply?(message: string): unknown;
}

/** The command a person types inside an agent to turn Session Capture off or on, or ask about it:
 * `/session-capture` (`$session-capture` in Codex), and the skill's name. Generic, not seshi's
 * name, so any product can install the same hooks under it. */
export const CAPTURE_COMMAND = "session-capture";

/** What a prompt that is only `$session-capture` or `/session-capture`, with `off`, `on` or
 * `status` after it, asks for (bare: status); undefined for any other prompt. The old name,
 * `seshi`, is still read: until `seshi capture install` runs again, the skill it wrote under that
 * name tells the agent the hook has already done `$seshi off`. */
export function captureCommandPrompt(prompt: string): "off" | "on" | "status" | undefined {
  const match =
    /^\s*[$/](?:session-capture|seshi)(?:\s+(?:capture\s+)?(off|on|status))?\s*[.!]?\s*$/i.exec(
      prompt,
    );
  if (!match) return undefined;
  return (match[1]?.toLowerCase() as "off" | "on" | "status" | undefined) ?? "status";
}

export interface SweepPath {
  root: string;
  resolve?(host: CaptureHost): string;
  depths: readonly number[];
  match(relative: string): boolean;
}

export interface TranscriptInfo {
  session_id: string;
  /** Where the agent ran; unknown for agents whose transcript does not say (Cursor). */
  cwd?: string;
  started_at?: string;
  parent_session_id?: string;
}

/** A session an agent keeps where `sweep` finds no file of it (OpenCode's database). */
export interface StoredSession {
  info: TranscriptInfo;
  /** When it last changed, in milliseconds since the epoch. */
  updatedMs: number;
  /** The whole transcript, as the agent's hook hands it over (`HookCapture.transcript`). Read
   * only when it is needed: for a captured session whose copy is missing or older. Given seshi's
   * `copy`, it returns that copy as it is when it holds the same session, so nothing is sent
   * again for a difference that is not one (keys in another order, a newer time). */
  transcript(copy?: string): string;
}

export interface InstallReport {
  changed: string[];
  notes: string[];
}

export interface InstallStatus {
  installed: boolean;
  files: { path: string; present: boolean; ours: boolean }[];
  notes: string[];
}

export interface InstallContext extends CaptureHost {
  command: readonly string[];
}

export interface Installer {
  detect(host: CaptureHost): boolean;
  install(context: InstallContext): Promise<InstallReport>;
  uninstall(context: InstallContext): Promise<InstallReport>;
  status(context: InstallContext): Promise<InstallStatus>;
}

export interface CaptureAgent {
  readonly name: string;
  readonly format: string;
  readonly encoding: "jsonl" | "json";
  readonly chunkable: boolean;
  readonly hooks: readonly HookHandler[];
  readonly sweep: readonly SweepPath[];
  identify(path: string, head: string): TranscriptInfo | null;
  locate?(sessionId: string, host: CaptureHost): string | undefined;
  /** For an agent whose hook hands seshi the transcript whole (`HookCapture.transcript`): its
   * sessions that changed at or after `sinceMs`, read from where the agent keeps them, so a
   * sweep finds those no hook handed over (from before install, or a run without the plugin).
   * None when the agent keeps no store here; throws, saying why, on a store it cannot read. */
  stored?(host: CaptureHost, sinceMs: number): Promise<StoredSession[]>;
  accountIds?(host: CaptureHost): Record<string, string>;
  readonly installer?: Installer;
  /** For an agent whose hooks keep what its transcript leaves out: the file uploaded instead. */
  readonly compose?: TranscriptComposer;
}

/** seshi's own folder for capture state: `$XDG_STATE_HOME/seshi` (`~/.local/state/seshi`), or
 * `%LOCALAPPDATA%\\seshi` on Windows. */
export function captureDir(host: CaptureHost): string {
  if (host.platform === "win32") {
    const local = host.env.LOCALAPPDATA || win32.join(host.home, "AppData", "Local");
    return win32.join(local, "seshi");
  }
  const base = host.env.XDG_STATE_HOME || posix.join(host.home, ".local", "state");
  return posix.join(base, "seshi");
}

/** Where seshi keeps a transcript a hook handed it (`HookCapture.transcript`). */
export function handedTranscriptDir(host: CaptureHost, agent: string): string {
  const at = host.platform === "win32" ? win32.join : posix.join;
  return at(captureDir(host), "transcripts", agent);
}

/** The file seshi keeps a transcript it was handed whole in (`HookCapture.transcript`), or found
 * in the agent's own store (`CaptureAgent.stored`); undefined for an unusable session id. */
export function handedTranscriptPath(
  host: CaptureHost,
  agent: Pick<CaptureAgent, "name" | "encoding">,
  sessionId: string,
): string | undefined {
  if (!/^[\w.-]+$/.test(sessionId)) return undefined;
  const at = host.platform === "win32" ? win32.join : posix.join;
  const ext = agent.encoding === "json" ? "json" : "jsonl";
  return at(handedTranscriptDir(host, agent.name), `${sessionId}.${ext}`);
}

/** seshi's folder for what an agent's hooks kept of one session beside its transcript
 * (`HookResult.toolResult`) and the file `compose` builds from both: `<capture dir>/kept/<agent>/
 * <session>`. Undefined for an unusable session id. */
export function keptSessionDir(
  host: CaptureHost,
  agent: string,
  sessionId: string,
): string | undefined {
  if (!/^[\w.-]+$/.test(sessionId) || sessionId === "." || sessionId === "..") return undefined;
  const at = host.platform === "win32" ? win32.join : posix.join;
  return at(captureDir(host), "kept", agent, sessionId);
}

/** Where `keptSessionDir` keeps every session of an agent. */
export function keptAgentDir(host: CaptureHost, agent: string): string {
  const at = host.platform === "win32" ? win32.join : posix.join;
  return at(captureDir(host), "kept", agent);
}

export function expandTilde(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2));
  return path;
}

export function hookHandler(agent: CaptureAgent, event: string): HookHandler | undefined {
  return agent.hooks.find((h) => h.event === event);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function payloadObject(payload: unknown, agent: string): Record<string, unknown> {
  if (!isRecord(payload)) throw new Error(`${agent}: the hook payload is not a JSON object`);
  return payload;
}

export function stringField(object: Record<string, unknown>, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}
