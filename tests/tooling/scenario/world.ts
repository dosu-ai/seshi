/** The world a scenario runs in, all in one process: a seshi server (an Instance over a folder
 * bucket, served on 127.0.0.1 so the CLI can sign in and fetch rules), a simulated machine
 * running real `seshi` commands (hooks, `capture …`, `doctor`) through `main`, synthetic
 * transcripts, the fake reviewer, one clock, and the faults. The uploader is the production
 * `Uploader` with the production pre-redactor and HTTP sink; only its `fetch` is wrapped, its
 * clock and `random` injected, and its git identity fixed, so a pass is the in-process
 * equivalent of `seshi daemon --once`. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, createApp } from "@seshi/api";
import { Auth } from "@seshi/auth";
import {
  allStale,
  capturePaths,
  httpSink,
  type PassSummary,
  RetractRefused,
  retractHash,
  type SessionSink,
  SignInNeeded,
  Uploader,
} from "@seshi/capture";
import type { FormatRegistry } from "@seshi/formats";
import { FormatRegistry as Registry } from "@seshi/formats";
import { buildInstance, type Instance } from "@seshi/instance";
import type { CaptureHost } from "@seshi/kit";
import { type FormatAdapter, localWriter } from "@seshi/model";
import { finishTombstone, getSession, tombstone } from "@seshi/pipeline";
import { compileRuleSet, type RuleSet, validatePack } from "@seshi/redact";
import { reviewerFromConfig } from "@seshi/review";
import { KeywordModel } from "@seshi/review/testing";
import { FsStore } from "@seshi/store";
import { accountCredential, NotSignedIn, openAccount, serverOf } from "seshi/account";
import { preRedactor } from "seshi/capture-runtime";
import { buildFormats, INTEGRATIONS } from "seshi/integrations";
import { Machine } from "../cli";
import { serverConfig } from "../instance";
import { ScenarioClock, seededRandom } from "./clock";
import { FaultPlan, faultFetch, ScenarioStore } from "./faults";
import type { ReviewAnswer, Rule, Scenario } from "./schema";

/** The person whose machine it is, as the server records them. */
export const SERVER_OWNER = "alice@acme.com";
export const LOCAL_OWNER = "me";
/** Every synthetic session is a Claude Code one. */
export const AGENT = "claude-code";

/** The model provider review calls: answers decisions from the scenario's queue (allow once it
 * is empty), finds the scenario's marks when asked to redact, and keeps what it was sent. */
class ReviewModel {
  readonly queue: ReviewAnswer[] = [];
  /** The user message of every decision call, in order. */
  readonly seen: string[] = [];
  /** Every request text, decisions and redactor calls. */
  readonly all: string[] = [];
  constructor(private readonly marks: () => string[]) {}

  provider(role: "decision" | "redactor") {
    return {
      kind: "fake",
      model: `scenario-${role}`,
      endpoint: "fake://scenario",
      complete: async (request: { user: string; schemaName: string }) => {
        this.all.push(request.user);
        if (request.schemaName === "findings") {
          const sensitive = this.marks().map((text) => ({ text, category: "secret" }));
          return new KeywordModel({ sensitive }).answer("findings", request.user);
        }
        this.seen.push(request.user);
        const next = this.queue.shift() ?? "allow";
        if (next === "fail") {
          const { ProviderError } = await import("@seshi/review");
          throw new ProviderError("http_400", false, "injected review failure");
        }
        return { label: next };
      },
    };
  }
}

function ruleSet(rules: readonly Rule[]): RuleSet {
  if (rules.length === 0) return compileRuleSet();
  return compileRuleSet({
    packs: [validatePack({ id: "org", rules: [...rules] }, { source: "org.toml" })],
  });
}

/** The registry with each bumped format's version raised `n` times: what a release whose
 * adapter changed records would ship (X4.9). */
function bumpedFormats(bumps: ReadonlyMap<string, number>): FormatRegistry {
  const base = buildFormats();
  if (bumps.size === 0) return base;
  const adapters = base.sources.map((source) => {
    const adapter = base.get(source) as FormatAdapter;
    const n = bumps.get(source);
    if (!n) return adapter;
    const current = base.versionOf(source) ?? "1";
    const [head, ...rest] = current.split("+");
    const version = [String(Number.parseInt(head as string, 10) + n), ...rest].join("+");
    return Object.create(adapter, { version: { value: version, enumerable: true } });
  });
  return new Registry(adapters);
}

export interface SessionInfo {
  /** The session id (the scenario's name for it). */
  id: string;
  path: string;
  /** The folder its last turn ran in. */
  cwd: string;
  parent?: string;
}

