import { randomBytes } from "node:crypto";
import { BucketHttpError } from "./http-error";
import { keys } from "./layout";
import { accessDeniedIn, isPreconditionFailed, type Store, StoreError } from "./store";

/** One step of the storage test and what the store did. */
export interface StorageStep {
  step: number;
  what: string;
  ok: boolean;
  /** What went wrong, in words, when `ok` is false. */
  detail?: string;
}

export interface StorageTestResult {
  at: string;
  steps: StorageStep[];
  /** Steps 1–4 held: the store honours If-None-Match and If-Match on upload. Without them
   * seshi cannot use the store. */
  conditionalWrites: boolean;
  /** Step 5 held: a delete with a stale If-Match leaves the object. Without it the daemon's
   * sweep stays off. */
  conditionalDelete: boolean;
  /** The first missing feature, in words; undefined when every step held. */
  missing?: string;
}

const encoder = new TextEncoder();

/** A delete with If-Match the store answered with an error other than a failed condition:
 * a refusal of the key or of its credentials (403, 401) is thrown on, as is anything the store
 * did not answer (the network, a sign-in that failed): they say nothing about the store.
 * Anything else means the store does not do conditional deletes. */
function notConditional(err: unknown): string {
  if (accessDeniedIn(err)) throw err;
  const answered =
    err instanceof StoreError && err.cause instanceof BucketHttpError && err.cause.status !== 401;
  if (!answered) throw err;
  return `answered a delete with If-Match with an error (${err.message}): this store does not do conditional deletes`;
}
const MADE_UP_ETAG = "0123456789abcdef0123456789abcdef";

/** The key the test writes: beside the start-up probe, in the owner's own folder, so it needs
 * no permission outside it (F11.11). */
export function storageTestKey(owner: string, suffix = randomBytes(6).toString("hex")): string {
  return `${keys.probe(owner)}-${suffix}`;
}

/** Test the conditional writes and deletes seshi relies on, on a fresh key in `owner`'s folder
 * that it deletes at the end (F11, the storage test):
 *
 * 1. PUT with If-None-Match: * on the fresh key succeeds.
 * 2. The same again is refused (412).
 * 3. PUT with If-Match on a made-up ETag is refused.
 * 4. PUT with If-Match on the real ETag succeeds.
 * 5. DELETE with If-Match on a made-up ETag leaves the object.
 * 6. DELETE with the real ETag removes it.
 *
 * Errors other than a refused condition (no permission, the network) are thrown: they say
 * nothing about the store's features. */
export async function storageTest(
  store: Store,
  owner: string,
  options: { key?: string; now?: () => Date } = {},
): Promise<StorageTestResult> {
  const key = options.key ?? storageTestKey(owner);
  const at = (options.now ?? (() => new Date()))().toISOString();
  const steps: StorageStep[] = [];
  const record = (step: number, what: string, ok: boolean, detail?: string) => {
    steps.push({ step, what, ok, ...(ok || detail === undefined ? {} : { detail }) });
    return ok;
  };
  const refused = async (attempt: () => Promise<unknown>): Promise<boolean> => {
    try {
      await attempt();
      return false;
    } catch (err) {
      if (isPreconditionFailed(err)) return true;
      throw err;
    }
  };

  try {
    let etag: string | undefined;
    try {
      etag = (await store.put(key, encoder.encode("1\n"), { ifNoneMatch: "*" })).etag;
      record(1, "upload with If-None-Match: * to a new key", true);
    } catch (err) {
      if (!isPreconditionFailed(err)) throw err;
      record(1, "upload with If-None-Match: * to a new key", false, "refused a new key");
    }
    record(
      2,
      "the same upload again is refused",
      await refused(() => store.put(key, encoder.encode("2\n"), { ifNoneMatch: "*" })),
      "accepted a second create: this store ignores If-None-Match on upload",
    );
    record(
      3,
      "upload with If-Match on a made-up ETag is refused",
      await refused(() => store.put(key, encoder.encode("3\n"), { ifMatch: MADE_UP_ETAG })),
      "accepted an upload with a wrong If-Match: this store ignores If-Match on upload",
    );
    etag = (await store.stat(key))?.etag ?? etag;
    let step4 = false;
    if (etag !== undefined) {
      try {
        etag = (await store.put(key, encoder.encode("4\n"), { ifMatch: etag })).etag ?? etag;
        step4 = true;
      } catch (err) {
        if (!isPreconditionFailed(err)) throw err;
      }
    }
    record(
      4,
      "upload with If-Match on the real ETag",
      step4,
      etag === undefined
        ? "the store reports no ETag"
        : "refused an upload with the right If-Match",
    );
    etag = (await store.stat(key))?.etag ?? etag;
    let deleteError: string | undefined;
    try {
      await store.delete(key, { ifMatch: MADE_UP_ETAG });
    } catch (err) {
      if (!isPreconditionFailed(err)) deleteError = notConditional(err);
    }
    const kept = (await store.stat(key)) !== null;
    record(
      5,
      "delete with If-Match on a made-up ETag leaves the object",
      kept && deleteError === undefined,
      deleteError ??
        "deleted the object despite a wrong If-Match: this store ignores If-Match on delete",
    );
    let realError: string | undefined;
    if (kept) {
      try {
        await store.delete(key, etag !== undefined ? { ifMatch: etag } : {});
      } catch (err) {
        realError = isPreconditionFailed(err)
          ? "refused a delete with the right If-Match"
          : notConditional(err);
      }
    }
    record(
      6,
      "delete with the real ETag removes the object",
      realError === undefined && (await store.stat(key)) === null,
      realError ?? "the object is still there",
    );
  } finally {
    await store.delete(key).catch(() => {});
  }

  const failed = (n: number) => steps.find((s) => s.step === n && !s.ok);
  const write = [1, 2, 3, 4].map(failed).find((s) => s !== undefined);
  const del = failed(5) ?? failed(6);
  const missing = write?.detail ?? del?.detail;
  return {
    at,
    steps,
    conditionalWrites: write === undefined,
    conditionalDelete: del === undefined,
    ...(missing !== undefined ? { missing } : {}),
  };
}
