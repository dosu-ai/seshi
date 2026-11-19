/** Waits until the npm registry serves a release to `npm install`. `npm publish` returns once
 * the registry has the version, but a package's first versions can take minutes to reach the
 * registry's CDN: 0.10.0's `npm i -g @dosu/seshi` got E404 for every new package 16 seconds after
 * they were published, and installed five minutes later. A platform package that 404s is worse
 * than a launcher that does: npm skips a missing optional dependency and installs a launcher
 * with no binary. So the `verify` job waits for the launcher and every platform package. */

import { parseArgs } from "node:util";
import { LAUNCHER } from "./npm";
import { TARGETS } from "./targets";

export const REGISTRY = "https://registry.npmjs.org";

/** The abbreviated packument `npm install` and `npx` ask for; the CDN caches it apart from the
 * full one `npm view` reads, so this is the document that has to carry the version. */
export const INSTALL_ACCEPT =
  "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*";

export type Fetch = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface WaitOptions {
  names: readonly string[];
  version: string;
  registry?: string;
  timeoutMs?: number;
  intervalMs?: number;
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}

/** The names `npm i -g @dosu/seshi` resolves: the launcher and its platform packages. */
export function installedNames(): string[] {
  return [LAUNCHER, ...TARGETS.map((t) => t.npm)];
}

export function packumentUrl(registry: string, name: string): string {
  return `${registry.replace(/\/$/, "")}/${name.replace("/", "%2f")}`;
}

/** `null` when the registry serves `name@version` to an install, else why it does not. */
export async function missing(
  fetch: Fetch,
  registry: string,
  name: string,
  version: string,
): Promise<string | null> {
  let res: Awaited<ReturnType<Fetch>>;
  try {
    res = await fetch(packumentUrl(registry, name), { headers: { accept: INSTALL_ACCEPT } });
  } catch (err) {
    return `request failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (res.status !== 200) return `HTTP ${res.status}`;
  const doc = (await res.json().catch(() => null)) as { versions?: Record<string, unknown> } | null;
  return doc?.versions?.[version] ? null : `${version} not listed yet`;
}

/** Polls until every package serves `version`; throws, naming the ones that do not, once
 * `timeoutMs` has passed. */
export async function waitForNpm(options: WaitOptions): Promise<void> {
  const registry = options.registry ?? REGISTRY;
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  const intervalMs = options.intervalMs ?? 15_000;
  const fetch = options.fetch ?? (globalThis.fetch as unknown as Fetch);
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const start = now();
  let pending = [...options.names];
  for (;;) {
    const reasons = new Map<string, string>();
    for (const name of pending) {
      const why = await missing(fetch, registry, name, options.version);
      if (why === null) log(`${name}@${options.version}: on the registry`);
      else reasons.set(name, why);
    }
    pending = [...reasons.keys()];
    if (pending.length === 0) return;
    const waited = now() - start;
    const list = [...reasons].map(([name, why]) => `${name} (${why})`).join(", ");
    if (waited >= timeoutMs) {
      throw new Error(
        `after ${Math.round(waited / 1000)}s the registry still does not serve ${options.version} of ${list}`,
      );
    }
    log(`waiting ${Math.round(intervalMs / 1000)}s for ${list}`);
    await sleep(intervalMs);
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      version: { type: "string" },
      timeout: { type: "string", default: "900" },
      interval: { type: "string", default: "15" },
    },
    strict: true,
  });
  if (!values.version) {
    console.error("usage: wait-npm.ts --version X.Y.Z [--timeout seconds] [--interval seconds]");
    process.exit(2);
  }
  try {
    await waitForNpm({
      names: installedNames(),
      version: values.version,
      timeoutMs: Number(values.timeout) * 1000,
      intervalMs: Number(values.interval) * 1000,
      log: (line) => console.log(`npm: ${line}`),
    });
  } catch (err) {
    console.error(`npm: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
