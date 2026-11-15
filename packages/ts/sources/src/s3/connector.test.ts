/** The S3 poller (F6) against an in-memory bucket and a pipeline that keeps the log protocol
 * (X4.4, X4.6): what it submits, what it reads, and what its manifest remembers. The real
 * pipeline and formats are exercised end to end in `tests/instance/s3-sync.test.ts`. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { loadConfig, type SourceConfig, serverConfigSchema } from "@seshi/config";
import { BUILTIN_FORMATS, FormatRegistry } from "@seshi/formats";
import type { Envelope, FormatAdapter, LogPayload } from "@seshi/model";
import {
  type FailedRecord,
  FsStore,
  listRecords,
  readCheckpoint,
  type Store,
  writeCheckpoint,
} from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Sources, type Submitter } from "../sources";
import { FakeS3 } from "../testing";
import { completeLines, S3Connector, sourcePrefix, TAIL_WINDOW } from "./connector";
import type { Manifest } from "./manifest";

const NOW = new Date("2026-11-14T12:00:00.000Z");

/** A JSONL format `detect` knows by its `kind: "line"` records, and a document format. */
const LINES: FormatAdapter = {
  source: "lines",
  chunkable: true,
  detect: { record: (row) => row.kind === "line" },
  normalize: () => [],
};
const DOC: FormatAdapter = {
  source: "doc",
  chunkable: false,
  detect: { document: (head) => head.has("doc_version") },
  normalize: () => [],
};
const formats = new FormatRegistry([LINES, DOC, ...BUILTIN_FORMATS]);

const line = (n: number, pad = 0) =>
  `${JSON.stringify({ kind: "line", n, pad: "x".repeat(pad) })}\n`;
const lines = (from: number, to: number, pad = 0) =>
  Array.from({ length: to - from }, (_, i) => line(from + i, pad)).join("");

/** A pipeline that keeps each session's log the way the real one does: a whole log starts or
 * extends a session (or replaces it with `replace`), a chunk must start where it ends. */
class LogPipeline implements Submitter {
  readonly envelopes: Envelope[] = [];
  readonly sessions = new Map<string, string>();
  /** Answer `filtered` for a session's first log when this says so. */
  filter: (text: string) => boolean = () => false;
  /** Answer the next envelope this way instead. */
  override: ((e: Envelope) => unknown) | undefined;
  readonly health = {
    counted: [] as string[],
    count: (id: string) => this.health.counted.push(id),
  };

  async submit(envelope: Envelope): Promise<unknown> {
    this.envelopes.push(envelope);
    const override = this.override;
    if (override) {
      this.override = undefined;
      return override(envelope);
    }
    const payload = envelope.payload as LogPayload;
    const id = `${envelope.format}\n${envelope.session_key}`;
    const stored = this.sessions.get(id);
    const bytes = (t: string) => Buffer.byteLength(t, "utf8");
    if (payload.offset > 0) {
      if (stored === undefined || bytes(stored) !== payload.offset) {
        return { status: "failed", code: "offset_mismatch", message: "m", record: "r" };
      }
      this.sessions.set(id, stored + payload.text);
      return { status: "stored", bytes_total: bytes(stored + payload.text) };
    }
    if (stored === undefined) {
      if (this.filter(payload.text)) return { status: "filtered", bytes_total: 0 };
      this.sessions.set(id, payload.text);
      return { status: "stored", bytes_total: bytes(payload.text) };
    }
    if (payload.text.startsWith(stored)) {
      this.sessions.set(id, payload.text);
      const status = payload.text === stored ? "unchanged" : "stored";
      return { status, bytes_total: bytes(payload.text) };
    }
    if (!envelope.replace) return { status: "failed", code: "conflict", message: "m", record: "r" };
    this.sessions.set(id, payload.text);
    return { status: "stored", bytes_total: bytes(payload.text), replaced: true };
  }

  /** The last envelope's payload. */
  last(): LogPayload {
    return this.envelopes.at(-1)?.payload as LogPayload;
  }
}

function sourceConfigs(toml: string): SourceConfig[] {
  const text = `[store]\nurl = "file:///tmp/unused"\n${toml}`;
  return loadConfig(serverConfigSchema, {
    file: "seshi.toml",
    fs: { readFile: () => text, mode: () => 0o100600 },
  }).config.sources;
}

const SOURCE = (extra = "") => `
[[sources]]
id = "evals"
type = "s3"
url = "s3://src/harness"
endpoint = "http://s3.test"
credentials = { access_key_id = "AKID", secret_access_key = "secret" }
${extra}
`;

let dir: string;
let store: Store;
let fake: FakeS3;
let pipeline: LogPipeline;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-s3-poller-"));
  store = new FsStore(dir);
  fake = new FakeS3({ bucket: "src", accessKeyId: "AKID", now: () => NOW });
  pipeline = new LogPipeline();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function sources(
  extra = "",
  options: Partial<ConstructorParameters<typeof S3Connector>[0]> = {},
): Sources {
  return new Sources({
    store,
    pipeline,
    sources: sourceConfigs(SOURCE(extra)),
    connectors: [new S3Connector({ formats, maxBytes: 1 << 20, env: {}, ...options })],
    fetch: fake.fetch as typeof fetch,
    now: () => NOW,
  });
}

