/** The poller against a fake Cloud Agents API (no request leaves the machine) and a fake
 * context that records what it submits and the checkpoints it writes. The fake store keeps
 * each session's log length and refuses an append at another offset, as the server does. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConnectorContext, ConnectorFailure, Cursor, SubmitOutcome } from "@seshi/kit";
import type { Envelope } from "@seshi/model";
import { describe, expect, it } from "vitest";
import {
  cursorCloudConnector,
  keptEvents,
  readCursorCloudConfig,
  readCursorCloudCursor,
  SESSION_CONFLICT,
  STREAM_EXPIRED,
} from "./connector";
import { normalizeCursorCloud } from "./format";

const NOW = new Date("2026-11-19T12:00:00Z");
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

const sse = (events: { id?: string; event: string; data: unknown }[]) =>
  events
    .map(
      (e) => `${e.id ? `id: ${e.id}\n` : ""}event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`,
    )
    .join("");

/** A run's stream: a prompt, a reply (with the deltas the format drops) and its end. */
function runStream(runId: string, prompt: string, reply: string, ended = true): string {
  const t = NOW.getTime() - HOUR;
  return sse([
    { event: "status", data: { runId, status: "RUNNING" } },
    {
      id: `${t}-0`,
      event: "interaction_update",
      data: { type: "user-message-appended", userMessage: { text: prompt } },
    },
    { id: `${t + 1}-0`, event: "interaction_update", data: { type: "token-delta", tokens: 3 } },
    { id: `${t + 2}-0`, event: "assistant", data: { text: reply } },
    { id: `${t + 2}-0`, event: "interaction_update", data: { type: "text-delta", text: reply } },
    { event: "heartbeat", data: {} },
    ...(ended
      ? [
          { id: `${t + 3}-0`, event: "result", data: { runId, status: "FINISHED", text: reply } },
          { id: `${t + 3}-0`, event: "done", data: {} },
        ]
      : []),
  ]);
}

interface FakeRun {
  id: string;
  status: string;
  createdAt: string;
  stream: string | number | (() => string | number);
}

class FakeCursor {
  agents: { id: string; updatedAt: string; repos?: { url: string }[] }[] = [];
  runs = new Map<string, FakeRun[]>();
  calls: string[] = [];
  queued: Response[] = [];
  keys: string[] = [];

  agent(id: string, updatedAt: string, runs: FakeRun[]) {
    this.agents = [
      { id, updatedAt, repos: [{ url: "https://github.com/example/demo" }] },
      ...this.agents.filter((a) => a.id !== id),
    ];
    this.runs.set(id, runs);
  }

  fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    this.calls.push(url.pathname);
    this.keys.push(new Headers(init.headers).get("authorization") ?? "");
    const queued = this.queued.shift();
    if (queued) return queued;
    const parts = url.pathname.split("/").filter(Boolean); // v1 agents {id} runs {run} stream
    if (parts.length === 2) return Response.json({ items: this.agents });
    const runs = this.runs.get(parts[2] as string) ?? [];
    if (parts[3] === "usage") {
      return Response.json({
        runs: [{ id: url.searchParams.get("runId"), usage: { inputTokens: 1 } }],
      });
    }
    if (parts.length === 4) {
      return Response.json({
        items: runs.map(({ id, status, createdAt }) => ({ id, status, createdAt })),
      });
    }
    const run = runs.find((r) => r.id === parts[4]);
    if (!run) return Response.json({ error: { message: "no such run" } }, { status: 404 });
    if (parts[5] === "stream") {
      const body = typeof run.stream === "function" ? run.stream() : run.stream;
      if (typeof body === "number") return new Response("", { status: body });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    return Response.json({
      id: run.id,
      status: run.status,
      createdAt: run.createdAt,
      durationMs: 1000,
      git: { branches: [{ repoUrl: "github.com/example/demo", branch: `cursor/${run.id}` }] },
    });
  };
}

class FakeContext {
  submitted: Envelope[] = [];
  failures: ConnectorFailure[] = [];
  checkpoints: Cursor[] = [];
  logs: string[] = [];
  /** Each session's log length, as the store keeps it. */
  stored = new Map<string, number>();
  cursor: Cursor | null = null;

