/** The CLI against real servers for cross-package tests (X3.6): a seshi server served on
 * 127.0.0.1 over its own Instance and temporary folder store, a stand-in IdP served the same
 * way (discovery, device authorization, token and authorize endpoints, the shapes RFC 8628,
 * RFC 7636 and OIDC Core document, ID tokens signed by `FakeIdp`), and `seshi` run through
 * `main` with its own home folder and an in-memory secret store, so nothing touches the real
 * keychain, the real CLI config or the network. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createApp } from "@seshi/api";
import { Auth, type AuthSettings } from "@seshi/auth";
import { FakeIdp } from "@seshi/auth/testing";
import type { Instance, InstanceParts } from "@seshi/instance";
import type { Integration } from "@seshi/kit";
import type { RuleSet } from "@seshi/redact";
import { FsStore } from "@seshi/store";
import { Logins, MemorySecrets } from "seshi/account";
import { INTEGRATIONS } from "seshi/integrations";
import { type MainOptions, main } from "seshi/main";
import { testInstance } from "./instance";

/** The terminal `seshi` asks questions of and opens browsers through. */
export type Terminal = Awaited<ReturnType<NonNullable<MainOptions["terminal"]>>>;

export interface Run {
  code: number | undefined;
  out: string;
  err: string;
}

export interface RunOptions {
  stdin?: string;
  env?: Record<string, string>;
  terminal?: Terminal;
  tty?: { stdout: boolean; stdin: boolean };
  integrations?: Integration[];
}

/** One person's machine: a home folder, a CLI config folder and a secret store. */
export class Machine {
  readonly dir: string;
  readonly configDir: string;
  readonly secrets = new MemorySecrets();
  readonly env: Record<string, string>;
  /** What commands asked to start detached (a hook starting the uploader): recorded, never
   * run. */
  readonly spawned: { words: string[]; self: boolean }[] = [];
  /** Programs commands ran and waited for (a service manager): recorded, answered 0. */
  readonly executed: string[][] = [];

