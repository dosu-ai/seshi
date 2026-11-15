/** The command registry: every `seshi` command group (F8.1), by name, with the module that
 * runs it. A command's module is imported only when that command runs (X3.3), so `seshi hook`
 * and `seshi statusline` never evaluate the server, protobuf or search code
 * (`bun run check:hook` enforces it). Nothing here may import a command module at the top
 * level.
 *
 * Each command lives in its own file. Commands a later branch builds are stubs that exit 9
 * (`notImplemented`); that branch replaces the file and, if the summary changes, its line
 * here. Conventions every command follows: `--json` for one JSON document on stdout, and the
 * stable exit codes in `../cli/exit.ts`. */

import type { Integration } from "@seshi/kit";
import type { SecretBackend } from "../account/secrets";
import type { Terminal } from "../cli/terminal";

/** What a command gets from the router. */
export interface CommandContext {
  /** The arguments after the command name. */
  argv: string[];
  env: Record<string, string | undefined>;
  stdout(line: string): void;
  stderr(line: string): void;
  /** The integrations this binary was built with (the static registry), loaded on demand. */
  integrations(): Promise<readonly Integration[]>;
  /** All of standard input, for commands that read `-`; absent where there is none. */
  stdin?(): Promise<string>;
  /** Whether standard output and input are terminals: colour, glyphs and questions need them
   * (B1.4). Neither is, when absent. */
  tty?: { stdout: boolean; stdin: boolean };
  /** `--no-color` was on the command line; the router takes it out of `argv` (B1.4). */
  noColor?: boolean;
  /** The terminal, for questions, the background colour and opening a browser; absent when
   * standard input or output is not one. Loaded on demand. */
  terminal?(): Promise<Terminal>;
  /** Where credentials are kept (F8.2); the OS keychain with a file fallback when absent. */
  secrets?: SecretBackend;
  /** Start a program detached, not waited for (a hook starting the uploader, F9.1). `self`
   * puts the words that start this seshi in front of `words`. Tests record calls instead. */
  spawn?(words: string[], options?: { self?: boolean }): Promise<void>;
  /** Run a program and wait for it (a service manager's own command); a real process when
   * absent. Tests record calls instead. */
  exec?(words: string[]): Promise<{ code: number; output: string }>;
}

export interface CommandModule {
  /** Runs the command. The exit code, or `undefined` for a command that keeps the process
   * running (a server) and exits on its own. */
  run(ctx: CommandContext): Promise<number | undefined>;
}

export interface CommandSpec {
  /** One line for `seshi --help`. */
  summary: string;
  load(): Promise<CommandModule>;
}

export const COMMANDS: Readonly<Record<string, CommandSpec>> = {
  admin: {
    summary: "set up the server: the first admin token and the org key (admin init)",
    load: () => import("./admin"),
  },
  capture: {
    summary: "agent integrations on this machine: install|uninstall|status|pause|resume|off|on",
    load: () => import("./capture"),
  },
  config: {
    summary: "check the config, or show every value and where it came from",
    load: () => import("./config"),
  },
  daemon: {
    summary: "run the background uploader and sweep",
    load: () => import("./daemon"),
  },
  healthcheck: {
    summary: "ask a running server's /healthz whether it is up (container health checks)",
    load: () => import("./healthcheck"),
  },
  hook: {
    summary: "internal: called by agents on their events (hook <agent> <event>)",
    load: () => import("./hook"),
  },
  login: {
    summary: "sign in to a seshi server",
    load: () => import("./login"),
  },
  logout: {
    summary: "forget the stored credentials",
    load: () => import("./logout"),
  },
  normalize: {
    summary: "print a transcript as canonical, redacted records (any format this binary reads)",
    load: () => import("./normalize"),
  },
  redact: {
    summary: "try redaction rules on a file, or apply new rules to stored sessions (test|backfill)",
    load: () => import("./redact"),
  },
  reprocess: {
    summary: "rewind a source so its sessions are read and written again",
    load: () => import("./reprocess"),
  },
  review: {
    summary: "measure a model review policy against labelled fixtures (eval)",
    load: () => import("./review"),
  },
  search: {
    summary: "search the sessions you may read",
    load: () => import("./search"),
  },
  serve: {
    summary: "run the server: the HTTP API and the worker over one bucket",
    load: () => import("./serve"),
  },
  sessions: {
    summary: "list, show, export and delete sessions (ls|show|export|rm)",
    load: () => import("./sessions"),
  },
  statusline: {
    summary: "one short line for an agent's status bar",
    load: () => import("./statusline"),
  },
  sync: {
    summary:
      "poll a source once, and see checkpoints, failures and drops (run|status|failed|dropped)",
    load: () => import("./sync"),
  },
  tokens: {
    summary: "manage seshi tokens",
    load: () => import("./tokens"),
  },
  upload: {
    summary: "send transcripts or folders of them by hand",
    load: () => import("./upload"),
  },
  whoami: {
    summary: "who the CLI is signed in as, and to which server",
    load: () => import("./whoami"),
  },
  workers: {
    summary: "the worker, its jobs and their last runs (status)",
    load: () => import("./workers"),
  },
};
