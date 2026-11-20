import { describe, expect, it } from "vitest";
import { loadServerConfig } from "./configs";
import { ConfigError, type ConfigFs } from "./load";
import { describeOrigin } from "./origins";

/** Files in memory, with their permission bits; folders are listed from the paths. */
function memFs(files: Record<string, string | { text: string; mode: number }>): ConfigFs {
  const entry = (path: string) => {
    const file = files[path];
    if (file === undefined) return undefined;
    return typeof file === "string" ? { text: file, mode: 0o100600 } : file;
  };
  return {
    readFile(path) {
      const file = entry(path);
      if (!file) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      return file.text;
    },
    mode: (path) => entry(path)?.mode,
    list: (dir) =>
      Object.keys(files)
        .filter((path) => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes("/"))
        .map((path) => path.slice(dir.length + 1)),
  };
}

const MAIN = `[store]
url = "file:///data"

[[sources]]
id = "otel"
type = "otlp"

[redaction]
packs = ["/etc/seshi/packs/org.toml"]
`;

const bucket = (id: string) =>
  `[[sources]]\nid = "${id}"\ntype = "s3"\nurl = "s3://${id}/sessions"\n`;

function load(files: Record<string, string | { text: string; mode: number }>) {
  return loadServerConfig({ configFlag: "/etc/seshi/seshi.toml", fs: memFs(files) });
}

describe("drop-ins in seshi.d/", () => {
  it("add sources and rule packs after the file's, in file-name order, each with its origin", () => {
    const loaded = load({
      "/etc/seshi/seshi.toml": MAIN,
      "/etc/seshi/seshi.d/20-adx.toml": `${bucket("b")}\n[redaction]\npacks = ["/var/adx/org.toml"]\n`,
      "/etc/seshi/seshi.d/10-adx.toml": bucket("a"),
      "/etc/seshi/seshi.d/notes.txt": "not read",
      "/etc/seshi/seshi.d/.10-adx.toml.swp": "not read",
    });
    expect(loaded.config.sources.map((s) => s.id)).toEqual(["otel", "a", "b"]);
    expect(loaded.config.redaction.packs).toEqual([
      "/etc/seshi/packs/org.toml",
      "/var/adx/org.toml",
    ]);
    expect(loaded.dropIns).toEqual([
      "/etc/seshi/seshi.d/10-adx.toml",
      "/etc/seshi/seshi.d/20-adx.toml",
    ]);
    expect(describeOrigin(loaded.origins.get(["sources", 0, "id"]))).toBe(
      "file /etc/seshi/seshi.toml",
    );
    expect(describeOrigin(loaded.origins.get(["sources", 1, "url"]))).toBe(
      "file /etc/seshi/seshi.d/10-adx.toml",
    );
    expect(describeOrigin(loaded.origins.get(["sources", 2, "id"]))).toBe(
      "file /etc/seshi/seshi.d/20-adx.toml",
    );
  });

  it("may set nothing else", () => {
    const run = () =>
      load({
        "/etc/seshi/seshi.toml": MAIN,
        "/etc/seshi/seshi.d/adx.toml": `${bucket("a")}\n[server]\nlisten = ":1"\n[redaction]\npacks = []\n`,
      });
    expect(run).toThrow(ConfigError);
    expect(run).toThrow(
      "/etc/seshi/seshi.d/adx.toml: a drop-in may only add to sources, redaction.packs and capture.exclude; server.listen belongs in the main config file",
    );
  });

  it("add to the org's exclude list: every file's entries, in one list", () => {
    const loaded = load({
      "/etc/seshi/seshi.toml": `${MAIN}\n[capture]\nexclude = ["acme/payroll"]\n`,
      "/etc/seshi/seshi.d/50-adx.toml": `[capture]\nexclude = ["github.com/acme/hr-*", "~/clients/**"]\n`,
      "/etc/seshi/seshi.d/60-more.toml": `[capture]\nexclude = ["# reviewed 2026-11", "acme/legal"]\n`,
    });
    expect(loaded.config.capture.exclude).toEqual([
      "acme/payroll",
      "github.com/acme/hr-*",
      "~/clients/**",
      "# reviewed 2026-11",
      "acme/legal",
    ]);
  });

  it("a drop-in's exclude list alone, with no list in the main file", () => {
    const loaded = load({
      "/etc/seshi/seshi.toml": MAIN,
      "/etc/seshi/seshi.d/adx.toml": `[capture]\nexclude = ["acme/app"]\n`,
    });
    expect(loaded.config.capture).toEqual({ allow_retract: true, exclude: ["acme/app"] });
  });

  it("a drop-in may not set the capture section's other keys", () => {
    expect(() =>
      load({
        "/etc/seshi/seshi.toml": MAIN,
        "/etc/seshi/seshi.d/adx.toml": `[capture]\nexclude = []\nallow_retract = false\n`,
      }),
    ).toThrow(/capture\.allow_retract belongs in the main config file/);
  });

  it("refuse an exclude entry that could never match", () => {
    const run = () =>
      load({
        "/etc/seshi/seshi.toml": MAIN,
        "/etc/seshi/seshi.d/adx.toml": `[capture]\nexclude = ["https://bot:tok@github.com/acme/app", "acme/my app"]\n`,
      });
    expect(run).toThrow(ConfigError);
    expect(run).toThrow(/capture\.exclude\[0\].*names a credential/);
    expect(run).toThrow(
      /capture\.exclude\[1\]: "acme\/my app" has a space, which no repository name has/,
    );
    // The refusal names where the entry is, never what it says: it may hold a token.
    expect(run).not.toThrow(/tok/);
    expect(run).toThrow(/"https:\/\/\*\*\*@github\.com\/acme\/app" names a credential/);
  });

  it("are checked with the rest: a drop-in source's id must be unique", () => {
    expect(() =>
      load({ "/etc/seshi/seshi.toml": MAIN, "/etc/seshi/seshi.d/adx.toml": bucket("otel") }),
    ).toThrow(
      /sources\[otel\]\.id: id 'otel' is used twice \(in \/etc\/seshi\/seshi\.d\/adx\.toml\)/,
    );
  });

  it("warn about a literal secret in a drop-in others can read", () => {
    const loaded = load({
      "/etc/seshi/seshi.toml": MAIN,
      "/etc/seshi/seshi.d/adx.toml": {
        text: `${bucket("a")}credentials = { access_key_id = "AKIA", secret_access_key = "s" }\n`,
        mode: 0o100644,
      },
    });
    expect(loaded.warnings).toEqual([
      expect.stringMatching(/^\/etc\/seshi\/seshi\.d\/adx\.toml holds literal secrets/),
    ]);
  });

  it("are read only beside a config file", () => {
    const loaded = loadServerConfig({
      env: { SESHI_STORE__URL: "file:///data" },
      cwd: "/nowhere",
      systemPath: "/none.toml",
      fs: memFs({ "/nowhere/seshi.d/adx.toml": bucket("a") }),
    });
    expect(loaded.config.sources).toEqual([]);
    expect(loaded.dropIns).toEqual([]);
  });
});
