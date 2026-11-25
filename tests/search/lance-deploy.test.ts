/** The LanceDB search backend deployed as F10.6–F10.8 say: one index in the bucket, written by
 * a worker in its own process (the server build's entry point, main-server.ts) and read by an
 * API instance that never writes it. The API answers `GET /v1/search` and `GET
 * /v1/changes/all` from what the worker committed; `seshi search --status`, `--scrub` and
 * `--rebuild --wait` and `seshi doctor --config` run against the same config. On a folder in
 * every run, and on S3 where `SESHI_TEST_S3_*` names one (CI's rustfs). */

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "@seshi/api";
import { HttpSeshi, ServerError } from "@seshi/client";
import { loadServerConfig } from "@seshi/config";
import { buildInstance, type Instance, SEARCH_JOB } from "@seshi/instance";
import { lanceIndex } from "@seshi/lance";
import type { SearchResults } from "@seshi/model";
import { provideLance } from "@seshi/search";
import { buildFormats } from "seshi/integrations";
import { main } from "seshi/main";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

const s3 = {
  endpoint: process.env.SESHI_TEST_S3_ENDPOINT,
  bucket: process.env.SESHI_TEST_S3_BUCKET,
  key: process.env.SESHI_TEST_S3_ACCESS_KEY,
  secret: process.env.SESHI_TEST_S3_SECRET_KEY,
};
const s3Configured = Boolean(s3.endpoint && s3.bucket && s3.key && s3.secret);

interface Variant {
  name: string;
  skip: boolean;
  /** The `[store]` section for a fresh bucket under `dir`. */
  store(dir: string): string;
}

const VARIANTS: Variant[] = [
  {
    name: "a folder",
    skip: false,
    store: (dir) => `[store]\nurl = "file://${join(dir, "bucket")}"\n`,
  },
  {
    name: "S3",
    skip: !s3Configured,
    store: () =>
      [
        "[store]",
        `url = "s3://${s3.bucket}/lance-deploy-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}"`,
        `endpoint = "${s3.endpoint}"`,
        'region = "us-east-1"',
        `credentials = { access_key_id = "${s3.key}", secret_access_key = "${s3.secret}" }`,
        "",
      ].join("\n"),
  },
];

const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;
function log(prompt: string): string {
  const ts = "2026-11-01T10:00:00Z";
  return (
    line({ role: "meta", source: "trajectory" }) +
    line({ role: "user", content: `${prompt} ${"context ".repeat(260)}`, timestamp: ts }) +
    line({ role: "assistant", content: "on it", timestamp: ts })
  );
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
    if (Date.now() > end) {
      throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
    }
    await Bun.sleep(200);
  }
}

