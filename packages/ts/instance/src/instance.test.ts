import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type ServerConfig, serverConfigSchema } from "@seshi/config";
import { BUILTIN_FORMATS, FormatRegistry } from "@seshi/formats";
import type { Connector } from "@seshi/kit";
import type { Envelope } from "@seshi/model";
import { MemoryHealthCounters } from "@seshi/pipeline";
import {
  addHealth,
  FsStore,
  getBytes,
  keys,
  readCheckpoint,
  readHealth,
  readHeartbeat,
  readLayout,
  writeFailed,
  writeHeartbeat,
} from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { heartbeatFresh } from "./builtin-jobs";
import {
  buildInstance,
  defaultInstanceId,
  Instance,
  InstanceError,
  readRedactionPacks,
  storeOptions,
} from "./instance";
import { assessWorker } from "./status";

const formats = new FormatRegistry([...BUILTIN_FORMATS]);
const NOW = new Date("2026-11-14T12:00:00.000Z");

let dir: string;
let url: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-instance-"));
  url = `file://${join(dir, "bucket")}`;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function config(toml = "", env: Record<string, string> = {}): ServerConfig {
  const text = `[store]\nurl = "${url}"\n${toml}`;
  return loadConfig(serverConfigSchema, {
    file: "seshi.toml",
    env,
    fs: { readFile: () => text, mode: () => 0o100600 },
  }).config;
}

const DD = `
[[sources]]
id = "dd"
type = "datadog"
api_key = "k"
app_key = "a"
interval = 30
`;

/** A connector that submits one envelope per run (a payload no adapter reads, so the pipeline
 * records a failure) and saves a page counter. */
function pagingConnector(): Connector & { runs: number } {
  const connector = {
    kind: "datadog",
    runs: 0,
    async run(ctx: Parameters<Connector["run"]>[0]) {
      connector.runs++;
      const page = ((ctx.checkpoint.read()?.page as number | undefined) ?? 0) + 1;
      const envelope: Envelope = {
        schema: "seshi/envelope/1",
        source: "datadog",
        source_id: ctx.source.id,
        format: "trajectory",
        session_key: `s${page}`,
        payload: { kind: "log", encoding: "jsonl", text: "not json\n", offset: 0 },
        caller: { kind: "service", principal: `svc:${ctx.source.id}` },
        owner: `svc:${ctx.source.id}`,
        owner_basis: "service",
        idempotency_key: `dd:${page}`,
        received_at: ctx.now().toISOString(),
      };
      await ctx.submit(envelope);
      await ctx.checkpoint.write({ page });
      return undefined;
    },
  };
  return connector;
}

