/** `seshi mcp` with a real agent (docs/seshi/session-tools.md, "Testing it end to end", 3): an
 * isolated `seshi serve` on a folder store holds four Claude Code sessions with known answers,
 * and Claude Code in headless mode (`claude -p`, `--mcp-config` naming `seshi mcp`, only the
 * seshi tools allowed) is given four tasks over them. Each check reads the agent's transcript for
 * the tools it called and its answer.
 *
 * It needs Claude Code on PATH and a model (ANTHROPIC_API_KEY, or a signed-in Claude Code), so it
 * runs nightly and by hand, not on pull requests: `bun run test:agent`. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HttpSeshi } from "@seshi/client";
import { loadServerConfig } from "@seshi/config";
import { buildInstance } from "@seshi/instance";
import { buildFormats } from "seshi/integrations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const ENABLED = process.env.VERIFY_SESHI_AGENT === "1";
const MODEL = process.env.VERIFY_SESHI_AGENT_MODEL ?? "sonnet";

const DAY = 86_400_000;
/** Noon UTC yesterday: "yesterday" whatever the hour the test runs. */
const YESTERDAY = Math.floor(Date.now() / DAY) * DAY - DAY / 2;

interface Turn {
  prompt: string;
  model: string;
  input: number;
  output: number;
  /** Tool calls the answer makes, each with its result and whether it failed. */
  tools: { name: string; input: Record<string, unknown>; result: string; error?: boolean }[];
  answer: string;
}

interface Fixture {
  user: string;
  id: string;
  repo: string;
  at: number;
  turns: Turn[];
}

/** The sessions, and from them the answers the tasks expect. */
const SESSIONS: Fixture[] = [
  {
    user: "alice",
    id: "rate-limit",
    repo: "github.com/acme/app",
    at: YESTERDAY,
    turns: [
      {
        prompt: "Add a rate limiter to the login endpoint: five attempts a minute per IP.",
        model: "claude-opus-5-5",
        input: 12_000,
        output: 2_000,
        tools: [
          {
            name: "Edit",
            input: { file_path: "/repo/app/src/login.ts" },
            result: "edited login.ts: added a token-bucket rate limiter",
          },
          {
            name: "Bash",
            input: { command: "bun test src/login.test.ts" },
            result: "4 pass, 0 fail",
          },
        ],
        answer: "The login endpoint now allows five attempts a minute per IP.",
      },
    ],
  },
  {
    user: "alice",
    id: "flaky-scrub",
    repo: "github.com/acme/app",
    at: YESTERDAY - 3 * DAY,
    turns: [
      {
        prompt: "The search tests fail on CI. Find out why.",
        model: "claude-sonnet-5-5",
        input: 30_000,
        output: 3_000,
        tools: [
          {
            name: "Bash",
            input: { command: "bun test packages/ts/search --bail" },
            result:
              "FAIL src/lance.test.ts > scrub keeps deleted rows\nexpected 0 rows, got 3 (the compaction ran before the scrub)",
            error: true,
          },
          {
            name: "Read",
            input: { file_path: "/repo/app/packages/ts/search/src/lance.ts" },
            result: "export async function scrub(table) { … }",
          },
        ],
        answer: "The scrub runs after compaction; it must run before.",
      },
    ],
  },
  {
    user: "bob",
    id: "docs-build",
    repo: "github.com/acme/docs",
    at: YESTERDAY - 2 * DAY,
    turns: [
      {
        prompt: "Fix the docs build.",
        model: "claude-haiku-5-5",
        input: 5_000,
        output: 1_000,
        tools: [
          {
            name: "Bash",
            input: { command: "bun run docs:build" },
            result: "error: broken link in guide.md",
            error: true,
          },
          {
            name: "Read",
            input: { file_path: "/repo/docs/guide.md" },
            result: "ENOENT: no such file",
            error: true,
          },
          {
            name: "Bash",
            input: { command: "bun run docs:build" },
            result: "error: broken link in intro.md",
            error: true,
          },
          { name: "Bash", input: { command: "bun run docs:build" }, result: "built 41 pages" },
        ],
        answer: "Fixed two broken links; the docs build again.",
      },
    ],
  },
  {
    user: "bob",
    id: "docs-search",
    repo: "github.com/acme/docs",
    at: YESTERDAY - 4 * DAY,
    turns: [
      {
        prompt: "Add a search box to the docs site.",
        model: "claude-opus-5-5",
        input: 20_000,
        output: 4_000,
        tools: [
          {
            name: "Bash",
            input: { command: "bun add pagefind" },
            result: "installed pagefind",
          },
        ],
        answer: "Added a Pagefind search box to the header.",
      },
      {
        prompt: "Style it like the rest of the header.",
        model: "claude-haiku-5-5",
        input: 3_000,
        output: 500,
        tools: [],
        answer: "Styled the search box.",
      },
    ],
  },
];

