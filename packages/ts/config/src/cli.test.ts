import { describe, expect, it } from "vitest";
import { cliConfigSchema } from "./cli";
import { loadCliConfig } from "./configs";
import { ConfigError } from "./load";
import { cliConfigPath, findServerConfig } from "./paths";

describe("cliConfigPath", () => {
  it("is ~/.config/seshi/config.toml, or under XDG_CONFIG_HOME", () => {
    expect(cliConfigPath({ env: {}, home: "/home/a", platform: "linux" })).toBe(
      "/home/a/.config/seshi/config.toml",
    );
    expect(cliConfigPath({ env: {}, home: "/Users/a", platform: "darwin" })).toBe(
      "/Users/a/.config/seshi/config.toml",
    );
    expect(
      cliConfigPath({ env: { XDG_CONFIG_HOME: "/x" }, home: "/home/a", platform: "linux" }),
    ).toBe("/x/seshi/config.toml");
  });

  it("is %APPDATA%\\seshi\\config.toml on Windows (F8.4)", () => {
    expect(
      cliConfigPath({
        env: { APPDATA: "C:\\Users\\a\\AppData\\Roaming" },
        home: "C:\\Users\\a",
        platform: "win32",
      }),
    ).toBe("C:\\Users\\a\\AppData\\Roaming\\seshi\\config.toml");
    expect(cliConfigPath({ env: {}, home: "C:\\Users\\a", platform: "win32" })).toBe(
      "C:\\Users\\a\\AppData\\Roaming\\seshi\\config.toml",
    );
  });
});

describe("findServerConfig", () => {
  it("names nothing when no file is there", () => {
    expect(findServerConfig({ env: {}, cwd: "/w", exists: () => false })).toEqual({
      explicit: false,
    });
  });
});

describe("the CLI's config", () => {
  const fs = (files: Record<string, string>) => ({
    readFile: (path: string) => {
      const text = files[path];
      if (text === undefined) throw new Error("ENOENT");
      return text;
    },
    mode: (path: string) => (path in files ? 0o100600 : undefined),
  });

  it("reads the default location when it exists, with env over it", () => {
    const loaded = loadCliConfig({
      home: "/home/a",
      platform: "linux",
      env: { SESHI_USER: "alice@acme.com" },
      fs: fs({
        "/home/a/.config/seshi/config.toml": `server = "https://seshi.acme.dev"\nuser = "a"\ntheme = "dark"\n[capture]\nenabled = false\n[[capture.paths]]\npath = "~/clients/acme"\ncapture = false\n`,
      }),
    });
    expect(loaded.file).toBe("/home/a/.config/seshi/config.toml");
    expect(loaded.config).toEqual({
      server: "https://seshi.acme.dev",
      user: "alice@acme.com",
      theme: "dark",
      capture: { enabled: false, paths: [{ path: "~/clients/acme", capture: false }] },
    });
  });

  it("is defaults when there is no file", () => {
    const loaded = loadCliConfig({ home: "/home/a", platform: "linux", fs: fs({}) });
    expect(loaded.file).toBeUndefined();
    expect(loaded.config).toEqual({ theme: "auto", capture: { enabled: true, paths: [] } });
  });

  it("is as strict as the server's", () => {
    const run = () =>
      loadCliConfig({ file: "/c.toml", fs: fs({ "/c.toml": `colour = "mint"\n` }) });
    expect(run).toThrow(ConfigError);
    expect(run).toThrow("colour: unknown key (in /c.toml)");
    expect(cliConfigSchema.safeParse({ capture: { paths: [{ path: "/x" }] } }).success).toBe(false);
  });
});
