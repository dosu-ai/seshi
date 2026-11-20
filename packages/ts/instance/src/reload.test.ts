import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadServerConfig, type ServerConfig } from "@seshi/config";
import { BUILTIN_FORMATS, FormatRegistry } from "@seshi/formats";
import type { Connector } from "@seshi/kit";
import { getTrace, type Reviewer, uploadEnvelope } from "@seshi/pipeline";
import { fakeProviderServer, KeywordModel } from "@seshi/review/testing";
import { archiveId, listReviews, readCheckpoint, readMetadata } from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildInstance, type Instance, readRedactionPacks } from "./instance";
import { canonical, differences, diffSources, effectiveConfig } from "./reload";

const formats = new FormatRegistry([...BUILTIN_FORMATS]);

let dir: string;
let file: string;
let bucket: string;
let open: Instance[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-reload-"));
  file = join(dir, "seshi.toml");
  bucket = `file://${join(dir, "bucket")}`;
  open = [];
});
afterEach(async () => {
  for (const instance of open) await instance.close(1000);
  rmSync(dir, { recursive: true, force: true });
});

/** Write the config file: `[store]` and `[search]` first, then `toml`. */
function writeConfig(toml = ""): void {
  writeFileSync(file, `[store]\nurl = "${bucket}"\n[search]\nenabled = false\n${toml}`, {
    mode: 0o600,
  });
}

const load = (): ServerConfig => loadServerConfig({ configFlag: file, env: {} }).config;

function dd(id: string, extra = ""): string {
  return `\n[[sources]]\nid = "${id}"\ntype = "datadog"\napi_key = "k"\napp_key = "a"\ninterval = "1h"\n${extra}`;
}

/** A datadog connector that submits nothing and moves a page counter on each run; with
 * `hold`, a run waits until it is aborted. */
function pager(options: { hold?: boolean } = {}): Connector & {
  runs: Record<string, number>;
  aborted: string[];
} {
  const connector = {
    kind: "datadog",
    runs: {} as Record<string, number>,
    aborted: [] as string[],
    async run(ctx: Parameters<Connector["run"]>[0]) {
      const id = ctx.source.id;
      connector.runs[id] = (connector.runs[id] ?? 0) + 1;
      const page = ((ctx.checkpoint.read()?.page as number | undefined) ?? 0) + 1;
      await ctx.checkpoint.write({ page });
      if (options.hold) {
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) resolve();
          else ctx.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        connector.aborted.push(id);
      }
      return undefined;
    },
  };
  return connector;
}

async function start(extra: Partial<Parameters<typeof buildInstance>[1]> = {}): Promise<Instance> {
  const config = load();
  const instance = await buildInstance(config, {
    formats,
    env: {},
    loadConfig: load,
    redaction: await readRedactionPacks(config.redaction.packs),
    ...extra,
  });
  open.push(instance);
  return instance;
}

const page = async (instance: Instance, id: string) =>
  (await readCheckpoint(instance.store, id))?.value.cursor.page;

const pollers = (instance: Instance) =>
  instance.jobs
    .list()
    .filter((job) => job.kind === "poller")
    .map((job) => `${job.name}@${job.intervalMs}`)
    .sort();

