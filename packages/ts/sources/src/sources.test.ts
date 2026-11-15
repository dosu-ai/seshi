import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type SourceConfig, serverConfigSchema } from "@seshi/config";
import { CheckpointLost, type Connector, type ConnectorContext } from "@seshi/kit";
import type { Envelope } from "@seshi/model";
import {
  addHealth,
  FsStore,
  PreconditionFailed,
  readCheckpoint,
  writeCheckpoint,
  writeFailed,
} from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type SourceError, Sources, type Submitter } from "./sources";

const NOW = new Date("2026-11-14T12:00:00.000Z");
const now = () => NOW;

/** `[[sources]]` as the config parses them. */
function sources(toml: string): SourceConfig[] {
  const text = `[store]\nurl = "file:///tmp/unused"\n${toml}`;
  return loadConfig(serverConfigSchema, {
    file: "seshi.toml",
    fs: { readFile: () => text, mode: () => 0o100600 },
  }).config.sources;
}

const DD = `
[[sources]]
id = "dd-prod"
type = "datadog"
api_key = "k"
app_key = "a"
interval = "2m"

[[sources]]
id = "dd-off"
type = "datadog"
enabled = false
api_key = "k"
app_key = "a"

[[sources]]
id = "claude"
type = "otlp"

[[sources]]
id = "archive"
type = "s3"
url = "s3://elsewhere/sessions"
`;

function envelope(sourceId: string, key: string): Envelope {
  return {
    schema: "seshi/envelope/1",
    source: "datadog",
    source_id: sourceId,
    format: "trajectory",
    session_key: key,
    payload: { kind: "log", encoding: "jsonl", text: "{}", offset: 0 },
    caller: { kind: "service", principal: `svc:${sourceId}` },
    owner: `svc:${sourceId}`,
    owner_basis: "service",
    idempotency_key: `${sourceId}:${key}`,
    received_at: NOW.toISOString(),
  };
}

/** A pipeline that answers `stored` for every envelope, or what `answer` says. */
class FakePipeline implements Submitter {
  readonly envelopes: Envelope[] = [];
  answer: (e: Envelope) => unknown = () => ({ status: "stored" });
  async submit(envelope: Envelope, options?: { onFailure?: string }): Promise<unknown> {
    expect(options?.onFailure).toBe("record");
    this.envelopes.push(envelope);
    return this.answer(envelope);
  }
}

/** A connector whose run is the test's. */
function connector(
  run: (ctx: ConnectorContext) => Promise<unknown>,
  extra: Partial<Connector> = {},
): Connector {
  return {
    kind: "datadog",
    run: (ctx) => run(ctx) as Promise<undefined>,
    ...extra,
  };
}

let dir: string;
let store: FsStore;
let pipeline: FakePipeline;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-sources-"));
  store = new FsStore(dir);
  pipeline = new FakePipeline();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function make(c: Connector, extra: { fetch?: typeof fetch } = {}): Sources {
  return new Sources({ store, pipeline, sources: sources(DD), connectors: [c], now, ...extra });
}

describe("the sources a binary can poll", () => {
  it("lists every configured source, polled when enabled and a connector has its type", () => {
    const s = make(connector(async () => undefined));
    expect(s.list()).toEqual([
      {
        id: "dd-prod",
        type: "datadog",
        enabled: true,
        connector: "datadog",
        polled: true,
        interval_ms: 120_000,
      },
      {
        id: "dd-off",
        type: "datadog",
        enabled: false,
        connector: "datadog",
        polled: false,
        interval_ms: 300_000,
        note: "enabled = false",
      },
      {
        id: "claude",
        type: "otlp",
        enabled: true,
        polled: false,
        note: "pushed to POST /otlp/v1/traces, not polled",
      },
      {
        id: "archive",
        type: "s3",
        enabled: true,
        polled: false,
        note: "no connector for type 's3' in this binary",
      },
    ]);
    expect(s.polled().map((p) => p.id)).toEqual(["dd-prod"]);
  });

  it("refuses two connectors for one type", () => {
    const c = connector(async () => undefined);
    expect(() => new Sources({ store, pipeline, sources: [], connectors: [c, c] })).toThrow(
      /two connectors/,
    );
  });

  it("names the configured sources for an unknown id", () => {
    const s = make(connector(async () => undefined));
    expect(() => s.get("nope")).toThrow(/no source 'nope'.*dd-prod, dd-off, claude, archive/);
    try {
      s.get("nope");
    } catch (err) {
      expect((err as SourceError).code).toBe("unknown_source");
    }
  });
});

