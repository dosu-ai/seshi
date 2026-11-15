/** The capture contract (F9): what an agent integration tells `@seshi/capture` so that sessions
 * are captured as they happen. One `CaptureAgent` per agent says how to read its hook payloads,
 * where its transcripts live for the sweep, how to tell which session a transcript is, and how
 * to wire seshi into the agent on a machine (its installer).
 *
 * Everything here is data and small functions over the file system: an agent's capture module
 * must load fast, because `seshi hook` loads it on every agent turn (X3.3). It may not import
 * the agent's format adapter or anything else heavy; the integration's index lists the same
 * object as its `capture`, and `apps/seshi` loads the capture module alone for the hook. */

/** The environment and machine a capture function runs on. Nothing reads `process.env` or the
 * real home folder directly, so tests point them at temporary folders. */
export interface CaptureHost {
  env: Readonly<Record<string, string | undefined>>;
  /** The user's home folder. */
  home: string;
  platform: NodeJS.Platform;
}

/** One session a hook says to capture (F9.1): which session, where its transcript is, where the
 * agent ran. The hook spools it; the uploader reads the transcript later. */
export interface HookCapture {
  /** The agent's own id for the session. */
  session_id: string;
  /** The transcript file, when the payload names it. Some agents leave it out early in a
   * session (Cursor's first prompt); the uploader then finds it with `locate`. */
  transcript_path?: string;
  /** The folder the agent ran in: what the capture rules (F9.5) are judged against. */
  cwd?: string;
  /** The session this one ran inside (a subagent's parent). */
  parent_session_id?: string;
  /** The session ended: no more is coming, upload what there is now. */
  final?: boolean;
}

/** What a hook handler makes of one payload. */
export interface HookResult {
  /** Sessions to capture; empty when the event carries nothing to upload. */
  captures: HookCapture[];
  /** Variables to keep in the agent's environment for the commands it runs later (Claude
   * Code's `CLAUDE_ENV_FILE`, written by its SessionStart hook): how `seshi capture off
   * --session` learns the current session (F9.5). Appended to `file` as `export K=V` lines. */
  exportEnv?: { file: string; vars: Record<string, string> };
}

/** Handles one kind of hook event of one agent (F9.2): turns the JSON the agent sends into the
 * sessions to capture. Pure, apart from what `host` says; it never touches the network or the
 * transcript itself. Throws on a payload it cannot read. */
export interface HookHandler {
  /** The event, in the agent's own naming (`Stop`, `sessionEnd`, `notify`). */
  readonly event: string;
  parse(payload: unknown, host: CaptureHost): HookResult;
}

/** A folder the sweep looks through for transcripts (F9.3). */
export interface SweepPath {
  /** The folder; `~` is the home folder. An environment variable that moves the agent's folder
   * is applied by `resolve`. */
  root: string;
  /** Where the folder really is on this machine (the agent's own env variables applied). */
  resolve?(host: CaptureHost): string;
  /** How deep below `root` transcripts sit: 1 for `root/<file>`, 2 for `root/<dir>/<file>`. A
   * file is looked for at exactly these depths. */
  depths: readonly number[];
  /** Whether a file at that place is a transcript, by its path relative to `root` (with `/`). */
  match(relative: string): boolean;
}

/** What a transcript says about itself, from its first lines. */
export interface TranscriptInfo {
  session_id: string;
  /** Where the agent ran; unknown for agents whose transcript does not say (Cursor). */
  cwd?: string;
  /** When the session started (its first record), ISO 8601. */
  started_at?: string;
  parent_session_id?: string;
}

/** What an installer did, said in a line each. */
export interface InstallReport {
  /** The files it wrote or changed. */
  changed: string[];
  /** Things the person should know (a status line left as it was, a hook kept). */
  notes: string[];
}

/** Whether seshi is wired into an agent on this machine. */
export interface InstallStatus {
  installed: boolean;
  /** The agent's own config files seshi edits, and whether each holds seshi's entries. */
  files: { path: string; present: boolean; ours: boolean }[];
  notes: string[];
}

/** Where an installer runs. */
export interface InstallContext extends CaptureHost {
  /** The command that starts seshi, as words (`["seshi"]`, or the binary's absolute path):
   * hooks run `<command> hook <agent> <event>`. */
  command: readonly string[];
}

/** Wires seshi into one agent on one machine (F9.6): merges its hooks into the agent's config,
 * keeping every hook already there, and takes out only its own on uninstall. */
export interface Installer {
  /** Whether the agent seems to be used on this machine (its config folder exists). */
  detect(host: CaptureHost): boolean;
  install(context: InstallContext): Promise<InstallReport>;
  uninstall(context: InstallContext): Promise<InstallReport>;
  status(context: InstallContext): Promise<InstallStatus>;
}

/** Everything capture needs to know about one agent. */
export interface CaptureAgent {
  /** The agent's name in `seshi hook <agent>` and in the state file: the integration's name. */
  readonly name: string;
  /** The transcript format uploads are sent as (`claude-code`): one the server's format
   * registry knows. */
  readonly format: string;
  /** `jsonl` (a log that grows by lines) or `json` (one document rewritten whole). */
  readonly encoding: "jsonl" | "json";
  /** Whether a log can be sent in chunks once the session has a trace (X4.2). A format that
   * cannot is always sent whole. */
  readonly chunkable: boolean;
  readonly hooks: readonly HookHandler[];
  readonly sweep: readonly SweepPath[];
  /** Which session a transcript is, from its first bytes (`head`, at most 64 KiB) and its path;
   * null for a file that is not one of this agent's sessions. */
  identify(path: string, head: string): TranscriptInfo | null;
  /** The transcript of `sessionId` on this machine, when a hook did not name it. */
  locate?(sessionId: string, host: CaptureHost): string | undefined;
  /** The agent's account ids on this machine by vendor (`{anthropic: <id>}`), sent as claims
   * so mismatches can be spotted (F9 Access). Never a token. */
  accountIds?(host: CaptureHost): Record<string, string>;
  readonly installer?: Installer;
}

/** `~` and `~/…` (or `~\…`) as the home folder. */
export function expandTilde(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) return `${home}${path.slice(1)}`;
  return path;
}

/** The handler for `event`, if the agent has one. Event names match case-sensitively, as the
 * agents send them. */
export function hookHandler(agent: CaptureAgent, event: string): HookHandler | undefined {
  return agent.hooks.find((h) => h.event === event);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `payload` as an object, or a thrown error naming what was expected. */
export function payloadObject(payload: unknown, agent: string): Record<string, unknown> {
  if (!isRecord(payload)) throw new Error(`${agent}: the hook payload is not a JSON object`);
  return payload;
}

/** A non-empty string field of a payload, or undefined. */
export function stringField(object: Record<string, unknown>, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}
