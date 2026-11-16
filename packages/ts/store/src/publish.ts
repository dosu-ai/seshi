import { createHash } from "node:crypto";
import { CHANGE_SCHEMA, type ChangeEntry, type SessionMetadata } from "@seshi/model";
import { decodeJson, encodeJson, type JsonUpdate, updateJson } from "./json";
import { changeSuffix, keys } from "./layout";
import {
  getBytes,
  isPreconditionFailed,
  type Store,
  StoreError,
  type UpdateOptions,
} from "./store";

export { decodeJson, gunzipJson, gzipJsonDeterministic } from "./json";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function md5(bytes: Uint8Array): string {
  return createHash("md5").update(bytes).digest("hex");
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type PublishOutcome = "written" | "exists";

/** How an occupied key is treated. `immutable` is for content-addressed keys (a trace): the first
 * object wins, since whatever differs in a later one (timestamps, lineage) is outside the hash and
 * the first writer's view is as good as any. `replace` is for keys whose object may change (a span
 * record sent again): the same bytes are a no-op and different bytes replace. */
export type PublishMode = "immutable" | "replace";

/** Write `body` at `key` unless it is already there, and verify what landed: by ETag when the
 * backend reports a plain MD5 (single-part PUT on S3, R2, MinIO, and `fs`), else by reading the
 * object back and hashing it. */
export async function publishObject(
  store: Store,
  key: string,
  body: Uint8Array,
  contentType: string,
  mode: PublishMode = "immutable",
): Promise<PublishOutcome> {
  const want = md5(body);
  const before = await store.stat(key);
  if (before) {
    const kept =
      mode === "immutable" ||
      (before.size === body.length && (await matches(store, key, before.etag, want, body)));
    if (kept && (await resetAgeSoSweepSkips(store, key, contentType))) return "exists";
  }
  if (mode === "immutable") {
    try {
      await store.put(key, body, { contentType, ifNoneMatch: "*" });
    } catch (err) {
      if (isPreconditionFailed(err)) return "exists";
      throw err;
    }
  } else {
    await store.put(key, body, { contentType });
  }
  const after = await store.stat(key);
  if (
    !after ||
    after.size !== body.length ||
    !(await matches(store, key, after.etag, want, body))
  ) {
    throw new StoreError(`verification failed after writing ${key}`);
  }
  return "written";
}

async function resetAgeSoSweepSkips(
  store: Store,
  key: string,
  contentType: string,
): Promise<boolean> {
  const current = await store.get(key);
  if (current === null) return false;
  try {
    await store.put(key, current.body, { contentType, ifMatch: current.etag });
  } catch (err) {
    if (!isPreconditionFailed(err)) throw err;
    return (await store.stat(key)) !== null;
  }
  return true;
}

async function matches(
  store: Store,
  key: string,
  etag: string | undefined,
  wantMd5: string,
  body: Uint8Array,
): Promise<boolean> {
  if (etag && /^[0-9a-f]{32}$/.test(etag)) return etag === wantMd5;
  const got = await getBytes(store, key);
  return got !== null && sha256(got) === sha256(body);
}

export async function readMetadata(
  store: Store,
  owner: string,
  archive: string,
): Promise<SessionMetadata | null> {
  const bytes = await getBytes(store, keys.metadata(owner, archive));
  return bytes === null ? null : decodeJson<SessionMetadata>(bytes);
}

/** Update a session's pointer with If-Match and retry on 412: `step` gets the pointer as it is
 * (null for a new session) and returns the next one, or null to leave it alone. `step` may run
 * more than once and must depend only on what it is given. */
export function updateMetadata(
  store: Store,
  owner: string,
  archive: string,
  step: (current: SessionMetadata | null) => SessionMetadata | null,
  options?: Omit<UpdateOptions, "contentType">,
): Promise<JsonUpdate<SessionMetadata>> {
  return updateJson(store, keys.metadata(owner, archive), step, options);
}

/** Append one entry to the owner's change feed. The key is the entry's stamp, its session's
 * archive id, a random suffix and what changed (`keys.change`), so no two entries share one,
 * however close together they are written; an entry written twice is two entries, which readers
 * that read the current metadata take as one. */
export async function appendChange(
  store: Store,
  entry: Omit<ChangeEntry, "schema">,
): Promise<string> {
  const key = keys.change(
    entry.owner,
    entry.at,
    entry.archive_id,
    changeSuffix(),
    entry.kind,
    entry.content_hash,
  );
  await store.put(key, encodeJson({ schema: CHANGE_SCHEMA, ...entry }), {
    contentType: "application/json",
  });
  return key;
}

/** What a step of `updateMetadataWithChange` decides: the next pointer (null to leave it), and
 * the change entry that pointer needs (null for none). */
export interface ChangeUpdate {
  next: SessionMetadata | null;
  change: Omit<ChangeEntry, "schema"> | null;
}

export interface PointerWithChange extends JsonUpdate<SessionMetadata> {
  /** The change entry's key, when one was written. */
  change: string | null;
}

class ChangeFirst extends Error {
  constructor(readonly entry: Omit<ChangeEntry, "schema">) {
    super("the change entry is written before the pointer moves");
  }
}

/** Update a session's pointer as `updateMetadata` does, writing the change entry the update
 * needs first (decision 7 of 18: at least once). `step` gets the pointer as it is and returns
 * the next one with its entry; when it asks for an entry and none was written yet, the entry
 * is written and the update runs again from a fresh read. At most one entry is written: a
 * retry after a 412 that still wants one reuses it. A failure after the entry (the pointer
 * update gives up, the process dies) leaves the entry for a change that did not happen.
 *
 * `expected` is the pointer as the caller last read it (null: no session): when given, the
 * entry `step` wants for it is written before the first read, which saves a read. `step` may
 * run more than once and must depend only on what it is given. */
export async function updateMetadataWithChange(
  store: Store,
  owner: string,
  archive: string,
  step: (current: SessionMetadata | null) => ChangeUpdate,
  options: Omit<UpdateOptions, "contentType"> & { expected?: SessionMetadata | null } = {},
): Promise<PointerWithChange> {
  const { expected, ...update } = options;
  let change: string | null = null;
  if (expected !== undefined) {
    const wanted = step(expected).change;
    if (wanted) change = await appendChange(store, wanted);
  }
  for (;;) {
    try {
      const result = await updateMetadata(
        store,
        owner,
        archive,
        (current) => {
          const decided = step(current);
          if (decided.change && change === null) throw new ChangeFirst(decided.change);
          return decided.next;
        },
        update,
      );
      return { ...result, change };
    } catch (err) {
      if (!(err instanceof ChangeFirst)) throw err;
      change = await appendChange(store, err.entry);
    }
  }
}

/** The boot-time write check: PUT then GET a fixed key, so a write-only policy without Delete
 * passes. */
export async function probe(store: Store, owner: string): Promise<void> {
  const key = keys.probe(owner);
  const body = encoder.encode(`${new Date().toISOString()}\n`);
  await store.put(key, body, { contentType: "text/plain" });
  const back = await getBytes(store, key);
  if (back === null || decoder.decode(back) !== decoder.decode(body)) {
    throw new StoreError(`probe mismatch at ${key}: wrote and read back different bytes`);
  }
}
