import { describe, expect, it } from "vitest";
import { GcsStore, parseGcsUrl, resolveGcsAccess } from "./gcs";
import { openStore } from "./open";
import { publishObject } from "./publish";
import { storageTest } from "./storage-test";
import { AccessDenied, PreconditionFailed, StoreError } from "./store";

describe("parseGcsUrl", () => {
  it("takes the bucket and a trimmed prefix", () => {
    expect(parseGcsUrl("gs://b/p/q/")).toEqual({ bucket: "b", prefix: "p/q" });
    expect(parseGcsUrl("gs://b")).toEqual({ bucket: "b", prefix: "" });
    expect(() => parseGcsUrl("s3://b")).toThrow("not a gs:// URL");
  });
});

describe("resolveGcsAccess", () => {
  it("talks to STORAGE_EMULATOR_HOST without credentials", () => {
    expect(
      resolveGcsAccess("gs://b", { env: { STORAGE_EMULATOR_HOST: "localhost:4443" } }),
    ).toEqual({ endpoint: "http://localhost:4443", token: undefined });
    const access = resolveGcsAccess("gs://b", {
      endpoint: "http://127.0.0.1:9000",
      env: { STORAGE_EMULATOR_HOST: "http://localhost:4443" },
    });
    expect(access.endpoint).toBe("http://127.0.0.1:9000");
  });

  it("uses a key from config over the environment, and names the bucket when it is bad", () => {
    expect(() =>
      resolveGcsAccess("gs://b/p", {
        credentials: { serviceAccountKey: "not json" },
        env: { STORAGE_EMULATOR_HOST: "localhost:4443" },
      }),
    ).toThrow("gs://b/p's service account key is not a Google credentials JSON file");
  });

  it("falls back to Application Default Credentials", () => {
    expect(() =>
      resolveGcsAccess("gs://b", { env: { GOOGLE_APPLICATION_CREDENTIALS: "/nonexistent.json" } }),
    ).toThrow("cannot read Google credentials /nonexistent.json");
    const access = resolveGcsAccess("gs://b", { env: { HOME: "/nonexistent" } });
    expect(access.token).toBeTypeOf("function");
    expect(access.endpoint).toBeUndefined();
  });
});

/** An in-memory bucket behind the JSON API, honouring generation preconditions on every
 * operation as GCS does (fake-gcs-server ignores them on reads and deletes). */
function fakeGcs() {
  const objects = new Map<string, { body: Uint8Array; generation: string }>();
  let clock = 1_700_000_000_000_000;
  const err = (status: number, reason: string) =>
    new Response(JSON.stringify({ error: { code: status, errors: [{ reason }] } }), { status });
  const fetch = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const want = url.searchParams.get("ifGenerationMatch");
    const holds = (name: string) =>
      want === null || (objects.get(name)?.generation ?? "0") === want;
    if (url.pathname === "/upload/storage/v1/b/b/o") {
      const name = url.searchParams.get("name") as string;
      if (!holds(name)) return err(412, "conditionNotMet");
      const generation = String(++clock);
      objects.set(name, { body: init?.body as Uint8Array, generation });
      return new Response(JSON.stringify({ generation }));
    }
    if (url.pathname === "/storage/v1/b/b/o") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const items = [...objects.keys()]
        .filter((k) => k.startsWith(prefix))
        .sort()
        .map((name) => ({ name, size: String(objects.get(name)?.body.length) }));
      return new Response(JSON.stringify({ items }));
    }
    const name = decodeURIComponent(url.pathname.replace("/storage/v1/b/b/o/", ""));
    const object = objects.get(name);
    if (!object) return err(404, "notFound");
    if (!holds(name)) return err(412, "conditionNotMet");
    if (method === "DELETE") {
      objects.delete(name);
      return new Response(null, { status: 204 });
    }
    if (url.searchParams.get("alt") === "media") {
      return new Response(object.body as BodyInit, {
        headers: { "x-goog-generation": object.generation },
      });
    }
    return new Response(
      JSON.stringify({ size: String(object.body.length), generation: object.generation }),
    );
  };
  return { objects, fetch };
}

