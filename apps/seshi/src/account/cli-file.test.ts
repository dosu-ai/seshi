import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "@seshi/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setTopLevelKey, writeCliKey } from "./cli-file";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-cli-file-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("setting a key in the CLI config", () => {
  it("adds it to an empty file, before the first table, or replaces it", () => {
    expect(setTopLevelKey("", "server", "https://a")).toBe('server = "https://a"\n');
    expect(setTopLevelKey('# mine\ntheme = "dark"\n', "server", "https://a")).toBe(
      '# mine\ntheme = "dark"\nserver = "https://a"\n',
    );
    expect(setTopLevelKey("# c\n[capture]\nenabled = false\n", "user", "me")).toBe(
      '# c\nuser = "me"\n\n[capture]\nenabled = false\n',
    );
    expect(
      setTopLevelKey('server = "https://old" # was\n[capture]\n', "server", "https://new"),
    ).toBe('server = "https://new"\n[capture]\n');
    // A `server` inside a table is not the top-level one.
    expect(setTopLevelKey('[x]\nserver = "keep"\n', "server", "https://a")).toBe(
      'server = "https://a"\n\n[x]\nserver = "keep"\n',
    );
    expect(setTopLevelKey("", "user", 'say "hi"')).toBe('user = "say \\"hi\\""\n');
  });

  it("writes a file the CLI can load, and nothing when it would not load", () => {
    const path = join(dir, "seshi", "config.toml");
    expect(writeCliKey(path, "server", "https://seshi.acme.com", {})).toMatchObject({
      server: "https://seshi.acme.com",
    });
    expect(readFileSync(path, "utf8")).toBe('server = "https://seshi.acme.com"\n');
    const local = join(dir, "local.toml");
    writeFileSync(local, '[local]\nconfig = "~/seshi.toml"\n');
    expect(() => writeCliKey(local, "server", "https://a", {})).toThrow(ConfigError);
    expect(readFileSync(local, "utf8")).toBe('[local]\nconfig = "~/seshi.toml"\n');
  });
});