async function manifest(): Promise<Manifest> {
  return (await readCheckpoint(store, "evals"))?.value.cursor as unknown as Manifest;
}

async function failures() {
  return (await listRecords(store, "failed", "evals")).records.map((r) => r.record as FailedRecord);
}

describe("the first run", () => {
  it("submits each new object whole, as the source's service account, with replace", async () => {
    const text = lines(0, 3);
    const object = fake.put("harness/run-1.jsonl", text);
    const report = await sources().run("evals");
    expect(report).toMatchObject({ outcome: "ok", submitted: 1, outcomes: { stored: 1 } });
    expect(pipeline.envelopes[0]).toEqual({
      schema: "seshi/envelope/1",
      source: "s3",
      source_id: "evals",
      format: "lines",
      session_key: "run-1.jsonl",
      payload: { kind: "log", encoding: "jsonl", text, offset: 0 },
      caller: { kind: "service", principal: "svc:evals" },
      owner: "svc:evals",
      owner_basis: "service",
      idempotency_key: `s3://src/harness/run-1.jsonl#${object.etag}~${NOW.getTime()}`,
      provenance: { object_key: "s3://src/harness/run-1.jsonl", etag: object.etag },
      received_at: NOW.toISOString(),
      replace: true,
    });
    expect((await manifest()).objects["harness/run-1.jsonl"]).toEqual({
      etag: object.etag,
      size: text.length,
      modified: NOW.toISOString(),
      format: "lines",
      session: "run-1.jsonl",
      offset: text.length,
      tail: expect.any(String),
    });
    expect((await manifest()).listed_at).toBe(NOW.toISOString());
  });

  it("sends a whole document as json, and detects formats from the start of each object", async () => {
    fake.put("harness/a.json", JSON.stringify({ doc_version: 1, steps: [] }));
    fake.put("harness/b.jsonl", lines(0, 2));
    await sources().run("evals");
    expect(
      pipeline.envelopes.map((e) => [e.session_key, e.format, (e.payload as LogPayload).encoding]),
    ).toEqual([
      ["a.json", "doc", "json"],
      ["b.jsonl", "lines", "jsonl"],
    ]);
  });

  it("takes the format from the source, then the object's metadata, then the key", async () => {
    fake.put("harness/x/one.log", "not json at all\n");
    await sources('format = "lines"').run("evals");
    expect(pipeline.envelopes[0]?.format).toBe("lines");

    pipeline = new LogPipeline();
    const s = sources('path = "{format}/{session}.log"');
    fake.objects.clear();
    fake.put("harness/doc/two.log", "{}", { metadata: { "seshi-format": "lines" } });
    fake.put("harness/doc/three.log", "{}");
    await s.run("evals");
    expect(pipeline.envelopes.map((e) => [e.session_key, e.format])).toEqual([
      ["three", "doc"],
      ["two", "lines"],
    ]);
  });

  it("joins the URL's prefix and the source's, and skips keys outside them", async () => {
    expect(sourcePrefix({ url: "s3://b/a/", prefix: "/b/c/" })).toBe("a/b/c");
    expect(sourcePrefix({ url: "r2://b", prefix: undefined })).toBe("");
    expect(sourcePrefix({ url: "file:///tmp/x", prefix: "p" })).toBe("p");
    fake.put("harness/in/a.jsonl", lines(0, 1));
    fake.put("harness/out/b.jsonl", lines(0, 1));
    fake.put("harnessX/in/c.jsonl", lines(0, 1));
    await sources('prefix = "in"').run("evals");
    expect(pipeline.envelopes.map((e) => e.session_key)).toEqual(["a.jsonl"]);
    const listing = fake.requests.find((r) => r.url.searchParams.has("list-type"));
    expect(listing?.url.searchParams.get("prefix")).toBe("harness/in/");
  });

  it("reads only the keys the include globs and the path template pick", async () => {
    fake.put("harness/alice/s1.jsonl", lines(0, 1));
    fake.put("harness/alice/notes.txt", "x");
    fake.put("harness/bob/deep/s2.jsonl", lines(0, 1));
    fake.put("harness/dir/", "");
    await sources('include = ["**/*.jsonl"]\npath = "{username}/{session}.jsonl"').run("evals");
    expect(pipeline.envelopes.map((e) => [e.session_key, e.claims])).toEqual([
      ["s1", { username: "alice" }],
    ]);
    expect(fake.reads().map((r) => r.key)).toEqual(["harness/alice/s1.jsonl"]);
  });

  it("records claims, project and branch from the template and metadata, never the owner", async () => {
    fake.put("harness/a@x.io/app/s1.jsonl", lines(0, 1), {
      metadata: {
        "seshi-session": "native-1",
        "seshi-git-email": "dev@x.io",
        "seshi-branch": "main",
        "seshi-name": "Ann",
      },
    });
    await sources('path = "{email}/{project}/{session}.jsonl"').run("evals");
    const [envelope] = pipeline.envelopes;
    expect(envelope?.session_key).toBe("native-1");
    expect(envelope?.claims).toEqual({ email: "a@x.io", name: "Ann", git_email: "dev@x.io" });
    expect(envelope?.project).toBe("app");
    expect(envelope?.branch).toBe("main");
    expect(envelope?.owner).toBe("svc:evals");
  });
});

