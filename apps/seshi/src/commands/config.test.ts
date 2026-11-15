import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../main";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-config-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function seshi(argv: string[], env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {
    env,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function file(name: string, text: string, mode = 0o600): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  chmodSync(path, mode);
  return path;
}

const VALID = `[store]
url = "s3://acme-sessions/prod"

[auth.tokens]
alice = { env = "ALICE_TOKEN" }

[[sources]]
id = "datadog-prod"
type = "datadog"
api_key = { env = "DD_API_KEY" }
app_key = { file = "${"__DIR__"}/dd-app-key" }
`;

function validConfig(): string {
  file("dd-app-key", "TOPSECRET-VALUE\n");
  return file("seshi.toml", VALID.replace("__DIR__", dir));
}

describe("seshi config check", () => {
  it("says ok, with the file it read", async () => {
    const path = validConfig();
    const { code, out } = await seshi(["config", "check", "--config", path], {
      ALICE_TOKEN: "alice-token-0123456789",
      DD_API_KEY: "dd",
    });
    expect(out).toBe(`ok: ${path}`);
    expect(code).toBe(0);
  });

  it("fails on a secret it cannot read, naming the setting", async () => {
    const path = validConfig();
    const { code, err } = await seshi(["config", "check", "--config", path], {
      ALICE_TOKEN: "alice-token-0123456789",
    });
    expect(code).toBe(1);
    expect(err).toContain(
      "error: sources[datadog-prod].api_key: environment variable DD_API_KEY is not set",
    );
  });

  it("fails on unknown keys and bad values, every one, with where each came from", async () => {
    const path = file("seshi.toml", `[store]\nurl = "s3://b/p"\nformat = "xml"\nurll = "x"\n`);
    const { code, err } = await seshi(["config", "check", "--config", path], {
      SESHI_FILTER__MIN_CHARS: "lots",
    });
    expect(code).toBe(1);
    expect(err).toContain(`error: store.urll: unknown key (in ${path})`);
    expect(err).toContain(`store.format:`);
    expect(err).toContain("filter.min_chars:");
    expect(err).toContain("(from env SESHI_FILTER__MIN_CHARS)");
  });

  it("runs the server's own checks too", async () => {
    const path = file("seshi.toml", `[store]\nurl = "file:///tmp/x"\n`);
    const { code, err } = await seshi(["config", "check", "--config", path]);
    expect(code).toBe(1);
    expect(err).toContain("error: no way to call the server");
  });

  it("prints warnings and notices, and still passes", async () => {
    const path = file(
      "seshi.toml",
      `default_visibility = "owner"
[store]
url = "file:///tmp/x"
[auth.tokens]
alice = "alice-token-0123456789"
[[review.policies]]
id = "default"
decision = { provider = "anthropic", model = "claude-haiku-5-5" }
`,
      0o644,
    );
    const { code, out } = await seshi(["config", "check", "--config", path]);
    expect(code).toBe(0);
    expect(out).toContain('warning: default_visibility = "owner" is not enforced without an IdP');
    expect(out).toContain("warning: review policy 'default' decision has no api_key");
    expect(out).toContain(`holds literal secrets (auth.tokens.alice)`);
    expect(out).toContain(
      "note: review policy 'default' sends envelopes to anthropic (decision: claude-haiku-5-5)",
    );
    expect(out).toContain(`ok: ${path} (3 warnings)`);
  });

  it("answers in JSON", async () => {
    const path = file("seshi.toml", `[store]\nurl = 3\n`);
    const { code, out } = await seshi(["config", "check", "--config", path, "--json"]);
    expect(code).toBe(1);
    expect(JSON.parse(out)).toMatchObject({ ok: false, file: path, warnings: [], notices: [] });
    expect(JSON.parse(out).errors[0]).toContain("store.url:");
  });

  it("checks the CLI's config with --cli", async () => {
    const home = join(dir, "home");
    mkdirSync(join(home, ".config", "seshi"), { recursive: true });
    writeFileSync(join(home, ".config", "seshi", "config.toml"), `theme = "neon"\n`);
    const { code, err } = await seshi(["config", "check", "--cli"], { HOME: home });
    expect(code).toBe(1);
    expect(err).toContain("theme:");
  });

  it("refuses server flags with --cli", async () => {
    const { code, err } = await seshi(["config", "check", "--cli", "--listen", ":1"], {
      HOME: dir,
    });
    expect(code).toBe(1);
    expect(err).toContain("--listen and --roles are server settings");
  });
});