async function until(check: () => Promise<boolean> | boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

describe("buildInstance", () => {
  it("opens the bucket, writes the layout marker, and probes the static tokens' owners", async () => {
    const instance = await buildInstance(
      config('[auth.tokens]\nalice = "alice-token-0123456789"\n'),
      { formats, newDeploymentId: () => "dep-1", env: {} },
    );
    expect(instance.deployment).toBe("dep-1");
    expect((await readLayout(instance.store))?.deployment_id).toBe("dep-1");
    expect(await getBytes(instance.store, keys.probe("alice"))).not.toBeNull();
    expect(instance.storage).toEqual({ url });
    expect(instance.roles).toEqual(["api", "worker"]);
    expect(instance.api && instance.worker).toBe(true);
    await instance.close();
  });

  it("refuses another deployment's or org's bucket, and a sessiondb prefix (X1.4, X1.5)", async () => {
    await (
      await buildInstance(config('deployment_id = "prod"\norg = "acme"\n'), { formats, env: {} })
    ).close();
    await expect(
      buildInstance(config('deployment_id = "staging"\n'), { formats, env: {} }),
    ).rejects.toThrow(/cannot use .*belongs to deployment/);
    await expect(buildInstance(config('org = "globex"\n'), { formats, env: {} })).rejects.toThrow(
      /belongs to org/,
    );
    mkdirSync(join(dir, "old"), { recursive: true });
    writeFileSync(
      join(dir, "old", "sessionstorage.json"),
      JSON.stringify({ schema: "sessionstorage/layout/1", created_at: "x", created_by: "y" }),
    );
    await expect(
      buildInstance(
        loadConfig(serverConfigSchema, {
          env: { SESHI_STORE__URL: `file://${join(dir, "old")}` },
        }).config,
        { formats, env: {} },
      ),
    ).rejects.toBeInstanceOf(InstanceError);
  });

  it("refuses a store URL it cannot open and a redaction pack it cannot use", async () => {
    await expect(
      buildInstance(
        loadConfig(serverConfigSchema, { env: { SESHI_STORE__URL: "r2://bucket/p" } }).config,
        { formats, env: {} },
      ),
    ).rejects.toThrow(/r2:\/\/ needs an account id/);
    const pack = join(dir, "bad.json");
    writeFileSync(pack, JSON.stringify({ patterns: ["("] }));
    await expect(readRedactionPacks([pack])).rejects.toThrow(`${pack} (pack legacy): `);
    await expect(readRedactionPacks([join(dir, "missing.json")])).rejects.toThrow(
      /cannot read redaction pack/,
    );
    expect((await readRedactionPacks([])).packs).toEqual([]);
    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify({ patterns: ["ACME-\\d+"] }));
    const merged = await readRedactionPacks([good, good]);
    expect(merged.packs.map((p) => p.id)).toEqual(["legacy"]);
    expect(merged.text[0]?.matchers).toHaveLength(2);
    const toml = join(dir, "acme.toml");
    writeFileSync(
      toml,
      'id = "acme"\n[[rules]]\nid = "acme-key"\npattern = "ACME-[0-9]{4}"\ntests.match = ["ACME-12"]\n',
    );
    await expect(readRedactionPacks([toml])).rejects.toThrow(
      `${toml} (pack acme): acme-key: does not match its test string "ACME-12"`,
    );
  });

  it("refuses auth settings serve would refuse", () => {
    const store = new FsStore(url);
    expect(
      () =>
        new Instance({
          config: config('[auth.tokens]\nalice = "short"\n'),
          store,
          storage: { url },
          formats,
          deployment: "d",
        }),
    ).toThrow(InstanceError);
  });

  it("refuses two integrations' connectors for one source type", async () => {
    const c = pagingConnector();
    await expect(
      buildInstance(config(), {
        formats,
        env: {},
        integrations: [
          { name: "a", connectors: [c] },
          { name: "b", connectors: [c] },
        ],
      }),
    ).rejects.toThrow(/provided by both/);
  });
});

describe("an Instance", () => {
  function make(toml = "", extra: Partial<ConstructorParameters<typeof Instance>[0]> = {}) {
    return new Instance({
      config: config(toml),
      store: new FsStore(url),
      storage: { url },
      formats,
      deployment: "d",
      now: () => NOW,
      ...extra,
    });
  }

  it("keeps nothing at module level: two instances share no state (X1.2)", async () => {
    const a = make('[auth.tokens]\nalice = "alice-token-0123456789"\n', { id: "a" });
    const b = new Instance({
      config: loadConfig(serverConfigSchema, {
        env: { SESHI_STORE__URL: `file://${join(dir, "other")}` },
      }).config,
      store: new FsStore(`file://${join(dir, "other")}`),
      storage: { url: "other" },
      formats,
      deployment: "e",
      id: "b",
    });
    expect(a.auth).not.toBe(b.auth);
    expect(a.pipeline).not.toBe(b.pipeline);
    expect(a.jobs).not.toBe(b.jobs);
    expect((await a.auth.authenticate("alice-token-0123456789")).owner).toBe("alice");
    await expect(b.auth.authenticate("alice-token-0123456789")).rejects.toThrow();
  });

  it("takes the instance id from config, else the host name; the process id is unique", () => {
    expect(make('[server]\ninstance_id = "api-1"\n').id).toBe("api-1");
    const first = make();
    expect(first.id).toBe(defaultInstanceId());
    expect(first.process).toMatch(new RegExp(`^${first.id}-[0-9a-f]{8}$`));
    expect(make().process).not.toBe(first.process);
    expect(defaultInstanceId("web.example.com")).toBe("web-example-com");
    expect(defaultInstanceId("...")).toBe("seshi");
    expect(defaultInstanceId("x".repeat(80))).toHaveLength(64);
  });

  it("registers the built-in jobs, and pollers only for polled sources", () => {
    const instance = make(DD, { connectors: [pagingConnector()] });
    expect(instance.jobs.list().map((j) => j.name)).toEqual([
      "heartbeat",
      "retention",
      "source:dd",
      "assembler",
    ]);
    expect(
      make(DD)
        .jobs.list()
        .map((j) => j.name),
    ).toEqual(["heartbeat", "retention", "assembler"]);
    const extra = make("", {
      jobs: [
        () => [
          { name: "x", kind: "x", placement: "every", intervalMs: 5, run: async () => undefined },
        ],
      ],
    });
    expect(extra.jobs.list().map((j) => j.name)).toContain("x");
  });

  it("writes sessions as a local owner in local mode", async () => {
    const instance = make();
    const db = instance.localSessions("acme");
    expect(db.writer).toEqual({ kind: "local", principal: "acme", source_id: "upload" });
    expect(() => instance.localSessions("no/slash")).toThrow();
  });

  it("flushes source health on close, and refuses to start once closed", async () => {
    const health = new MemoryHealthCounters();
    const instance = make("", { health });
    let flushed = false;
    health.flush = async () => {
      flushed = true;
    };
    await instance.close();
    expect(flushed).toBe(true);
    expect(() => instance.start()).toThrow(/closed/);
    await instance.close();
  });

  it("counts into its own shard named by the instance id", async () => {
    const instance = make('[server]\ninstance_id = "api-1"\n');
    instance.health.count("upload", "stored");
    await instance.close();
    expect(await readHealth(instance.store, "upload")).toEqual([
      { day: "2026-11-14", counts: { stored: 1 } },
    ]);
    expect(
      await getBytes(instance.store, keys.health("upload", "2026-11-14", "api-1")),
    ).not.toBeNull();
  });

  it("maps [store] to the bucket client's options, secrets revealed", () => {
    const c = loadConfig(serverConfigSchema, {
      env: {
        SESHI_STORE__URL: "s3://b/p",
        SESHI_STORE__REGION: "eu-west-1",
        SESHI_STORE__CREDENTIALS__ACCESS_KEY_ID: "AKIA",
        SESHI_STORE__CREDENTIALS__SECRET_ACCESS_KEY: "shh",
      },
    }).config;
    expect(storeOptions(c)).toEqual({
      region: "eu-west-1",
      credentials: { accessKeyId: "AKIA", secretAccessKey: "shh" },
    });
  });
});

