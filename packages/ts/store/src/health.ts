import { readJson, updateJson } from "./json";
import { assertDay, keys } from "./layout";
import type { Store } from "./store";

export const HEALTH_SCHEMA = "seshi/source-health/1" as const;

/** How an envelope ended. `stored`: a new trace. `duplicate`: the trace was already there, or
 * the envelope was a resend (X4.7). `unchanged`: nothing new in it. `filtered`: the session
 * filter kept it out (X4.10). `dropped`: model review dropped it (F3). `failed`: a permanent
 * failure with no caller to tell, recorded under `failed/` (X4.8). `rejected`: refused to a
 * caller (422, 409 conflict, 403). */
export type HealthOutcome =
  | "stored"
  | "duplicate"
  | "unchanged"
  | "filtered"
  | "dropped"
  | "failed"
  | "rejected"
  /** Left out because the org's exclude list names its repository: a source's skip (a Cursor
   * Cloud agent never fetched), or an upload refused at ingest. */
  | "excluded";

export const HEALTH_OUTCOMES: readonly HealthOutcome[] = [
  "stored",
  "duplicate",
  "unchanged",
  "filtered",
  "dropped",
  "failed",
  "rejected",
  "excluded",
];

export type HealthCounts = Partial<Record<HealthOutcome, number>>;

export interface HealthShard {
  schema: typeof HEALTH_SCHEMA;
  source: string;
  day: string;
  instance: string;
  counts: HealthCounts;
  updated_at: string;
}

export function healthDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function add(into: HealthCounts, counts: HealthCounts): HealthCounts {
  const out: HealthCounts = { ...into };
  for (const outcome of HEALTH_OUTCOMES) {
    const n = counts[outcome];
    if (n) out[outcome] = (out[outcome] ?? 0) + n;
  }
  return out;
}

export async function addHealth(
  store: Store,
  input: { source: string; day: string; instance: string; counts: HealthCounts; at: string },
): Promise<void> {
  const { source, day, instance } = input;
  if (!HEALTH_OUTCOMES.some((o) => (input.counts[o] ?? 0) > 0)) return;
  await updateJson<HealthShard>(store, keys.health(source, day, instance), (current) => ({
    schema: HEALTH_SCHEMA,
    source,
    day,
    instance,
    counts: add(current?.counts ?? {}, input.counts),
    updated_at: input.at,
  }));
}

/** A source's counts by day, every shard summed, oldest first; from `since` (a day) on when
 * given. */
export async function readHealth(
  store: Store,
  source: string,
  options: { since?: string } = {},
): Promise<{ day: string; counts: HealthCounts }[]> {
  const prefix = keys.healthAll(source);
  const startAfter =
    options.since === undefined ? undefined : `${prefix}${assertDay(options.since)}`;
  const days = new Map<string, HealthCounts>();
  let after = startAfter;
  for (;;) {
    const page = await store.list(prefix, { startAfter: after });
    for (const key of page.keys) {
      const day = key.slice(prefix.length, prefix.length + 10);
      const found = await readJson<HealthShard>(store, key);
      if (!found) continue;
      days.set(day, add(days.get(day) ?? {}, found.value.counts));
    }
    after = page.keys.at(-1);
    if (!page.truncated || after === undefined) break;
  }
  return [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, counts]) => ({ day, counts }));
}

export async function sourcesWithHealth(store: Store): Promise<string[]> {
  const ids = new Set<string>();
  let after: string | undefined;
  for (;;) {
    const page = await store.list("sources/", { startAfter: after });
    for (const key of page.keys) {
      const m = /^sources\/([^/]+)\/health\//.exec(key);
      if (m) ids.add(m[1] as string);
    }
    after = page.keys.at(-1);
    if (!page.truncated || after === undefined) return [...ids].sort();
  }
}

/** Delete a source's shards for days before the last `keepDays` UTC days (today included).
 * Days are listed in order, so it stops at the first day to keep. Returns how many shards it
 * deleted. */
export async function pruneHealth(
  store: Store,
  source: string,
  options: { keepDays: number; now?: () => Date },
): Promise<number> {
  const today = (options.now ?? (() => new Date()))();
  const keepFrom = healthDay(
    new Date(today.getTime() - Math.max(0, options.keepDays - 1) * 24 * 60 * 60 * 1000),
  );
  const prefix = keys.healthAll(source);
  let deleted = 0;
  let after: string | undefined;
  for (;;) {
    const page = await store.list(prefix, { startAfter: after });
    for (const key of page.keys) {
      const day = key.slice(prefix.length, prefix.length + 10);
      if (day >= keepFrom) return deleted;
      await store.delete(key);
      deleted++;
    }
    after = page.keys.at(-1);
    if (!page.truncated || after === undefined) return deleted;
  }
}
