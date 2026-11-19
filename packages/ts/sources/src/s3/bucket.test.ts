import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssumedCredentials } from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeS3, FakeSts } from "../testing";
import { FolderSourceBucket, ObjectChanged, S3SourceBucket, type S3SourceOptions } from "./bucket";

const NOW = new Date("2026-11-14T12:00:00.000Z");
const testdata = (file: string) =>
  readFileSync(join(import.meta.dirname, "..", "..", "testdata", "s3", file), "utf8");

function s3(fake: FakeS3, extra: Partial<S3SourceOptions> = {}): S3SourceBucket {
  return new S3SourceBucket({
    url: `s3://${fake.options.bucket}/harness`,
    endpoint: "http://s3.test",
    credentials: { accessKeyId: "AKID", secretAccessKey: "secret" },
    fetch: fake.fetch,
    env: {},
    now: () => NOW,
    ...extra,
  });
}

describe("an S3 source bucket", () => {
  it("lists with sizes and ETags, page by page", async () => {
    const fake = new FakeS3({ bucket: "src", accessKeyId: "AKID" });
    fake.put("harness/a.jsonl", "aa", { modified: NOW });
    fake.put("harness/b.jsonl", "bbb");
    fake.put("other/c.jsonl", "c");
    const bucket = s3(fake);
    const first = await bucket.list("harness/", { limit: 1 });
    expect(first.truncated).toBe(true);
    expect(first.objects).toEqual([
      {
        key: "harness/a.jsonl",
        size: 2,
        etag: fake.objects.get("harness/a.jsonl")?.etag,
        last_modified: NOW.toISOString(),
      },
    ]);
    const second = await bucket.list("harness/", { limit: 1, startAfter: "harness/a.jsonl" });
    expect(second.objects.map((o) => o.key)).toEqual(["harness/b.jsonl"]);
    expect(second.truncated).toBe(false);
    expect(bucket.locate("harness/a.jsonl")).toBe("s3://src/harness/a.jsonl");
  });

  it("reads AWS's documented ListObjectsV2 shape", async () => {
    const bucket = s3(new FakeS3({ bucket: "eval-runs" }), {
      url: "s3://eval-runs/harness",
      fetch: async () => new Response(testdata("list-objects-v2.xml")),
    });
    expect(await bucket.list("harness/", { limit: 2 })).toEqual({
      objects: [
        {
          key: "harness/alice/run&1.jsonl",
          size: 938,
          etag: "9b2cf535f27731c974343645a3985328",
          last_modified: "2026-11-01T09:00:00.000Z",
        },
        {
          key: "harness/bob/run2.json",
          size: 10485760,
          etag: "3858f62230ac3c915f300c664312c11f-2",
          last_modified: "2026-11-02T10:30:00.000Z",
        },
      ],
      truncated: true,
    });
  });

  it("reads an object or its tail only at the version listed", async () => {
    const fake = new FakeS3({ bucket: "src" });
    const object = fake.put("harness/a.jsonl", "0123456789", {
      metadata: { "seshi-session": "s" },
    });
    const bucket = s3(fake);
    const whole = await bucket.read("harness/a.jsonl", { etag: object.etag });
    expect(new TextDecoder().decode(whole?.body)).toBe("0123456789");
    expect(whole?.metadata).toEqual({ "seshi-session": "s" });
    const tail = await bucket.read("harness/a.jsonl", { etag: object.etag, start: 6 });
    expect(tail?.start).toBe(6);
    expect(new TextDecoder().decode(tail?.body)).toBe("6789");
    expect(fake.reads().at(-1)).toEqual({ key: "harness/a.jsonl", range: "bytes=6-" });

    await expect(bucket.read("harness/a.jsonl", { etag: "stale" })).rejects.toBeInstanceOf(
      ObjectChanged,
    );
    await expect(
      bucket.read("harness/a.jsonl", { etag: object.etag, start: 99 }),
    ).rejects.toBeInstanceOf(ObjectChanged);
    expect(await bucket.read("harness/none", { etag: "x" })).toBeNull();
  });

  it("passes S3's other errors through", async () => {
    const fake = new FakeS3({ bucket: "src", accessKeyId: "OTHER" });
    await expect(s3(fake).list("", { limit: 1 })).rejects.toThrow(/403 InvalidAccessKeyId/);
    fake.queued.push(new Response("<Error><Code>InternalError</Code></Error>", { status: 500 }));
    await expect(s3(fake).read("k", { etag: "e" })).rejects.toThrow(/500 InternalError/);
  });

  it("falls back to the environment's keys, R2's first for r2://", async () => {
    const fake = new FakeS3({ bucket: "src", accessKeyId: "R2KEY" });
    const r2 = new S3SourceBucket({
      url: "r2://src/harness",
      accountId: "acct",
      fetch: async (input, init) => {
        expect(new URL(input).host).toBe("acct.r2.cloudflarestorage.com");
        expect((init?.headers as Record<string, string> | undefined)?.authorization).toContain(
          "/auto/s3/",
        );
        return fake.fetch(input.replace("acct.r2.cloudflarestorage.com", "s3.test"), init);
      },
      env: { R2_ACCESS_KEY_ID: "R2KEY", R2_SECRET_ACCESS_KEY: "s", AWS_ACCESS_KEY_ID: "AWS" },
      now: () => NOW,
    });
    expect((await r2.list("harness/", { limit: 1 })).objects).toEqual([]);
    expect(r2.locate("harness/x")).toBe("r2://src/harness/x");

    const none = new S3SourceBucket({
      url: "s3://src",
      fetch: fake.fetch,
      env: {},
      now: () => NOW,
    });
    await expect(none.list("", { limit: 1 })).rejects.toThrow(/needs keys/);
    const noEndpoint = new S3SourceBucket({
      url: "r2://src",
      credentials: { accessKeyId: "a", secretAccessKey: "b" },
      fetch: fake.fetch,
      env: {},
      now: () => NOW,
    });
    await expect(noEndpoint.list("", { limit: 1 })).rejects.toThrow(/account_id or endpoint/);
  });

  it("assumes a role with its external id and keeps the keys until near expiry", async () => {
    let now = NOW;
    const sts = new FakeSts({
      roleArn: "arn:aws:iam::1:role/read",
      externalId: "ext",
      issued: { accessKeyId: "ASIA1", secretAccessKey: "tmp", sessionToken: "tok" },
      now: () => now,
    });
    const fake = new FakeS3({ bucket: "src", accessKeyId: "ASIA1" });
    fake.put("harness/a", "x");
    const cache = new Map<string, AssumedCredentials>();
    const fetch = async (input: string, init?: RequestInit) =>
      input.startsWith("https://sts.test") ? sts.fetch(input, init) : fake.fetch(input, init);
    const open = () =>
      s3(fake, {
        role: { arn: "arn:aws:iam::1:role/read", externalId: "ext", sessionName: "seshi-evals" },
        roleCache: cache,
        stsEndpoint: "https://sts.test",
        fetch,
        now: () => now,
      });
    expect((await open().list("harness/", { limit: 5 })).objects).toHaveLength(1);
    const listing = fake.requests.at(-1);
    expect(listing?.headers.get("x-amz-security-token")).toBe("tok");
    expect(sts.calls).toHaveLength(1);
    expect(sts.calls[0]?.get("RoleSessionName")).toBe("seshi-evals");
    // A later run reuses the keys…
    await open().list("harness/", { limit: 5 });
    expect(sts.calls).toHaveLength(1);
    // …until they are within five minutes of expiring.
    now = new Date(NOW.getTime() + 56 * 60 * 1000);
    await open().list("harness/", { limit: 5 });
    expect(sts.calls).toHaveLength(2);

    const wrong = s3(fake, {
      role: { arn: "arn:aws:iam::1:role/read", externalId: "nope", sessionName: "s" },
      stsEndpoint: "https://sts.test",
      fetch,
    });
    await expect(wrong.list("", { limit: 1 })).rejects.toThrow(/AccessDenied/);
    const r2 = new S3SourceBucket({
      url: "r2://src",
      accountId: "a",
      credentials: { accessKeyId: "a", secretAccessKey: "b" },
      role: { arn: "r", sessionName: "s" },
      fetch,
      env: {},
      now: () => now,
    });
    await expect(r2.list("", { limit: 1 })).rejects.toThrow(/role applies to s3:\/\//);
  });

  it("reads AWS's documented AssumeRole answer", async () => {
    const fake = new FakeS3({ bucket: "src", accessKeyId: "ASIAIOSFODNN7EXAMPLE" });
    const bucket = s3(fake, {
      role: { arn: "arn:aws:iam::123456789012:role/seshi-read", sessionName: "seshi-evals" },
      stsEndpoint: "https://sts.test",
      fetch: async (input, init) =>
        input.startsWith("https://sts.test")
          ? new Response(testdata("assume-role.xml"))
          : fake.fetch(input, init),
    });
    await bucket.list("", { limit: 1 });
    expect(fake.requests.at(-1)?.headers.get("x-amz-security-token")).toBe(
      "IQoJb3JpZ2luX2VjEXAMPLE&TOKEN",
    );
  });
});

describe("a folder source", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seshi-folder-source-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("lists files in key order with a stat-based ETag", async () => {
    mkdirSync(join(dir, "runs", "deep"), { recursive: true });
    writeFileSync(join(dir, "runs", "b.jsonl"), "bb");
    writeFileSync(join(dir, "runs", "deep", "a.jsonl"), "a");
    writeFileSync(join(dir, "top.txt"), "t");
    const bucket = new FolderSourceBucket(`file://${dir}/`);
    const all = await bucket.list("runs/", { limit: 10 });
    expect(all.objects.map((o) => [o.key, o.size])).toEqual([
      ["runs/b.jsonl", 2],
      ["runs/deep/a.jsonl", 1],
    ]);
    const paged = await bucket.list("", { limit: 1, startAfter: "runs/b.jsonl" });
    expect(paged.objects.map((o) => o.key)).toEqual(["runs/deep/a.jsonl"]);
    expect(paged.truncated).toBe(true);
    expect(bucket.locate("runs/b.jsonl")).toBe(`file://${join(dir, "runs", "b.jsonl")}`);
    expect(
      (await new FolderSourceBucket(join(dir, "missing")).list("", { limit: 5 })).objects,
    ).toEqual([]);
  });

  it("reads a file or its tail while unchanged", async () => {
    const path = join(dir, "log.jsonl");
    writeFileSync(path, "0123456789");
    const bucket = new FolderSourceBucket(dir);
    const [listed] = (await bucket.list("", { limit: 1 })).objects;
    if (!listed) throw new Error("not listed");
    const tail = await bucket.read("log.jsonl", { etag: listed.etag, start: 4 });
    expect(new TextDecoder().decode(tail?.body)).toBe("456789");
    expect(tail?.start).toBe(4);
    expect(tail?.size).toBe(10);
    writeFileSync(path, "0123456789ab");
    utimesSync(path, new Date(), new Date(Date.now() + 5000));
    await expect(bucket.read("log.jsonl", { etag: listed.etag })).rejects.toBeInstanceOf(
      ObjectChanged,
    );
    expect(await bucket.read("nope", { etag: "x" })).toBeNull();
  });
});
