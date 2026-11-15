import { ENVELOPE_SCHEMA, type Envelope, SessionRejected } from "@seshi/model";
import { describe, expect, it } from "vitest";
import {
  checkEnvelope,
  hasCaller,
  uploadEnvelope,
  uploadIdempotencyKey,
  writerOf,
} from "./envelope";
import { mayReplace, permissiveAuthorizer } from "./stages";

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
  it("builds the envelope an upload stands for", () => {
    const envelope = uploadEnvelope(
      {
        owner: "alice",
        agent: "codex",
        session_id: "s9",
        transcript: "a\n",
        format: "jsonl",
        offset: 12,
        project: "p",
        branch: "main",
        parent_session_id: "s0",
        fork_of: "s0",
        replace: true,
        visibility: "owner",
        shipped: { records: 3, prefix_sha256: "a".repeat(64) },
      },
      {
        caller: { kind: "person", principal: "alice" },
        owner_basis: "verified",
        source: "hook",
        claims: { git_email: "a@example.com" },
        now,
      },
    );
    expect(envelope).toEqual({
      schema: ENVELOPE_SCHEMA,
      source: "hook",
      source_id: "upload",
      format: "codex",
      session_key: "s9",
      payload: { kind: "log", encoding: "jsonl", text: "a\n", offset: 12 },
      caller: { kind: "person", principal: "alice" },
      owner: "alice",
      owner_basis: "verified",
      idempotency_key: uploadIdempotencyKey("s9", 12, "a\n"),
      received_at: "2026-11-14T09:00:00.000Z",
      claims: { git_email: "a@example.com" },
      visibility: "owner",
      replace: true,
      shipped: { records: 3, prefix_sha256: "a".repeat(64) },
      project: "p",
      branch: "main",
      parent_session_id: "s0",
      fork_of: "s0",
    });
    expect(() => checkEnvelope(envelope)).not.toThrow();
  });

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
    ]) {
      expect(bad(change)).toThrow(SessionRejected);
      expect(bad(change)).toThrow(expect.objectContaining({ code: "bad_envelope" }));
    }
  });
});

describe("callers and writers", () => {
  it("answers uploads and hooks, records for every other source", () => {
    expect(hasCaller({ source: "upload" })).toBe(true);
    expect(hasCaller({ source: "hook" })).toBe(true);
    for (const source of ["otlp", "datadog", "s3", "cursor-cloud"] as const) {
      expect(hasCaller({ source })).toBe(false);
    }
  });

  it("writes as the caller, through the envelope's source", () => {
    expect(writerOf(base())).toEqual({
      kind: "device",
      principal: "alice",
      credential_id: "tok_1",
      source_id: "upload",
    });
  });

  it("trusts the envelope by default, and lets only the original writer or an admin replace", async () => {
    const auth = await permissiveAuthorizer().authorize(base());
    expect(auth).toEqual({
      owner: "alice",
      owner_basis: "claimed",
      writer: writerOf(base()),
      admin: false,
    });
    const original = { kind: "static" as const, principal: "alice", source_id: "upload" };
    expect(mayReplace(auth, original)).toBe(true);
    expect(mayReplace(auth, { ...original, principal: "bob" })).toBe(false);
    expect(mayReplace(auth, { ...original, source_id: "s3-logs" })).toBe(false);
    expect(mayReplace({ ...auth, admin: true }, { ...original, principal: "bob" })).toBe(true);
  });
});