  constructor(env: Record<string, string> = {}) {
    this.dir = mkdtempSync(join(tmpdir(), "seshi-cli-"));
    this.configDir = join(this.dir, "config", "seshi");
    this.env = {
      HOME: this.dir,
      XDG_CONFIG_HOME: join(this.dir, "config"),
      // git (claims, the org key's username) reads this machine's config only: not the real
      // ~/.gitconfig, a GIT_CONFIG_GLOBAL the test process carries, or the system's.
      GIT_CONFIG_GLOBAL: join(this.dir, ".gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      ...env,
    };
  }

  /** The logins `seshi login` wrote. */
  get logins(): Logins {
    return new Logins(this.configDir, this.secrets);
  }

  /** Write the CLI config. */
  cliConfig(toml: string): void {
    mkdirSync(this.configDir, { recursive: true });
    writeFileSync(join(this.configDir, "config.toml"), toml, { mode: 0o600 });
  }

  async seshi(argv: string[], options: RunOptions = {}): Promise<Run> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(argv, {
      env: { ...this.env, ...options.env },
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      integrations: async () => options.integrations ?? INTEGRATIONS,
      secrets: this.secrets,
      spawn: async (words, spawnOptions) => {
        this.spawned.push({ words, self: spawnOptions?.self === true });
      },
      exec: async (words) => {
        this.executed.push(words);
        return { code: 0, output: "" };
      },
      ...(options.stdin !== undefined ? { stdin: async () => options.stdin as string } : {}),
      ...(options.terminal ? { terminal: async () => options.terminal as Terminal } : {}),
      ...(options.tty ? { tty: options.tty } : {}),
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  }

  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** A seshi server on 127.0.0.1 over its own Instance and folder store. */
/** One request the test server answered: what a client sent, as the server read it. */
export interface SeenRequest {
  method: string;
  path: string;
  status: number;
  /** Request headers, lowercased. */
  headers: Record<string, string>;
  /** The request body as text, gunzipped. */
  body: string;
}

export interface TestServer {
  url: string;
  instance: Instance;
  auth: Auth;
  /** Every request served, in order. */
  requests: SeenRequest[];
  stop(): Promise<void>;
}

export async function startServer(
  options: {
    settings?: Partial<AuthSettings>;
    idp?: FakeIdp;
    config?: string;
    /** The rule set the server redacts with and serves (F2.4); the built-in pack by default. */
    redaction?: RuleSet;
    /** Model review (F3); none by default. */
    reviewer?: InstanceParts["reviewer"];
  } = {},
): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), "seshi-server-"));
  const store = new FsStore(`file://${join(dir, "bucket")}`);
  const auth = new Auth(
    {
      staticTokens: [],
      orgKey: true,
      admins: [],
      aliases: {},
      sessionKeys: { k1: "k".repeat(32) },
      ...options.settings,
    },
    { store, deployment: "test", ...(options.idp ? { oidcKeys: options.idp.keys } : {}) },
  );
  const instance = testInstance({
    store,
    auth,
    ...(options.config ? { config: options.config } : {}),
    ...(options.redaction ? { redaction: options.redaction } : {}),
    ...(options.reviewer ? { reviewer: options.reviewer } : {}),
  });
  const app = createApp(instance);
  const requests: SeenRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const bytes = new Uint8Array(await request.clone().arrayBuffer());
      const gzipped = request.headers.get("content-encoding") === "gzip";
      const response = await app.fetch(request);
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        status: response.status,
        headers: Object.fromEntries(request.headers),
        body: new TextDecoder().decode(gzipped ? gunzipSync(bytes) : bytes),
      });
      return response;
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    instance,
    auth,
    requests,
    async stop() {
      server.stop(true);
      await instance.close(1000);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A stand-in IdP on 127.0.0.1. `claims` go into every ID token it issues; the device flow
 * answers `authorization_pending` `pendingPolls` times before the tokens. */
export class IdpServer {
  readonly calls: { path: string; grant?: string }[] = [];
  /** Refresh tokens it still honours. */
  readonly refreshTokens = new Set<string>();
  claims: Record<string, unknown> = { email: "alice@acme.com", email_verified: true };
  pendingPolls = 1;
  /** Whether it offers the device flow. */
  device = true;
  /** The `jwks_uri` discovery names; its own `/jwks` when unset. */
  jwksUri: string | undefined;
  /** Told of every call once it is answered. */
  onCall:
    | ((call: { path: string; grant?: string }, response: Response, request: Request) => unknown)
    | undefined;
  private codes = new Map<string, { challenge: string; nonce: string; redirect: string }>();
  private counter = 0;

  private constructor(
    readonly idp: FakeIdp,
    private readonly server: ReturnType<typeof Bun.serve>,
  ) {}

  get url(): string {
    return this.idp.issuer;
  }

  static async start(): Promise<IdpServer> {
    let handler: (request: Request) => Promise<Response> = async () =>
      new Response("", { status: 503 });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (r) => handler(r) });
    const idp = await FakeIdp.create({ issuer: `http://127.0.0.1:${server.port}` });
    const fake = new IdpServer(idp, server);
    handler = (request) => fake.handle(request);
    return fake;
  }

  private async tokens(extra: Record<string, unknown> = {}): Promise<Response> {
    const refresh = `rt-${++this.counter}`;
    this.refreshTokens.add(refresh);
    return Response.json({
      id_token: await this.idp.idToken({ ...this.claims, ...extra }),
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: 3600,
    });
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const form = new URLSearchParams(request.method === "POST" ? await request.text() : "");
    const call = {
      path: url.pathname,
      ...(form.get("grant_type") ? { grant: form.get("grant_type") as string } : {}),
    };
    this.calls.push(call);
    const response = await this.route(url, form);
    await this.onCall?.(call, response, request);
    return response;
  }

  private async route(url: URL, form: URLSearchParams): Promise<Response> {
    const error = (code: string) => Response.json({ error: code }, { status: 400 });
    switch (url.pathname) {
      case "/.well-known/openid-configuration":
        return Response.json({
          issuer: this.url,
          token_endpoint: `${this.url}/token`,
          authorization_endpoint: `${this.url}/authorize`,
          ...(this.device ? { device_authorization_endpoint: `${this.url}/device` } : {}),
          jwks_uri: this.jwksUri ?? `${this.url}/jwks`,
          scopes_supported: ["openid", "email", "profile", "offline_access"],
        });
      case "/jwks":
        return Response.json(this.idp.jwks);
      case "/device":
        if (form.get("client_id") !== "seshi-cli") return error("invalid_client");
        return Response.json({
          device_code: "dc-1",
          user_code: "WDJB-MJHT",
          verification_uri: `${this.url}/activate`,
          verification_uri_complete: `${this.url}/activate?user_code=WDJB-MJHT`,
          expires_in: 600,
          interval: 0,
        });
      case "/authorize": {
        const redirect = url.searchParams.get("redirect_uri") as string;
        const code = `code-${++this.counter}`;
        this.codes.set(code, {
          challenge: url.searchParams.get("code_challenge") as string,
          nonce: url.searchParams.get("nonce") as string,
          redirect,
        });
        const back = new URL(redirect);
        back.searchParams.set("code", code);
        back.searchParams.set("state", url.searchParams.get("state") as string);
        return Response.redirect(back.toString(), 302);
      }
      case "/token": {
        const grant = form.get("grant_type");
        if (grant === "urn:ietf:params:oauth:grant-type:device_code") {
          if (form.get("device_code") !== "dc-1") return error("invalid_grant");
          if (this.pendingPolls > 0) {
            this.pendingPolls--;
            return error("authorization_pending");
          }
          return this.tokens();
        }
        if (grant === "refresh_token") {
          const token = form.get("refresh_token") as string;
          if (!this.refreshTokens.delete(token)) return error("invalid_grant");
          return this.tokens();
        }
        if (grant === "authorization_code") {
          const issued = this.codes.get(form.get("code") as string);
          if (!issued || issued.redirect !== form.get("redirect_uri"))
            return error("invalid_grant");
          const verifier = form.get("code_verifier") as string;
          const challenge = new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");
          if (challenge !== issued.challenge) return error("invalid_grant");
          return this.tokens({ nonce: issued.nonce });
        }
        return error("unsupported_grant_type");
      }
      default:
        return new Response("not found", { status: 404 });
    }
  }

  stop(): void {
    this.server.stop(true);
  }
}

/** A terminal that answers questions from a list and "opens" URLs by fetching them, as a
 * browser following the IdP's redirect would. */
export function fakeTerminal(answers: string[] = []): Terminal & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async ask(question) {
      asked.push(question);
      return answers.shift() ?? "";
    },
    async background() {
      return undefined;
    },
    async openUrl(url) {
      await fetch(url);
      return true;
    },
  };
}
