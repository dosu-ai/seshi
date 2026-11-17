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
  /** The whole transcript, for an agent that keeps none in a file of its own (OpenCode keeps
   * its sessions in a database): seshi writes it to `<capture dir>/transcripts/<agent>/` only
   * when the session is captured, and uploads it from there. */
  transcript?: string;
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
  /** Something to tell the person as it is, such as a `/seshi` it could not read. */
  say?: string;
}

export interface HookHandler {
  readonly event: string;
  parse(payload: unknown, host: CaptureHost): HookResult;
  /** What the hook prints to tell the person `message` (an `announce` or a `request`'s
   * result), in the shape this agent shows to the person. */
  reply?(message: string): unknown;
}

/** What a prompt that is only `$seshi` or `/seshi`, with `off`, `on` or `status` after it,
 * asks for (bare: status); undefined for any other prompt. */
export function seshiPrompt(prompt: string): "off" | "on" | "status" | undefined {
  const match = /^\s*[$/]seshi(?:\s+(?:capture\s+)?(off|on|status))?\s*[.!]?\s*$/i.exec(prompt);
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
  accountIds?(host: CaptureHost): Record<string, string>;
  readonly installer?: Installer;
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