describe("reloading sources", () => {
  it("starts added sources, restarts changed ones, stops removed ones, and keeps every checkpoint", async () => {
    writeConfig(dd("a") + dd("b"));
    const connector = pager();
    const instance = await start({ connectors: [connector] });
    expect(pollers(instance)).toEqual(["source:a@3600000", "source:b@3600000"]);
    await instance.jobs.runNow("source:a");
    await instance.jobs.runNow("source:b");
    expect([await page(instance, "a"), await page(instance, "b")]).toEqual([1, 1]);

    // a changes (its interval), b stays, c is new.
    writeConfig(dd("a").replace('"1h"', '"30m"') + dd("b") + dd("c"));
    const first = await instance.reload("manual");
    expect(first).toMatchObject({
      outcome: "applied",
      generation: 2,
      changed: ["sources"],
      sources: { added: ["c"], removed: [], changed: ["a"], unchanged: ["b"] },
      restart_required: [],
    });
    expect(pollers(instance)).toEqual(["source:a@1800000", "source:b@3600000", "source:c@3600000"]);
    expect(instance.sources.list().map((s) => s.id)).toEqual(["a", "b", "c"]);
    // The restart picked up where a was: its checkpoint was not reset.
    expect(await page(instance, "a")).toBe(1);
    await instance.jobs.runNow("source:a");
    expect(await page(instance, "a")).toBe(2);
    // b's job is the one that was running, with its record.
    expect(instance.jobs.snapshot()["source:b"]?.runs).toBe(1);

    // Remove a; its checkpoint stays in the store.
    writeConfig(dd("b") + dd("c"));
    const second = await instance.reload("manual");
    expect(second.sources).toEqual({
      added: [],
      removed: ["a"],
      changed: [],
      unchanged: ["b", "c"],
    });
    expect(pollers(instance)).toEqual(["source:b@3600000", "source:c@3600000"]);
    expect(() => instance.sources.get("a")).toThrow(/no source 'a'/);
    expect(await page(instance, "a")).toBe(2);

    // Adding it back reads on from there.
    writeConfig(dd("a") + dd("b") + dd("c"));
    expect((await instance.reload("manual")).sources?.added).toEqual(["a"]);
    await instance.jobs.runNow("source:a");
    expect(await page(instance, "a")).toBe(3);
    expect(instance.configStatus().generation).toBe(4);
  });

  it("aborts a removed source's run and waits for it to end", async () => {
    writeConfig(dd("a"));
    const connector = pager({ hold: true });
    const instance = await start({ connectors: [connector] });
    const running = instance.jobs.runNow("source:a");
    while (connector.runs.a !== 1) await Bun.sleep(5);
    writeConfig("");
    const report = await instance.reload("manual");
    expect(report.sources?.removed).toEqual(["a"]);
    // The reload returned after the run saw its abort.
    expect(connector.aborted).toEqual(["a"]);
    await running;
    expect(pollers(instance)).toEqual([]);
    expect(await page(instance, "a")).toBe(1);
  });

  it("disabling a source stops its poller; enabling it starts one", async () => {
    writeConfig(dd("a"));
    const instance = await start({ connectors: [pager()] });
    writeConfig(dd("a", "enabled = false"));
    expect((await instance.reload()).sources?.changed).toEqual(["a"]);
    expect(pollers(instance)).toEqual([]);
    writeConfig(dd("a"));
    await instance.reload();
    expect(pollers(instance)).toEqual(["source:a@3600000"]);
  });

  it("lets a service token act for a source added by a reload", async () => {
    writeConfig("");
    const instance = await start();
    const { admin } = await instance.auth.initAdmin({ owner: "ops" });
    const by = await instance.auth.authenticate(admin?.token as string);
    const ask = () =>
      instance.auth.issue({ kind: "service", service: "otel", scopes: ["sessions:write"] }, by);
    await expect(ask()).rejects.toThrow(/no source has id 'otel'/);
    writeConfig('\n[[sources]]\nid = "otel"\ntype = "otlp"\n');
    await instance.reload();
    await expect(ask()).resolves.toBeDefined();
  });

  it("reads sources from drop-ins in seshi.d/, in name order", async () => {
    writeConfig(dd("a"));
    const instance = await start({ connectors: [pager()] });
    mkdirSync(join(dir, "seshi.d"));
    writeFileSync(join(dir, "seshi.d", "20-adx.toml"), dd("adx-2"));
    writeFileSync(join(dir, "seshi.d", "10-adx.toml"), dd("adx-1"));
    const report = await instance.reload();
    expect(report.sources?.added).toEqual(["adx-1", "adx-2"]);
    expect(instance.sources.list().map((s) => s.id)).toEqual(["a", "adx-1", "adx-2"]);
    rmSync(join(dir, "seshi.d", "10-adx.toml"));
    expect((await instance.reload()).sources?.removed).toEqual(["adx-1"]);
  });
});

