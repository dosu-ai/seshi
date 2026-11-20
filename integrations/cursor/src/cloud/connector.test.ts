/** The poller against a fake Cloud Agents API (no request leaves the machine) and a fake
 * context that records what it submits and the checkpoints it writes. The fake store keeps
 * each session's log length and refuses an append at another offset, as the server does. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConnectorContext, ConnectorFailure, Cursor, SubmitOutcome } from "@seshi/kit";
import { type Envelope, excludingEntry, repoExcludes } from "@seshi/model";
import { describe, expect, it } from "vitest";
import {
  cursorCloudConnector,
  expectedOffset,
  keptEvents,
  readCursorCloudConfig,
  readCursorCloudCursor,
  SESSION_CONFLICT,
  STREAM_EXPIRED,
} from "./connector";
import { normalizeCursorCloud } from "./format";

/** A stream that sends `text` and then nothing, never closing. */
function hanging(text: string): () => Response {
  return () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text));
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
}

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
  stream: string | number | (() => string | number | Response);
}

class FakeCursor {
  agents: { id: string; updatedAt: string; repos?: { url: string }[] }[] = [];
  runs = new Map<string, FakeRun[]>();
  calls: string[] = [];
  queued: Response[] = [];
  keys: string[] = [];

  agent(
    id: string,
    updatedAt: string,
    runs: FakeRun[],
    repos: { url: string }[] = [{ url: "https://github.com/example/demo" }],
  ) {
    this.agents = [{ id, updatedAt, repos }, ...this.agents.filter((a) => a.id !== id)];
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
      if (body instanceof Response) return body;
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
  /** Answers already given, by idempotency key: a resend gets the same answer (X4.7). */
  answers = new Map<string, SubmitOutcome>();
  /** A first upload shorter than this is filtered (kept nothing of), as the session filter does. */
  filterUnder = 0;
  cursor: Cursor | null = null;
  /** The server's `[capture] exclude`. */
  exclude: string[] = [];
  /** Agents counted as excluded (the source's health). */
  excludedCount = 0;

  constructor(
    readonly api: FakeCursor,
    readonly config: Record<string, unknown> = { api_key: "key-1" },
  ) {}

  context(): ConnectorContext {
    return {
      source: { id: "cursor-team", type: "cursor-cloud", config: this.config },
      submit: async (envelope): Promise<SubmitOutcome> => {
        this.submitted.push(envelope);
        const earlier = this.answers.get(envelope.idempotency_key);
        if (earlier) return { ...earlier, status: "duplicate" } as SubmitOutcome;
        const payload = envelope.payload as { text: string; offset: number };
        const length = this.stored.get(envelope.session_key) ?? 0;
        if (payload.offset !== length) {
          return {
            status: "failed",
            code: "offset_mismatch",
            message: `chunk starts at byte ${payload.offset}; the session's log ends at ${length}`,
            record: "r",
          };
        }
        if (length === 0 && Buffer.byteLength(payload.text) < this.filterUnder) {
          return { status: "filtered", records_total: 0, prefix_sha256: "p", bytes_total: 0 };
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
      excludedBy: (repos) => excludingEntry(repoExcludes(this.exclude), repos),
      excluded: () => {
        this.excludedCount++;
      },
    };
  }
}

const poller = cursorCloudConnector({ sleep: async () => {}, backoffMs: 1, readTimeoutMs: 50 });
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
    const held = readCursorCloudCursor(ctx.cursor).agents["bc-a"];
    expect(held?.conflict).toContain("99 bytes long, not 0");
    expect(held?.expected).toBe(99);
    api.calls = [];
    await poller.run(ctx.context());
    expect(api.calls).toEqual(["/v1/agents"]);

    // seshi reprocess --since releases it: it goes on after where the stored session ends.
    ctx.cursor = poller.rewind?.(ctx.cursor, NOW, {}) ?? null;
    expect(readCursorCloudCursor(ctx.cursor).agents["bc-a"]).toEqual({ bytes: 99 });
    await poller.run(ctx.context());
    expect(ctx.submitted.at(-1)?.payload).toMatchObject({ offset: 99 });
    expect(readCursorCloudCursor(ctx.cursor).agents["bc-a"]?.conflict).toBeUndefined();
  });

