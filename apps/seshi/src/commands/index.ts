import type { Integration } from "@seshi/kit";
import type { SecretBackend } from "../account/secrets";
import type { Terminal } from "../cli/terminal";

export interface CommandContext {
  argv: string[];
  env: Record<string, string | undefined>;
  stdout(line: string): void;
  stderr(line: string): void;
  integrations(): Promise<readonly Integration[]>;
  stdin?(): Promise<string>;
  tty?: { stdout: boolean; stdin: boolean };
  noColor?: boolean;
  terminal?(): Promise<Terminal>;
  secrets?: SecretBackend;
  spawn?(words: string[], options?: { self?: boolean }): Promise<void>;
  exec?(words: string[]): Promise<{ code: number; output: string }>;
}

export interface CommandModule {
  run(ctx: CommandContext): Promise<number | undefined>;
}

export interface CommandSpec {
  summary: string;
  load(): Promise<CommandModule>;
  /** Left out of `seshi --help`: a command seshi runs itself. */
  hidden?: boolean;
}

export const COMMANDS: Readonly<Record<string, CommandSpec>> = {
  admin: {
    summary:
      "set up the server (admin init) or the bucket (admin mode|layout|config): tokens, the org key, mode, minimum version, shared settings",
    load: () => import("./admin"),
  },
  capture: {
    summary:
      "agent integrations on this machine: install|uninstall|status|pause|resume|off|on|resend",
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
  doctor: {
    summary:
      "check that sessions are captured right: transcript, capture state and what was stored",
    load: () => import("./doctor"),
  },
  explore: {
    summary:
      "a local, read-only web page to explore and debug captured sessions (the doctor's views)",
    load: () => import("./explore"),
  },
  healthcheck: {
    summary: "ask a running server's /healthz whether it is up (container health checks)",
    load: () => import("./healthcheck"),
  },
  hook: {
    summary: "internal: called by agents on their events (hook <agent> <event>)",
    load: () => import("./hook"),
  },
  init: {
    summary: "set this machine up to write a shared bucket directly, with no server (--serverless)",
    load: () => import("./init"),
  },
  login: {
    summary: "sign in to a seshi server",
    load: () => import("./login"),
  },
  logout: {
    summary: "forget the stored credentials",
    load: () => import("./logout"),
  },
  mcp: {
    summary:
      "an MCP server for coding agents: list, search and read the sessions you may read (stdio)",
    load: () => import("./mcp"),
  },
  normalize: {
    summary: "print a transcript as canonical, redacted records (any format this binary reads)",
    load: () => import("./normalize"),
  },
  redact: {
    summary:
      "try redaction rules on a file, or apply new rules to stored sessions (test|backfill|sweep)",
    load: () => import("./redact"),
  },
  reprocess: {
    summary:
      "rewind a polled source so its sessions are read and written again (uploads: capture resend)",
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
    summary:
      "list, show, export and delete sessions, set who sees them (ls|show|export|rm|visibility)",
    load: () => import("./sessions"),
  },
  share: {
    summary:
      "share a session with the org: this agent's session, or the one named (unshare takes it back)",
    load: () => import("./share").then((m) => ({ run: (ctx) => m.run(ctx, "share") })),
  },
  sql: {
    summary: "one read-only SELECT over sessions, events and llm_calls (sql --schema)",
    load: () => import("./sql"),
  },
  "sql-worker": {
    summary: "internal: a sql worker process, started by the server or seshi sql",
    load: () => import("./sql-worker"),
    hidden: true,
  },
  statusline: {
    summary: "one short line for an agent's status bar",
    load: () => import("./statusline"),
  },
  store: {
    summary:
      "check a bucket against the layout's invariants, read-only (check: metadata, traces, the change feed, spans)",
    load: () => import("./store"),
  },
  sync: {
    summary:
      "poll a source, assemble spans or prune records once, and see checkpoints, failures and drops (run|assemble|prune|status|failed|dropped)",
    load: () => import("./sync"),
  },
  tokens: {
    summary: "manage seshi tokens",
    load: () => import("./tokens"),
  },
  unshare: {
    summary: "make a shared session its owner's alone again (the reverse of share)",
    load: () => import("./share").then((m) => ({ run: (ctx) => m.run(ctx, "unshare") })),
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
