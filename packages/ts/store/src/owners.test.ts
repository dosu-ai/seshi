import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsStore } from "./fs";
import { assertOwner, isOwner, keys } from "./layout";
import { listOwners } from "./owners";
import { StoreError } from "./store";

let dir: string;
let store: FsStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-owners-"));
  store = new FsStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("owner ids (X5.8)", () => {
  it("take usernames, emails and IdP subjects, and service accounts", () => {
    for (const owner of [
      "alice",
      "alice@acme.com",
      "alice+ci@acme.com",
      "00uAbC123",
      "a.b_c-d",
      "svc:otlp-prod",
    ]) {
      expect(assertOwner(owner)).toBe(owner);
      expect(isOwner(owner)).toBe(true);
    }
  });

  it("refuse anything that could leave its folder, and malformed service accounts", () => {
    for (const owner of [
      "",
      "a/b",
      "..",
      ".hidden",
      "@acme.com",
      "a b",
      "svc:",
      "svc:Otlp",
      "svc:a--b",
      "svc:../x",
      "x:y",
      "a".repeat(129),
    ]) {
      expect(() => assertOwner(owner)).toThrow(StoreError);
      expect(isOwner(owner)).toBe(false);
    }
  });
});

describe("listOwners", () => {
  async function session(owner: string, n = 1): Promise<void> {
    for (let i = 0; i < n; i++) {
      await store.put(
        `${keys.sessions(owner)}${String(i).repeat(64).slice(0, 64)}/metadata.json`,
        new TextEncoder().encode("{}"),
      );
    }
  }

  it("lists the owner folders in key order, one call per owner however many keys each has", async () => {
    await session("bob", 3);
    await session("alice@acme.com", 2);
    await session("alice", 1);
    await session("svc:otlp");
    await store.put(keys.probe("carol"), new TextEncoder().encode("x"));
    await store.put("tokens/abc.json", new TextEncoder().encode("{}"));
    const page = await listOwners(store);
    expect(page).toEqual({
      owners: ["alice", "alice@acme.com", "bob", "carol", "svc:otlp"],
      cursor: "svc:otlp",
      truncated: false,
    });
  });

  it("pages with after and limit", async () => {
    for (const owner of ["a", "b", "c", "d"]) await session(owner, 2);
    const first = await listOwners(store, { limit: 2 });
    expect(first).toEqual({ owners: ["a", "b"], cursor: "b", truncated: true });
    const second = await listOwners(store, { after: first.cursor, limit: 2 });
    expect(second).toEqual({ owners: ["c", "d"], cursor: "d", truncated: false });
    expect(await listOwners(store, { after: "d" })).toEqual({
      owners: [],
      cursor: undefined,
      truncated: false,
    });
  });

  it("is empty for an empty bucket", async () => {
    expect((await listOwners(store)).owners).toEqual([]);
  });
});
