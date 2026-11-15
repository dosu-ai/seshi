import { join, win32 } from "node:path";
import { OwnerAliases, type Principal } from "@seshi/auth";
import { describe, expect, it } from "vitest";
import { defaultIndexPath } from "./paths";
import { LOCAL_VIEWER, viewerFor } from "./viewer";

describe("defaultIndexPath", () => {
  it("is one file per deployment in the user cache folder", () => {
    expect(
      defaultIndexPath({ deployment: "d-1", env: {}, platform: "linux", home: "/home/a" }),
    ).toBe(join("/home/a", ".cache", "seshi", "search", "d-1.sqlite"));
    expect(
      defaultIndexPath({
        deployment: "d-1",
        env: { XDG_CACHE_HOME: "/xdg" },
        platform: "linux",
        home: "/home/a",
      }),
    ).toBe(join("/xdg", "seshi", "search", "d-1.sqlite"));
    expect(
      defaultIndexPath({ deployment: "d-1", env: {}, platform: "darwin", home: "/Users/a" }),
    ).toBe(join("/Users/a", "Library", "Caches", "seshi", "search", "d-1.sqlite"));
    expect(
      defaultIndexPath({
        deployment: "d-1",
        env: { XDG_CACHE_HOME: "/xdg" },
        platform: "darwin",
        home: "/Users/a",
      }),
    ).toBe(join("/xdg", "seshi", "search", "d-1.sqlite"));
    expect(
      defaultIndexPath({
        deployment: "d-1",
        env: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" },
        platform: "win32",
        home: "C:\\Users\\a",
      }),
    ).toBe(win32.join("C:\\Users\\a\\AppData\\Local", "seshi", "cache", "search", "d-1.sqlite"));
  });

  it("keeps the deployment id inside its folder", () => {
    const path = defaultIndexPath({
      deployment: "../../etc/x",
      env: {},
      platform: "linux",
      home: "/h",
    });
    expect(path).toBe(join("/h", ".cache", "seshi", "search", ".._.._etc_x.sqlite"));
    expect(defaultIndexPath({ deployment: "", env: {}, platform: "linux", home: "/h" })).toBe(
      join("/h", ".cache", "seshi", "search", "seshi.sqlite"),
    );
  });
});

describe("viewerFor", () => {
  const principal = (role: Principal["role"], owner = "alice"): Principal => ({
    kind: role === "admin" ? "admin" : role === "service" ? "service" : "person",
    owner,
    owner_basis: "verified",
    role,
    scopes: new Set(["search"]),
    credential: "session",
    credential_id: "c",
    claims: {},
  });

  it("gives members their own folders and the read rule, admins and services everything", () => {
    const aliases = new OwnerAliases({ "old-alice": "alice" });
    const alice = viewerFor(principal("member"), aliases);
    expect(alice.everything).toBe(false);
    expect(alice.own).toEqual(["alice", "old-alice"]);
    expect(alice.canRead({ owner: "old-alice", visibility: "owner" })).toBe(true);
    expect(alice.canRead({ owner: "bob", visibility: "owner" })).toBe(false);
    expect(alice.canRead({ owner: "bob", visibility: "org" })).toBe(true);
    expect(viewerFor(principal("admin")).everything).toBe(true);
    expect(
      viewerFor(principal("service", "svc:sync")).canRead({ owner: "bob", visibility: "owner" }),
    ).toBe(true);
    expect(LOCAL_VIEWER.canRead({ owner: "x", visibility: "owner" })).toBe(true);
  });
});
