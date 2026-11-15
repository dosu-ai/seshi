import { describe, expect, it } from "vitest";
import { BadUsername, resolveUser, sendableUser } from "./user";

const noGit = async () => undefined;

describe("the org key's username (X5.7)", () => {
  it("takes SESHI_USER, then the config, then git user.email, then the OS user", async () => {
    const git = async () => "dev@acme.com";
    const os = () => "dev";
    expect(
      await resolveUser({ env: { SESHI_USER: "env@acme.com" }, configured: "cfg", gitEmail: git }),
    ).toEqual({ user: "env@acme.com", from: "SESHI_USER" });
    expect(await resolveUser({ env: {}, configured: "cfg", gitEmail: git })).toEqual({
      user: "cfg",
      from: "config",
    });
    expect(await resolveUser({ env: {}, gitEmail: git, osUser: os })).toEqual({
      user: "dev@acme.com",
      from: "git",
    });
    expect(await resolveUser({ env: { SESHI_USER: " " }, gitEmail: noGit, osUser: os })).toEqual({
      user: "dev",
      from: "os",
    });
  });

  it("refuses a name an HTTP header cannot carry", async () => {
    expect(sendableUser("alice@acme.com")).toBe(true);
    expect(sendableUser("Zoë")).toBe(false);
    expect(sendableUser("a\nb")).toBe(false);
    await expect(resolveUser({ env: { SESHI_USER: "Zoë" } })).rejects.toBeInstanceOf(BadUsername);
    await expect(resolveUser({ env: {}, gitEmail: noGit, osUser: () => "名前" })).rejects.toThrow(
      /printable ASCII/,
    );
  });
});
