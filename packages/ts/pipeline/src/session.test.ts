import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_FORMATS, FormatRegistry } from "@seshi/formats";
import { SessionRejected } from "@seshi/model";
import { archiveId, FsStore, readMetadata } from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { storeSession } from "./session";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-session-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("storeSession", () => {
  it("refuses a format the registry has no adapter for, before writing anything", async () => {
    const upload = storeSession(
      {
        owner: "alice",
        format: "claude",
        session_id: "s1",
        transcript: '{"role":"user","content":"hi"}\n',
        encoding: "jsonl",
      },
      { store: new FsStore(dir), formats: new FormatRegistry(BUILTIN_FORMATS) },
    );
    await expect(upload).rejects.toBeInstanceOf(SessionRejected);
    await expect(upload).rejects.toMatchObject({
      code: "unsupported_agent",
      message: "no normalizer for 'claude' (one of atif, trajectory)",
    });
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("the retraction hash (F9.7)", () => {
  const ts = "2026-09-01T00:00:00Z";
  const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}
`;
  const head =
    line({ role: "meta", source: "trajectory" }) +
    line({ role: "user", content: "x".repeat(2000), timestamp: ts }) +
    line({ role: "assistant", content: "done", timestamp: ts });

  it("keeps the first hash a session gets, whoever writes later", async () => {
    const store = new FsStore(dir);
    const formats = new FormatRegistry(BUILTIN_FORMATS);
    const first = "a".repeat(64);
    const upload = (transcript: string, retract_hash: string, offset = 0) =>
      storeSession(
        {
          owner: "alice",
          format: "trajectory",
          session_id: "s1",
          transcript,
          encoding: "jsonl",
          offset,
          retract_hash,
        },
        { store, formats },
      );
    const stored = await upload(head, first);
    expect(stored.status).toBe("stored");
    const tail = line({ role: "assistant", content: "more", timestamp: ts });
    await upload(tail, "b".repeat(64), stored.bytes_total);
    const metadata = await readMetadata(store, "alice", archiveId("alice", "trajectory", "s1"));
    expect(metadata?.retract_hash).toBe(first);
  });
});

describe("when a session was last active", () => {
  const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;
  const head =
    line({ role: "meta", source: "trajectory" }) +
    line({ role: "user", content: "x".repeat(2000), timestamp: "2026-09-01T10:00:00Z" }) +
    line({ role: "assistant", content: "done", timestamp: "2026-09-01T10:05:00Z" });

  it("is the latest record timestamp, moved by a later chunk and never moved back", async () => {
    const store = new FsStore(dir);
    const formats = new FormatRegistry(BUILTIN_FORMATS);
    const upload = (transcript: string, offset = 0) =>
      storeSession(
        {
          owner: "alice",
          format: "trajectory",
          session_id: "s1",
          transcript,
          encoding: "jsonl",
          offset,
        },
        { store, formats },
      );
    const active = async () =>
      (await readMetadata(store, "alice", archiveId("alice", "trajectory", "s1")))?.active_at;
    const stored = await upload(head);
    expect(await active()).toBe("2026-09-01T10:05:00.000Z");
    const later = line({ role: "assistant", content: "more", timestamp: "2026-09-02T08:00:00Z" });
    const grown = await upload(later, stored.bytes_total);
    expect(await active()).toBe("2026-09-02T08:00:00.000Z");
    const earlier = line({
      role: "assistant",
      content: "clock went back",
      timestamp: "2026-09-01T09:00:00Z",
    });
    await upload(earlier, grown.bytes_total);
    expect(await active()).toBe("2026-09-02T08:00:00.000Z");
  });
});

describe("the session filter and limits from config", () => {
  const ts = "2026-09-01T00:00:00Z";
  const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;
  const META = line({ role: "meta", source: "trajectory" });
  const user = (content: string) => line({ role: "user", content, timestamp: ts });
  const reply = (content: string) => line({ role: "assistant", content, timestamp: ts });
  const formats = new FormatRegistry(BUILTIN_FORMATS);
  const upload = (transcript: string, offset = 0) => ({
    owner: "alice",
    format: "trajectory",
    session_id: "s1",
    transcript,
    encoding: "jsonl" as const,
    offset,
  });

  it("keeps every storable session when the filter is off", async () => {
    const off = { enabled: false, min_chars: 2000, require_user: true, require_reply: true };
    const store = new FsStore(dir);
    const short = await storeSession(upload(META + user("hi") + reply("yo")), {
      store,
      formats,
      filter: off,
    });
    expect(short.status).toBe("stored");
  });

  it("never stores a session the trace format cannot hold, whatever the rules say", async () => {
    const lenient = { enabled: false, min_chars: 0, require_user: false, require_reply: false };
    const store = new FsStore(dir);
    for (const [id, transcript] of [
      ["empty", META],
      ["asked", META + user("only a question")],
      ["answered", META + reply("only an answer")],
    ] as const) {
      const result = await storeSession(
        { ...upload(transcript), session_id: id },
        { store, formats, filter: lenient },
      );
      expect(result.status).toBe("filtered");
    }
  });

  it("judges the whole session again when what `shipped` names was never stored", async () => {
    const store = new FsStore(dir);
    const short = META + user("hi") + reply("hello");
    const first = await storeSession(upload(short), { store, formats });
    expect(first.status).toBe("filtered");
    // A client that still sends a prefix of the session (an older one, which kept the records
    // it saw): the session has since grown past min_chars, so all of it is stored, not a
    // continuation of records that never were.
    const grown = await storeSession(
      {
        ...upload(short + reply("y".repeat(2000))),
        shipped: { records: 3, prefix_sha256: "0".repeat(64) },
      },
      { store, formats },
    );
    expect(grown).toMatchObject({ status: "stored", records: grown.records_total });
  });

  it("refuses an upload past max_upload_bytes, and a trace past max_records", async () => {
    const store = new FsStore(dir);
    const transcript = META + user("x".repeat(3000)) + reply("done");
    await expect(
      storeSession(upload(transcript), {
        store,
        formats,
        limits: { max_records: 50_000, max_records_bytes: 32 << 20, max_upload_bytes: 10 },
      }),
    ).rejects.toMatchObject({ code: "too_large", message: "upload exceeds 10 bytes" });
    await expect(
      storeSession(
        { ...upload(transcript), session_id: "s2" },
        {
          store,
          formats,
          limits: { max_records: 1, max_records_bytes: 32 << 20, max_upload_bytes: 64 << 20 },
        },
      ),
    ).rejects.toMatchObject({ code: "too_large" });
    await expect(
      storeSession(
        { ...upload(transcript), session_id: "s3" },
        {
          store,
          formats,
          limits: { max_records: 50_000, max_records_bytes: 100, max_upload_bytes: 64 << 20 },
        },
      ),
    ).rejects.toMatchObject({ code: "too_large", message: "records exceed 100 bytes" });
  });
});