describe("later runs (F6.2)", () => {
  it("reads nothing for objects whose ETag and size did not change", async () => {
    fake.put("harness/a.jsonl", lines(0, 2));
    const s = sources();
    await s.run("evals");
    const reads = fake.reads().length;
    const report = await s.run("evals");
    expect(report.submitted).toBe(0);
    expect(fake.reads()).toHaveLength(reads);
    expect(report.checkpoint_saved).toBe(true);
  });

  it("continues a grown log from its offset, reading only the tail (X4.4)", async () => {
    const first = lines(0, 50, 100);
    fake.put("harness/a.jsonl", first);
    const s = sources();
    await s.run("evals");
    const grown = fake.append("harness/a.jsonl", lines(50, 52));
    const report = await s.run("evals");
    expect(report.outcomes).toEqual({ stored: 1 });
    expect(pipeline.last()).toEqual({
      kind: "log",
      encoding: "jsonl",
      text: lines(50, 52),
      offset: first.length,
    });
    const envelope = pipeline.envelopes.at(-1);
    expect(envelope?.replace).toBeUndefined();
    expect(envelope?.idempotency_key).toBe(
      `s3://src/harness/a.jsonl#${grown.etag}@${first.length}`,
    );
    expect(fake.reads().at(-1)).toEqual({
      key: "harness/a.jsonl",
      range: `bytes=${first.length - TAIL_WINDOW}-`,
    });
    expect((await manifest()).objects["harness/a.jsonl"]?.offset).toBe(grown.body.length);
    // And again: the tail digest moved with it.
    fake.append("harness/a.jsonl", lines(52, 53));
    await s.run("evals");
    expect(pipeline.last().offset).toBe(grown.body.length);
    expect(pipeline.sessions.get("lines\na.jsonl")).toBe(first + lines(50, 53));
  });

  it("continues a short log, whose tail window is the whole of it", async () => {
    fake.put("harness/a.jsonl", lines(0, 1));
    const s = sources();
    await s.run("evals");
    fake.append("harness/a.jsonl", lines(1, 2));
    await s.run("evals");
    expect(pipeline.last().offset).toBe(line(0).length);
    expect(fake.reads().at(-1)?.range).toBeUndefined();
  });

  it("sends only complete lines of a chunk, and the rest once it is finished", async () => {
    fake.put("harness/a.jsonl", lines(0, 2));
    const s = sources();
    await s.run("evals");
    const partial = line(2).slice(0, 10);
    fake.append("harness/a.jsonl", line(3) + partial);
    await s.run("evals");
    expect(pipeline.last().text).toBe(line(3));
    fake.append("harness/a.jsonl", line(2).slice(10));
    await s.run("evals");
    expect(pipeline.last().text).toBe(line(2));
    expect(pipeline.sessions.get("lines\na.jsonl")).toBe(lines(0, 2) + line(3) + line(2));
  });

  it("waits for a newline when a log grew by part of a line", async () => {
    fake.put("harness/a.jsonl", lines(0, 2));
    const s = sources();
    await s.run("evals");
    const grown = fake.append("harness/a.jsonl", '{"kind":"li');
    const report = await s.run("evals");
    expect(report.submitted).toBe(0);
    expect((await manifest()).objects["harness/a.jsonl"]).toMatchObject({
      etag: grown.etag,
      offset: lines(0, 2).length,
    });
  });

  it("keeps a whole log's last line without a newline when it is complete JSON", async () => {
    expect(completeLines("a\nb\n")).toBe("a\nb\n");
    expect(completeLines('{"a":1}\n{"b":2}')).toBe('{"a":1}\n{"b":2}');
    expect(completeLines('{"a":1}\n{"b":')).toBe('{"a":1}\n');
    expect(completeLines('{"b":')).toBe("");
    expect(completeLines("x\n  ")).toBe("x\n  ");
    const text = lines(0, 2).trimEnd();
    fake.put("harness/a.jsonl", text);
    const s = sources();
    await s.run("evals");
    expect(pipeline.last().text).toBe(text);
    // The writer later finishes the line and adds more: the chunk starts with that newline.
    fake.append("harness/a.jsonl", `\n${line(2)}`);
    await s.run("evals");
    expect(pipeline.last()).toMatchObject({ text: `\n${line(2)}`, offset: text.length });
  });

  it("does not send a whole log that has no complete line yet", async () => {
    fake.put("harness/a.jsonl", '{"kind":"line","n"');
    const s = sources();
    expect((await s.run("evals")).submitted).toBe(0);
    fake.append("harness/a.jsonl", ":0}\n");
    await s.run("evals");
    expect(pipeline.last()).toMatchObject({ text: '{"kind":"line","n":0}\n', offset: 0 });
  });

  it("replaces the session when a log was rewritten rather than appended (F6.3)", async () => {
    fake.put("harness/a.jsonl", lines(0, 5));
    const s = sources();
    await s.run("evals");
    // Longer, but the bytes before the old end changed.
    const rewritten = lines(10, 16);
    fake.put("harness/a.jsonl", rewritten);
    await s.run("evals");
    expect(pipeline.envelopes.at(-1)?.replace).toBe(true);
    expect(pipeline.last()).toMatchObject({ offset: 0, text: rewritten });
    expect(pipeline.sessions.get("lines\na.jsonl")).toBe(rewritten);
    // Shorter: read whole too.
    fake.put("harness/a.jsonl", lines(10, 11));
    await s.run("evals");
    expect(pipeline.last()).toMatchObject({ offset: 0, text: lines(10, 11) });
  });

  it("reads a rewritten whole document whole, with replace", async () => {
    fake.put("harness/a.json", JSON.stringify({ doc_version: 1, steps: [1] }));
    const s = sources();
    await s.run("evals");
    fake.put("harness/a.json", JSON.stringify({ doc_version: 1, steps: [1, 2] }));
    await s.run("evals");
    expect(pipeline.envelopes).toHaveLength(2);
    expect(pipeline.envelopes[1]).toMatchObject({ replace: true, format: "doc" });
    expect(pipeline.last().offset).toBe(0);
    expect(fake.reads().at(-1)?.range).toBeUndefined();
  });

  it("sends a filtered session whole again once it grows", async () => {
    pipeline.filter = (text) => text.length < 100;
    fake.put("harness/a.jsonl", lines(0, 1));
    const s = sources();
    expect((await s.run("evals")).outcomes).toEqual({ filtered: 1 });
    expect((await manifest()).objects["harness/a.jsonl"]?.offset).toBe(0);
    fake.append("harness/a.jsonl", lines(1, 5));
    await s.run("evals");
    expect(pipeline.last()).toMatchObject({ offset: 0, text: lines(0, 5) });
    expect(pipeline.envelopes.at(-1)?.replace).toBe(true);
  });

  it("sends the log whole when the session is not where the manifest says", async () => {
    fake.put("harness/a.jsonl", lines(0, 2));
    const s = sources();
    await s.run("evals");
    // The session moved on without the manifest (a crash after a submit, before the save).
    pipeline.sessions.set("lines\na.jsonl", lines(0, 3));
    fake.append("harness/a.jsonl", lines(2, 4));
    await s.run("evals");
    const tail = pipeline.envelopes.slice(-2).map((e) => (e.payload as LogPayload).offset);
    expect(tail).toEqual([lines(0, 2).length, 0]);
    expect(pipeline.sessions.get("lines\na.jsonl")).toBe(lines(0, 4));
  });

  it("works against a backend that ignores Range", async () => {
    fake = new FakeS3({ bucket: "src", accessKeyId: "AKID", ignoreRange: true });
    fake.put("harness/a.jsonl", lines(0, 100, 50));
    const s = sources();
    await s.run("evals");
    fake.append("harness/a.jsonl", lines(100, 101));
    await s.run("evals");
    expect(pipeline.last()).toMatchObject({
      text: lines(100, 101),
      offset: lines(0, 100, 50).length,
    });
  });

  it("ignores deleted objects and drops them from the manifest on a complete listing (F6.4)", async () => {
    fake.put("harness/a.jsonl", lines(0, 1));
    fake.put("harness/b.jsonl", lines(0, 1));
    const s = sources();
    await s.run("evals");
    fake.delete("harness/a.jsonl");
    const report = await s.run("evals");
    expect(report.submitted).toBe(0);
    expect(Object.keys((await manifest()).objects)).toEqual(["harness/b.jsonl"]);
    expect(pipeline.sessions.has("lines\na.jsonl")).toBe(true);
  });

  it("skips an object that changed or vanished between listing and reading", async () => {
    fake.put("harness/a.jsonl", lines(0, 1));
    fake.put("harness/b.jsonl", lines(0, 1));
    const original = fake.handle.bind(fake);
    let swapped = false;
    fake.handle = async (request: Request) => {
      const url = new URL(request.url);
      if (!swapped && !url.searchParams.has("list-type")) {
        swapped = true;
        fake.put("harness/a.jsonl", lines(0, 3));
        fake.delete("harness/b.jsonl");
      }
      return original(request);
    };
    const s = sources();
    const report = await s.run("evals");
    expect(report.submitted).toBe(0);
    expect((await manifest()).objects).toEqual({});
    await s.run("evals");
    expect(pipeline.envelopes.map((e) => e.session_key)).toEqual(["a.jsonl"]);
    expect(pipeline.last().text).toBe(lines(0, 3));
  });
});

