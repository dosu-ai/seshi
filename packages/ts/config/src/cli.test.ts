import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { cliConfigSchema, cliLabelProblems } from "./cli";
import { loadCliConfig } from "./configs";
import { ConfigError } from "./load";
import { cliConfigPath, findServerConfig } from "./paths";

const fs = (files: Record<string, string>) => ({
  readFile: (path: string) => {
    const text = files[path];
    if (text === undefined) throw new Error("ENOENT");
    return text;
  },
  mode: (path: string) => (path in files ? 0o100600 : undefined),
});

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

  it("reads ./seshi.toml only when asked (seshi serve), and says when it skipped one", () => {
    // Joined as this platform does: the lookup runs on Windows too.
    const local = join("/w", "seshi.toml");
    const here = (p: string) => p === local;
    const both = (p: string) => here(p) || p === "/etc/s.toml";
    expect(findServerConfig({ env: {}, cwd: "/w", exists: here })).toEqual({
      explicit: false,
      skipped: local,
    });
    expect(
      findServerConfig({ env: {}, cwd: "/w", exists: both, systemPath: "/etc/s.toml" }),
    ).toEqual({ path: "/etc/s.toml", explicit: false, skipped: local });
    expect(findServerConfig({ env: {}, cwd: "/w", exists: here, trustCwdConfig: true })).toEqual({
      path: local,
      explicit: false,
    });
    expect(findServerConfig({ env: { SESHI_CONFIG: "x.toml" }, cwd: "/w", exists: here })).toEqual({
      path: resolve("/w", "x.toml"),
      explicit: true,
    });
  });
});

describe("the CLI's config", () => {
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
      keychain: true,
      search: { scope: "visible" },
      capture: {
        enabled: false,
        paths: [{ path: "~/clients/acme", capture: false }],
        remotes: [],
        exclude: [],
        redact_tool_calls: [],
      },
      labels: { paths: [] },
    });
  });

  it("is defaults when there is no file", () => {
    const loaded = loadCliConfig({ home: "/home/a", platform: "linux", fs: fs({}) });
    expect(loaded.file).toBeUndefined();
    expect(loaded.config).toEqual({
      theme: "auto",
      keychain: true,
      search: { scope: "visible" },
      capture: { enabled: true, paths: [], remotes: [], exclude: [], redact_tool_calls: [] },
      labels: { paths: [] },
    });
  });

  it("is as strict as the server's", () => {
    const run = () =>
      loadCliConfig({ file: "/c.toml", fs: fs({ "/c.toml": `colour = "mint"\n` }) });
    expect(run).toThrow(ConfigError);
    expect(run).toThrow("colour: unknown key (in /c.toml)");
    expect(cliConfigSchema.safeParse({ capture: { paths: [{ path: "/x" }] } }).success).toBe(false);
  });

  it("refuses an exclude entry that could never match, as the server does", () => {
    const run = () =>
      loadCliConfig({
        file: "/c.toml",
        fs: fs({ "/c.toml": `[capture]\nexclude = ["acme/app", "acme/my app"]\n` }),
      });
    expect(run).toThrow(
      /capture\.exclude\[1\]: "acme\/my app" has a space, which no repository name has/,
    );
    expect(
      cliConfigSchema.safeParse({ capture: { exclude: ["~/my clients", "# a note"] } }).success,
    ).toBe(true);
  });

  it("still reads a redact_tool_calls entry the server would refuse, as since 0.19", () => {
    // A laptop's own list was plain strings when it shipped: such an entry never matches, but
    // it must not make the config unreadable (which would stop capture altogether).
    const loaded = loadCliConfig({
      file: "/c.toml",
      fs: fs({
        "/c.toml": `[capture]\nredact_tool_calls = ["https://bot:tok@github.com/acme/x", "acme/my app"]\n`,
      }),
    });
    expect(loaded.config.capture.redact_tool_calls).toHaveLength(2);
  });
});

describe("the CLI's labels", () => {
  const load = (toml: string, env: Record<string, string> = {}) =>
    loadCliConfig({ file: "/c.toml", env, fs: fs({ "/c.toml": toml }) }).config;

  it("takes fixed values, env references and folders, and SESHI_LABELS__<KEY>", () => {
    const config = load(
      [
        "[labels]",
        '"dosu.project" = { env = "DOSU_PROJECT" }',
        'team = "platform"',
        "[[labels.paths]]",
        'path = "~/code/monorepo/packages/billing"',
        '"dosu.project" = "github.com/acme/billing"',
      ].join("\n"),
      { SESHI_LABELS__OWNER: "me" },
    );
    expect(config.labels).toEqual({
      "dosu.project": { env: "DOSU_PROJECT" },
      team: "platform",
      owner: "me",
      paths: [
        { path: "~/code/monorepo/packages/billing", "dosu.project": "github.com/acme/billing" },
      ],
    });
    expect(cliLabelProblems(config.labels)).toEqual([]);
  });

  it("refuses any other kind of value: no files, no commands", () => {
    expect(() => load('[labels]\nx = { file = "/etc/passwd" }\n')).toThrow(ConfigError);
    expect(() => load('[labels]\nx = { env = "A", file = "/b" }\n')).toThrow(ConfigError);
    expect(() => load("[labels]\nx = 3\n")).toThrow(ConfigError);
    expect(() => load('[[labels.paths]]\nx = "no path"\n')).toThrow(ConfigError);
  });

  it("loads labels out of the limits, and says what is wrong with them", () => {
    const many = Array.from({ length: 33 }, (_, i) => `k${i} = "v"`).join("\n");
    const config = load(
      [
        "[labels]",
        'Team = "x"',
        `long = "${"x".repeat(513)}"`,
        "[[labels.paths]]",
        'path = "/w"',
        '"-bad" = "y"',
      ].join("\n"),
    );
    expect(cliLabelProblems(config.labels)).toEqual([
      expect.stringContaining("[labels]: label key 'Team' must be lowercase"),
      "[labels]: label 'long' is 513 characters long; at most 512 are allowed",
      expect.stringContaining("[[labels.paths]] /w: label key '-bad'"),
    ]);
    expect(cliLabelProblems(load(`[labels]\n${many}\n`).labels)).toEqual([
      "[labels]: 33 labels; at most 32 are allowed",
    ]);
  });
});
