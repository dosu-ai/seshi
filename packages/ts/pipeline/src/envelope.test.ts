import { createHash } from "node:crypto";
import { type Envelope, SessionRejected } from "@seshi/model";
import { describe, expect, it } from "vitest";
import { checkEnvelope, uploadEnvelope, uploadIdempotencyKey, writerOf } from "./envelope";
import { mayReplace, permissiveAuthorizer, retractSecretMatches } from "./stages";

const now = () => new Date("2026-11-14T09:00:00.000Z");

function base(): Envelope {
  return uploadEnvelope(
    {
      owner: "alice",
      agent: "claude-code",
      session_id: "s1",
      transcript: "{}\n",
      format: "jsonl",
    },
    {
      caller: { kind: "device", principal: "alice", credential_id: "tok_1" },
      owner_basis: "claimed",
      now,
    },
  );
}

describe("uploadEnvelope", () => {
  it("keys an upload by session, offset and text, unless it names its own key", () => {
    expect(uploadIdempotencyKey("s1", 0, "a")).toBe(uploadIdempotencyKey("s1", 0, "a"));
    expect(uploadIdempotencyKey("s1", 0, "a")).not.toBe(uploadIdempotencyKey("s1", 0, "ab"));
    expect(uploadIdempotencyKey("s1", 0, "a")).not.toBe(uploadIdempotencyKey("s1", 5, "a"));
    expect(uploadIdempotencyKey("s1", 0, "a")).not.toBe(uploadIdempotencyKey("s2", 0, "a"));
    expect(uploadIdempotencyKey("s1", 0, "a")).toMatch(/^s1@0#[0-9a-f]{32}$/);
    const named = uploadEnvelope(
      {
        owner: "a",
        agent: "x",
        session_id: "s",
        transcript: "",
        format: "json",
        idempotency_key: "k1",
      },
      { caller: { kind: "local", principal: "a" }, owner_basis: "verified" },
    );
    expect(named.idempotency_key).toBe("k1");
  });
});

describe("checkEnvelope", () => {
  const bad = (change: (e: Record<string, unknown>) => void) => {
    const envelope = base() as unknown as Record<string, unknown>;
    change(envelope);
    return () => checkEnvelope(envelope as unknown as Envelope);
  };

  it("refuses what the pipeline cannot take, as bad_envelope", () => {
    for (const change of [
      (e: Record<string, unknown>) => {
        e.schema = "seshi/envelope/2";
      },
      (e: Record<string, unknown>) => {
        e.source = "ftp";
      },
      (e: Record<string, unknown>) => {
        e.source_id = "Not_An_Id";
      },
      (e: Record<string, unknown>) => {
        e.owner = "a/b";
      },
      (e: Record<string, unknown>) => {
        e.owner_basis = "trusted";
      },
      (e: Record<string, unknown>) => {
        e.idempotency_key = "";
      },
      (e: Record<string, unknown>) => {
        e.caller = { kind: "root", principal: "x" };
      },
      (e: Record<string, unknown>) => {
        e.payload = { kind: "log", encoding: "xml", text: "", offset: 0 };
      },
      (e: Record<string, unknown>) => {
        e.payload = { kind: "log", encoding: "jsonl", text: "", offset: 1.5 };
      },
      (e: Record<string, unknown>) => {
        e.payload = { kind: "spans", spans: "nope" };
      },
      (e: Record<string, unknown>) => {
        e.payload = { kind: "blob" };
      },
      (e: Record<string, unknown>) => {
        e.retract_hash = "not-a-sha256";
      },
      (e: Record<string, unknown>) => {
        e.labels = { Team: "x" };
      },
      (e: Record<string, unknown>) => {
        e.labels = { team: "x".repeat(513) };
      },
    ]) {
      expect(bad(change)).toThrow(SessionRejected);
      expect(bad(change)).toThrow(expect.objectContaining({ code: "bad_envelope" }));
    }
  });
});

describe("callers and writers", () => {
  it("trusts the envelope by default, and lets only the original writer or an admin replace", async () => {
    const auth = await permissiveAuthorizer().authorize(base());
    expect(auth).toEqual({
      owner: "alice",
      owner_basis: "claimed",
      writer: writerOf(base()),
      admin: false,
    });
    const original = { kind: "static" as const, principal: "alice", source_id: "upload" };
    const verified = { ...auth, owner_basis: "verified" as const };
    expect(mayReplace(verified, original)).toBe(true);
    expect(mayReplace(verified, { ...original, principal: "bob" })).toBe(false);
    expect(mayReplace(verified, { ...original, source_id: "s3-logs" })).toBe(false);
    expect(mayReplace({ ...auth, admin: true }, { ...original, principal: "bob" })).toBe(true);
    // A claimed caller (the org key) states its name, so it needs the retraction secret too.
    expect(mayReplace(auth, original, "claimed")).toBe(false);
    expect(mayReplace(auth, original, "claimed", true)).toBe(true);
    expect(mayReplace(auth, { ...original, principal: "bob" }, "claimed", true)).toBe(false);
    expect(mayReplace(auth, original, "verified", true)).toBe(false);
    const hash = createHash("sha256").update("s3cret").digest("hex");
    expect(retractSecretMatches("s3cret", hash)).toBe(true);
    expect(retractSecretMatches(hash, hash)).toBe(false);
    expect(retractSecretMatches(undefined, hash)).toBe(false);
    expect(retractSecretMatches("s3cret", undefined)).toBe(false);
  });
});
