/** A source's `labels` (`[[sources]]`): put on every session it stores, through the real
 * pipeline, by the built-in S3 poller and by the Cursor Cloud poller (against a fake Cloud
 * Agents API: nothing leaves the machine). They win over the labels the data carries. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectorsOf } from "@seshi/kit";
import { getTrace } from "@seshi/pipeline";
import { archiveId, readMetadata } from "@seshi/store";
import { INTEGRATIONS } from "seshi/integrations";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootInstance } from "../tooling/instance";
import { transcript } from "../tooling/testdata";

const CLAUDE = transcript("claude-basic.claude-code.jsonl");
const LONG = `${CLAUDE.trim()}\n${JSON.stringify({
  type: "assistant",
  uuid: "a3",
  timestamp: "2026-09-01T00:00:08.000Z",
  sessionId: "sess1",
  message: {
    role: "assistant",
    model: "claude-x",
    content: [{ type: "text", text: `The auth flow: ${"details ".repeat(400)}` }],
  },
})}\n`;

let dir: string;
let booted: Awaited<ReturnType<typeof bootInstance>> | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-source-labels-"));
});
afterEach(async () => {
  await booted?.cleanup();
  booted = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe("a source's labels", () => {
  it("are put on every session an S3 source stores, and on its traces", async () => {
    const drop = join(dir, "drop");
    mkdirSync(drop);
    writeFileSync(join(drop, "sess1.jsonl"), LONG);
    booted = await bootInstance(`
[[sources]]
id = "drop"
type = "s3"
url = "file://${drop}"
labels = { "dosu.member" = "alice", team = "evals" }
`);
    const report = await booted.instance.sources.run("drop");
    expect(report).toMatchObject({ outcome: "ok", outcomes: { stored: 1 } });
    const owner = "svc:drop";
    const archive = archiveId(owner, "claude-code", "sess1.jsonl");
    const meta = await readMetadata(booted.store, owner, archive);
    expect(meta?.labels).toEqual({ "dosu.member": "alice", team: "evals" });
    const trace = await getTrace(booted.store, owner, archive, meta?.head as string);
    expect(trace?.metadata.labels).toEqual({ "dosu.member": "alice", team: "evals" });
  });

  it("are put on every session the Cursor Cloud poller stores", async () => {
    const now = Date.now();
    const at = (ms: number) => new Date(ms).toISOString();
    const reply = `The auth flow: ${"details ".repeat(400)}`;
    const sse = (events: { id?: string; event: string; data: unknown }[]) =>
      events
        .map(
          (e) =>
            `${e.id ? `id: ${e.id}\n` : ""}event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`,
        )
        .join("");
    const stream = sse([
      { event: "status", data: { runId: "run-1", status: "RUNNING" } },
      {
        id: `${now - 3000}-0`,
        event: "interaction_update",
        data: { type: "user-message-appended", userMessage: { text: "explain the auth flow" } },
      },
      { id: `${now - 2000}-0`, event: "assistant", data: { text: reply } },
      {
        id: `${now - 1000}-0`,
        event: "result",
        data: { runId: "run-1", status: "FINISHED", text: reply },
      },
      { id: `${now - 1000}-0`, event: "done", data: {} },
    ]);
    const api = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const parts = url.pathname.split("/").filter(Boolean); // v1 agents {id} runs {run} stream
      if (parts.length === 2) {
        return Response.json({
          items: [
            {
              id: "bc-a",
              updatedAt: at(now - 60_000),
              repos: [{ url: "https://github.com/acme/app" }],
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
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({
        id: "run-1",
        status: "FINISHED",
        createdAt: at(now - 120_000),
        durationMs: 1000,
        git: { branches: [{ repoUrl: "github.com/acme/app", branch: "cursor/run-1" }] },
      });
    };
    booted = await bootInstance(
      `
[[sources]]
id = "cursor-team"
type = "cursor-cloud"
api_key = "key-1"
api_url = "https://cursor.test"
usage = false
labels = { "dosu.member" = "alice" }
`,
      {
        connectors: connectorsOf(INTEGRATIONS),
        fetch: api as typeof fetch,
      },
    );
    const report = await booted.instance.sources.run("cursor-team");
    expect(report).toMatchObject({ outcome: "ok", outcomes: { stored: 1 } });
    const owner = "svc:cursor-team";
    const meta = await readMetadata(
      booted.store,
      owner,
      archiveId(owner, "cursor-cloud-api", "bc-a"),
    );
    expect(meta?.labels).toEqual({ "dosu.member": "alice" });
  });
});