  it("goes on to the other agents when one fails, and reads it again next poll", async () => {
    const api = new FakeCursor();
    api.agent("bc-ok", iso(NOW.getTime() - HOUR), [finished("run-ok", 2)]);
    api.agent("bc-bad", iso(NOW.getTime() - 0.5 * HOUR), [finished("run-bad", 1, 500)]);
    const ctx = new FakeContext(api);
    await poller.run(ctx.context());
    expect(ctx.submitted.map((e) => e.session_key)).toEqual(["bc-ok"]);
    expect(ctx.logs.some((l) => l.includes("bc-bad") && l.includes("read again next poll"))).toBe(
      true,
    );
    expect(readCursorCloudCursor(ctx.cursor).agents["bc-bad"]?.updated).toBeUndefined();

    ((api.runs.get("bc-bad") as FakeRun[])[0] as FakeRun).stream = runStream("run-bad", "p", "r");
    await poller.run(ctx.context());
    expect(ctx.submitted.map((e) => e.session_key)).toEqual(["bc-ok", "bc-bad"]);
  });

  it("stops reading a stream at done, and counts one that goes quiet as stalled", async () => {
    const api = new FakeCursor();
    api.agent("bc-open", iso(NOW.getTime() - HOUR), [
      finished("run-1", 2, hanging(runStream("run-1", "p", "r"))),
    ]);
    api.agent("bc-quiet", iso(NOW.getTime() - 0.5 * HOUR), [
      finished("run-2", 1, hanging(runStream("run-2", "p", "r", false))),
    ]);
    const ctx = new FakeContext(api);
    await poller.run(ctx.context());
    expect(ctx.submitted.map((e) => e.session_key)).toEqual(["bc-open"]);
    expect(ctx.logs.some((l) => l.includes("bc-quiet") && l.includes("sent nothing"))).toBe(true);
  });