/** `seshi …` in this process, as the server build runs it (LanceDB provided). */
async function seshi(
  argv: string[],
  env: Record<string, string>,
): Promise<{ code: number | undefined; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {
    env,
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    tty: { stdout: false, stdin: false },
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

provideLance(lanceIndex);

describe.each(VARIANTS)("LanceDB search served from $name", (variant) => {
  let dir: string;
  let configPath: string;
  let env: Record<string, string>;
  let api: Instance;
  let worker: Bun.Subprocess<"ignore", "pipe", "pipe">;
  let workerLog = "";
  let as: (token: string, user?: string) => HttpSeshi;
  let orgKey: string;
  let adminToken: string;

  beforeAll(async () => {
    if (variant.skip) return;
    dir = mkdtempSync(join(tmpdir(), "seshi-lance-deploy-"));
    configPath = join(dir, "seshi.toml");
    writeFileSync(
      configPath,
      [
        variant.store(dir),
        "[search]",
        'backend = "lance"',
        'interval = "200ms"',
        "",
        "[search.lance]",
        // Every read sees the worker's last commit, so the test need not wait 5 s for it.
        'read_consistency = "0s"',
        "",
        "[worker]",
        'heartbeat_interval = "1s"',
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    env = { HOME: dir, PATH: process.env.PATH ?? "" };
    const config = loadServerConfig({ configFlag: configPath, env }).config;

    // The API instance: it writes the bucket (uploads) but only reads the index.
    api = await buildInstance(config, {
      formats: buildFormats(),
      roles: ["api"],
      id: "api",
      env,
    });
    const app = createApp(api);
    as = (token, user) =>
      new HttpSeshi({
        server: "http://seshi.test",
        token,
        ...(user ? { user } : {}),
        fetch: (url, init) => app.fetch(new Request(url, init)),
      });
    const init = await api.auth.initAdmin({ owner: "ops" });
    orgKey = init.org_key?.token as string;
    adminToken = init.admin?.token as string;

    // The worker: the server build's entry point in a process of its own.
    worker = Bun.spawn(
      [
        process.execPath,
        "run",
        join(ROOT, "apps/seshi/src/main-server.ts"),
        "serve",
        "--config",
        configPath,
        "--roles",
        "worker",
        "--listen",
        "127.0.0.1:0",
      ],
      { cwd: dir, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    for (const stream of [worker.stdout, worker.stderr]) {
      void (async () => {
        for await (const chunk of stream) workerLog += new TextDecoder().decode(chunk);
      })();
    }
  }, 60_000);

  afterAll(async () => {
    if (variant.skip) return;
    worker?.kill();
    await worker?.exited;
    await api?.close(1000);
    rmSync(dir, { recursive: true, force: true });
  });

  async function search(q: string): Promise<SearchResults | undefined> {
    try {
      return await as(orgKey, "alice").search({ q });
    } catch (err) {
      // 503 while the worker builds the first generation.
      if (err instanceof ServerError && err.status === 503) return undefined;
      throw err;
    }
  }

  it.skipIf(variant.skip)(
    "the API instance only reads; the worker's index answers its searches and feed",
    async () => {
      expect(api.search?.shared).toBe(true);
      expect(api.jobs.list().map((j) => j.name)).not.toContain(SEARCH_JOB);
      await expect(api.search?.run()).rejects.toThrow(/the worker does/);

      await as(orgKey, "alice").ingest({
        format: "trajectory",
        session_id: "pay",
        transcript: log("deploy the payments service"),
      });
      await as(orgKey, "bob").ingest({
        format: "trajectory",
        session_id: "docs",
        transcript: log("deploy the docs site"),
      });

      const found = await until(async () => {
        const r = await search("deploy");
        return r && r.total === 2 ? r : undefined;
      }, "the worker to index both sessions").catch((err) => {
        throw new Error(`${(err as Error).message}\nworker:\n${workerLog}`);
      });
      expect(found.results.map((r) => r.session_id).sort()).toEqual(["docs", "pay"]);
      expect(found.capped).toBeUndefined();
      expect((await search("payments"))?.results.map((r) => r.session_id)).toEqual(["pay"]);

      // Every owner's feed, from the index's copy of it, through the read-only instance.
      const service = await api.auth.issue(
        { kind: "service", service: "adx", scopes: ["sessions:read", "search"] },
        await api.auth.authenticate(adminToken),
      );
      const feed = await until(async () => {
        const page = await as(service.token).allChanges();
        return page.entries.length >= 2 ? page : undefined;
      }, "the cross-owner feed");
      expect(feed.entries.map((e) => `${e.owner}/${e.entry.session_id}`).sort()).toEqual([
        "alice/pay",
        "bob/docs",
      ]);

      // A later upload reaches the API within read_consistency of the worker's commit.
      await as(orgKey, "alice").ingest({
        format: "trajectory",
        session_id: "late",
        transcript: log("rollback the payments deploy"),
      });
      await until(async () => {
        const r = await search("rollback");
        return r?.results.some((x) => x.session_id === "late") ? r : undefined;
      }, "the later session");
    },
    120_000,
  );

  it.skipIf(variant.skip)(
    "seshi search --status, --scrub and --rebuild --wait, and seshi doctor --config",
    async () => {
      await until(async () => ((await search("deploy"))?.total ? true : undefined), "ready");

      const status = await seshi(["search", "--status", "--config", configPath, "--json"], env);
      expect(status.code, status.err).toBe(0);
      const before = JSON.parse(status.out);
      expect(before).toMatchObject({ backend: "lance", ready: true });
      expect(before.location).not.toMatch(/secret|rustfsadmin/);
      expect(typeof before.generation).toBe("string");

      const scrub = await seshi(["search", "--scrub", "--config", configPath, "--json"], env);
      expect(scrub.code, scrub.err).toBe(0);
      expect(JSON.parse(scrub.out)).toEqual({ scrub: "requested" });

      const rebuilt = await seshi(
        ["search", "--rebuild", "--wait", "--config", configPath, "--json"],
        env,
      );
      expect(rebuilt.code, `${rebuilt.err}\nworker:\n${workerLog}`).toBe(0);
      const after = JSON.parse(rebuilt.out);
      expect(after.generation).toBe(after.rebuilt);
      expect(after.generation).not.toBe(before.generation);
      expect(after.building).toBeUndefined();
      // The rebuilt generation answers the API instance.
      await until(async () => {
        const r = await search("deploy");
        return r && r.total >= 2 ? r : undefined;
      }, "searches from the new generation");

      // A second indexer beside the running worker is refused: one writer (F10.8).
      const refused = await seshi(["sync", "search", "--config", configPath, "--json"], env);
      expect(refused.code).toBe(3);
      expect(JSON.parse(refused.err)).toMatchObject({ error: { code: "worker_running" } });

      const doctor = await seshi(["doctor", "--config", configPath, "--json"], env);
      expect(doctor.code, doctor.out + doctor.err).toBe(0);
      const checks = JSON.parse(doctor.out).server as { id: string; status: string }[];
      expect(checks.map((c) => [c.id, c.status])).toEqual([
        ["search", "ok"],
        ["search-write", "ok"],
        ["search-fresh", "ok"],
      ]);
      if (variant.name === "a folder") {
        // The index is in the bucket, under search/<deployment>/ (F10.9).
        expect(readdirSync(join(dir, "bucket", "search"))).toEqual([api.deployment]);
      }

      // With the worker gone, a deployment that runs its jobs from cron runs the same pass
      // (X7.1), and carries out a rebuild asked for meanwhile.
      worker.kill();
      await worker.exited;
      const live = JSON.parse(
        (await seshi(["search", "--status", "--config", configPath, "--json"], env)).out,
      ).generation;
      const asked = await seshi(["search", "--rebuild", "--config", configPath, "--json"], env);
      expect(JSON.parse(asked.out)).toMatchObject({ rebuild: "requested" });
      const pass = await until(async () => {
        const run = await seshi(["sync", "search", "--config", configPath, "--json"], env);
        return run.code === 0 ? run : undefined;
      }, "the worker's heartbeat to go stale");
      expect(JSON.parse(pass.out)).toMatchObject({ caught_up: true });
      // The pass took the request and started the rebuild; the next one finishes it.
      await seshi(["sync", "search", "--config", configPath, "--json"], env);
      const rebuiltByCron = JSON.parse(
        (await seshi(["search", "--status", "--config", configPath, "--json"], env)).out,
      );
      expect(rebuiltByCron.generation).not.toBe(live);
      expect(rebuiltByCron).toMatchObject({ ready: true });
      expect(rebuiltByCron.requested).toBeUndefined();
    },
    120_000,
  );
});