describe("a run", () => {
  it("submits through the pipeline, saves the checkpoint, and the next run starts from it", async () => {
    const seen: unknown[] = [];
    const s = make(
      connector(async (ctx) => {
        seen.push(ctx.checkpoint.read());
        expect(ctx.source).toMatchObject({ id: "dd-prod", type: "datadog" });
        expect((ctx.source.config as { interval: number }).interval).toBe(120_000);
        const page = ((ctx.checkpoint.read()?.page as number | undefined) ?? 0) + 1;
        await ctx.submit(envelope("dd-prod", `s${page}a`));
        await ctx.submit(envelope("dd-prod", `s${page}b`));
        await ctx.checkpoint.write({ page });
        return { lag_ms: 42 };
      }),
    );
    const first = await s.run("dd-prod");
    expect(first).toEqual({
      source: "dd-prod",
      started_at: NOW.toISOString(),
      finished_at: NOW.toISOString(),
      outcome: "ok",
      submitted: 2,
      outcomes: { stored: 2 },
      checkpoint_saved: true,
      more: false,
      lag_ms: 42,
    });
    await s.run("dd-prod");
    expect(seen).toEqual([null, { page: 1 }]);
    expect((await readCheckpoint(store, "dd-prod"))?.value.cursor).toEqual({ page: 2 });
    expect(pipeline.envelopes.map((e) => e.session_key)).toEqual(["s1a", "s1b", "s2a", "s2b"]);
  });

  it("counts the pipeline's answers by status, failures included", async () => {
    pipeline.answer = (e) =>
      e.session_key === "bad"
        ? { status: "failed", code: "invalid", message: "x", record: "k" }
        : { status: "filtered" };
    const s = make(
      connector(async (ctx) => {
        await ctx.submit(envelope("dd-prod", "bad"));
        await ctx.submit(envelope("dd-prod", "ok"));
        return { more: true };
      }),
    );
    const report = await s.run("dd-prod");
    expect(report.outcomes).toEqual({ failed: 1, filtered: 1 });
    expect(report.more).toBe(true);
    expect(report.checkpoint_saved).toBe(false);
  });

  it("is discarded when another worker moved the checkpoint since it read it (X7.3)", async () => {
    await writeCheckpoint(store, "dd-prod", { page: 1 }, null);
    let caught: unknown;
    const s = make(
      connector(async (ctx) => {
        await ctx.submit(envelope("dd-prod", "a"));
        // The other worker saves first.
        const other = await readCheckpoint(store, "dd-prod");
        await writeCheckpoint(store, "dd-prod", { page: 9 }, other?.etag ?? null);
        try {
          await ctx.checkpoint.write({ page: 2 });
        } catch (err) {
          caught = err;
        }
        // Swallowing the error does not save the run: nothing more is accepted.
        await expect(ctx.submit(envelope("dd-prod", "b"))).rejects.toBeInstanceOf(CheckpointLost);
        await expect(ctx.checkpoint.write({ page: 3 })).rejects.toBeInstanceOf(CheckpointLost);
        return undefined;
      }),
    );
    const report = await s.run("dd-prod");
    expect(caught).toBeInstanceOf(CheckpointLost);
    expect(report.outcome).toBe("discarded");
    expect(report.error).toMatch(/moved by another worker/);
    expect(report.checkpoint_saved).toBe(false);
    expect(report.submitted).toBe(1);
    expect((await readCheckpoint(store, "dd-prod"))?.value.cursor).toEqual({ page: 9 });
  });

  it("refuses a first checkpoint when another worker wrote one meanwhile", async () => {
    const s = make(
      connector(async (ctx) => {
        expect(ctx.checkpoint.read()).toBeNull();
        await writeCheckpoint(store, "dd-prod", { page: 5 }, null);
        await ctx.checkpoint.write({ page: 1 });
        return undefined;
      }),
    );
    expect((await s.run("dd-prod")).outcome).toBe("discarded");
  });

  it("reports a connector's error and leaves the checkpoint where it was", async () => {
    await writeCheckpoint(store, "dd-prod", { page: 1 }, null);
    const s = make(
      connector(async (ctx) => {
        await ctx.submit(envelope("dd-prod", "a"));
        throw new Error("datadog answered 503");
      }),
    );
    const report = await s.run("dd-prod");
    expect(report).toMatchObject({ outcome: "error", error: "datadog answered 503", submitted: 1 });
    expect((await readCheckpoint(store, "dd-prod"))?.value.cursor).toEqual({ page: 1 });
  });

  it("is an error when the pipeline fails transiently", async () => {
    pipeline.answer = () => {
      throw new PreconditionFailed("k", "the store is busy");
    };
    const s = make(
      connector(async (ctx) => {
        await ctx.submit(envelope("dd-prod", "a"));
        await ctx.checkpoint.write({ page: 1 });
        return undefined;
      }),
    );
    const report = await s.run("dd-prod");
    expect(report.outcome).toBe("error");
    expect(await readCheckpoint(store, "dd-prod")).toBeNull();
  });

  it("keeps the checkpoint behind a transient failure the connector swallowed (X4.8)", async () => {
    await writeCheckpoint(store, "dd-prod", { page: 1 }, null);
    pipeline.answer = (e) => {
      if (e.session_key === "a") throw new PreconditionFailed("k", "the store is busy");
      return { status: "stored" };
    };
    let writeError: unknown;
    const s = make(
      connector(async (ctx) => {
        await ctx.submit(envelope("dd-prod", "a")).catch(() => undefined);
        await ctx.submit(envelope("dd-prod", "b"));
        await ctx.checkpoint.write({ page: 2 }).catch((err) => {
          writeError = err;
        });
        return undefined;
      }),
    );
    const report = await s.run("dd-prod");
    expect(report.outcome).toBe("error");
    expect(report.error).toMatch(/failed transiently/);
    expect(report.checkpoint_saved).toBe(false);
    expect(String(writeError)).toMatch(/not saving the checkpoint/);
    expect((await readCheckpoint(store, "dd-prod"))?.value.cursor).toEqual({ page: 1 });
  });

  it("takes nothing from a connector after its run ended", async () => {
    let late: ConnectorContext | undefined;
    const s = make(
      connector(async (ctx) => {
        late = ctx;
        return undefined;
      }),
    );
    expect((await s.run("dd-prod")).outcome).toBe("ok");
    await expect(late?.submit(envelope("dd-prod", "z"))).rejects.toThrow(/has ended/);
    await expect(late?.checkpoint.write({ page: 9 })).rejects.toThrow(/has ended/);
    expect(pipeline.envelopes).toEqual([]);
    expect(await readCheckpoint(store, "dd-prod")).toBeNull();
  });

  it("refuses an envelope for another source", async () => {
    const s = make(
      connector(async (ctx) => {
        await ctx.submit(envelope("dd-off", "a"));
        return undefined;
      }),
    );
    const report = await s.run("dd-prod");
    expect(report.outcome).toBe("error");
    expect(report.error).toMatch(/submitted an envelope for 'dd-off'/);
    expect(pipeline.envelopes).toEqual([]);
  });

  it("refuses a disabled source unless forced, a pushed one, and one already running", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const s = make(connector(() => gate.then(() => undefined)));
    await expect(s.run("dd-off")).rejects.toMatchObject({ code: "disabled" });
    await expect(s.run("claude")).rejects.toMatchObject({ code: "not_polled" });
    const running = s.run("dd-prod");
    await expect(s.run("dd-prod")).rejects.toMatchObject({ code: "busy" });
    release();
    expect((await running).outcome).toBe("ok");
    const forced = s.run("dd-off", { force: true });
    expect((await forced).outcome).toBe("ok");
  });

  it("gives the connector a fetch tied to the run's signal", async () => {
    const outer = new AbortController();
    const signals: AbortSignal[] = [];
    const fakeFetch = (async (_input: unknown, init?: RequestInit) => {
      signals.push(init?.signal as AbortSignal);
      return new Response("{}");
    }) as unknown as typeof fetch;
    const s = make(
      connector(async (ctx) => {
        await ctx.fetch("https://api.example/x");
        expect(ctx.signal.aborted).toBe(false);
        outer.abort();
        expect(ctx.signal.aborted).toBe(true);
        return undefined;
      }),
      { fetch: fakeFetch },
    );
    await s.run("dd-prod", { signal: outer.signal });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
  });
});

