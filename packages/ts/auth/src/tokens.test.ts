import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsStore, keys, readToken } from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tokenId } from "./opaque";
import { TokenService, tokenInfo } from "./tokens";

let dir: string;
let store: FsStore;
let clock: Date;
let tokens: TokenService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-tokens-"));
  store = new FsStore(dir);
  clock = new Date("2026-11-14T09:00:00.000Z");
  tokens = new TokenService(store, { now: () => clock });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const later = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

describe("TokenService (X5.9)", () => {
  it("stores a hashed record, created once (If-None-Match), and shows the token once", async () => {
    const { token, record } = await tokens.issue({
      kind: "device",
      owner: "alice",
      scopes: ["sessions:write"],
      owner_basis: "verified",
      visibility: "owner",
      label: "laptop",
    });
    const stored = (await readToken(store, record.id))?.value;
    expect(stored).toEqual(record);
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(stored).toMatchObject({
      schema: "seshi/token/1",
      kind: "device",
      owner: "alice",
      scopes: ["sessions:write"],
      visibility: "owner",
      expires_at: null,
      revoked: false,
      created_at: "2026-11-14T09:00:00.000Z",
    });
    expect(tokenId(token)).toBe(record.id);
    expect(await store.stat(keys.token(record.id))).not.toBeNull();
    expect(tokenInfo(record)).not.toHaveProperty("hash");
  });

  it("verifies its own tokens and nothing else", async () => {
    const { token, record } = await tokens.issue({ kind: "admin", owner: "ops", scopes: [] });
    expect((await tokens.verify(token))?.id).toBe(record.id);
    expect(await tokens.verify(`${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`)).toBe(
      undefined,
    );
    expect(await tokens.verify(`seshi_${"0".repeat(20)}_${"a".repeat(43)}`)).toBeUndefined();
    expect(await tokens.verify("not-a-token")).toBeUndefined();
  });

  it("refuses an expired token", async () => {
    const { token } = await tokens.issue({
      kind: "device",
      owner: "alice",
      scopes: ["sessions:write"],
      expires_at: new Date(clock.getTime() + 1000),
    });
    expect(await tokens.verify(token)).toBeDefined();
    later(1000);
    expect(await tokens.verify(token)).toBeUndefined();
  });

  it("revokes at once in this process, and another process sees it once its cache expires", async () => {
    const { token, record } = await tokens.issue({ kind: "admin", owner: "ops", scopes: [] });
    const other = new TokenService(store, { now: () => clock, cacheMs: 30_000 });
    expect(await other.verify(token)).toBeDefined();
    const revoked = await tokens.revoke(record.id);
    expect(revoked).toMatchObject({ revoked: true, revoked_at: "2026-11-14T09:00:00.000Z" });
    expect(await tokens.verify(token)).toBeUndefined();
    // The other process still trusts its cached copy, for the cache's lifetime only.
    expect(await other.verify(token)).toBeDefined();
    later(30_000);
    expect(await other.verify(token)).toBeUndefined();
    // Revoking again changes nothing; an unknown id is null.
    expect((await tokens.revoke(record.id))?.revoked_at).toBe("2026-11-14T09:00:00.000Z");
    expect(await tokens.revoke("0".repeat(20))).toBeNull();
    expect(await tokens.revoke("../x")).toBeNull();
  });

  it("caches records: a busy token costs one read per cache period", async () => {
    const { token } = await tokens.issue({ kind: "admin", owner: "ops", scopes: [] });
    let reads = 0;
    const counting = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "get") {
          return (key: string) => {
            reads++;
            return target.get(key);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const cached = new TokenService(counting, { now: () => clock });
    for (let i = 0; i < 5; i++) expect(await cached.verify(token)).toBeDefined();
    expect(reads).toBe(1);
    later(31_000);
    await cached.verify(token);
    expect(reads).toBe(2);
  });

  it("lists live tokens by owner and kind, and revokes every one of an owner's (X5.11)", async () => {
    await tokens.issue({ kind: "device", owner: "alice", scopes: ["sessions:write"] });
    await tokens.issue({ kind: "admin", owner: "alice", scopes: [] });
    await tokens.issue({ kind: "device", owner: "bob", scopes: ["sessions:write"] });
    const gone = await tokens.issue({
      kind: "device",
      owner: "alice",
      scopes: [],
      expires_at: new Date(clock.getTime() + 10),
    });
    later(10);
    expect((await tokens.list({ owner: "alice" })).length).toBe(2);
    expect((await tokens.list({ owner: "alice", all: true })).map((r) => r.id)).toContain(
      gone.record.id,
    );
    expect((await tokens.list({ kind: "device" })).map((r) => r.owner).sort()).toEqual([
      "alice",
      "bob",
    ]);
    const revoked = await tokens.revokeOwner("alice");
    expect(revoked.map((r) => r.kind).sort()).toEqual(["admin", "device"]);
    expect(await tokens.list({ owner: "alice" })).toEqual([]);
    expect((await tokens.list({ owner: "bob" })).length).toBe(1);
    expect(await tokens.revokeOwner("bob", "admin")).toEqual([]);
  });
});