/** One Claude Code session's transcript: each turn's prompt, the assistant's tool calls (each a
 * model call with its usage) and their results, then its answer. Padded past the server's
 * session filter. */
function transcript(f: Fixture): string {
  const lines: unknown[] = [];
  let t = f.at;
  let n = 0;
  const at = () => {
    t += 5_000;
    return new Date(t).toISOString();
  };
  const base = { sessionId: f.id, cwd: "/repo", gitBranch: "main", version: "2.1.331" };
  for (const turn of f.turns) {
    lines.push({
      ...base,
      type: "user",
      uuid: `u${++n}`,
      timestamp: at(),
      message: { role: "user", content: `${turn.prompt}\n${"context ".repeat(260)}` },
    });
    // The turn's usage, on its first model call.
    let usage: Record<string, number> | undefined = {
      input_tokens: turn.input,
      output_tokens: turn.output,
    };
    const call = (content: unknown[]) => {
      const id = `msg_${f.id}_${++n}`;
      lines.push({
        ...base,
        type: "assistant",
        uuid: `a${n}`,
        timestamp: at(),
        message: {
          id,
          role: "assistant",
          model: turn.model,
          content,
          stop_reason: "end_turn",
          // Only the first call carries tokens, so each turn's tokens are counted once.
          usage: usage ?? { input_tokens: 0, output_tokens: 0 },
        },
      });
      usage = undefined;
    };
    for (const tool of turn.tools) {
      const id = `toolu_${f.id}_${n}`;
      call([{ type: "tool_use", id, name: tool.name, input: tool.input }]);
      lines.push({
        ...base,
        type: "user",
        uuid: `r${++n}`,
        timestamp: at(),
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: id,
              content: tool.result,
              ...(tool.error ? { is_error: true } : {}),
            },
          ],
        },
      });
    }
    call([{ type: "text", text: turn.answer }]);
  }
  return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}

/** Tokens (input + output) per model for `user`, as the fixture holds them. */
function tokensOf(user: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of SESSIONS.filter((x) => x.user === user)) {
    for (const t of s.turns) out.set(t.model, (out.get(t.model) ?? 0) + t.input + t.output);
  }
  return out;
}

interface Run {
  /** The seshi tools it called, in order (`list_sessions`, `sql`…). */
  tools: string[];
  answer: string;
  transcript: string;
}