describe("status", () => {
  it("shows the checkpoint, record counts and health of a source and of uploads", async () => {
    const s = make(connector(async () => undefined));
    await writeCheckpoint(store, "dd-prod", { page: 3 }, null, now);
    for (const key of ["a", "b"]) {
      await writeFailed(store, {
        at: NOW.toISOString(),
        source: "dd-prod",
        idempotency_key: key,
        code: "invalid",
        message: "m",
      });
    }
    await addHealth(store, {
      source: "dd-prod",
      day: "2026-11-14",
      instance: "w",
      counts: { stored: 3, failed: 2 },
      at: NOW.toISOString(),
    });
    await addHealth(store, {
      source: "dd-prod",
      day: "2026-11-01",
      instance: "w",
      counts: { stored: 100 },
      at: NOW.toISOString(),
    });
    expect(await s.status("dd-prod")).toMatchObject({
      id: "dd-prod",
      polled: true,
      checkpoint: { updated_at: NOW.toISOString(), cursor: { page: 3 } },
      dropped: 0,
      failed: 2,
      health: { stored: 3, failed: 2 },
    });
    expect((await s.status("dd-prod", { days: 30 })).health).toEqual({ stored: 103, failed: 2 });
    expect(await s.status("upload")).toMatchObject({
      id: "upload",
      polled: false,
      checkpoint: null,
    });
  });
});

