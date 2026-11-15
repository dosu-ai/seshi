/** Instances for cross-package tests (X3.6): each test builds its own, on its own temporary
 * folder store, so suites run in parallel with no shared state (X1.2). */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, createApp } from "@seshi/api";
import { Auth } from "@seshi/auth";
import { loadConfig, type ServerConfig, serverConfigSchema } from "@seshi/config";
import type { FormatRegistry } from "@seshi/formats";
import { type BuildOptions, buildInstance, Instance, type InstanceParts } from "@seshi/instance";
import type { StorageView } from "@seshi/model";
import { FsStore, type Store } from "@seshi/store";
import { buildFormats } from "seshi/integrations";

/** A server config from TOML (without `[store]`, a placeholder folder URL is used), as the
 * loader would read it from a file only the owner can read. */
export function serverConfig(
  toml = "",
  options: { env?: Record<string, string | undefined>; storeUrl?: string } = {},
): ServerConfig {
  const text = /^\[store\]/m.test(toml)
    ? toml
    : `[store]\nurl = ${JSON.stringify(options.storeUrl ?? "file:///unused-test-store")}\n${toml}`;
  return loadConfig(serverConfigSchema, {
    file: "seshi.toml",
    env: options.env ?? {},
    fs: { readFile: () => text, mode: () => 0o100600 },
  }).config;
}

/** A store URL the config schema accepts for `store`: its own when it is one. */
function urlOf(store: Store): string {
  return /^(file|s3|r2):\/\//.test(store.url) ? store.url : "file:///unused-test-store";
}

/** What the old `createApp(options)` took, which most API suites still describe their server
 * with: the store, static tokens and overrides. */
export interface TestAppOptions
  extends Partial<Omit<InstanceParts, "config" | "store" | "storage" | "formats" | "auth">> {
  store: Store;
  storage?: StorageView;
  /** Static tokens, when no `auth` is given (the org key is on, no IdP). */
  tokens?: { token: string; owner: string }[];
  auth?: Auth;
  formats?: FormatRegistry;
  /** Extra config, as TOML. */
  config?: string;
}

/** An Instance over an open store, built synchronously (no marker check), the way the API
 * suites set up a server. */
export function testInstance(options: TestAppOptions): Instance {
  const { store, storage, tokens, auth, formats, config, ...parts } = options;
  const now = parts.now ?? (() => new Date());
  return new Instance({
    deployment: "local",
    id: "test",
    ...parts,
    config: serverConfig(config ?? "", { storeUrl: urlOf(store) }),
    store,
    storage: storage ?? { url: store.url },
    formats: formats ?? buildFormats(),
    auth:
      auth ??
      new Auth(
        {
          staticTokens: (tokens ?? []).filter((t) => t.token.length > 0),
          orgKey: true,
          admins: [],
          aliases: {},
          sessionKeys: {},
        },
        { store, deployment: parts.deployment ?? "local", now },
      ),
  });
}

/** The HTTP app over `testInstance(options)`. */
export function testApp(options: TestAppOptions): App {
  return createApp(testInstance(options));
}

/** A temporary folder store and a way to remove it. */
export function tempStore(prefix = "seshi-test-"): {
  dir: string;
  store: FsStore;
  cleanup(): void;
} {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const store = new FsStore(`file://${join(dir, "bucket")}`);
  return { dir, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** `buildInstance` over a temporary folder store with this binary's formats: the full boot
 * path (marker, probes, packs) as `seshi serve` runs it. */
export async function bootInstance(
  toml = "",
  options: Partial<BuildOptions> & { storeUrl?: string } = {},
): Promise<{ instance: Instance; dir: string; store: Store; cleanup(): Promise<void> }> {
  const temp = tempStore("seshi-instance-");
  const { storeUrl, ...rest } = options;
  const config = serverConfig(toml, { storeUrl: storeUrl ?? temp.store.url });
  const instance = await buildInstance(config, {
    formats: buildFormats(),
    id: "test",
    env: {},
    ...rest,
  });
  return {
    instance,
    dir: temp.dir,
    store: instance.store,
    async cleanup() {
      await instance.close(1000);
      temp.cleanup();
    },
  };
}