/** A seshi server over the scenario's bucket. A restart builds a new Instance over the same
 * bucket behind the same address. */
class ScenarioServer {
  instance: Instance | undefined;
  app: App | undefined;
  url = "";
  orgKey = "";
  private listener: ReturnType<typeof Bun.serve> | undefined;
  rules: Rule[];
  readonly bumps = new Map<string, number>();

  constructor(
    private readonly world: World,
    rules: Rule[],
  ) {
    this.rules = [...rules];
  }

  get formats(): FormatRegistry {
    return bumpedFormats(this.bumps);
  }

  async boot(): Promise<void> {
    const { store, clock } = this.world;
    const auth = new Auth(
      {
        staticTokens: [],
        orgKey: true,
        admins: [],
        aliases: {},
        sessionKeys: { k1: "k".repeat(32) },
      },
      { store, deployment: "test", now: clock.now },
    );
    // The scenario's own server config first (top-level keys must come before any table).
    const toml = `${this.world.scenario.setup.server ?? ""}\n[store]\nurl = ${JSON.stringify(store.url)}\n`;
    this.instance = await buildInstance(serverConfig(toml), {
      store: { store, storage: { url: store.url } },
      formats: this.formats,
      redaction: ruleSet(this.rules),
      ...(this.world.reviewer ? { reviewer: this.world.reviewer } : {}),
      auth,
      now: clock.now,
      id: "test",
      env: {},
      newDeploymentId: () => "test",
    });
    this.app = createApp(this.instance);
    if (!this.orgKey) {
      this.orgKey = (await auth.initAdmin({ owner: "ops" })).org_key?.token as string;
    }
    if (this.world.scenario.setup.mode === "server" && !this.listener) {
      this.listener = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => {
          if (!this.app) return new Response("restarting", { status: 503 });
          return this.app.fetch(request);
        },
      });
      this.url = `http://127.0.0.1:${this.listener.port}`;
    }
  }

  async restart(): Promise<void> {
    const old = this.instance;
    this.app = undefined;
    this.instance = undefined;
    await old?.close(1000);
    await this.boot();
  }

  async stop(): Promise<void> {
    this.listener?.stop(true);
    await this.instance?.close(1000);
  }
}

export class World {
  readonly clock = new ScenarioClock();
  readonly plan = new FaultPlan();
  readonly dir: string;
  readonly fs: FsStore;
  readonly store: ScenarioStore;
  readonly machine: Machine;
  readonly server: ScenarioServer;
  readonly review: ReviewModel;
  reviewer: Awaited<ReturnType<typeof reviewerFromConfig>>;
  readonly random: () => number;
  readonly sessions = new Map<string, SessionInfo>();
  /** Every `mark` a turn carried. */
  readonly marks: string[] = [];
  /** Whether any turn planted the fake credentials. */
  planted = false;
  lastPass: PassSummary | undefined;
  /** Transcripts a compaction shrank: their offsets may run past the end until the uploader
   * has sent them again (a pass that skips one, waiting out a backoff, has not). */
  readonly shrunk = new Set<string>();

  constructor(readonly scenario: Scenario) {
    this.dir = mkdtempSync(join(tmpdir(), "seshi-scenario-"));
    this.fs = new FsStore(`file://${join(this.dir, "bucket")}`);
    this.store = new ScenarioStore(this.fs, this.plan, this.clock);
    this.machine = new Machine();
    this.server = new ScenarioServer(this, scenario.setup.rules);
    this.review = new ReviewModel(() => this.marks);
    this.random = seededRandom(scenario.setup.seed);
    this.reviewer = undefined;
  }

  get owner(): string {
    return this.scenario.setup.mode === "local" ? LOCAL_OWNER : SERVER_OWNER;
  }

  get home(): string {
    return this.machine.dir;
  }

  get host(): CaptureHost {
    return { env: this.machine.env, home: this.machine.dir, platform: process.platform };
  }

  get paths() {
    return capturePaths(this.host);
  }