describe("objects that cannot be stored (X4.8)", () => {
  it("records an object no format matches, once per version", async () => {
    const object = fake.put("harness/notes.txt", "plain words");
    const s = sources();
    const report = await s.run("evals");
    expect(report.outcomes).toEqual({ failed: 1 });
    expect(pipeline.envelopes).toEqual([]);
    expect(pipeline.health.counted).toEqual(["evals"]);
    const [record] = await failures();
    expect(record).toMatchObject({
      source: "evals",
      source_kind: "s3",
      owner: "svc:evals",
      session_key: "notes.txt",
      idempotency_key: `s3://src/harness/notes.txt#${object.etag}~${NOW.getTime()}`,
      provenance: { object_key: "s3://src/harness/notes.txt", etag: object.etag },
      code: "unknown_format",
    });
    expect(record?.message).not.toContain("plain words");
    expect((await manifest()).objects["harness/notes.txt"]?.failed).toBe("unknown_format");
    await s.run("evals");
    expect(await failures()).toHaveLength(1);
    // A new version is tried again.
    fake.put("harness/notes.txt", lines(0, 1));
    await s.run("evals");
    expect(pipeline.envelopes).toHaveLength(1);
    expect((await manifest()).objects["harness/notes.txt"]?.failed).toBeUndefined();
  });

  it("records a format named by metadata that this binary does not read", async () => {
    fake.put("harness/a.jsonl", lines(0, 1), { metadata: { "seshi-format": "nope" } });
    await sources().run("evals");
    expect((await failures())[0]?.code).toBe("unknown_format");
  });

  it("records an object over the size limit without reading it", async () => {
    fake.put("harness/big.jsonl", lines(0, 20));
    await sources("", { maxBytes: 100 }).run("evals");
    expect((await failures())[0]?.code).toBe("too_large");
    expect(fake.reads()).toEqual([]);
  });

  it("records a log that grew past the size limit", async () => {
    fake.put("harness/a.jsonl", lines(0, 1));
    const s = sources("", { maxBytes: 200 });
    await s.run("evals");
    fake.append("harness/a.jsonl", lines(1, 20));
    await s.run("evals");
    expect((await failures())[0]?.code).toBe("too_large");
    expect((await manifest()).objects["harness/a.jsonl"]).toMatchObject({
      failed: "too_large",
      offset: line(0).length,
    });
  });

  it("records bytes that are not UTF-8, whole or appended", async () => {
    fake.put("harness/bin.jsonl", new Uint8Array([0x7b, 0xff, 0xfe, 0x7d, 0x0a]));
    fake.put("harness/a.jsonl", lines(0, 1));
    const s = sources('format = "lines"');
    await s.run("evals");
    expect((await failures()).map((r) => r.code)).toEqual(["not_utf8"]);
    fake.append("harness/a.jsonl", new Uint8Array([0xc3, 0x28, 0x0a]));
    await s.run("evals");
    expect((await failures()).map((r) => r.code).sort()).toEqual(["not_utf8", "not_utf8"]);
  });

  it("marks what the pipeline refused and tries it again only when it changes", async () => {
    fake.put("harness/a.jsonl", lines(0, 1));
    pipeline.override = () => ({
      status: "failed",
      code: "normalize_invalid",
      message: "m",
      record: "r",
    });
    const s = sources();
    await s.run("evals");
    expect((await manifest()).objects["harness/a.jsonl"]?.failed).toBe("normalize_invalid");
    await s.run("evals");
    expect(pipeline.envelopes).toHaveLength(1);
  });

  it("never sends again a session an admin deleted (F6.4)", async () => {
    fake.put("harness/a.jsonl", lines(0, 1));
    const s = sources();
    await s.run("evals");
    fake.append("harness/a.jsonl", lines(1, 2));
    pipeline.override = () => ({ status: "failed", code: "redacted", message: "m", record: "r" });
    await s.run("evals");
    fake.append("harness/a.jsonl", lines(2, 3));
    fake.put("harness/a.jsonl", lines(5, 9));
    const report = await s.run("evals");
    expect(report.submitted).toBe(0);
    expect((await manifest()).objects["harness/a.jsonl"]?.failed).toBe("redacted");
  });

  it("records an object the bucket will not let it read, and goes on with the rest", async () => {
    fake.put("harness/a.jsonl", lines(0, 1));
    fake.put("harness/b.jsonl", lines(0, 1));
    const original = fake.handle.bind(fake);
    fake.handle = async (request: Request) =>
      new URL(request.url).pathname.endsWith("/a.jsonl")
        ? new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 })
        : original(request);
    const s = sources();
    const report = await s.run("evals");
    expect(report).toMatchObject({ outcome: "ok", outcomes: { failed: 1, stored: 1 } });
    expect((await failures()).map((r) => r.code)).toEqual(["access_denied"]);
    // Grown, it is tried again (and refused again, as a chunk would be).
    fake.handle = original;
    fake.append("harness/a.jsonl", lines(1, 2));
    await s.run("evals");
    expect(pipeline.sessions.get("lines\na.jsonl")).toBe(lines(0, 2));
  });

  it("records an object the bucket can never serve (archived, SSE-C) rather than stalling", async () => {
    fake.put("harness/a.jsonl", lines(0, 1));
    fake.put("harness/b.jsonl", lines(0, 1));
    fake.put("harness/c.jsonl", lines(0, 1));
    const original = fake.handle.bind(fake);
    fake.handle = async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/a.jsonl")) {
        return new Response("<Error><Code>InvalidObjectState</Code></Error>", { status: 403 });
      }
      if (path.endsWith("/b.jsonl")) {
        return new Response("<Error><Code>InvalidRequest</Code></Error>", { status: 400 });
      }
      return original(request);
    };
    const report = await sources().run("evals");
    expect(report).toMatchObject({ outcome: "ok", outcomes: { failed: 2, stored: 1 } });
    const recorded = await failures();
    expect(recorded.map((r) => r.code).sort()).toEqual(["access_denied", "unreadable"]);
    expect(recorded.find((r) => r.code === "unreadable")?.message).toBe(
      "the bucket answered 400 InvalidRequest for this object",
    );
  });

  it("fails the run, and moves nothing, when the bucket throttles a read", async () => {
    fake.put("harness/a.jsonl", lines(0, 1));
    const original = fake.handle.bind(fake);
    let throttled = false;
    fake.handle = async (request: Request) => {
      if (!throttled && !new URL(request.url).searchParams.has("list-type")) {
        throttled = true;
        return new Response("<Error><Code>SlowDown</Code></Error>", { status: 429 });
      }
      return original(request);
    };
    const s = sources();
    expect((await s.run("evals")).outcome).toBe("error");
    expect(await failures()).toEqual([]);
    expect((await s.run("evals")).outcomes).toEqual({ stored: 1 });
  });

  it("keeps keys that look like object internals as plain keys", async () => {
    fake.put("harness/__proto__", lines(0, 1));
    fake.put("harness/constructor", lines(0, 1));
    const s = sources();
    await s.run("evals");
    const m = await manifest();
    expect(Object.keys(m.objects).sort()).toEqual(["harness/__proto__", "harness/constructor"]);
    expect((await s.run("evals")).submitted).toBe(0);
  });

  it("refuses a second object feeding the same session", async () => {
    fake.put("harness/a/one.jsonl", lines(0, 1));
    fake.put("harness/b/one.jsonl", lines(0, 2));
    await sources('path = "*/{session}.jsonl"').run("evals");
    expect(pipeline.envelopes.map((e) => e.session_key)).toEqual(["one"]);
    expect((await failures()).map((r) => r.code)).toEqual(["duplicate_session"]);
  });

  it("unzips a gzip object, and always reads it whole", async () => {
    const text = lines(0, 3);
    fake.put("harness/a.jsonl.gz", new Uint8Array(gzipSync(text)));
    const s = sources();
    await s.run("evals");
    expect(pipeline.last()).toMatchObject({ text, offset: 0 });
    expect((await manifest()).objects["harness/a.jsonl.gz"]).toMatchObject({ gz: true });
    fake.put("harness/a.jsonl.gz", new Uint8Array(gzipSync(text + line(3))));
    await s.run("evals");
    expect(pipeline.last()).toMatchObject({ text: text + line(3), offset: 0 });
    expect(fake.reads().at(-1)?.range).toBeUndefined();
  });

  it("treats a Content-Encoding the fetch already undid as whole-only", async () => {
    fake.put("harness/a.jsonl", lines(0, 2), { contentEncoding: "gzip" });
    const s = sources();
    await s.run("evals");
    expect((await manifest()).objects["harness/a.jsonl"]?.gz).toBe(true);
    fake.put("harness/a.jsonl", lines(0, 3), { contentEncoding: "gzip" });
    await s.run("evals");
    expect(pipeline.last()).toMatchObject({ offset: 0, text: lines(0, 3) });
  });

  it("records gzip that does not unzip, and gzip that unzips past the limit", async () => {
    fake.put("harness/bad.gz", new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02]));
    fake.put("harness/bomb.gz", new Uint8Array(gzipSync(lines(0, 400))));
    await sources("", { maxBytes: 4000 }).run("evals");
    expect((await failures()).map((r) => r.code).sort()).toEqual(["bad_gzip", "too_large"]);
  });
});