describe("rewind (X4.9)", () => {
  it("removes the checkpoint, so the next run starts as the first did", async () => {
    const s = make(connector(async () => undefined));
    await writeCheckpoint(store, "dd-prod", { page: 3 }, null);
    expect(await s.rewind("dd-prod", { dryRun: true })).toEqual({
      source: "dd-prod",
      before: { page: 3 },
      after: null,
      applied: false,
    });
    expect(await readCheckpoint(store, "dd-prod")).not.toBeNull();
    expect((await s.rewind("dd-prod")).applied).toBe(true);
    expect(await readCheckpoint(store, "dd-prod")).toBeNull();
    // Nothing to remove is fine.
    expect((await s.rewind("dd-prod")).before).toBeNull();
  });

  it("rewinds to a time through the connector", async () => {
    const s = make(
      connector(async () => undefined, {
        rewind: (cursor, since) => ({ ...cursor, from: since.toISOString() }),
      }),
    );
    await writeCheckpoint(store, "dd-prod", { from: "2026-11-14T00:00:00.000Z", page: 3 }, null);
    const since = new Date("2026-11-01T00:00:00Z");
    const report = await s.rewind("dd-prod", { since });
    expect(report.after).toEqual({ from: "2026-11-01T00:00:00.000Z", page: 3 });
    expect((await readCheckpoint(store, "dd-prod"))?.value.cursor).toEqual(report.after);
  });

  it("refuses a time the connector cannot rewind to, uploads, and pushed sources", async () => {
    const s = make(connector(async () => undefined));
    await expect(s.rewind("dd-prod", { since: NOW })).rejects.toMatchObject({ code: "no_rewind" });
    await expect(s.rewind("upload")).rejects.toMatchObject({ code: "not_polled" });
    await expect(s.rewind("claude")).rejects.toMatchObject({ code: "not_polled" });
  });
});