  it("waits with the next run while a carried run cannot be read whole", async () => {
    const api = new FakeCursor();
    const ctx = new FakeContext(api, { api_key: "k", max_streams: 1 });
    ctx.cursor = {
      v: 1,
      agents: {
        "bc-a": {
          bytes: 0,
          carry: [{ at: iso(NOW.getTime() - 3 * HOUR), id: "run-1" }],
          through: { at: iso(NOW.getTime() - 3 * HOUR), id: "run-1" },
        },
      },
    };
    api.agent("bc-a", iso(NOW.getTime() - HOUR), [finished("run-1", 3), finished("run-2", 1)]);
    // The one stream this poll has goes to the carried run; run-2 waits, carry and all.
    expect(await poller.run(ctx.context())).toEqual({ more: true });
    expect(ctx.submitted).toHaveLength(0);
    expect(readCursorCloudCursor(ctx.cursor).agents["bc-a"]?.carry).toHaveLength(1);

    const roomy = new FakeContext(api);
    roomy.cursor = ctx.cursor;
    await poller.run(roomy.context());
    const text = ((roomy.submitted[0] as Envelope).payload as { text: string }).text;
    expect(
      text
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l).run_id),
    ).toEqual(["run-1", "run-2"]);
  });

  it("records a carried run Cursor no longer has, and stores the next run without it", async () => {
    const api = new FakeCursor();
    const ctx = new FakeContext(api);
    const long = iso(NOW.getTime() - 30 * HOUR);
    ctx.cursor = {
      v: 1,
      agents: {
        "bc-a": {
          bytes: 0,
          carry: [{ at: long, id: "run-1" }],
          through: { at: long, id: "run-1" },
        },
      },
    };
    api.agent("bc-a", iso(NOW.getTime() - HOUR), [
      finished("run-1", 30, 410),
      finished("run-2", 1),
    ]);
    await poller.run(ctx.context());
    expect(ctx.failures.map((f) => f.idempotency_key)).toEqual(["cursor-cloud:bc-a/run-1~expired"]);
    expect(ctx.submitted.map((e) => e.idempotency_key)).toEqual(["cursor-cloud:bc-a/run-2"]);
    expect(readCursorCloudCursor(ctx.cursor).agents["bc-a"]?.carry).toBeUndefined();
  });

  it("never moves an agent's log length back on an answer given earlier", async () => {
    const api = new FakeCursor();
    const ctx = new FakeContext(api);
    // Released after a conflict at 1000 bytes; run-1 was stored long ago, at 400.
    ctx.cursor = { v: 1, agents: { "bc-a": { bytes: 1000 } } };
    ctx.stored.set("bc-a", 1000);
    ctx.answers.set("cursor-cloud:bc-a/run-1", {
      status: "stored",
      archive_id: "a",
      content_hash: "h",
      session_id: "bc-a",
      records: 1,
      events: 1,
      records_total: 1,
      prefix_sha256: "p",
      bytes_total: 400,
    });
    api.agent("bc-a", iso(NOW.getTime() - HOUR), [finished("run-1", 3), finished("run-2", 1)]);
    await poller.run(ctx.context());
    expect(ctx.failures).toEqual([]);
    expect(ctx.submitted.map((e) => (e.payload as { offset: number }).offset)).toEqual([
      1000, 1000,
    ]);
    expect(readCursorCloudCursor(ctx.cursor).agents["bc-a"]?.bytes).toBe(ctx.stored.get("bc-a"));
  });

  it("sends a run the filter kept nothing of again, ahead of the agent's next run", async () => {
    const api = new FakeCursor();
    api.agent("bc-a", iso(NOW.getTime() - 3 * HOUR), [finished("run-1", 3)]);
    const ctx = new FakeContext(api);
    ctx.filterUnder = 2000;
    await poller.run(ctx.context());
    expect(readCursorCloudCursor(ctx.cursor).agents["bc-a"]).toMatchObject({
      bytes: 0,
      carry: [{ id: "run-1" }],
    });
    expect(ctx.logs.at(-1)).toContain("1 too short to keep yet");

    api.agent("bc-a", iso(NOW.getTime() - HOUR), [finished("run-1", 3), finished("run-2", 1)]);
    ctx.filterUnder = 0;
    await poller.run(ctx.context());
    const last = ctx.submitted.at(-1) as Envelope;
    const text = (last.payload as { text: string }).text;
    expect(last.payload).toMatchObject({ offset: 0 });
    expect(
      text
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l).run_id),
    ).toEqual(["run-1", "run-2"]);
    expect(readCursorCloudCursor(ctx.cursor).agents["bc-a"]?.carry).toBeUndefined();
  });

  it("drops an agent nothing was stored of from the checkpoint after 90 days", async () => {
    const api = new FakeCursor();
    const ctx = new FakeContext(api);
    const old = iso(NOW.getTime() - 100 * 24 * HOUR);
    ctx.cursor = {
      v: 1,
      agents: { "bc-gone": { bytes: 0, updated: old }, "bc-kept": { bytes: 40, updated: old } },
    };
    api.agent("bc-new", iso(NOW.getTime() - HOUR), [finished("run-1", 2)]);
    await poller.run(ctx.context());
    expect(Object.keys(readCursorCloudCursor(ctx.cursor).agents).sort()).toEqual([
      "bc-kept",
      "bc-new",
    ]);
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

describe("the org's exclude list", () => {
  it("leaves an excluded agent out before fetching any run, and counts it", async () => {
    const api = new FakeCursor();
    api.agent("bc-a", iso(NOW.getTime() - HOUR), [finished("run-1", 2)]);
    api.agent(
      "bc-x",
      iso(NOW.getTime() - HOUR),
      [finished("run-x", 2)],
      [{ url: "https://github.com/Acme/Payroll.git" }],
    );
    const ctx = new FakeContext(api);
    ctx.exclude = ["acme/payroll"];
    await poller.run(ctx.context());

    expect(ctx.submitted.map((e) => e.session_key)).toEqual(["bc-a"]);
    expect(api.calls.filter((c) => c.includes("bc-x"))).toEqual([]);
    expect(ctx.excludedCount).toBe(1);
    expect(ctx.logs.at(-1)).toContain("1 agent(s) not read: the org excludes their repository");
    expect(ctx.cursor).toMatchObject({
      agents: {
        "bc-x": {
          bytes: 0,
          updated: iso(NOW.getTime() - HOUR),
          // Cursor's own clock: the agent's updatedAt, past any run it has so far.
          through: { at: iso(NOW.getTime() - HOUR), id: "\uffff" },
        },
      },
    });

    // Not counted again until the agent changes.
    await poller.run(ctx.context());
    expect(ctx.excludedCount).toBe(1);
    expect(api.calls.filter((c) => c.includes("bc-x"))).toEqual([]);
  });

  it("excludes an agent with several repositories when any is listed", async () => {
    const api = new FakeCursor();
    api.agent(
      "bc-multi",
      iso(NOW.getTime() - HOUR),
      [finished("run-1", 2)],
      [{ url: "https://github.com/example/demo" }, { url: "git@github.com:acme/hr-portal.git" }],
    );
    const ctx = new FakeContext(api);
    ctx.exclude = ["github.com/acme/hr-*"];
    await poller.run(ctx.context());
    expect(ctx.submitted).toEqual([]);
    expect(ctx.excludedCount).toBe(1);
  });

  it("never matches an agent with no repository, or by a folder entry", async () => {
    const api = new FakeCursor();
    api.agent("bc-none", iso(NOW.getTime() - HOUR), [finished("run-1", 2)], []);
    api.agent("bc-a", iso(NOW.getTime() - HOUR), [finished("run-2", 2)]);
    const ctx = new FakeContext(api);
    ctx.exclude = ["/", "~", "~/**", "/**", "/home/*/example/demo"];
    await poller.run(ctx.context());
    expect(ctx.submitted.map((e) => e.session_key).sort()).toEqual(["bc-a", "bc-none"]);
    expect(ctx.excludedCount).toBe(0);
  });

  it("stops new runs of an agent added to the list, keeps what was stored, and never reads runs made while excluded", async () => {
    const api = new FakeCursor();
    api.agent("bc-a", iso(NOW.getTime() - 3 * HOUR), [finished("run-1", 4)]);
    const ctx = new FakeContext(api);
    await poller.run(ctx.context());
    expect(ctx.submitted.map((e) => e.idempotency_key)).toEqual(["cursor-cloud:bc-a/run-1"]);
    const stored = ctx.stored.get("bc-a");

    ctx.exclude = ["example/demo"];
    api.agent("bc-a", iso(NOW.getTime() - 2 * HOUR), [
      finished("run-1", 4),
      finished("run-2", 2.5),
    ]);
    await poller.run(ctx.context());
    expect(ctx.submitted).toHaveLength(1);
    expect(ctx.excludedCount).toBe(1);
    expect(ctx.cursor).toMatchObject({ agents: { "bc-a": { bytes: stored } } });

    // The entry goes: run-2 (made while excluded) is passed over, the next run is appended
    // where the stored session ends.
    ctx.exclude = [];
    api.agent("bc-a", iso(NOW.getTime() + HOUR), [
      finished("run-1", 4),
      finished("run-2", 2.5),
      { ...finished("run-3", 0), createdAt: iso(NOW.getTime() + 0.5 * HOUR) },
    ]);
    await poller.run(ctx.context());
    expect(ctx.submitted.map((e) => e.idempotency_key)).toEqual([
      "cursor-cloud:bc-a/run-1",
      "cursor-cloud:bc-a/run-3",
    ]);
    expect(ctx.submitted[1]?.payload).toMatchObject({ offset: stored });
  });

  it("cuts off on Cursor's clock: a run made in the instant of the cutoff stays passed over", async () => {
    const api = new FakeCursor();
    const at = iso(NOW.getTime() - HOUR);
    api.agent("bc-a", at, [{ ...finished("run-1", 0), createdAt: at }]);
    const ctx = new FakeContext(api);
    ctx.exclude = ["example/demo"];
    await poller.run(ctx.context());
    ctx.exclude = [];
    api.agent("bc-a", iso(NOW.getTime() - 0.5 * HOUR), [
      { ...finished("run-1", 0), createdAt: at },
      { ...finished("run-2", 0), createdAt: iso(NOW.getTime() - 0.5 * HOUR) },
    ]);
    await poller.run(ctx.context());
    expect(ctx.submitted.map((e) => e.idempotency_key)).toEqual(["cursor-cloud:bc-a/run-2"]);
  });

  it("names the project as a laptop names the repository", async () => {
    const api = new FakeCursor();
    api.agent(
      "bc-a",
      iso(NOW.getTime() - HOUR),
      [finished("run-1", 2)],
      [{ url: "https://x-access-token:secret@GitHub.com/acme/app.git" }],
    );
    const ctx = new FakeContext(api);
    await poller.run(ctx.context());
    expect(ctx.submitted[0]?.project).toBe("github.com/acme/app");
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

  it("reads where the stored log ends from the pipeline's refusal", () => {
    expect(expectedOffset("chunk starts at byte 0; the session's log ends at 4096")).toBe(4096);
    expect(expectedOffset("something else")).toBeUndefined();
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