describe("runs and checkpoints (X7.3)", () => {
  it("hands over after a batch and resumes after the last key handled", async () => {
    for (let i = 0; i < 5; i++) fake.put(`harness/${i}.jsonl`, lines(0, 1));
    const s = sources("", { batch: 2, pageSize: 2 });
    const first = await s.run("evals");
    expect(first).toMatchObject({ outcome: "ok", more: true, submitted: 2 });
    expect((await manifest()).after).toBe("harness/1.jsonl");
    const second = await s.run("evals");
    expect(second).toMatchObject({ more: true, submitted: 2 });
    const third = await s.run("evals");
    expect(third).toMatchObject({ more: false, submitted: 1, lag_ms: 0 });
    expect((await manifest()).after).toBeUndefined();
    expect(pipeline.envelopes.map((e) => e.session_key)).toEqual(
      [0, 1, 2, 3, 4].map((i) => `${i}.jsonl`),
    );
    const listings = fake.requests.filter((r) => r.url.searchParams.has("list-type"));
    expect(listings.some((r) => r.url.searchParams.get("start-after") === "harness/1.jsonl")).toBe(
      true,
    );
  });

  it("does not drop keys a pass that spanned runs may not have seen", async () => {
    for (let i = 0; i < 4; i++) fake.put(`harness/${i}.jsonl`, lines(0, 1));
    const s = sources("", { batch: 100 });
    await s.run("evals");
    const resumed = sources("", { batch: 1 });
    fake.put("harness/0.jsonl", lines(0, 2));
    fake.put("harness/3.jsonl", lines(0, 2));
    expect((await resumed.run("evals")).more).toBe(true);
    fake.delete("harness/1.jsonl");
    await resumed.run("evals");
    // That pass started mid-listing: 1.jsonl stays until a pass from the start misses it.
    expect(Object.keys((await manifest()).objects)).toContain("harness/1.jsonl");
    await resumed.run("evals");
    expect(Object.keys((await manifest()).objects)).not.toContain("harness/1.jsonl");
  });

  it("saves the checkpoint as it goes", async () => {
    for (let i = 0; i < 5; i++) fake.put(`harness/${i}.jsonl`, lines(0, 1));
    const writes: string[] = [];
    const counting: Store = {
      url: store.url,
      get: (k) => store.get(k),
      stat: (k) => store.stat(k),
      delete: (k, o) => store.delete(k, o),
      list: (p, o) => store.list(p, o),
      put: (k, b, o) => {
        if (k.includes("checkpoint")) writes.push(k);
        return store.put(k, b, o);
      },
    };
    const s = new Sources({
      store: counting,
      pipeline,
      sources: sourceConfigs(SOURCE()),
      connectors: [new S3Connector({ formats, maxBytes: 1 << 20, env: {}, saveEvery: 2 })],
      fetch: fake.fetch as typeof fetch,
      now: () => NOW,
    });
    await s.run("evals");
    // After objects 2 and 4, then at the end.
    expect(writes).toHaveLength(3);
  });

  it("is discarded when another worker moved the checkpoint, and resubmits idempotently", async () => {
    fake.put("harness/a.jsonl", lines(0, 1));
    fake.put("harness/b.jsonl", lines(0, 1));
    let moved = false;
    const original = pipeline.submit.bind(pipeline);
    pipeline.submit = async (envelope) => {
      if (!moved) {
        moved = true;
        await writeCheckpoint(store, "evals", { v: 1, objects: {} }, null, () => NOW);
      }
      return original(envelope);
    };
    const s = sources("", { saveEvery: 1 });
    const report = await s.run("evals");
    expect(report.outcome).toBe("discarded");
    const keys = pipeline.envelopes.map((e) => e.idempotency_key);
    await s.run("evals");
    // The next run submits the same versions with the same keys (X4.7).
    expect(pipeline.envelopes.map((e) => e.idempotency_key).slice(0, keys.length)).toEqual(keys);
  });

  it("fails the run on a transient bucket error and leaves the checkpoint", async () => {
    fake.put("harness/a.jsonl", lines(0, 1));
    const s = sources();
    await s.run("evals");
    const before = await readCheckpoint(store, "evals");
    fake.put("harness/a.jsonl", lines(0, 2));
    fake.queued.push(new Response("<Error><Code>SlowDown</Code></Error>", { status: 503 }));
    const report = await s.run("evals");
    expect(report.outcome).toBe("error");
    expect(report.error).toContain("503 SlowDown");
    expect((await readCheckpoint(store, "evals"))?.etag).toBe(before?.etag);
  });

  it("refuses to run with a format this binary does not read", async () => {
    fake.put("harness/a.jsonl", lines(0, 1));
    const report = await sources('format = "claude-code"').run("evals");
    expect(report.outcome).toBe("error");
    expect(report.error).toContain("format 'claude-code' is not one this binary reads");
    expect(fake.requests).toEqual([]);
  });

  it("stops at an object boundary when the instance shuts down", async () => {
    for (let i = 0; i < 3; i++) fake.put(`harness/${i}.jsonl`, lines(0, 1));
    const controller = new AbortController();
    const original = pipeline.submit.bind(pipeline);
    pipeline.submit = async (envelope) => {
      controller.abort();
      return original(envelope);
    };
    const report = await sources().run("evals", { signal: controller.signal });
    expect(report.submitted).toBe(1);
    expect((await manifest()).after).toBe("harness/0.jsonl");
  });

  it("starts over from a checkpoint it does not understand", async () => {
    await writeCheckpoint(store, "evals", { cursor: "datadog-shaped" }, null, () => NOW);
    fake.put("harness/a.jsonl", lines(0, 1));
    expect((await sources().run("evals")).submitted).toBe(1);
  });
});