describe("seshi config show", () => {
  it("prints every value, secrets masked and unread", async () => {
    const path = validConfig();
    const { code, out } = await seshi(["config", "show", "--config", path], {
      SESHI_LIMITS__MAX_UPLOAD_BYTES: "128MiB",
    });
    expect(code).toBe(0);
    expect(out).toContain('store.url = "s3://acme-sessions/prod"');
    expect(out).toContain('auth.tokens.alice = "<secret: env ALICE_TOKEN>"');
    expect(out).toContain('sources[datadog-prod].app_key = "<secret: file ');
    expect(out).toContain('limits.max_upload_bytes = "128MiB"');
    expect(out).toContain('records.dropped_retention = "30d"');
    expect(out).not.toContain("TOPSECRET-VALUE");
  });

  it("says where each value came from with --origin", async () => {
    const path = validConfig();
    const { out } = await seshi(
      ["config", "show", "--config", path, "--origin", "--listen", ":9000"],
      { SESHI_FILTER__MIN_CHARS: "500" },
    );
    expect(out).toContain(`# ${path}`);
    expect(out).toContain('server.listen = ":9000"  # flag --listen');
    expect(out).toContain("filter.min_chars = 500  # env SESHI_FILTER__MIN_CHARS");
    expect(out).toContain(`store.url = "s3://acme-sessions/prod"  # file ${path}`);
    expect(out).toContain("filter.require_user = true  # default");
  });

  it("prints JSON: values nested, or a list with origins", async () => {
    const path = validConfig();
    const nested = JSON.parse((await seshi(["config", "show", "--config", path, "--json"])).out);
    expect(nested.store.url).toBe("s3://acme-sessions/prod");
    expect(nested.sources[0].api_key).toBe("<secret: env DD_API_KEY>");
    const listed = JSON.parse(
      (await seshi(["config", "show", "--config", path, "--json", "--origin"])).out,
    );
    expect(listed.file).toBe(path);
    expect(listed.values).toContainEqual({
      path: "store.url",
      value: "s3://acme-sessions/prod",
      origin: { source: "file", path },
    });
  });

  it("shows the CLI's config", async () => {
    const path = file(
      "config.toml",
      `server = "https://seshi.acme.dev"\n[[capture.paths]]\npath = "~/clients/acme"\ncapture = false\n`,
    );
    const { code, out } = await seshi(["config", "show", "--cli", "--config", path, "--origin"], {
      SESHI_THEME: "light",
      SESHI_STORE__URL: "s3://server/setting",
    });
    expect(code).toBe(0);
    expect(out).toContain('server = "https://seshi.acme.dev"');
    expect(out).toContain('theme = "light"  # env SESHI_THEME');
    expect(out).toContain('capture.paths[0].path = "~/clients/acme"');
    expect(out).not.toContain("store.url");
  });
});

describe("seshi config", () => {
  it("prints usage without a subcommand and refuses an unknown one", async () => {
    expect((await seshi(["config"])).code).toBe(2);
    const unknown = await seshi(["config", "edit"]);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain("unknown subcommand 'edit'");
    const help = await seshi(["config", "--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("seshi config show");
  });

  it("refuses unknown flags and --origin on check", async () => {
    expect((await seshi(["config", "show", "--bogus"])).code).toBe(2);
    expect((await seshi(["config", "check", "--origin"])).err).toContain(
      "--origin is for config show",
    );
  });

  it("is listed in --help", async () => {
    expect((await seshi(["--help"])).out).toContain("config");
  });
});
