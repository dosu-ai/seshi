import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_FORMATS, FormatRegistry } from "@seshi/formats";
import { EMPTY_PREFIX_SHA256, SessionRejected } from "@seshi/model";
import { FsStore } from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { storeSession } from "./session";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-session-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("storeSession", () => {
  it("refuses an agent the registry has no format for, before writing anything", async () => {
    const upload = storeSession(
      {
        owner: "alice",
        agent: "claude",
        session_id: "s1",
        transcript: '{"role":"user","content":"hi"}\n',
        format: "jsonl",
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

describe("the session filter and limits from config", () => {
  const ts = "2026-09-01T00:00:00Z";
  const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;
  const META = line({ role: "meta", source: "trajectory" });
  const user = (content: string) => line({ role: "user", content, timestamp: ts });
  const reply = (content: string) => line({ role: "assistant", content, timestamp: ts });
  const formats = new FormatRegistry(BUILTIN_FORMATS);
  const upload = (transcript: string, offset = 0) => ({
    owner: "alice",
    agent: "trajectory",
    session_id: "s1",
    transcript,
    format: "jsonl" as const,
    offset,
  });

  it("keeps today's rules by default: a short session is not stored", async () => {
    const result = await storeSession(upload(META + user("hi") + reply("hello")), {
      store: new FsStore(dir),
      formats,
    });
    expect(result).toEqual({
      status: "filtered",
      records_total: 0,
      prefix_sha256: EMPTY_PREFIX_SHA256,
      bytes_total: 0,
    });
    // Nothing of a filtered session is stored (X6.3, X4.10).
    expect(readdirSync(dir)).toEqual(["seshi.json"]);
  });

  it("stores a short session when min_chars allows it", async () => {
    const filter = { enabled: true, min_chars: 5, require_user: true, require_reply: true };
    const result = await storeSession(upload(META + user("hi") + reply("hello")), {
      store: new FsStore(dir),
      formats,
      filter,
    });
    expect(result.status).toBe("stored");
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

  it("judges only the first trace: a short tail past the head always ships", async () => {
    const store = new FsStore(dir);
    const head = META + user("x".repeat(2000)) + reply("done");
    const first = await storeSession(upload(head), { store, formats });
    expect(first.status).toBe("stored");
    // An agent-only tail, far under min_chars and with no user record.
    const tail = await storeSession(upload(reply("one more thing"), first.bytes_total), {
      store,
      formats,
      filter: { enabled: true, min_chars: 1_000_000, require_user: true, require_reply: true },
    });
    expect(tail.status).toBe("stored");
    expect(tail.records_total).toBe(first.records_total + 1);
  });

  it("judges only the first trace for whole uploads too: a tail past what is stored always ships", async () => {
    const store = new FsStore(dir);
    const head = META + user("x".repeat(2000)) + reply("done");
    const first = await storeSession(upload(head), { store, formats });
    expect(first.status).toBe("stored");
    // The whole log again, grown by an agent-only tail far under min_chars. The server's own
    // state says what is stored; the client need not send `shipped`.
    const tail = await storeSession(upload(head + reply("one more thing")), { store, formats });
    expect(tail).toMatchObject({ status: "stored", records: 2 }); // the meta record and the tail
    expect(tail.records_total).toBe(first.records_total + 1);
    // Nothing new past what is stored: nothing to write.
    const again = await storeSession(upload(`${head + reply("one more thing")}\n`), {
      store,
      formats,
    });
    expect(again).toMatchObject({ status: "unchanged", records_total: tail.records_total });
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