describe("ordered keys (F6.2)", () => {
  it("lists after the key before the newest, which stays watched while it grows", async () => {
    fake.put("harness/2026-11-01.jsonl", lines(0, 1));
    fake.put("harness/2026-11-02.jsonl", lines(0, 1));
    fake.put("harness/2026-11-03.jsonl", lines(0, 1));
    const s = sources("ordered_keys = true");
    await s.run("evals");
    let m = await manifest();
    expect(m.watch_from).toBe("harness/2026-11-02.jsonl");
    expect(Object.keys(m.objects)).toEqual(["harness/2026-11-03.jsonl"]);

    fake.append("harness/2026-11-03.jsonl", lines(1, 2));
    await s.run("evals");
    expect(pipeline.last().offset).toBe(line(0).length);
    const listing = fake.requests.filter((r) => r.url.searchParams.has("list-type")).at(-1);
    expect(listing?.url.searchParams.get("start-after")).toBe("harness/2026-11-02.jsonl");

    fake.put("harness/2026-11-04.jsonl", lines(0, 1));
    await s.run("evals");
    m = await manifest();
    expect(m.watch_from).toBe("harness/2026-11-03.jsonl");
    expect(Object.keys(m.objects)).toEqual(["harness/2026-11-04.jsonl"]);
    // Nothing new: the watch stays where it is.
    await s.run("evals");
    expect((await manifest()).watch_from).toBe("harness/2026-11-03.jsonl");
    expect(pipeline.envelopes).toHaveLength(5);
  });

  it("keeps the watch before an object it could not read this time", async () => {
    fake.put("harness/1.jsonl", lines(0, 1));
    fake.put("harness/2.jsonl", lines(0, 1));
    fake.put("harness/3.jsonl", lines(0, 1));
    const original = fake.handle.bind(fake);
    fake.handle = async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/1.jsonl") && !url.searchParams.has("list-type")) {
        fake.handle = original;
        fake.put("harness/1.jsonl", lines(0, 2));
      }
      return original(request);
    };
    const s = sources("ordered_keys = true");
    await s.run("evals");
    expect((await manifest()).watch_from).toBeUndefined();
    await s.run("evals");
    expect(pipeline.envelopes.map((e) => e.session_key).sort()).toEqual([
      "1.jsonl",
      "2.jsonl",
      "3.jsonl",
    ]);
    expect((await manifest()).watch_from).toBe("harness/2.jsonl");
  });
});