  constructor(
    readonly api: FakeCursor,
    readonly config: Record<string, unknown> = { api_key: "key-1" },
  ) {}

  context(): ConnectorContext {
    return {
      source: { id: "cursor-team", type: "cursor-cloud", config: this.config },
      submit: async (envelope): Promise<SubmitOutcome> => {
        this.submitted.push(envelope);
        const payload = envelope.payload as { text: string; offset: number };
        const length = this.stored.get(envelope.session_key) ?? 0;
        if (payload.offset !== length) {
          return {
            status: "failed",
            code: "offset_mismatch",
            message: `expected ${length}`,
            record: "r",
          };
        }
        const total = length + Buffer.byteLength(payload.text);
        this.stored.set(envelope.session_key, total);
        return {
          status: "stored",
          archive_id: "a",
          content_hash: "h",
          session_id: envelope.session_key,
          records: 2,
          events: 2,
          records_total: 2,
          prefix_sha256: "p",
          bytes_total: total,
        };
      },
      checkpoint: {
        read: () => this.cursor,
        write: async (cursor) => {
          this.cursor = structuredClone(cursor);
          this.checkpoints.push(this.cursor);
        },
      },
      fetch: (input, init) => this.api.fetch(String(input), init ?? {}),
      log: {
        info: (m) => this.logs.push(m),
        warn: (m) => this.logs.push(m),
        error: (m) => this.logs.push(m),
      },
      signal: new AbortController().signal,
      now: () => NOW,
      fail: async (failure) => {
        this.failures.push(failure);
        return "recorded";
      },
    };
  }
}

const poller = cursorCloudConnector({ sleep: async () => {}, backoffMs: 1 });
const finished = (id: string, hoursAgo: number, stream?: FakeRun["stream"]): FakeRun => ({
  id,
  status: "FINISHED",
  createdAt: iso(NOW.getTime() - hoursAgo * HOUR),
  stream: stream ?? runStream(id, `prompt of ${id}`, `reply of ${id}`),
});

