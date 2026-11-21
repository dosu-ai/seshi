import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ConfigFs, Keyring, loadServerConfig, type RuntimeLayer } from "@seshi/config";
import { openStore } from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeChangeError, RuntimeConfig } from "./runtime";

const K1 = "k1-0123456789abcdef0123456789abcdef";
const K2 = "k2-0123456789abcdef0123456789abcdef";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-runtime-unit-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function runtime(keyring: Keyring, main = "") {
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
      loadServerConfig({ configFlag: file, fs, ...(layer ? { runtime: layer } : {}) }),
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

    const old = runtime(new Keyring({ k1: K1 }));
    await old.sync();
    const loaded = old.compose();
    expect(loaded.config.sources).toEqual([]);
    expect(loaded.warnings.join("\n")).toMatch(/cursor-a.json: left out: .*key 'k2'/);
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
});
