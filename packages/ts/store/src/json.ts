import { gunzipSync, gzipSync } from "node:zlib";
import {
  type Store,
  StoreError,
  type UpdateOptions,
  type UpdateResult,
  updateObject,
} from "./store";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeJson(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value, null, 2)}\n`);
}

export function decodeJson<T>(bytes: Uint8Array): T {
  return JSON.parse(decoder.decode(bytes)) as T;
}

export function gzipJson(value: unknown): Uint8Array {
  return new Uint8Array(gzipSync(encoder.encode(JSON.stringify(value)), { level: 6 }));
}

export function gunzipJson<T>(bytes: Uint8Array): T {
  return JSON.parse(decoder.decode(gunzipSync(bytes))) as T;
}

const JSON_TYPE = "application/json";

export interface Versioned<T> {
  value: T;
  etag: string;
}

function parse<T>(key: string, bytes: Uint8Array): T {
  try {
    return decodeJson<T>(bytes);
  } catch (err) {
    throw new StoreError(`${key} is not JSON`, err);
  }
}

export async function readJson<T>(store: Store, key: string): Promise<Versioned<T> | null> {
  const object = await store.get(key);
  return object === null ? null : { value: parse<T>(key, object.body), etag: object.etag };
}

/** Write `value` only if nothing is at `key` (If-None-Match); `PreconditionFailed` otherwise.
 * Returns the new ETag. */
export async function createJson(store: Store, key: string, value: unknown): Promise<string> {
  const put = await store.put(key, encodeJson(value), {
    contentType: JSON_TYPE,
    ifNoneMatch: "*",
  });
  return put.etag ?? "";
}

/** Replace the version read at `etag` (If-Match); `PreconditionFailed` when it changed. */
export async function replaceJson(
  store: Store,
  key: string,
  value: unknown,
  etag: string,
): Promise<string> {
  const put = await store.put(key, encodeJson(value), { contentType: JSON_TYPE, ifMatch: etag });
  return put.etag ?? "";
}

/** Write `value` whatever is there: for objects only one writer owns (a heartbeat, a pending
 * marker that is only touched). */
export async function putJson(store: Store, key: string, value: unknown): Promise<string> {
  const put = await store.put(key, encodeJson(value), { contentType: JSON_TYPE });
  return put.etag ?? "";
}

export interface JsonUpdate<T> extends Omit<UpdateResult, "current"> {
  /** The object as it now stands; null when there is none. */
  value: T | null;
}

/** Read-modify-write a JSON object with retry on 412 (`updateObject`): `step` gets the current
 * value (null when there is none) and returns the next one, or null to leave it alone. `step`
 * may run more than once, so it must depend only on what it is given. */
export async function updateJson<T>(
  store: Store,
  key: string,
  step: (current: T | null) => T | null,
  options: Omit<UpdateOptions, "contentType"> = {},
): Promise<JsonUpdate<T>> {
  let value: T | null = null;
  const result = await updateObject(
    store,
    key,
    (current) => {
      const before = current === null ? null : parse<T>(key, current.body);
      const next = step(before);
      value = next ?? before;
      return next === null ? null : encodeJson(next);
    },
    { ...options, contentType: JSON_TYPE },
  );
  return { written: result.written, value };
}