  async start(): Promise<void> {
    this.clock.install();
    const { setup } = this.scenario;
    if (setup.review) {
      const toml = [
        "[[review.policies]]",
        'id = "scenario"',
        `on_failure = "${setup.review.on_failure}"`,
        "retries = 0",
        'decision = { api_key = "k", base_url = "http://review.invalid" }',
      ].join("\n");
      this.reviewer = await reviewerFromConfig(serverConfig(toml), {
        providers: (_step, role) => this.review.provider(role),
        sleep: async () => {},
      });
    }
    await this.server.boot();
    if (setup.mode === "server") {
      const login = await this.machine.seshi(
        ["login", "--server", this.server.url, "--key", "-", "--user", SERVER_OWNER],
        { stdin: this.server.orgKey },
      );
      if (login.code !== 0) throw new Error(`seshi login failed: ${login.err}`);
    } else {
      const toml = join(this.dir, "seshi.toml");
      writeFileSync(toml, `[store]\nurl = "${this.store.url}"\n`, { mode: 0o600 });
      this.machine.cliConfig(`[local]\nconfig = "${toml}"\nowner = "${LOCAL_OWNER}"\n`);
    }
    for (const [folder, repo] of Object.entries(setup.repos)) {
      const root = join(this.home, folder);
      mkdirSync(join(root, ".git"), { recursive: true });
      writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
      if (repo.config !== undefined) {
        mkdirSync(join(root, ".seshi"), { recursive: true });
        writeFileSync(join(root, ".seshi", "config.toml"), repo.config);
      }
    }
  }

  async stop(): Promise<void> {
    try {
      await this.server.stop();
    } finally {
      this.clock.restore();
      this.machine.cleanup();
      // SCENARIO_KEEP=1 keeps the scenario's folder (bucket, server state) to look at afterwards.
      if (process.env.SCENARIO_KEEP) console.error(`scenario folder kept: ${this.dir}`);
      else rmSync(this.dir, { recursive: true, force: true });
    }
  }

  /** The context a command gets, for the account code. */
  context(): Parameters<typeof openAccount>[0] {
    return {
      argv: [],
      env: this.machine.env,
      stdout: () => {},
      stderr: () => {},
      integrations: async () => INTEGRATIONS,
      secrets: this.machine.secrets,
    };
  }

  /** Where the uploader sends: the server over the faulted fetch, or, in local mode, the
   * scenario's Instance as `seshi`'s local sink does it. */
  private async sink(): Promise<SessionSink> {
    if (this.scenario.setup.mode === "local") return this.localSink();
    const account = openAccount(this.context());
    const server = serverOf(account) as string;
    return httpSink({
      target: server,
      fetch: faultFetch(this.plan, this.clock),
      credential: async () => {
        try {
          const credential = await accountCredential(account, server, "upload");
          return {
            server: credential.server,
            token: credential.token,
            ...(credential.user ? { user: credential.user } : {}),
          };
        } catch (err) {
          if (err instanceof NotSignedIn) throw new SignInNeeded(err.message);
          throw err;
        }
      },
    });
  }

  /** `localSink` in apps/seshi/src/capture-runtime.ts, over this world's Instance (so store
   * faults and the scenario clock reach it). */
  private localSink(): SessionSink {
    const server = this.server;
    const owner = LOCAL_OWNER;
    const instance = () => server.instance as Instance;
    return {
      target: `local: ${this.store.url}`,
      async ready() {},
      ingest: (upload, options) => instance().localSessions(owner).ingest(upload, options),
      stale: () =>
        allStale((after) =>
          instance()
            .localSessions(owner)
            .staleSessions(after !== undefined ? { after } : {}),
        ),
      async retract(agent, sessionId, secret) {
        const inst = instance();
        if (!inst.config.capture.allow_retract) {
          throw new RetractRefused("retract_disabled", "retraction is turned off");
        }
        const metadata = await getSession(inst.store, owner, agent, sessionId);
        if (!metadata) return "absent";
        if (metadata.status === "redacted") {
          await finishTombstone({ store: inst.store, owner, agent, session_id: sessionId });
          return "gone";
        }
        if (metadata.retract_hash !== retractHash(secret)) {
          throw new RetractRefused("bad_retract_secret", "not the session's retraction secret");
        }
        await tombstone({
          store: inst.store,
          owner,
          agent,
          session_id: sessionId,
          now: inst.now,
          reason: "retracted",
          writer: localWriter(owner),
        });
        return "retracted";
      },
    };
  }

  /** One uploader pass, as `seshi daemon --once` makes it (the sweep included). */
  async pass(sweep = true): Promise<PassSummary> {
    const account = openAccount(this.context());
    const paths = this.paths;
    const uploader = new Uploader({
      paths,
      host: this.host,
      // The agents this binary captures: each integration's `capture` (what `seshi daemon`
      // loads through apps/seshi/src/capture-agents.ts; a test there checks they are the same).
      agents: INTEGRATIONS.flatMap((i) => (i.capture ? [i.capture] : [])),
      sink: () => this.sink(),
      preRedact: preRedactor(account, { cacheFile: paths.redactionRules }),
      git: async () => ({ email: "alice@acme.com", name: "Alice" }),
      now: this.clock.now,
      random: this.random,
    });
    const summary = await uploader.pass({ sweep });
    this.lastPass = summary;
    return summary;
  }
}
