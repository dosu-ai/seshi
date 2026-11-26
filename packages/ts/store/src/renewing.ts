/** Renew a credential this long before it expires, or halfway through a shorter life. */
const RENEW_BEFORE_MS = 5 * 60 * 1000;

export interface Renewable<T> {
  value: T;
  /** When to ask for a new one (ms since the epoch). */
  renewAt: number;
}

/** When to renew a credential that lasts `lifetimeMs` from `nowMs`: five minutes before it
 * expires, or halfway through when it has less than ten minutes to live (a metadata server
 * may hand out its cached credential close to its end). */
export function renewAt(nowMs: number, lifetimeMs: number): number {
  return nowMs + lifetimeMs - Math.min(RENEW_BEFORE_MS, Math.max(0, lifetimeMs) / 2);
}

/** A source that calls `exchange` when it has nothing or what it has is due for renewal;
 * concurrent callers share one exchange, and a failed one is tried again on the next call. */
export function renewing<T>(
  exchange: () => Promise<Renewable<T>>,
  now: () => Date,
): () => Promise<T> {
  let current: Renewable<T> | undefined;
  let pending: Promise<T> | undefined;
  return () => {
    if (current && current.renewAt > now().getTime()) return Promise.resolve(current.value);
    pending ??= exchange()
      .then((fresh) => {
        current = fresh;
        return fresh.value;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}
