import { randomBytes } from "node:crypto";
import type { ServerConfig } from "@seshi/config";
import { type Instance, lanceLocation, revealedAccess } from "@seshi/instance";
import { openStore, type Store } from "@seshi/store";
import type { CheckResult } from "./types";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** `events` past this, and maintenance outgrows the worker (docs/seshi/lancedb-search.md,
 * "Risks"). */
export const LANCE_EVENTS_WARN = 20_000_000;

const MINUTE_MS = 60_000;

function ago(ms: number): string {
  if (ms < MINUTE_MS) return "just now";
  if (ms < 60 * MINUTE_MS) return `${Math.round(ms / MINUTE_MS)} min ago`;
  if (ms < 48 * 60 * MINUTE_MS) return `${Math.round(ms / (60 * MINUTE_MS))} h ago`;
  return `${Math.round(ms / (24 * 60 * MINUTE_MS))} days ago`;
}

export interface SearchCheckOptions {
  env: Readonly<Record<string, string | undefined>>;
  now?: Date;
  /** Where the write probe goes; the index's location, reached with its keys, by default. */
  probeStore?: () => Store;
}

/** The store that reaches the index's location with the same keys the worker uses, and the
 * key of a probe object in it. */
function probeTarget(
  instance: Instance,
  config: ServerConfig,
  env: SearchCheckOptions["env"],
): { store: Store; key: string } {
  const name = `.seshi-doctor-${randomBytes(6).toString("hex")}`;
  const lance = config.search.lance;
  if (lance.uri === undefined) {
    return { store: instance.store, key: `search/${instance.deployment}/${name}` };
  }
  const access = revealedAccess(config);
  const { store } = openStore(lance.uri, { ...access, env: { ...env } });
  return { store, key: name };
}

/** `seshi doctor --config`'s search checks: the index answers, the worker can write where it
 * lives, it is current, and (LanceDB) it is not past the size this design fits. */
export async function searchServerChecks(
  instance: Instance,
  config: ServerConfig,
  options: SearchCheckOptions,
): Promise<CheckResult[]> {
  const now = options.now ?? new Date();
  const search = instance.search;
  if (!search) {
    return [{ id: "search", title: "Search", status: "ok", summary: "off ([search] enabled)" }];
  }
  const shared = config.search.backend === "lance";
  const checks: CheckResult[] = [];
  const where = shared ? lanceLocation(config, instance.deployment, options.env).uri : undefined;

  let status: Awaited<ReturnType<typeof search.status>>;
  try {
    status = await search.status();
  } catch (err) {
    return [
      {
        id: "search",
        title: "Search index",
        status: "fail",
        summary: `cannot be read: ${message(err)}`,
        ...(where ? { detail: [`location ${where}`] } : {}),
        hint: shared
          ? "check search.lance.uri and its keys ([store]'s by default); a deployment named in the error is another server's index"
          : "check search.path",
      },
    ];
  }
  checks.push({
    id: "search",
    title: "Search index",
    status: "ok",
    summary: shared ? `LanceDB at ${status.location}` : `SQLite at ${status.location}`,
    detail: [
      `${status.sessions} sessions, ${status.events} records`,
      ...(status.generation ? [`generation ${status.generation}`] : []),
    ],
  });

  if (shared) {
    let target: { store: Store; key: string } | undefined;
    try {
      target = options.probeStore
        ? { store: options.probeStore(), key: `.seshi-doctor-${randomBytes(6).toString("hex")}` }
        : probeTarget(instance, config, options.env);
      await target.store.put(target.key, new TextEncoder().encode("seshi doctor\n"));
      await target.store.delete(target.key);
      checks.push({
        id: "search-write",
        title: "Search writes",
        status: "ok",
        summary: "the worker's keys can write the index's location",
      });
    } catch (err) {
      checks.push({
        id: "search-write",
        title: "Search writes",
        status: "fail",
        summary: `the worker cannot write the index's location: ${message(err)}`,
        hint: "the worker needs write access under search.lance.uri ([store]'s bucket, search/<deployment>/, by default)",
      });
    }
  }

  checks.push(freshness(status, config, now, shared));

  if (status.scrub_failed) {
    const failed = status.scrub_failed;
    checks.push({
      id: "search-scrub",
      title: "Search scrub",
      status: "warn",
      summary: `the scrub failed${failed.failures > 1 ? ` ${failed.failures} times in a row` : ""}, last ${ago(now.getTime() - Date.parse(failed.at))}: text deleted, retracted or redacted${failed.due_since ? ` since ${failed.due_since}` : ""} is still in the index's files`,
      detail: [failed.error, `the worker tries again at ${failed.retry_at}`],
      hint: 'seshi search --scrub retries it on the worker\'s next pass; see "Deleted text" in docs/search.md',
    });
  }

  if (shared && status.events > LANCE_EVENTS_WARN) {
    checks.push({
      id: "search-size",
      title: "Search size",
      status: "warn",
      summary: `${status.events.toLocaleString("en-US")} records: past the ${LANCE_EVENTS_WARN.toLocaleString("en-US")} this backend is sized for`,
      detail: ["optimize() and the scrub rewrite the whole table, so they take longer as it grows"],
      hint: 'see "Past the limit" in docs/seshi/lancedb-search.md',
    });
  }
  return checks;
}

function freshness(
  status: Awaited<ReturnType<NonNullable<Instance["search"]>["status"]>>,
  config: ServerConfig,
  now: Date,
  shared: boolean,
): CheckResult {
  const id = "search-fresh";
  const title = "Search freshness";
  const keeper = shared ? "the worker" : "this instance";
  if (status.stale_schema) {
    return {
      id,
      title,
      status: "warn",
      summary: `the live index was written by another version of seshi (${status.stale_schema}); searches wait until ${keeper} rebuilds it`,
    };
  }
  if (!status.ready) {
    const read = status.building?.read_through;
    return {
      id,
      title,
      status: "warn",
      summary: `not built yet: ${keeper} is building it from the change feed${read ? ` (read through ${read})` : ""}`,
      ...(shared ? { hint: "make sure one instance runs the worker role (X7.2)" } : {}),
    };
  }
  const caught = Date.parse(status.caught_up_at ?? "");
  const age = Number.isFinite(caught) ? now.getTime() - caught : Number.POSITIVE_INFINITY;
  // A pass every search.interval: well past a few of them, the indexer has stopped.
  const limit = Math.max(15 * MINUTE_MS, 20 * config.search.interval);
  const building = status.building ? [`rebuilding generation ${status.building.generation}`] : [];
  if (age > limit) {
    return {
      id,
      title,
      status: "warn",
      summary: `last caught up ${Number.isFinite(age) ? ago(age) : "never"}`,
      detail: building,
      hint: shared
        ? "is the worker running? seshi workers status shows its search-index job"
        : "the search-index job runs on every API instance; see seshi workers status",
    };
  }
  return {
    id,
    title,
    status: "ok",
    summary: `caught up ${ago(age)}`,
    ...(building.length > 0 ? { detail: building } : {}),
  };
}