describe("the worker (X7)", () => {
  it("polls each source on its interval, writes the heartbeat, and status shows both", async () => {
    const connector = pagingConnector();
    const instance = await buildInstance(config(`${DD}\n[worker]\nheartbeat_interval = 200\n`), {
      formats,
      env: {},
      connectors: [connector],
      id: "w1",
    });
    instance.start();
    try {
      await until(
        async () =>
          ((await readCheckpoint(instance.store, "dd"))?.value.cursor.page as number) >= 3,
      );
      await until(
        async () =>
          (await readHeartbeat(instance.store))?.value.jobs?.["source:dd"]?.last_outcome === "ok",
      );
      const beat = (await readHeartbeat(instance.store))?.value;
      expect(beat).toMatchObject({
        instance: instance.process,
        host: "w1",
        roles: ["api", "worker"],
      });
      const status = await instance.status();
      expect(status.worker.state).toBe("running");
      const job = status.jobs.find((j) => j.name === "source:dd");
      expect(job).toMatchObject({ kind: "poller", source: "dd", placement: "worker" });
      expect(job?.last?.last_outcome).toBe("ok");
      expect(job?.backlog?.checkpoint_age_ms).toBeGreaterThanOrEqual(0);
      expect(job?.failed).toBeGreaterThanOrEqual(3);
      const dd = status.sources.find((s) => s.id === "dd");
      expect(dd?.failed).toBeGreaterThanOrEqual(3);
      expect(status.sources.map((s) => s.id)).toEqual(["dd", "upload"]);
      expect(status.warnings.some((w) => w.includes("seshi sync failed dd"))).toBe(true);
    } finally {
      await instance.close();
    }
    // Stopped: no more runs.
    const runs = connector.runs;
    await Bun.sleep(80);
    expect(connector.runs).toBe(runs);
  });

  it("runs no worker job on an api-only instance", async () => {
    const connector = pagingConnector();
    const instance = await buildInstance(config(DD), {
      formats,
      env: {},
      connectors: [connector],
      roles: ["api"],
    });
    instance.start();
    await Bun.sleep(80);
    await instance.close();
    expect(connector.runs).toBe(0);
    expect(await readHeartbeat(instance.store)).toBeNull();
  });

  it("spots a second worker from the heartbeat (X7.3)", async () => {
    // Long enough that a loaded test machine still writes each beat within its fresh window.
    const toml = "[worker]\nheartbeat_interval = 200\n";
    const one = await buildInstance(config(toml), { formats, env: {}, id: "one" });
    const two = await buildInstance(config(toml), { formats, env: {}, id: "two" });
    one.start();
    two.start();
    try {
      // Whichever wrote last, the heartbeat names the other.
      for (const instance of [one, two]) {
        await until(async () => (await instance.status()).worker.state === "several");
      }
      const status = await two.status();
      expect(status.warnings.join("\n")).toMatch(/2 workers are running/);
    } finally {
      await Promise.all([one.close(), two.close()]);
    }
  });

  it("does not take its predecessor's last heartbeat for a second worker", async () => {
    const store = new FsStore(url);
    // The worker that ran before a restart, whose last heartbeat is still fresh.
    await writeHeartbeat(store, {
      instance: "old-1",
      version: "0.9.0",
      roles: ["worker"],
      started_at: new Date(Date.now() - 60_000).toISOString(),
      at: new Date(Date.now() - 1_000).toISOString(),
      interval_ms: 60_000,
    });
    const instance = await buildInstance(config(), { formats, env: {} });
    await instance.jobs.runNow("heartbeat");
    const beat = (await readHeartbeat(instance.store))?.value;
    expect(beat?.instance).toBe(instance.process);
    expect(beat?.others).toBeUndefined();
    expect((await instance.status()).worker.state).toBe("running");
    await instance.close();
  });

  it("prunes old records and health days on the retention job", async () => {
    const instance = await buildInstance(
      config('[records]\nfailed_retention = "1d"\nhealth_retention = "2d"\n'),
      { formats, env: {}, now: () => NOW },
    );
    await writeFailed(instance.store, {
      at: "2026-11-01T00:00:00.000Z",
      source: "upload",
      idempotency_key: "old",
      code: "invalid",
      message: "m",
    });
    await writeFailed(instance.store, {
      at: NOW.toISOString(),
      source: "upload",
      idempotency_key: "new",
      code: "invalid",
      message: "m",
    });
    for (const day of ["2026-11-10", "2026-11-13", "2026-11-14"]) {
      await addHealth(instance.store, {
        source: "upload",
        day,
        instance: "x",
        counts: { stored: 1 },
        at: NOW.toISOString(),
      });
    }
    const record = await instance.jobs.runNow("retention");
    expect(record.last_summary).toEqual({ dropped: 0, failed: 1, health: 1 });
    expect((await readHealth(instance.store, "upload")).map((d) => d.day)).toEqual([
      "2026-11-13",
      "2026-11-14",
    ]);
    await instance.close();
  });
});