describe("the cursor-cloud poller", () => {
  it("appends an agent's finished runs to its session, in order, one line per run", async () => {
    const api = new FakeCursor();
    api.agent("bc-a", iso(NOW.getTime() - HOUR), [finished("run-2", 2), finished("run-1", 3)]);
    const ctx = new FakeContext(api);
    expect(await poller.run(ctx.context())).toEqual({});

    expect(ctx.submitted.map((e) => e.idempotency_key)).toEqual([
      "cursor-cloud:bc-a/run-1",
      "cursor-cloud:bc-a/run-2",
    ]);
    const [first, second] = ctx.submitted as [Envelope, Envelope];
    expect(first).toMatchObject({
      source: "cursor-cloud",
      source_id: "cursor-team",
      format: "cursor-cloud-api",
      session_key: "bc-a",
      owner: "svc:cursor-team",
      owner_basis: "service",
      caller: { kind: "service", principal: "svc:cursor-team" },
      project: "github.com/example/demo",
      branch: "cursor/run-1",
      payload: { kind: "log", encoding: "jsonl", offset: 0 },
    });
    const text = (first.payload as { text: string }).text;
    expect((second.payload as { offset: number }).offset).toBe(Buffer.byteLength(text));
    const line = JSON.parse(text);
    expect(line).toMatchObject({
      type: "cursor_cloud_run",
      agent_id: "bc-a",
      run_id: "run-1",
      usage: { id: "run-1", usage: { inputTokens: 1 } },
    });
    expect(line.events.map((e: { event: string }) => e.event)).toEqual([
      "status",
      "interaction_update",
      "assistant",
      "result",
      "done",
    ]);
    const records = normalizeCursorCloud(text + (second.payload as { text: string }).text);
    expect(records.map((r) => r.role)).toEqual(["meta", "user", "assistant", "user", "assistant"]);

    expect(ctx.cursor).toMatchObject({
      v: 1,
      agents: { "bc-a": { updated: iso(NOW.getTime() - HOUR), through: { id: "run-2" } } },
    });
    expect(api.keys.every((k) => k === "Bearer key-1")).toBe(true);
  });

  it("reads nothing more of an agent whose updatedAt has not moved, and the next run when it does", async () => {
    const api = new FakeCursor();
    api.agent("bc-a", iso(NOW.getTime() - HOUR), [finished("run-1", 3)]);
    const ctx = new FakeContext(api);
    await poller.run(ctx.context());
    api.calls = [];
    await poller.run(ctx.context());
    expect(api.calls).toEqual(["/v1/agents"]);

    api.agent("bc-a", iso(NOW.getTime() - 0.1 * HOUR), [
      finished("run-1", 3),
      finished("run-9", 0.5),
    ]);
    await poller.run(ctx.context());
    expect(ctx.submitted.map((e) => e.idempotency_key)).toEqual([
      "cursor-cloud:bc-a/run-1",
      "cursor-cloud:bc-a/run-9",
    ]);
    expect(ctx.stored.get("bc-a")).toBe(
      ctx.submitted.reduce(
        (n, e) => n + Buffer.byteLength((e.payload as { text: string }).text),
        0,
      ),
    );
  });

  it("holds the runs after one still going, and leaves agents untouched past the lookback", async () => {
    const api = new FakeCursor();
    api.agent("bc-old", iso(NOW.getTime() - 30 * HOUR), [finished("run-old", 31)]);
    api.agent("bc-a", iso(NOW.getTime() - HOUR), [
      finished("run-1", 3),
      {
        id: "run-2",
        status: "RUNNING",
        createdAt: iso(NOW.getTime() - 2 * HOUR),
        stream: runStream("run-2", "p", "r", false),
      },
      finished("run-3", 1),
    ]);
    const ctx = new FakeContext(api);
    await poller.run(ctx.context());
    expect(ctx.submitted.map((e) => e.idempotency_key)).toEqual(["cursor-cloud:bc-a/run-1"]);
    expect(api.calls.some((c) => c.includes("bc-old"))).toBe(false);
    expect(
      (ctx.cursor as { agents: Record<string, { updated?: string }> }).agents["bc-a"]?.updated,
    ).toBeUndefined();

    const runs = api.runs.get("bc-a") as FakeRun[];
    (runs[1] as FakeRun).status = "FINISHED";
    (runs[1] as FakeRun).stream = runStream("run-2", "p", "r");
    await poller.run(ctx.context());
    expect(ctx.submitted.map((e) => e.idempotency_key)).toEqual([
      "cursor-cloud:bc-a/run-1",
      "cursor-cloud:bc-a/run-2",
      "cursor-cloud:bc-a/run-3",
    ]);
  });

  it("records a run whose stream has expired and goes on to the next", async () => {
    const api = new FakeCursor();
    api.agent("bc-a", iso(NOW.getTime() - HOUR), [
      finished("run-1", 24.5, 410),
      finished("run-2", 1),
    ]);
    const ctx = new FakeContext(api);
    await poller.run(ctx.context());
    expect(ctx.failures).toEqual([
      expect.objectContaining({
        code: STREAM_EXPIRED,
        session_key: "bc-a",
        idempotency_key: "cursor-cloud:bc-a/run-1~expired",
      }),
    ]);
    expect(ctx.submitted.map((e) => e.idempotency_key)).toEqual(["cursor-cloud:bc-a/run-2"]);
  });

  it("asks again for a replay that ends early, then waits for the next poll", async () => {
    const api = new FakeCursor();
    let asked = 0;
    api.agent("bc-a", iso(NOW.getTime() - HOUR), [
      finished("run-1", 2, () => {
        asked++;
        return asked < 3 ? "" : runStream("run-1", "p", "r");
      }),
    ]);
    const ctx = new FakeContext(api);
    await poller.run(ctx.context());
    expect(asked).toBe(3);
    expect(ctx.submitted).toHaveLength(1);

    asked = -10;
    api.agent("bc-b", iso(NOW.getTime() - HOUR), [
      finished("run-x", 2, () => {
        asked++;
        return "";
      }),
    ]);
    await poller.run(ctx.context());
    expect(ctx.submitted).toHaveLength(1);
    expect(ctx.logs.some((l) => l.includes("ended before the run's result"))).toBe(true);
  });

  it("holds an agent whose stored session is not the length the checkpoint says", async () => {
    const api = new FakeCursor();
    api.agent("bc-a", iso(NOW.getTime() - HOUR), [finished("run-1", 2)]);
    const ctx = new FakeContext(api);
    ctx.stored.set("bc-a", 99);
    await poller.run(ctx.context());
    expect(ctx.failures.map((f) => f.code)).toEqual([SESSION_CONFLICT]);
    expect(readCursorCloudCursor(ctx.cursor).agents["bc-a"]?.conflict).toContain(
      "not 0 bytes long",
    );
    api.calls = [];
    await poller.run(ctx.context());
    expect(api.calls).toEqual(["/v1/agents"]);
  });

  it("stops at its stream budget and says there is more", async () => {
    const api = new FakeCursor();
    api.agent("bc-a", iso(NOW.getTime() - HOUR), [
      finished("run-1", 3),
      finished("run-2", 2),
      finished("run-3", 1),
    ]);
    const ctx = new FakeContext(api, { api_key: "k", max_streams: 2 });
    expect(await poller.run(ctx.context())).toEqual({ more: true });
    expect(ctx.submitted).toHaveLength(2);
    expect(await poller.run(ctx.context())).toEqual({});
    expect(ctx.submitted).toHaveLength(3);
  });

  it("waits out a 429 and tries again", async () => {
    const api = new FakeCursor();
    api.agent("bc-a", iso(NOW.getTime() - HOUR), [finished("run-1", 2)]);
    api.queued.push(new Response("", { status: 429, headers: { "retry-after": "0" } }));
    const ctx = new FakeContext(api);
    await poller.run(ctx.context());
    expect(api.calls.slice(0, 2)).toEqual(["/v1/agents", "/v1/agents"]);
    expect(ctx.submitted).toHaveLength(1);
  });

  it("fails a poll whose key Cursor refuses", async () => {
    const api = new FakeCursor();
    api.queued.push(Response.json({ error: { message: "Invalid API key" } }, { status: 401 }));
    await expect(poller.run(new FakeContext(api).context())).rejects.toThrow(
      /refused the API key \(401\)/,
    );
  });
});

