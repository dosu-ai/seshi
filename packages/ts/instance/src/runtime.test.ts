import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ConfigFs, Keyring, loadServerConfig, type RuntimeLayer } from "@seshi/config";
import { openStore } from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRedactionPacks } from "./instance";
import { RuntimeChangeError, RuntimeConfig } from "./runtime";

const K1 = "k1-0123456789abcdef0123456789abcdef";
const K2 = "k2-0123456789abcdef0123456789abcdef";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-runtime-unit-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function runtime(keyring: Keyring, main = "", env: Record<string, string> = {}) {
  const file = join(dir, "seshi.toml");
  const fs: ConfigFs = {
    readFile: (path) => {
      if (path !== file) throw new Error(`ENOENT ${path}`);
      return `[store]\nurl = "file://${join(dir, "bucket")}"\n${main}`;
    },
    mode: (path) => (path === file ? 0o100600 : undefined),
    list: () => [],
  };
  const { store } = openStore(`file://${join(dir, "bucket")}`);
  return new RuntimeConfig({
    store,
    keyring,
    load: (layer: RuntimeLayer | undefined) =>
      loadServerConfig({ configFlag: file, fs, env, ...(layer ? { runtime: layer } : {}) }),
    cacheDir: join(dir, "cache"),
    pollMs: 1_000,
  });
}

const ok = async () => [];