describe("reprocess (X4.9)", () => {
  it("rewinds to a time by forgetting what changed since, and to the start", async () => {
    fake.put("harness/old.jsonl", lines(0, 1), { modified: new Date("2026-11-01T00:00:00Z") });
    fake.put("harness/new.jsonl", lines(0, 1), { modified: new Date("2026-11-12T00:00:00Z") });
    const s = sources();
    await s.run("evals");
    const rewound = await s.rewind("evals", { since: new Date("2026-11-10T00:00:00Z") });
    expect(Object.keys((rewound.after as unknown as Manifest).objects)).toEqual([
      "harness/old.jsonl",
    ]);
    await s.run("evals");
    expect(pipeline.envelopes.map((e) => [e.session_key, pipeline.sessions.size])).toHaveLength(3);
    expect(pipeline.envelopes.at(-1)).toMatchObject({ session_key: "new.jsonl", replace: true });
    expect(new S3Connector({ formats, maxBytes: 1 }).rewind(null, new Date())).toBeNull();
    await s.rewind("evals");
    expect(await readCheckpoint(store, "evals")).toBeNull();
  });
});

describe("a folder source", () => {
  it("polls file:// like a bucket", async () => {
    const folder = mkdtempSync(join(tmpdir(), "seshi-drop-"));
    try {
      await Bun.write(join(folder, "runs", "a.jsonl"), lines(0, 2));
      const s = new Sources({
        store,
        pipeline,
        sources: sourceConfigs(
          `[[sources]]\nid = "drop"\ntype = "s3"\nurl = "file://${folder}"\nprefix = "runs"\n`,
        ),
        connectors: [new S3Connector({ formats, maxBytes: 1 << 20 })],
        now: () => NOW,
      });
      await s.run("drop");
      expect(pipeline.envelopes[0]).toMatchObject({
        source_id: "drop",
        session_key: "a.jsonl",
        provenance: { object_key: `file://${join(folder, "runs", "a.jsonl")}` },
      });
      await Bun.write(join(folder, "runs", "a.jsonl"), lines(0, 3));
      await s.run("drop");
      expect(pipeline.last()).toMatchObject({ text: line(2), offset: lines(0, 2).length });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
