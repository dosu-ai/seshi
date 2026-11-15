import { type Authorization, ENVELOPE_SCHEMA, type Envelope, Forbidden } from "@seshi/model";
import { describe, expect, it } from "vitest";
import { ownershipAuthorizer } from "./authorizer";
import { serviceIdentity } from "./owner";

function envelope(over: Partial<Envelope>): Envelope {
  return {
    schema: ENVELOPE_SCHEMA,
    source: "upload",
    source_id: "upload",
    format: "claude-code",
    session_key: "s",
    payload: { kind: "log", encoding: "jsonl", text: "", offset: 0 },
    caller: { kind: "device", principal: "alice", credential_id: "t1" },
    owner: "alice",
    owner_basis: "verified",
    idempotency_key: "k",
    received_at: "2026-11-14T09:00:00.000Z",
    ...over,
  };
}

const authorize = (e: Envelope) => ownershipAuthorizer().authorize(e) as Authorization;

describe("ownershipAuthorizer (X4.3 stage 1, X5.4)", () => {
  it("lets a caller write its own sessions and records it as the writer", () => {
    expect(authorize(envelope({}))).toEqual({
      owner: "alice",
      owner_basis: "verified",
      writer: { kind: "device", principal: "alice", credential_id: "t1", source_id: "upload" },
      admin: false,
    });
  });

  it("refuses a write in someone else's name, unless the caller is an admin", () => {
    expect(() => authorize(envelope({ owner: "bob" }))).toThrow(Forbidden);
    const byAdmin = authorize(
      envelope({ owner: "bob", caller: { kind: "admin", principal: "ops" } }),
    );
    expect(byAdmin).toMatchObject({ owner: "bob", admin: true });
  });

  it("keeps svc: owners for service accounts, with basis service, and only theirs", () => {
    const svc = { kind: "service" as const, principal: "svc:otlp" };
    expect(
      authorize(
        envelope({
          source: "otlp",
          source_id: "otlp",
          caller: svc,
          owner: "svc:otlp",
          owner_basis: "service",
        }),
      ),
    ).toMatchObject({ owner: "svc:otlp", owner_basis: "service" });
    expect(() =>
      authorize(envelope({ caller: svc, owner: "svc:otlp", owner_basis: "verified" })),
    ).toThrow("owner_basis service");
    expect(() =>
      authorize(envelope({ caller: svc, owner: "alice", owner_basis: "service" })),
    ).toThrow(Forbidden);
    expect(() => authorize(envelope({ owner: "svc:otlp", owner_basis: "service" }))).toThrow(
      "only a service account",
    );
  });

  it("accepts a poller's envelope built from serviceIdentity (X5.4)", () => {
    expect(
      authorize(
        envelope({ source: "datadog", source_id: "dd-prod", ...serviceIdentity("dd-prod") }),
      ),
    ).toMatchObject({
      owner: "svc:dd-prod",
      owner_basis: "service",
      writer: { kind: "service", principal: "svc:dd-prod", source_id: "dd-prod" },
    });
  });

  it("makes a poller write as its own source's service account (X5.4)", () => {
    expect(() =>
      authorize(
        envelope({
          source: "datadog",
          source_id: "dd-prod",
          caller: { kind: "service", principal: "svc:otlp" },
          owner: "svc:otlp",
          owner_basis: "service",
        }),
      ),
    ).toThrow("svc:dd-prod");
  });

  it("gives claimed ownership to org-key callers only (X5.12)", () => {
    expect(
      authorize(
        envelope({ caller: { kind: "person", principal: "alice" }, owner_basis: "claimed" }),
      ).owner_basis,
    ).toBe("claimed");
    expect(() => authorize(envelope({ owner_basis: "claimed" }))).toThrow("org-key");
  });
});