describe("GcsStore", () => {
  const open = (fetch = fakeGcs().fetch) =>
    GcsStore.fromUrl("gs://b/seshi", {
      endpoint: "http://gcs",
      fetch,
      env: { STORAGE_EMULATOR_HOST: "x" },
    });

  it("passes the storage test on a bucket that honours generation preconditions", async () => {
    const result = await storageTest(open(), "alice");
    expect(result.steps.filter((s) => !s.ok)).toEqual([]);
    expect(result).toMatchObject({ conditionalWrites: true, conditionalDelete: true });
  });

  it("creates, replaces on the generation, and refuses a stale one", async () => {
    const s = open();
    const enc = (v: string) => new TextEncoder().encode(v);
    const first = await s.put("k", enc("1"), { ifNoneMatch: "*" });
    await expect(s.put("k", enc("2"), { ifNoneMatch: "*" })).rejects.toBeInstanceOf(
      PreconditionFailed,
    );
    const second = await s.put("k", enc("2"), { ifMatch: first.etag });
    await expect(s.put("k", enc("3"), { ifMatch: first.etag })).rejects.toThrow(
      "the object changed or is gone",
    );
    await expect(s.delete("k", { ifMatch: first.etag })).rejects.toBeInstanceOf(PreconditionFailed);
    await s.delete("k", { ifMatch: second.etag });
    expect(await s.get("k")).toBeNull();
    expect((await s.list("")).keys).toEqual([]);
  });

  it("publishes and replaces, verifying by reading back (a generation is not an MD5)", async () => {
    const s = open();
    const enc = (v: string) => new TextEncoder().encode(v);
    expect(await publishObject(s, "t.json", enc('{"a":1}'), "application/json")).toBe("written");
    expect(await publishObject(s, "t.json", enc('{"a":1}'), "application/json")).toBe("exists");
    expect(await publishObject(s, "t.json", enc('{"a":2}'), "application/json", "replace")).toBe(
      "written",
    );
  });

  it("keeps its keys under the prefix", async () => {
    const gcs = fakeGcs();
    const s = open(gcs.fetch);
    await s.put("owners/a/x", new Uint8Array([1]));
    expect([...gcs.objects.keys()]).toEqual(["seshi/owners/a/x"]);
    expect((await s.list("owners/")).keys).toEqual(["owners/a/x"]);
  });

  it("reports refusals as AccessDenied and other failures as StoreError", async () => {
    const answer = (status: number) => async () =>
      new Response(JSON.stringify({ error: { code: status, errors: [{ reason: "x" }] } }), {
        status,
      });
    await expect(open(answer(403)).get("k")).rejects.toBeInstanceOf(AccessDenied);
    await expect(open(answer(401)).put("k", new Uint8Array())).rejects.toBeInstanceOf(AccessDenied);
    const err = await open(answer(500))
      .list("")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect(err).not.toBeInstanceOf(AccessDenied);
  });
});

describe("openStore with gs://", () => {
  it("opens a GCS store and says where it is, never with the key", () => {
    const { store, storage } = openStore("gs://sessions/prod", {
      endpoint: "http://127.0.0.1:4443",
      env: { STORAGE_EMULATOR_HOST: "127.0.0.1:4443" },
    });
    expect(store).toBeInstanceOf(GcsStore);
    expect(storage).toEqual({ url: "gs://sessions/prod", endpoint: "http://127.0.0.1:4443" });
    expect(openStore("gs://sessions", { env: { HOME: "/nonexistent" } }).storage).toEqual({
      url: "gs://sessions",
    });
  });

  it("refuses keys for the other kinds of bucket", () => {
    expect(() =>
      openStore("gs://b", { credentials: { accessKeyId: "a", secretAccessKey: "s" }, env: {} }),
    ).toThrow("a gs:// store takes a service account key");
    expect(() =>
      openStore("az://c", { accountName: "a", credentials: { serviceAccountKey: "{}" }, env: {} }),
    ).toThrow("account key or SAS token");
    expect(() =>
      openStore("s3://b", { credentials: { serviceAccountKey: "{}" }, env: {} }),
    ).toThrow("access key id and secret access key");
  });
});
