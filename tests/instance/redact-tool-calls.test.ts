/** The server's `[capture] redact_tool_calls`, through the real instance: the Cursor Cloud poller
 * (against a fake Cloud Agents API: nothing leaves the machine) stores a listed agent's runs with
 * every tool call's input and output redacted, matching any of the agent's repositories, before
 * anything is stored or indexed. An agent elsewhere is stored as it came. */

import { connectorsOf } from "@seshi/kit";
import { getTrace } from "@seshi/pipeline";
import { archiveId, readMetadata } from "@seshi/store";
import { INTEGRATIONS } from "seshi/integrations";
import { afterEach, describe, expect, it } from "vitest";
import { bootInstance } from "../tooling/instance";

let booted: Awaited<ReturnType<typeof bootInstance>> | undefined;
afterEach(async () => {
  await booted?.cleanup();
  booted = undefined;
});

const now = Date.now();
const at = (ms: number) => new Date(ms).toISOString();
const reply = `The env holds one key. ${"details ".repeat(400)}`;

/** One finished run that reads `.env` with the shell. */
function stream(): string {
  const events = [
    { event: "status", data: { runId: "run-1", status: "RUNNING" } },
    {
      id: `${now - 4000}-0`,
      event: "interaction_update",
      data: { type: "user-message-appended", userMessage: { text: "what is in the env file?" } },
    },
    {
      id: `${now - 3000}-0`,
      event: "tool_call",
      data: {
        callId: "call-1",
        name: "run_terminal_cmd",
        status: "completed",
        args: { command: "cat .env.production", timeout: 30 },
        result: { success: { stdout: "STRIPE_KEY=sk_live_from_the_tool\n", exitCode: 0 } },
      },
    },
    { id: `${now - 2000}-0`, event: "assistant", data: { text: reply } },
    { id: `${now - 1000}-0`, event: "result", data: { runId: "run-1", status: "FINISHED" } },
    { id: `${now - 1000}-0`, event: "done", data: {} },
  ];
  return events
    .map(
      (e) => `${e.id ? `id: ${e.id}\n` : ""}event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`,
    )
    .join("");
}

/** A fake Cloud Agents API with two agents: one whose second repository is listed, one not. */
async function api(input: string | URL | Request): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const parts = url.pathname.split("/").filter(Boolean); // v1 agents {id} runs {run} stream
  if (parts.length === 2) {
    return Response.json({
      items: [
        {
          id: "bc-listed",
          updatedAt: at(now - 60_000),
          // The envelope's `repo` is the first; the list names the second.
          repos: [
            { url: "https://github.com/acme/app" },
            { url: "git@github.com:Acme/Research.git" },
          ],
        },
        {
          id: "bc-other",
          updatedAt: at(now - 60_000),
          repos: [{ url: "https://github.com/acme/web" }],
        },
      ],
    });
  }
  if (parts[3] === "usage") return Response.json({ runs: [] });
  if (parts.length === 4) {
    return Response.json({
      items: [{ id: "run-1", status: "FINISHED", createdAt: at(now - 120_000) }],
    });
  }
  if (parts[5] === "stream") {
    return new Response(stream(), { headers: { "content-type": "text/event-stream" } });
  }
  return Response.json({ id: "run-1", status: "FINISHED", createdAt: at(now - 120_000) });
}

describe("[capture] redact_tool_calls on the server", () => {
  it("stores a listed Cursor Cloud agent's runs with tool calls redacted, another's as they came", async () => {
    booted = await bootInstance(
      `
[capture]
redact_tool_calls = ["acme/research"]

[[sources]]
id = "cursor-team"
type = "cursor-cloud"
api_key = "key-1"
api_url = "https://cursor.test"
usage = false
`,
      { connectors: connectorsOf(INTEGRATIONS), fetch: api as typeof fetch },
    );
    const report = await booted.instance.sources.run("cursor-team");
    expect(report).toMatchObject({ outcome: "ok", outcomes: { stored: 2 } });

    const owner = "svc:cursor-team";
    const stored = async (agent: string) => {
      const archive = archiveId(owner, "cursor-cloud-api", agent);
      const meta = await readMetadata(booted?.store as never, owner, archive);
      const trace = await getTrace(booted?.store as never, owner, archive, meta?.head as string);
      return { meta, records: trace?.records ?? [] };
    };

    const listed = await stored("bc-listed");
    const text = JSON.stringify(listed.records);
    expect(text).not.toContain("cat .env.production");
    expect(text).not.toContain("sk_live_from_the_tool");
    expect(listed.records).toContainEqual(
      expect.objectContaining({
        tool_calls: [
          expect.objectContaining({
            id: "call-1",
            name: "run_terminal_cmd",
            args: expect.any(String),
          }),
        ],
      }),
    );
    const call = listed.records.find((r) => "tool_calls" in r) as {
      tool_calls: { args: string }[];
    };
    expect(JSON.parse(call.tool_calls[0]?.args ?? "{}")).toEqual({
      command: "[redacted:tool-call]",
      timeout: 30,
    });
    expect(listed.records).toContainEqual(
      expect.objectContaining({
        role: "tool",
        tool_call_id: "call-1",
        content: "[redacted:tool-call]",
      }),
    );
    // The conversation stays.
    expect(text).toContain("what is in the env file?");
    expect(text).toContain("The env holds one key.");
    expect(listed.meta?.redaction?.counts["tool-call"]).toBe(2);

    const other = JSON.stringify((await stored("bc-other")).records);
    expect(other).toContain("cat .env.production");
  });
});
