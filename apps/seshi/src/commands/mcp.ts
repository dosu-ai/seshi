/** `seshi mcp`: a stdio MCP server whose tools (`list_sessions`, `read_session`, `search`) read
 * sessions with this machine's seshi login, or a token. Nothing but protocol messages goes to
 * stdout; everything else goes to stderr. docs/seshi/session-tools.md ("seshi mcp"). */
import { parseArgs } from "node:util";
import { HttpSeshi } from "@seshi/client";
import { VERSION } from "@seshi/model";
import { type Account, openAccount } from "../account/account";
import { normalizeServer } from "../account/logins";
import { type Backend, openBackend, ServerBackend } from "../backend";
import { EXIT } from "../cli/exit";
import { helpOrUsageError } from "../cli/output";
import { TOOL_NAMES, type ToolName, Tools } from "../mcp/tools";
import { isServerless } from "../serverless/settings";
import { USER_AGENT } from "../user-agent";
import type { CommandContext } from "./index";

const USAGE = `usage: seshi mcp [--server <url>] [--token <token> [--user <name>]] [--tools ${TOOL_NAMES.join(",")}]
                 [--include-private]   serverless mode: owner-only sessions too
  An MCP server on stdin and stdout for coding agents, with this machine's seshi login
  (or --token, or SESHI_TOKEN). For example: claude mcp add seshi -- seshi mcp`;

const OPTIONS = {
  server: { type: "string" },
  token: { type: "string" },
  user: { type: "string" },
  tools: { type: "string" },
  "include-private": { type: "boolean" },
} as const;

const INSTRUCTIONS = [
  "seshi holds your team's coding-agent sessions (Claude Code, Codex, Cursor and others): what was asked, what the agent did, which tools it ran and what they printed.",
  "list_sessions lists sessions by who, repo, branch and time (newest first); search finds the sessions whose prompts, answers or tool calls mention something; read_session reads part of one session.",
  "Every answer starts with the current UTC time and whose sessions you see. Search matches read `#event@trace`: pass trace and around to read_session to read around one.",
].join(" ");

/** Where the tools' backend comes from: made once, or (with the login) afresh for each call, so
 * a session token that ran out is renewed as the CLI renews it. A failure is the call's answer,
 * not the command's: the server starts whatever the backend's state. */
export function backendSource(ctx: CommandContext, values: Values): () => Promise<Backend> {
  const token = values.token ?? ctx.env.SESHI_TOKEN;
  let account: Account | undefined;
  const opened = () => {
    account ??= openAccount(ctx);
    return account;
  };
  if (token !== undefined && token !== "") {
    let backend: Backend | undefined;
    return async () => {
      if (backend) return backend;
      const server = values.server ?? opened().cli.server;
      if (server === undefined) {
        throw new Error("--token needs a server: pass --server <url>, or run seshi login first");
      }
      const user = values.user ?? opened().cli.user;
      backend = new ServerBackend(
        new HttpSeshi({
          server: normalizeServer(server),
          token,
          userAgent: USER_AGENT,
          ...(user !== undefined ? { user } : {}),
        }),
        user,
      );
      return backend;
    };
  }
  let serverless: Promise<Backend> | undefined;
  return async () => {
    const account = opened();
    if (values.server === undefined && isServerless(account.cli)) {
      // Opening the bucket reads its marker and the index: once, retried after a failure.
      if (serverless === undefined) {
        const opening = openBackend(ctx, account, {
          includePrivate: values["include-private"] === true,
        });
        opening.catch(() => {
          if (serverless === opening) serverless = undefined;
        });
        serverless = opening;
      }
      return serverless;
    }
    return openBackend(ctx, account, {
      ...(values.server !== undefined ? { server: values.server } : {}),
      purpose: "mcp",
    });
  };
}

interface Values {
  server?: string;
  token?: string;
  user?: string;
  tools?: string;
  "include-private"?: boolean;
}

function toolsOf(given: string | undefined): ToolName[] {
  if (given === undefined) return [...TOOL_NAMES];
  const names = given
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
  for (const name of names) {
    if (!(TOOL_NAMES as readonly string[]).includes(name)) {
      throw new Error(`--tools: no tool ${name}; there are ${TOOL_NAMES.join(", ")}`);
    }
  }
  return names as ToolName[];
}

export async function run(ctx: CommandContext): Promise<number> {
  let values: Values;
  let enabled: ToolName[];
  try {
    ({ values } = parseArgs({ args: ctx.argv, options: OPTIONS, strict: true }));
    enabled = toolsOf(values.tools);
  } catch (err) {
    return helpOrUsageError(ctx, false, (err as Error).message, USAGE);
  }
  // Only protocol messages on stdout: anything a library logs goes to stderr instead.
  for (const method of ["log", "info", "debug"] as const) {
    console[method] = (...args: unknown[]) => console.error(...args);
  }
  // A warning (a stale login, the device token in use) is said once, not on every call.
  const said = new Set<string>();
  const quiet: CommandContext = {
    ...ctx,
    stdout: (line) => ctx.stderr(line),
    stderr: (line) => {
      if (said.has(line)) return;
      said.add(line);
      ctx.stderr(line);
    },
  };
  const tools = new Tools(
    { backend: backendSource(quiet, values), now: () => new Date() },
    enabled,
  );

  // The low-level `Server`, not `McpServer`: the tools' input schemas are the design's JSON
  // Schema as written, which `McpServer` would want as zod.
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import(
    "@modelcontextprotocol/sdk/types.js"
  );
  const server = new Server(
    { name: "seshi", title: "seshi sessions", version: VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.list() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    tools.call(request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>),
  );
  const closed = new Promise<void>((resolve) => {
    server.onclose = () => resolve();
  });
  await server.connect(new StdioServerTransport());
  // The client closing stdin ends the session.
  process.stdin.once("end", () => void server.close());
  await closed;
  return EXIT.ok;
}
