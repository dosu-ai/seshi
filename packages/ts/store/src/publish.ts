/** The publish protocol: write a trace object, verify it landed intact, then update the
 * session's pointer and append a change entry. A trace is content-addressed and a raw part
 * part-numbered, so re-publishing the same bytes is a no-op and two writers converge. The
 * pointer (`metadata.json`) is mutable and written with If-Match (X6.5): two writers updating
 * one session each re-read and retry instead of one losing the other's update. */

import { createHash } from "node:crypto";
import { CHANGE_SCHEMA, type ChangeEntry, type SessionMetadata } from "@seshi/model";
import { decodeJson, encodeJson, type JsonUpdate, updateJson } from "./json";
import { keys } from "./layout";
import { getBytes, type Store, StoreError, type UpdateOptions } from "./store";

export { decodeJson, gunzipJson, gzipJson } from "./json";

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
 * the first writer's view is as good as any. `replace` is for part-numbered keys (a raw part): the
 * same bytes are a no-op and different bytes replace. */
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
    if (mode === "immutable") return "exists";
    if (before.size === body.length && (await matches(store, key, before.etag, want, body))) {
      return "exists";
    }
  }
  await store.put(key, body, { contentType });
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

/** Append one entry to the owner's change feed. Keys are time-prefixed and end in the trace's
 * hash (or the kind), so an entry written twice lands on one key. */
export async function appendChange(
  store: Store,
  entry: Omit<ChangeEntry, "schema">,
): Promise<string> {
  const key = keys.change(entry.owner, entry.at, entry.kind, entry.content_hash);
  await store.put(key, encodeJson({ schema: CHANGE_SCHEMA, ...entry }), {
    contentType: "application/json",
  });
  return key;
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