describe("assessWorker (X7.5)", () => {
  const beat = (at: string, others?: { instance: string; at: string }[]) => ({
    schema: "seshi/heartbeat/1" as const,
    instance: "w-1",
    version: "0.9.0",
    roles: ["worker"],
    started_at: "2026-11-14T11:00:00.000Z",
    at,
    interval_ms: 60_000,
    ...(others ? { others } : {}),
  });

  it("says never, running, stopped or several", () => {
    expect(assessWorker(null, NOW, 60_000).worker.state).toBe("never");
    expect(assessWorker(beat("2026-11-14T11:59:30.000Z"), NOW, 60_000).worker).toMatchObject({
      state: "running",
      age_ms: 30_000,
    });
    const stopped = assessWorker(beat("2026-11-14T11:50:00.000Z"), NOW, 60_000);
    expect(stopped.worker.state).toBe("stopped");
    expect(stopped.warnings[0]).toMatch(/last wrote its heartbeat 10m ago/);
    const several = assessWorker(
      beat("2026-11-14T11:59:30.000Z", [
        { instance: "w-2", at: "2026-11-14T11:59:00.000Z" },
        { instance: "w-3", at: "2026-11-14T11:00:00.000Z" },
      ]),
      NOW,
      60_000,
    );
    expect(several.worker.state).toBe("several");
    expect(several.worker.others).toEqual([{ instance: "w-2", at: "2026-11-14T11:59:00.000Z" }]);
  });

  it("calls a heartbeat fresh for three intervals", () => {
    expect(heartbeatFresh("2026-11-14T11:57:01.000Z", 60_000, NOW)).toBe(true);
    expect(heartbeatFresh("2026-11-14T11:57:00.000Z", 60_000, NOW)).toBe(false);
    expect(heartbeatFresh("garbage", 60_000, NOW)).toBe(false);
  });

  it("is read from the bucket by any instance", async () => {
    const store = new FsStore(url);
    const { schema: _schema, ...stale } = beat("2026-11-14T11:40:00.000Z");
    await writeHeartbeat(store, stale);
    const instance = new Instance({
      config: config(),
      store,
      storage: { url },
      formats,
      deployment: "d",
      roles: ["api"],
      now: () => NOW,
    });
    expect((await instance.status()).worker.state).toBe("stopped");
  });
});
