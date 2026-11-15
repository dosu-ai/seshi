/** `ConnectorContext.fail`: a connector's own failure records (X4.8), for what never became an
 * envelope. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, serverConfigSchema } from "@seshi/config";
import type { Connector, ConnectorContext } from "@seshi/kit";
import { FsStore, listRecords, readCheckpoint, type Store } from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Sources } from "./sources";

const NOW = new Date("2026-11-14T12:00:00.000Z");
const config = loadConfig(serverConfigSchema, {
  file: "seshi.toml",
  fs: {
    readFile: () =>
      `[store]\nurl = "file:///tmp/unused"\n[[sources]]\nid = "drop"\ntype = "s3"\nurl = "s3://elsewhere/x"\n`,
    mode: () => 0o100600,
  },
}).config;

let dir: string;
let store: FsStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-fail-"));
  store = new FsStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function sources(run: (ctx: ConnectorContext) => Promise<unknown>, over: Store = store) {
  const counted: string[] = [];
  const connector: Connector = { kind: "s3", run: (ctx) => run(ctx) as Promise<undefined> };
  const s = new Sources({
    store: over,
    pipeline: {
      submit: async () => ({ status: "stored" }),
      health: { count: (id) => counted.push(id) },
    },
    sources: config.sources,
    connectors: [connector],
    now: () => NOW,
  });
  return { s, counted };
}

describe("a connector's failure records", () => {
  it("writes a failure record as the source's service account and counts it", async () => {
    const { s, counted } = sources(async (ctx) => {
      const key = await ctx.fail?.({
        code: "unknown_format",
        message: `no format matches ${"x".repeat(400)}`,
        session_key: "a.jsonl",
        idempotency_key: "s3://elsewhere/x/a.jsonl#e1",
        provenance: { object_key: "s3://elsewhere/x/a.jsonl", etag: "e1" },
      });
      expect(key).toContain("sources/drop/failed/");
      await ctx.checkpoint.write({ v: 1 });
    });
    const report = await s.run("drop");
    expect(report).toMatchObject({
      outcome: "ok",
      outcomes: { failed: 1 },
      checkpoint_saved: true,
    });
    expect(counted).toEqual(["drop"]);
    const [record] = (await listRecords(store, "failed", "drop")).records;
    expect(record?.record).toMatchObject({
      schema: "seshi/failed/1",
      at: NOW.toISOString(),
      source: "drop",
      source_kind: "s3",
      owner: "svc:drop",
      session_key: "a.jsonl",
      idempotency_key: "s3://elsewhere/x/a.jsonl#e1",
      provenance: { object_key: "s3://elsewhere/x/a.jsonl", etag: "e1" },
      code: "unknown_format",
    });
    expect((record?.record as { message?: string } | undefined)?.message).toHaveLength(300);
  });

  it("refuses once the run has ended", async () => {
    let kept: ConnectorContext | undefined;
    const { s } = sources(async (ctx) => {
      kept = ctx;
    });
    await s.run("drop");
    await expect(kept?.fail?.({ code: "x", message: "m", idempotency_key: "k" })).rejects.toThrow(
      /has ended/,
    );
  });

  it("is transient when the record cannot be written: the checkpoint stays", async () => {
    const broken: Store = {
      url: store.url,
      get: (k) => store.get(k),
      stat: (k) => store.stat(k),
      list: (p, o) => store.list(p, o),
      delete: (k, o) => store.delete(k, o),
      put: async (k, b, o) => {
        if (k.includes("/failed/")) throw new Error("bucket unavailable");
        return store.put(k, b, o);
      },
    };
    const { s } = sources(async (ctx) => {
      await ctx.fail?.({ code: "x", message: "m", idempotency_key: "k" }).catch(() => undefined);
      await ctx.checkpoint.write({ v: 1 });
    }, broken);
    const report = await s.run("drop");
    expect(report.outcome).toBe("error");
    expect(report.error).toContain("bucket unavailable");
    expect(await readCheckpoint(store, "drop")).toBeNull();
  });
});