describe("its config and checkpoint", () => {
  it("needs a key and an https API URL", () => {
    expect(() => readCursorCloudConfig({})).toThrow(/needs api_key/);
    expect(() => readCursorCloudConfig({ api_key: "k", api_url: "http://example.com" })).toThrow(
      /must be https/,
    );
    expect(
      readCursorCloudConfig({ api_key: { reveal: () => "k" }, api_url: "http://127.0.0.1:9" }),
    ).toEqual({
      api_key: "k",
      api_url: "http://127.0.0.1:9",
      lookback: 25 * HOUR,
      max_streams: 25,
      usage: true,
    });
  });

  it("refuses a checkpoint it did not write", () => {
    expect(readCursorCloudCursor(null)).toEqual({ v: 1, agents: {} });
    expect(() => readCursorCloudCursor({ v: 2 })).toThrow(/not one this version wrote/);
    expect(() => readCursorCloudCursor({ v: 1, agents: { a: { bytes: -1 } } })).toThrow(/agent a/);
  });

  it("keeps everything but heartbeats and repeated deltas", () => {
    const fixture = readFileSync(
      join(import.meta.dirname, "..", "..", "testdata", "cloud", "tools.jsonl"),
      "utf8",
    );
    const events = JSON.parse(fixture).events;
    expect(keptEvents(events)).toEqual(events);
    expect(
      keptEvents([
        { event: "heartbeat", data: {} },
        { event: "interaction_update", data: { type: "thinking-delta" } },
        { event: "interaction_update", data: { type: "turn-ended" } },
      ]),
    ).toEqual([{ event: "interaction_update", data: { type: "turn-ended" } }]);
  });
});
