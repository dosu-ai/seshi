import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type ServerConfig, serverConfigSchema } from "@seshi/config";
import { VERSION } from "@seshi/model";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requestBodyCap } from "./serve";
import { configFlags, ServeConfigError, serveSettings } from "./serve-settings";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-serve-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const MAIN = join(import.meta.dirname, "..", "main.ts");

function spawn(env: Record<string, string>, args: string[] = []) {
  return Bun.spawn(["bun", MAIN, "serve", ...args], {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "",
      SESHI_AUTH__TOKENS__DEFAULT: "sdb_test-token-0123456789abcdef",
      SESHI_STORE__URL: `file://${join(dir, "bucket")}`,
      SESHI_SERVER__LISTEN: "127.0.0.1:0",
      SESHI_SEARCH__PATH: join(dir, "search.sqlite"),
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** Boot the server and give it a moment: what it printed, and its exit code if it stopped. */
async function boot(
  env: Record<string, string>,
  args: string[] = [],
): Promise<{ code: number | null; out: string }> {
  const proc = spawn(env, args);
  const exited = await Promise.race([proc.exited, Bun.sleep(3000).then(() => null)]);
  if (exited === null) proc.kill();
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  return { code: exited, out };
}

/** Start the server and wait until it says where it listens. */
async function listening(
  env: Record<string, string>,
  args: string[] = [],
): Promise<{ port: string; out: string; stop(): Promise<void> }> {
  const proc = spawn(env, args);
  const reader = proc.stdout.getReader();
  let out = "";
  while (!/localhost:(\d+)|127\.0\.0\.1:(\d+)/.test(out)) {
    const { value, done } = await reader.read();
    if (done) {
      proc.kill();
      throw new Error(`server stopped: ${out}${await new Response(proc.stderr).text()}`);
    }
    out += new TextDecoder().decode(value);
  }
  const match = /(?:localhost|127\.0\.0\.1):(\d+)/.exec(out) as RegExpExecArray;
  return {
    port: match[1] as string,
    out,
    async stop() {
      proc.kill();
      await proc.exited;
    },
  };
}

describe("redaction packs", () => {
  it("refuses to start on a pattern that cannot be used, naming the file", async () => {
    const file = join(dir, "redaction.json");
    writeFileSync(file, JSON.stringify({ patterns: ["("] }));
    const { code, out } = await boot({ SESHI_REDACTION__PACKS: file });
    expect(code).toBe(3);
    expect(out).toContain(`seshi: ${file} (pack legacy): `);
    expect(out).toContain("pattern '(' is not a usable RE2 pattern");
  });

  it("starts with usable packs and says what they added", async () => {
    const a = join(dir, "a.json");
    const b = join(dir, "b.json");
    writeFileSync(a, JSON.stringify({ patterns: ["ACME-\\d+"], sensitive_files: ["*.secret"] }));
    writeFileSync(b, JSON.stringify({ patterns: ["INTERNAL-\\d+"] }));
    const server = await listening({ SESHI_REDACTION__PACKS: `${a},${b}` });
    try {
      expect(server.out).toMatch(
        /redaction: packs legacy \(from .*a\.json, .*b\.json\) on top of the built-in rules seshi\/rules\/3; rule set [0-9a-f]{12}/,
      );
    } finally {
      await server.stop();
    }
  });

  it("refuses a pack it cannot read", async () => {
    const { code, out } = await boot({ SESHI_REDACTION__PACKS: join(dir, "missing.json") });
    expect(code).toBe(3);
    expect(out).toContain("cannot read redaction pack");
  });
});

describe("seshi serve", () => {
  it("serves /healthz with the release's version", async () => {
    const server = await listening({});
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/healthz`);
      expect(await response.json()).toEqual({ ok: true, version: VERSION });
      expect(server.out).toContain(`seshi ${VERSION} listening on http://127.0.0.1:`);
    } finally {
      await server.stop();
    }
  });

  it("runs the worker's jobs in the same process by default (X7.1, X7.2)", async () => {
    const server = await listening({ SESHI_WORKER__HEARTBEAT_INTERVAL: "50" });
    try {
      expect(server.out).toContain("roles: api, worker");
      // The assembler (09) publishes before the indexer (12) reads the change feed.
      expect(server.out).toMatch(/; jobs: heartbeat, retention, assembler, search-index$/m);
      const heartbeat = join(dir, "bucket", "worker", "heartbeat.json");
      for (let i = 0; i < 100 && !existsSync(heartbeat); i++) await Bun.sleep(20);
      expect(JSON.parse(readFileSync(heartbeat, "utf8"))).toMatchObject({
        schema: "seshi/heartbeat/1",
        roles: ["api", "worker"],
      });
    } finally {
      await server.stop();
    }
  });

  it("serves /healthz only with --roles worker, and runs only the indexer with --roles api", async () => {
    const worker = await listening({}, ["--roles", "worker"]);
    try {
      expect(worker.out).toContain("worker only: /healthz and nothing else");
      expect((await fetch(`http://127.0.0.1:${worker.port}/healthz`)).status).toBe(200);
      const me = await fetch(`http://127.0.0.1:${worker.port}/v1/me`, {
        headers: { authorization: "Bearer sdb_test-token-0123456789abcdef" },
      });
      expect(me.status).toBe(404);
    } finally {
      await worker.stop();
    }
    const api = await listening({}, ["--roles", "api"]);
    try {
      expect(api.out).toContain("roles: api (instance");
      // Every instance that serves search keeps its own index (F10.3); the worker's jobs stay
      // on the worker.
      expect(api.out).toMatch(/; jobs: search-index$/m);
    } finally {
      await api.stop();
    }
  });

  it("reads seshi.toml from the working directory, with env over it and flags over env", async () => {
    writeFileSync(
      join(dir, "seshi.toml"),
      `[server]\nlisten = "127.0.0.1:1"\n[store]\nurl = "file://${join(dir, "from-file")}"\n[auth.tokens]\nalice = { env = "ALICE_TOKEN" }\n`,
    );
    const server = await listening(
      {
        ALICE_TOKEN: "alice-token-0123456789",
        SESHI_SERVER__LISTEN: "127.0.0.1:2",
        SESHI_STORE__URL: "",
      },
      ["--listen", "127.0.0.1:0"],
    );
    try {
      expect(server.out).toContain(`sessions in file://${join(dir, "from-file")}`);
      expect(server.out).toContain("static tokens for alice, default");
      expect(server.out).toContain(`(config ${join(realpathSync(dir), "seshi.toml")})`);
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/me`, {
        headers: { authorization: "Bearer alice-token-0123456789" },
      });
      expect((await response.json()).owner).toBe("alice");
    } finally {
      await server.stop();
    }
  });

  it("reads the file named by --config", async () => {
    const file = join(dir, "elsewhere.toml");
    writeFileSync(file, `[store]\nurl = "file://${join(dir, "named")}"\n`);
    const server = await listening({ SESHI_STORE__URL: "" }, ["--config", file]);
    try {
      expect(server.out).toContain(`sessions in file://${join(dir, "named")}`);
    } finally {
      await server.stop();
    }
  });

  it("warns about a literal secret in a file others can read", async () => {
    const file = join(dir, "seshi.toml");
    writeFileSync(file, `[auth.tokens]\nbob = "bob-token-0123456789"\n`);
    chmodSync(file, 0o644);
    const { out } = await boot({});
    expect(out).toContain("seshi: warning:");
    expect(out).toContain("auth.tokens.bob");
  });

  it("exits 3 (config) with every config problem, and where each value came from", async () => {
    const { code, out } = await boot({ SESHI_FILTER__MIN_CHARS: "lots", SESHI_STORE__URLL: "x" });
    expect(code).toBe(3);
    expect(out).toContain("seshi: SESHI_STORE__URLL: not a setting");
    const second = await boot({ SESHI_FILTER__MIN_CHARS: "lots" });
    expect(second.code).toBe(3);
    expect(second.out).toContain("seshi: filter.min_chars:");
    expect(second.out).toContain("(from env SESHI_FILTER__MIN_CHARS)");
    // The per-bucket trace format is gone (X6.2): naming it is an unknown setting.
    const third = await boot({ SESHI_STORE__FORMAT: "otlp" });
    expect(third.code).toBe(3);
    expect(third.out).toContain("seshi: SESHI_STORE__FORMAT: not a setting");
  });

  it("records the deployment and org in the bucket's marker, and refuses another's bucket", async () => {
    const first = await listening({
      SESHI_STORE__DEPLOYMENT_ID: "prod-eu",
      SESHI_STORE__ORG: "acme",
    });
    try {
      expect(first.out).toContain("(deployment prod-eu)");
    } finally {
      await first.stop();
    }
    const marker = JSON.parse(readFileSync(join(dir, "bucket", "seshi.json"), "utf8"));
    expect(marker).toMatchObject({
      schema: "seshi/layout/1",
      trace_schema: "seshi/trace/1",
      deployment_id: "prod-eu",
      org: "acme",
      created_by: `seshi/${VERSION}`,
    });
    const staging = await boot({ SESHI_STORE__DEPLOYMENT_ID: "staging" });
    expect(staging.code).toBe(3);
    expect(staging.out).toContain('belongs to deployment "prod-eu", not "staging"');
    const globex = await boot({ SESHI_STORE__ORG: "globex" });
    expect(globex.code).toBe(3);
    expect(globex.out).toContain('belongs to org "acme", not "globex"');
  });

  it("refuses a bucket a sessiondb server wrote", async () => {
    mkdirSync(join(dir, "bucket"), { recursive: true });
    writeFileSync(
      join(dir, "bucket", "sessionstorage.json"),
      JSON.stringify({ schema: "sessionstorage/layout/1", created_at: "x", created_by: "y" }),
    );
    const { code, out } = await boot({});
    expect(code).toBe(3);
    expect(out).toContain("seshi: cannot use file://");
    expect(out).toContain("holds a sessiondb store");
  });

  it("exits 3 (config) with a message when its address is taken", async () => {
    const taken = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    try {
      const { code, out } = await boot({ SESHI_SERVER__LISTEN: `127.0.0.1:${taken.port}` });
      expect(code).toBe(3);
      expect(out).toContain(
        `seshi: cannot listen on 127.0.0.1:${taken.port}: the address is in use`,
      );
      expect(out).not.toContain("    at ");
    } finally {
      taken.stop(true);
    }
  });

  it("exits 2 (usage) on an unknown flag", async () => {
    const { code, out } = await boot({}, ["--port", "1"]);
    expect(code).toBe(2);
    expect(out).toContain("seshi: Unknown option '--port'");
  });

  it("does not read the old SESSIONDB_* names, and says when no token can call it", async () => {
    const { out } = await boot({
      SESHI_AUTH__TOKENS__DEFAULT: "",
      SESSIONDB_TOKEN: "sdb_test-token-0123456789abcdef",
    });
    expect(out).toContain("no token can call this server yet: run `seshi admin init`");
    expect(out).not.toContain("static tokens for");
  });
});

describe("serveSettings", () => {
  const config = (tree: Record<string, unknown>, env: Record<string, string> = {}): ServerConfig =>
    loadConfig(serverConfigSchema, {
      env: { SESHI_STORE__URL: "file:///tmp/x", ...env },
      flags: Object.entries(tree).map(([path, value]) => ({
        name: "--set",
        path,
        value: String(value),
      })),
    }).config;
  const error = (c: ServerConfig) => {
    try {
      serveSettings(c);
    } catch (err) {
      expect(err).toBeInstanceOf(ServeConfigError);
      return (err as Error).message;
    }
    throw new Error("expected a ServeConfigError");
  };

  it("maps the auth settings, the store, the listen address, the filter and limits", () => {
    const settings = serveSettings(
      config(
        {
          "server.listen": "[::1]:8080",
          "store.region": "eu-west-1",
          "store.deployment_id": "prod-eu",
          "store.org": "acme",
          "redaction.packs": "/etc/rules.json",
          "filter.min_chars": 10,
          "limits.max_upload_bytes": "1MiB",
        },
        {
          SESHI_AUTH__TOKENS__ALICE: " alice-token-0123456789 ",
          SESHI_AUTH__TOKENS__BOB: "bob-token-0123456789",
          SESHI_AUTH__SESSION_KEYS__K1: ` ${"s".repeat(32)} `,
          SESHI_AUTH__ADMINS: "Ops@Acme.com",
          SESHI_STORE__CREDENTIALS__ACCESS_KEY_ID: "AKIA",
          SESHI_STORE__CREDENTIALS__SECRET_ACCESS_KEY: "shh",
        },
      ),
    );
    expect(settings).toEqual({
      auth: {
        staticTokens: [
          { token: "alice-token-0123456789", owner: "alice" },
          { token: "bob-token-0123456789", owner: "bob" },
        ],
        orgKey: true,
        admins: ["ops@acme.com"],
        aliases: {},
        sessionKeys: { k1: "s".repeat(32) },
        signingKeyId: "k1",
      },
      owners: ["alice", "bob"],
      url: "file:///tmp/x",
      store: { region: "eu-west-1", credentials: { accessKeyId: "AKIA", secretAccessKey: "shh" } },
      deploymentId: "prod-eu",
      org: "acme",
      redactionPacks: ["/etc/rules.json"],
      hostname: "::1",
      port: 8080,
      roles: ["api", "worker"],
      filter: { enabled: true, min_chars: 10, require_user: true, require_reply: true },
      limits: {
        max_records: 50_000,
        max_records_bytes: 32 * 1024 * 1024,
        max_upload_bytes: 1024 * 1024,
        max_otlp_bytes: 64 * 1024 * 1024,
        max_otlp_inflated_bytes: 256 * 1024 * 1024,
      },
    });
  });

  it("defaults to every interface, port 7200, no packs and no deployment or org to check", () => {
    const settings = serveSettings(
      config({}, { SESHI_AUTH__TOKENS__DEFAULT: "single-token-0123456789" }),
    );
    expect(settings).toMatchObject({
      deploymentId: undefined,
      org: undefined,
      hostname: "0.0.0.0",
      port: 7200,
      redactionPacks: [],
      owners: ["default"],
    });
  });

  it("refuses what the server always refused", () => {
    // No static token is fine: seshi tokens in the bucket let callers in (X5.9).
    expect(serveSettings(config({})).auth.staticTokens).toEqual([]);
    expect(error(config({}, { SESHI_AUTH__TOKENS__ALICE: "short" }))).toContain(
      "auth.tokens.alice must be 16+ characters",
    );
    expect(error(config({}, { SESHI_AUTH__SESSION_KEYS__K1: "short" }))).toContain(
      "auth.session_keys.k1 must be 32+ characters",
    );
    expect(error(config({ "auth.tokens.svc:otlp": "token-0123456789abcdef" }))).toContain(
      "'svc:otlp' is not a valid owner id",
    );
    expect(error(config({ "auth.owner_aliases.a": "b", "auth.owner_aliases.b": "a" }))).toContain(
      "leads round in a circle",
    );
    expect(
      error(
        config(
          {},
          {
            SESHI_AUTH__TOKENS__A: "same-token-0123456789",
            SESHI_AUTH__TOKENS__B: "same-token-0123456789",
          },
        ),
      ),
    ).toBe("auth.tokens: the same token is given to two owners");
    expect(error(config({ "auth.tokens.a/b": "token-0123456789abcdef" }))).toContain(
      "'a/b' is not a valid owner id",
    );
  });

  it("takes either role alone (X7.1)", () => {
    expect(serveSettings(config({ "server.roles": "worker" })).roles).toEqual(["worker"]);
    expect(serveSettings(config({ "server.roles": "api" })).roles).toEqual(["api"]);
  });
});

describe("requestBodyCap", () => {
  it("takes an upload's body, or an OTLP body up to limits.max_otlp_bytes when that is larger", () => {
    const MiB = 1024 * 1024;
    // The defaults: an upload's 513 MiB is larger than OTLP's 64 MiB.
    expect(requestBodyCap({ max_upload_bytes: 256 * MiB, max_otlp_bytes: 64 * MiB })).toBe(
      513 * MiB,
    );
    // A raised OTLP cap is not cut by the listener, so the route's 413 names the key.
    expect(requestBodyCap({ max_upload_bytes: MiB, max_otlp_bytes: 64 * MiB })).toBe(64 * MiB);
  });
});

describe("configFlags", () => {
  it("maps --listen, --roles and --set to config paths", () => {
    expect(configFlags({ listen: ":1", roles: "api", set: ["store.url=s3://b/p=q"] })).toEqual([
      { name: "--set store.url", path: "store.url", value: "s3://b/p=q" },
      { name: "--listen", path: "server.listen", value: ":1" },
      { name: "--roles", path: "server.roles", value: "api" },
    ]);
  });

  it("refuses --set without a path", () => {
    expect(() => configFlags({ set: ["=x"] })).toThrow("--set takes path=value");
    expect(() => configFlags({ set: ["novalue"] })).toThrow("--set takes path=value");
  });
});