async function until<T>(read: () => Promise<T | undefined>, what: string, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      const value = await read();
      if (value !== undefined) return value;
    } catch (err) {
      last = err;
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${String(last ?? "")}`);
    await Bun.sleep(200);
  }
}

describe.runIf(ENABLED)("a real agent over seshi mcp", () => {
  let dir: string;
  let server: Bun.Subprocess<"ignore", "pipe", "pipe">;
  let serverLog = "";
  let url: string;
  let adminToken: string;
  let mcpConfig: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "seshi-agent-"));
    const configPath = join(dir, "seshi.toml");
    writeFileSync(
      configPath,
      [
        `[store]\nurl = "file://${join(dir, "bucket")}"\n`,
        "[search]",
        `path = "${join(dir, "index.sqlite")}"`,
        'interval = "200ms"',
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const env = { HOME: dir, PATH: process.env.PATH ?? "", XDG_CONFIG_HOME: join(dir, "config") };
    const setup = await buildInstance(loadServerConfig({ configFlag: configPath, env }).config, {
      formats: buildFormats(),
      roles: [],
      id: "setup",
      env,
    });
    const init = await setup.auth.initAdmin({ owner: "ops" });
    const orgKey = init.org_key?.token as string;
    adminToken = init.admin?.token as string;
    await setup.close();

    server = Bun.spawn(
      [
        process.execPath,
        "run",
        join(ROOT, "apps/seshi/src/main.ts"),
        "serve",
        "--config",
        configPath,
        "--listen",
        "127.0.0.1:0",
      ],
      { cwd: dir, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    for (const stream of [server.stdout, server.stderr]) {
      void (async () => {
        for await (const chunk of stream) serverLog += new TextDecoder().decode(chunk);
      })();
    }
    url = await until(
      async () => /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(serverLog)?.[1],
      "the server to listen",
    );
    for (const s of SESSIONS) {
      await new HttpSeshi({ server: url, token: orgKey, user: s.user }).ingest({
        format: "claude-code",
        session_id: s.id,
        transcript: transcript(s),
        repo: s.repo,
        branch: "main",
      });
    }
    await until(async () => {
      const list = await new HttpSeshi({ server: url, token: adminToken }).searchSessions({
        since: "30d",
      });
      return list.sessions.length === SESSIONS.length ? list : undefined;
    }, "the index to hold the sessions");

    mcpConfig = join(dir, "mcp.json");
    writeFileSync(
      mcpConfig,
      JSON.stringify({
        mcpServers: {
          seshi: {
            command: process.execPath,
            args: [
              "run",
              join(ROOT, "apps/seshi/src/main.ts"),
              "mcp",
              "--server",
              url,
              "--token",
              adminToken,
            ],
            env,
          },
        },
      }),
    );
  }, 240_000);

  afterAll(async () => {
    server?.kill();
    await server?.exited;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** Claude Code, headless, with only seshi's tools; its stream of messages read back. */
  async function ask(task: string): Promise<Run> {
    const claude = Bun.spawn(
      [
        "claude",
        "-p",
        task,
        "--model",
        MODEL,
        "--mcp-config",
        mcpConfig,
        "--strict-mcp-config",
        // Not the machine's own settings and hooks (a seshi capture hook among them).
        "--setting-sources",
        "project",
        "--allowedTools",
        "mcp__seshi__*",
        "--output-format",
        "stream-json",
        "--verbose",
        "--max-turns",
        "15",
      ],
      { cwd: dir, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const [out, err] = await Promise.all([
      new Response(claude.stdout).text(),
      new Response(claude.stderr).text(),
    ]);
    await claude.exited;
    const tools: string[] = [];
    let answer = "";
    for (const line of out.split("\n")) {
      if (line.trim() === "") continue;
      const message = JSON.parse(line) as {
        type: string;
        result?: string;
        is_error?: boolean;
        message?: { content?: { type: string; name?: string }[] };
      };
      // Claude Code's own failure (no model key, a login that ran out) is no answer at all.
      if (message.type === "result" && message.is_error) {
        throw new Error(`claude failed: ${message.result ?? ""}`);
      }
      for (const c of message.message?.content ?? []) {
        if (c.type === "tool_use" && c.name?.startsWith("mcp__seshi__")) {
          tools.push(c.name.slice("mcp__seshi__".length));
        }
      }
      if (message.type === "result") answer = message.result ?? "";
    }
    if (answer === "") throw new Error(`claude gave no answer (exit ${claude.exitCode}): ${err}`);
    return { tools, answer, transcript: out };
  }

  const digits = (s: string) => s.replace(/(\d),(\d)/g, "$1$2");

  it("says what a person worked on in a repo yesterday", async () => {
    const run = await ask(
      "Using the seshi tools: what did alice work on in the github.com/acme/app repo yesterday (UTC)? Answer in one sentence.",
    );
    expect(run.tools.some((t) => t === "list_sessions" || t === "search" || t === "sql")).toBe(
      true,
    );
    expect(run.answer).toMatch(/rate.?limit/i);
    expect(run.answer).not.toMatch(/scrub/i);
  }, 300_000);

  it("finds the session where a test failed and reads around the failure", async () => {
    const run = await ask(
      "Using the seshi tools: find the session where the test 'scrub keeps deleted rows' failed, read the events around the failure, and tell me the exact shell command that failed.",
    );
    expect(run.tools).toContain("read_session");
    expect(run.answer).toContain("bun test packages/ts/search --bail");
  }, 300_000);

  it("names the tool that failed most last week", async () => {
    const run = await ask(
      "Using the seshi tools: which tool failed most often across all sessions in the last 7 days, and how many times? Answer with the tool name and the count.",
    );
    expect(run.tools).toContain("sql");
    expect(run.answer).toMatch(/\bBash\b/);
    expect(run.answer).toMatch(/\b3\b|three/i);
  }, 300_000);

  it("adds up a person's tokens per model", async () => {
    const run = await ask(
      "Using the seshi tools: how many tokens (input plus output) did bob use per model over the last 30 days? List each model with its total.",
    );
    expect(run.tools).toContain("sql");
    const answer = digits(run.answer);
    for (const [model, tokens] of tokensOf("bob")) {
      expect(answer).toContain(model);
      expect(answer).toContain(String(tokens));
    }
  }, 300_000);
});