describe("a rejected reload", () => {
  it("keeps the running config when the file does not load, a pack does not compile, or a check fails", async () => {
    writeConfig(dd("a"));
    const instance = await start({ connectors: [pager()] });
    const before = instance.configStatus();

    writeFileSync(file, "[store\nurl = ");
    const syntax = await instance.reload("api");
    expect(syntax.outcome).toBe("rejected");
    expect(syntax.errors?.[0]).toMatch(/not valid TOML/);

    writeConfig(`${dd("a")}${dd("b")}\n[[sources]]\nid = "a"\ntype = "otlp"\n`);
    expect((await instance.reload()).errors).toEqual([
      expect.stringMatching(/id 'a' is used twice/),
    ]);

    const pack = join(dir, "bad.toml");
    writeFileSync(pack, 'id = "bad"\n[[rules]]\nid = "x"\npattern = "("\n');
    writeConfig(`${dd("a")}${dd("b")}\n[redaction]\npacks = ["${pack}"]\n`);
    const badPack = await instance.reload();
    expect(badPack.outcome).toBe("rejected");
    expect(badPack.errors?.[0]).toMatch(/bad\.toml/);

    // The file moves the store elsewhere (a restart-only change) and adds a source reading
    // the bucket that keeps running: the file alone passes, what would run does not.
    const elsewhere = `file://${join(dir, "other")}`;
    writeFileSync(
      file,
      `[store]\nurl = "${elsewhere}"\n[search]\nenabled = false\n${dd("a")}\n[[sources]]\nid = "loop"\ntype = "s3"\nurl = "${bucket}"\n`,
    );
    const loop = await instance.reload();
    expect(loop.errors).toEqual([
      expect.stringMatching(/sources\.1\.url: reads seshi's own bucket/),
    ]);

    expect(instance.configStatus()).toMatchObject({
      generation: before.generation,
      config_hash: before.config_hash,
      rule_set: before.rule_set,
      last_reload: { outcome: "rejected", trigger: "manual" },
    });
    expect(instance.sources.list().map((s) => s.id)).toEqual(["a"]);
    expect(pollers(instance)).toEqual(["source:a@3600000"]);
  });

  it("says why when there is nothing to read again", async () => {
    writeConfig("");
    const instance = await start({ loadConfig: undefined });
    expect(instance.configStatus().reloadable).toBe(false);
    expect(await instance.reload("signal")).toMatchObject({
      outcome: "rejected",
      errors: [expect.stringMatching(/not started from a config file/)],
    });
  });
});

/** A short session that mentions an `ACME-` key. */
const text = () =>
  `${JSON.stringify({ role: "meta", source: "trajectory" })}\n${JSON.stringify({
    role: "user",
    content: `${"x".repeat(2000)} the key is ACME-1234`,
    timestamp: "2026-09-01T00:00:00Z",
  })}\n${JSON.stringify({ role: "assistant", content: "ok", timestamp: "2026-09-01T00:00:01Z" })}\n`;
const envelope = (sessionId: string) =>
  uploadEnvelope(
    {
      owner: "alice",
      format: "trajectory",
      session_id: sessionId,
      transcript: text(),
      encoding: "jsonl",
    },
    { caller: { kind: "static", principal: "alice" }, owner_basis: "verified" },
  );

describe("reloading rule packs", () => {
  const PACK = 'id = "acme"\n[[rules]]\nid = "acme-key"\npattern = "ACME-[0-9]{4}"\n';
  async function stored(instance: Instance, sessionId: string) {
    const archive = archiveId("alice", "trajectory", sessionId);
    const meta = await readMetadata(instance.store, "alice", archive);
    const trace = await getTrace(instance.store, "alice", archive, meta?.head as string);
    return { rule_set: meta?.redaction?.rule_set, text: JSON.stringify(trace?.records) };
  }

  it("redacts the next write with an edited pack; a write already going keeps the rules it started with", async () => {
    const pack = join(dir, "acme.toml");
    writeFileSync(pack, 'id = "acme"\n');
    writeConfig(`\n[redaction]\npacks = ["${pack}"]\n`);
    let release: () => void = () => {};
    let reviewing: () => void = () => {};
    const inReview = new Promise<void>((resolve) => {
      reviewing = resolve;
    });
    let first = true;
    const reviewer: Reviewer = {
      async review() {
        if (first) {
          first = false;
          reviewing();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return { action: "allow" };
      },
    };
    const instance = await start({ reviewer });
    const oldRules = instance.redaction.hash;

    // s1 is redacted with the old rules, then waits in review while the pack changes.
    const going = instance.pipeline.submit(envelope("s1"));
    await inReview;
    writeFileSync(pack, PACK);
    const report = await instance.reload("api");
    expect(report).toMatchObject({ outcome: "applied", changed: ["redaction"] });
    expect(report.rule_set).not.toBe(oldRules);
    expect(instance.redaction.hash).toBe(report.rule_set);
    release();
    await going;

    await instance.pipeline.submit(envelope("s2"));
    const s1 = await stored(instance, "s1");
    const s2 = await stored(instance, "s2");
    expect(s1.rule_set).toBe(oldRules);
    expect(s1.text).toContain("ACME-1234");
    expect(s2.rule_set).toBe(report.rule_set);
    expect(s2.text).not.toContain("ACME-1234");
    expect(s2.text).toContain("[redacted:acme-key]");
  });

  it("is unchanged when neither the file nor the packs changed", async () => {
    const pack = join(dir, "acme.toml");
    writeFileSync(pack, PACK);
    writeConfig(`\n[redaction]\npacks = ["${pack}"]\n`);
    const instance = await start();
    const report = await instance.reload();
    expect(report).toMatchObject({ outcome: "unchanged", generation: 1, changed: [] });
  });
});

describe("reloading the org's exclude list", () => {
  /** A datadog connector that asks the list about one repository each run, and counts a skip. */
  function asker(repo: string): Connector & { answers: (string | undefined)[] } {
    const connector = {
      kind: "datadog",
      answers: [] as (string | undefined)[],
      async run(ctx: Parameters<Connector["run"]>[0]) {
        const entry = ctx.excludedBy?.([repo]);
        connector.answers.push(entry);
        if (entry !== undefined) ctx.excluded?.();
        return undefined;
      },
    };
    return connector;
  }

  it("combines seshi.toml's list with the drop-ins', and applies a changed list at once", async () => {
    writeConfig(`${dd("a")}\n[capture]\nexclude = ["acme/payroll", "~/clients"]\n`);
    mkdirSync(join(dir, "seshi.d"));
    const dropIn = join(dir, "seshi.d", "adx.toml");
    writeFileSync(dropIn, '[capture]\nexclude = ["github.com/acme/hr-*"]\n', { mode: 0o600 });
    const connector = asker("https://github.com/acme/hr-portal.git");
    const instance = await start({ connectors: [connector] });
    expect(instance.captureExclude).toEqual(["acme/payroll", "~/clients", "github.com/acme/hr-*"]);
    expect(instance.repoExcludes.repos.map((r) => r.entry)).toEqual([
      "acme/payroll",
      "github.com/acme/hr-*",
    ]);
    await instance.jobs.runNow("source:a");
    expect(connector.answers).toEqual(["github.com/acme/hr-*"]);

    // ADX rewrites its drop-in and asks for a reload: the next run sees the new list.
    writeFileSync(dropIn, '[capture]\nexclude = ["# none for now"]\n', { mode: 0o600 });
    const report = await instance.reload("api");
    expect(report).toMatchObject({ outcome: "applied", changed: ["capture"] });
    expect(instance.captureExclude).toEqual(["acme/payroll", "~/clients"]);
    await instance.jobs.runNow("source:a");
    expect(connector.answers).toEqual(["github.com/acme/hr-*", undefined]);

    await instance.health.flush();
    expect((await instance.sources.status("a")).health).toEqual({ excluded: 1 });
  });

  it("rejects a reload whose list has an entry that could never match, and keeps the running one", async () => {
    writeConfig('\n[capture]\nexclude = ["acme/payroll"]\n');
    const instance = await start();
    writeConfig('\n[capture]\nexclude = ["acme/payroll", "https://bot:tok@github.com/acme/x"]\n');
    const report = await instance.reload("api");
    expect(report.outcome).toBe("rejected");
    expect(report.errors?.join("\n")).toMatch(/names a credential/);
    expect(instance.captureExclude).toEqual(["acme/payroll"]);
  });
});

describe("reloading review", () => {
  it("reads prompt files again: an edited prompt is a new policy, with [review] unchanged", async () => {
    const provider = fakeProviderServer({ model: new KeywordModel({}) });
    try {
      const prompt = join(dir, "decision.txt");
      writeFileSync(prompt, "Judge it, version 1.");
      writeConfig(
        `\n[[review.policies]]\nid = "p"\ndecision = { api_key = "sk-test", base_url = "${provider.url}", prompt_file = "${prompt}" }\n`,
      );
      const instance = await start();
      /** Write a session and return the policy hash its review decision recorded. */
      const judged = async (sessionId: string) => {
        await instance.pipeline.submit(envelope(sessionId));
        const archive = archiveId("alice", "trajectory", sessionId);
        const [review] = await listReviews(instance.store, "alice", archive);
        return review?.policy_hash;
      };
      const asked = (text: string) =>
        provider.requests.some((r) => JSON.stringify(r.body).includes(text));

      const v1 = await judged("s1");
      expect(v1).toMatch(/^[0-9a-f]{64}$/);
      expect(asked("Judge it, version 1.")).toBe(true);
      const before = instance.configStatus();
      expect(before.review_set).toMatch(/^[0-9a-f]{64}$/);
      expect(await instance.reload()).toMatchObject({
        outcome: "unchanged",
        changed: [],
        review_set: before.review_set,
      });

      writeFileSync(prompt, "Judge it, version 2.");
      const report = await instance.reload();
      // The config names the same file, so its hash stays; the review set shows the change.
      expect(report).toMatchObject({
        outcome: "applied",
        generation: 2,
        changed: ["review"],
        config_hash: before.config_hash,
      });
      expect(report.review_set).not.toBe(before.review_set);
      expect(instance.configStatus().review_set).toBe(report.review_set);
      const v2 = await judged("s2");
      expect(v2).toMatch(/^[0-9a-f]{64}$/);
      expect(v2).not.toBe(v1);
      expect(asked("Judge it, version 2.")).toBe(true);

      // A prompt file that cannot be read is refused, as a restart would be.
      rmSync(prompt);
      const missing = await instance.reload();
      expect(missing.outcome).toBe("rejected");
      expect(missing.errors?.[0]).toMatch(/decision\.txt/);
      expect(missing.review_set).toBe(report.review_set);
      expect(await judged("s3")).toBe(v2);
    } finally {
      await provider.close();
    }
  });
});

describe("restart-only settings", () => {
  it("applies the rest and lists what waits for a restart", async () => {
    writeConfig("");
    const instance = await start({ connectors: [pager()] });
    writeConfig(`\n[server]\nlisten = ":9999"\n[limits]\nmax_upload_bytes = "1MiB"\n${dd("a")}`);
    const report = await instance.reload();
    expect(report).toMatchObject({
      outcome: "applied",
      restart_required: ["limits.max_upload_bytes", "server.listen"],
      sources: { added: ["a"] },
    });
    expect(instance.config.server.listen).toBe(":7200");
    expect(instance.configStatus().restart_required).toEqual([
      "limits.max_upload_bytes",
      "server.listen",
    ]);
    // Changing only a restart-only setting is not a new generation.
    writeConfig(`\n[server]\nlisten = ":9998"\n${dd("a")}`);
    expect(await instance.reload()).toMatchObject({
      outcome: "unchanged",
      generation: 2,
      restart_required: ["server.listen"],
    });
  });
});

describe("concurrent reloads", () => {
  it("run one at a time, in the order asked", async () => {
    writeConfig("");
    let active = 0;
    let most = 0;
    const configs = [dd("a"), dd("a") + dd("b")];
    let n = 0;
    const instance = await start({
      connectors: [pager()],
      loadConfig: async () => {
        active++;
        most = Math.max(most, active);
        writeConfig(configs[n++] as string);
        const config = load();
        await Bun.sleep(20);
        active--;
        return config;
      },
    });
    const [one, two] = await Promise.all([instance.reload("api"), instance.reload("signal")]);
    expect(most).toBe(1);
    expect(one).toMatchObject({ trigger: "api", generation: 2, sources: { added: ["a"] } });
    expect(two).toMatchObject({ trigger: "signal", generation: 3, sources: { added: ["b"] } });
    expect(instance.configStatus().last_reload?.trigger).toBe("signal");
  });
});

describe("the comparison", () => {
  it("hashes secrets instead of showing them, and sees a changed secret", () => {
    writeConfig(dd("a"));
    const a = load();
    writeConfig(dd("a").replace('api_key = "k"', 'api_key = "k2"'));
    const b = load();
    expect(JSON.stringify(canonical(a))).not.toContain('"k"');
    expect(diffSources(a.sources, b.sources).changed).toEqual(["a"]);
    expect(differences(a.sources, b.sources)).toEqual(["0.api_key.secret"]);
    const { config, restartRequired } = effectiveConfig(a, b);
    expect(restartRequired).toEqual([]);
    expect(config.sources).toBe(b.sources);
    expect(config.store).toBe(a.store);
  });
});