describe("RuntimeConfig", () => {
  it("reseals with a new key, and leaves out a source whose key is gone", async () => {
    const one = runtime(new Keyring({ k1: K1 }));
    await one.putSource("cursor-a", { type: "cursor-cloud", api_key: "secret-a" }, {}, ok);
    await one.sync();
    expect(one.compose().config.sources.map((s) => s.id)).toEqual(["cursor-a"]);

    const both = runtime(new Keyring({ k1: K1, k2: K2 }, "k2"));
    expect(await both.reseal()).toEqual({ resealed: ["cursor-a"], changed: [], current: [] });
    expect(await both.reseal()).toEqual({ resealed: [], changed: [], current: ["cursor-a"] });
    const stored = readFileSync(join(dir, "bucket", "runtime", "sources", "cursor-a.json"), "utf8");
    expect(stored).toContain('"v1.k2.');
    expect(stored).not.toContain("secret-a");

    // The value did not change, so its fingerprint did not either.
    const before = one.storedSource("cursor-a")?.source.api_key as { fingerprint: string };
    await both.sync();
    const after = both.storedSource("cursor-a")?.source.api_key as {
      fingerprint: string;
      key_id: string;
    };
    expect(after).toMatchObject({ key_id: "k2", fingerprint: before.fingerprint });

    const old = runtime(new Keyring({ k1: K1 }));
    await old.sync();
    const loaded = old.compose();
    expect(loaded.config.sources).toEqual([]);
    expect(loaded.warnings.join("\n")).toMatch(/cursor-a.json: left out: .*key 'k2'/);
    expect(old.leftOut("cursor-a")).toMatch(/key 'k2'/);
    // A reseal that cannot unseal one names it.
    await expect(
      runtime(new Keyring({ k1: K1, k3: K2.replace("k2", "k3") }, "k3")).reseal(),
    ).rejects.toThrow(/source 'cursor-a': .*key 'k2'/);
  });

  it("keeps a secret sent back as the view a read gave, and checks every pack", async () => {
    const rt = runtime(new Keyring({ k1: K1 }));
    await rt.putSource("cursor-a", { type: "cursor-cloud", api_key: "secret-a" }, {}, ok);
    await rt.sync();
    const view = rt.storedSource("cursor-a")?.source.api_key;
    expect(view).toMatchObject({ set: true });
    await rt.putSource("cursor-a", { type: "cursor-cloud", enabled: false, api_key: view }, {}, ok);
    await rt.sync();
    expect(rt.compose().config.sources[0]).toMatchObject({ enabled: false });
    expect(rt.storedSource("cursor-a")?.source.api_key).toEqual(view);
    await expect(
      rt.putSource("cursor-b", { type: "cursor-cloud", api_key: view }, {}, ok),
    ).rejects.toMatchObject({ problems: ["api_key: no secret stored to keep; send its value"] });

    const bad = new TextEncoder().encode('{"patterns":["(unclosed"],"sensitive_files":[]}');
    await expect(rt.putFile("packs/bad.json", bad, {}, ok)).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(rt.putFile("packs/bad.json", bad, {}, ok)).rejects.toThrow(/not a usable RE2/);
    const good = new TextEncoder().encode('{"patterns":["ZEBRA-[0-9]{6}"],"sensitive_files":[]}');
    await rt.putFile("packs/good.json", good, {}, ok);
  });

  it("names the bucket's config/ in messages, not its local copies", async () => {
    const rt = runtime(new Keyring({ k1: K1 }));
    const pack = new TextEncoder().encode('{"patterns":["X"],"sensitive_files":[]}');
    await rt.putFile("packs/org.json", pack, {}, ok);
    await rt.patchDoc({ set: { "redaction.packs": ["packs/org.json"] } }, {}, ok);
    // The check a server runs: the packs the config names are read.
    const packs = async (config: { redaction: { packs: string[] } }) =>
      readRedactionPacks(config.redaction.packs).then(
        () => [],
        (err: Error) => [err.message],
      );
    const refused = await rt.deleteFile("packs/org.json", {}, packs).catch((err) => err);
    expect(refused).toMatchObject({
      code: "in_use",
      problems: ["config/seshi.toml needs config/packs/org.json; take it out there first"],
    });
    await rt.sync();
    const [path] = rt.compose().config.redaction.packs;
    expect(rt.tidy(`cannot read ${path}`)).toBe("cannot read config/packs/org.json");
  });

  it("refuses a file's source, a file secret, and a deletion a review policy needs", async () => {
    const rt = runtime(new Keyring({ k1: K1 }), '[[sources]]\nid = "adx-ingest"\ntype = "otlp"\n');
    await expect(rt.putSource("adx-ingest", { type: "otlp" }, {}, ok)).rejects.toMatchObject({
      code: "file_owned",
    });
    await expect(
      rt.putSource("dd", { type: "datadog", api_key: { file: "/k" }, app_key: "x" }, {}, ok),
    ).rejects.toBeInstanceOf(RuntimeChangeError);
    await rt.putSource("dd", { type: "datadog", api_key: "a", app_key: "b" }, {}, ok);
    await rt.patchDoc(
      {
        set: {
          "review.policies": [
            {
              id: "p",
              sources: ["dd"],
              decision: {
                provider: "openai-compatible",
                model: "m",
                base_url: "http://127.0.0.1:9",
              },
            },
          ],
        },
      },
      {},
      ok,
    );
    await expect(rt.deleteSource("dd", {})).rejects.toMatchObject({ code: "in_use" });
  });

  it("takes a stored source's secrets only as values, never the server's env", async () => {
    const rt = runtime(new Keyring({ k1: K1 }));
    // An admin token must not get the server to send its own env (the sealing keys among it)
    // to an endpoint the caller picks.
    const leak = {
      type: "datadog",
      api_url: "http://127.0.0.1:9",
      api_key: { env: "SEAL_K1" },
      app_key: "b",
    };
    await expect(rt.putSource("dd", leak, {}, ok)).rejects.toMatchObject({
      code: "invalid",
      problems: [expect.stringMatching(/^api_key: .*\{ env \}/)],
    });
    // One written to the bucket some other way is left out, not run.
    mkdirSync(join(dir, "bucket", "runtime", "sources"), { recursive: true });
    writeFileSync(
      join(dir, "bucket", "runtime", "sources", "dd.json"),
      JSON.stringify({
        schema: "seshi/runtime-source/1",
        source: leak,
        secrets: {},
        updated_at: new Date(0).toISOString(),
      }),
    );
    await rt.sync();
    const loaded = rt.compose();
    expect(loaded.config.sources).toEqual([]);
    expect(loaded.warnings.join("\n")).toMatch(/dd.json: left out: api_key: not sealed/);
    // That one left out blocks no other write, and it can still be deleted.
    await rt.putSource("cursor-b", { type: "cursor-cloud", api_key: "secret-b" }, {}, ok);
    await rt.deleteSource("dd", {});
    expect(rt.compose().config.sources.map((s) => s.id)).toEqual(["cursor-b"]);
  });

  it("refuses to delete a file the doc needs, however it spells it", async () => {
    const rt = runtime(new Keyring({ k1: K1 }));
    await rt.putFile(
      "packs/org.json",
      new TextEncoder().encode('{"patterns": ["X-[0-9]{3}"]}'),
      {},
      ok,
    );
    await rt.patchDoc({ set: { "redaction.packs": ["./packs/org.json"] } }, {}, ok);
    const check = async (config: { redaction: { packs: readonly string[] } }) => {
      for (const pack of config.redaction.packs) {
        if (!(await Bun.file(pack).exists())) return [`cannot read redaction pack ${pack}`];
      }
      return [];
    };
    await expect(rt.deleteFile("packs/org.json", {}, check)).rejects.toMatchObject({
      code: "in_use",
    });
    await expect(rt.deleteFile("packs/none.json", {}, check)).rejects.toMatchObject({
      code: "no_such_file",
    });
  });

  it("locks a list the server's env sets whole", () => {
    const rt = runtime(new Keyring({ k1: K1 }), "", { SESHI_CAPTURE__EXCLUDE: '["acme/payroll"]' });
    expect(rt.locked()).toContain("capture.exclude");
    expect(runtime(new Keyring({ k1: K1 }), '[capture]\nexclude = ["a/b"]\n').locked()).toEqual([]);
  });
});
