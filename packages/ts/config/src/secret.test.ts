import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { describeSecret, Secret, secret } from "./secret";

const sources = (env: Record<string, string> = {}, files: Record<string, string> = {}) => ({
  env,
  readFile(path: string) {
    if (!(path in files)) throw new Error("ENOENT");
    return files[path] as string;
  },
});

describe("secret()", () => {
  it("takes a literal, an env reference or a file reference", () => {
    expect(secret().parse("abc").ref).toEqual({ kind: "literal", value: "abc" });
    expect(secret().parse({ env: "DD_API_KEY" }).ref).toEqual({ kind: "env", name: "DD_API_KEY" });
    expect(secret().parse({ file: "/run/secrets/dd" }).ref).toEqual({
      kind: "file",
      path: "/run/secrets/dd",
    });
  });

  it("refuses anything else", () => {
    for (const value of ["", 5, {}, { env: "" }, { env: "A", file: "/b" }, { vault: "x" }]) {
      expect(secret().safeParse(value).success).toBe(false);
    }
  });
});

describe("Secret", () => {
  it("resolves a literal at once, and references when asked", () => {
    expect(Secret.of("x").reveal()).toBe("x");
    const env = new Secret({ kind: "env", name: "TOKEN" });
    expect(env.resolved).toBe(false);
    expect(() => env.reveal()).toThrow("secret from env TOKEN was not resolved");
    env.resolve(sources({ TOKEN: "t" }));
    expect(env.reveal()).toBe("t");
    const file = new Secret({ kind: "file", path: "/s" });
    file.resolve(sources({}, { "/s": "from-file\n" }));
    expect(file.reveal()).toBe("from-file");
  });

  it("says what is missing", () => {
    expect(() => new Secret({ kind: "env", name: "NOPE" }).resolve(sources())).toThrow(
      "environment variable NOPE is not set",
    );
    expect(() => new Secret({ kind: "env", name: "E" }).resolve(sources({ E: "" }))).toThrow(
      "is not set",
    );
    expect(() => new Secret({ kind: "file", path: "/gone" }).resolve(sources())).toThrow(
      "cannot read /gone: ENOENT",
    );
    expect(() =>
      new Secret({ kind: "file", path: "/empty" }).resolve(sources({}, { "/empty": "\n" })),
    ).toThrow("/empty is empty");
  });

  it("never prints its value", () => {
    const s = Secret.of("hunter2-very-secret");
    expect(String(s)).toBe("[secret]");
    expect(`${s}`).toBe("[secret]");
    expect(JSON.stringify({ s })).toBe('{"s":"[secret]"}');
    expect(inspect(s)).toBe("[secret]");
    expect(inspect({ nested: s })).not.toContain("hunter2");
  });

  it("describes where it comes from", () => {
    expect(describeSecret(Secret.of("x"))).toBe("literal");
    expect(describeSecret(new Secret({ kind: "env", name: "A" }))).toBe("from env A");
    expect(describeSecret(new Secret({ kind: "file", path: "/p" }))).toBe("from file /p");
  });
});
