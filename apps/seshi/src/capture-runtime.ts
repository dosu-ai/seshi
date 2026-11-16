import { readFileSync } from "node:fs";
import {
  allStale,
  appendLog,
  capturePaths,
  gitIdentityIn,
  NO_PREREDACTION,
  type PreRedactor,
  RetractRefused,
  retractHash,
  type SessionSink,
  SignInNeeded,
  Uploader,
  type UploaderOptions,
  writePrivateFile,
} from "@seshi/capture";
import type { CaptureHost } from "@seshi/kit";
import { localWriter, SessionRejected } from "@seshi/model";
import type { RuleSet, redactTranscript, WithheldCalls } from "@seshi/redact";
import { type Account, accountCredential, openAccount, serverOf } from "./account/account";
import { NotSignedIn } from "./account/credential";
import { allCaptureAgents } from "./capture-agents";
import { Refused } from "./cli/failures";
import { hostOf } from "./commands/capture-host";
import type { CommandContext } from "./commands/index";
import type { ServerlessBucket } from "./serverless/open";
import { isServerless, serverlessOf } from "./serverless/settings";
import { USER_AGENT } from "./user-agent";

export interface OpenedSink {
  sink: SessionSink;
  close(): Promise<void>;
}

/** What a refusal to open the bucket for writing means for uploads: they wait, with the
 * status line saying why (F11). Other errors are thrown as they are. */
function holdOf(err: unknown): unknown {
  if (!(err instanceof Refused)) return err;
  switch (err.code) {
    case "needs_review_key":
      return new SignInNeeded(err.message, "needs review key");
    case "needs_update":
      return new SignInNeeded(err.message, "needs update");
    case "access_denied":
    case "no_bucket":
    case "store_unsupported":
      return new SignInNeeded(err.message, "bucket refused");
    default:
      return err;
  }
}

/** Serverless mode (F11): this machine runs the pipeline and writes its owner's folder. */
export async function serverlessSink(ctx: CommandContext, account: Account): Promise<OpenedSink> {
  const { openServerless, refusalOf, SERVERLESS_BASIS } = await import("./serverless/open");
  let bucket: ServerlessBucket | undefined;
  const open = async (): Promise<ServerlessBucket> => {
    if (bucket) return bucket;
    try {
      bucket = await openServerless({
        cli: account.cli,
        env: account.env,
        home: account.home,
        integrations: await ctx.integrations(),
        secrets: account.secrets,
        write: true,
        search: false,
      });
    } catch (err) {
      throw holdOf(err);
    }
    return bucket;
  };
  const refusedIngest = (err: unknown): never => {
    const refused = refusalOf(err, bucket?.owner);
    if (refused instanceof Refused) throw new SessionRejected("access_denied", refused.message);
    throw err;
  };
  const db = async () => {
    const opened = await open();
    return opened.instance.localSessions(opened.owner, SERVERLESS_BASIS);
  };
  const sink: SessionSink = {
    target: `serverless: ${serverlessOf(account.cli)?.url ?? "the bucket"}`,
    async ready() {
      await open();
    },
    ingest: async (upload, options) => {
      const sessions = await db();
      try {
        return await sessions.ingest(upload, options);
      } catch (err) {
        return refusedIngest(err);
      }
    },
    stale: async () => {
      const sessions = await db();
      return allStale((after) => sessions.staleSessions(after !== undefined ? { after } : {}));
    },
    async retract(agent, sessionId, secret) {
      const { instance, owner } = await open();
      if (!instance.config.capture.allow_retract) {
        throw new RetractRefused(
          "retract_disabled",
          "retraction is turned off (capture.allow_retract)",
        );
      }
      const { finishTombstone, getSession, tombstone } = await import("@seshi/pipeline");
      const metadata = await getSession(instance.store, owner, agent, sessionId);
      if (!metadata) return "absent";
      if (metadata.status === "redacted") {
        await finishTombstone({ store: instance.store, owner, agent, session_id: sessionId });
        return "gone";
      }
      if (metadata.retract_hash !== retractHash(secret)) {
        throw new RetractRefused(
          "bad_retract_secret",
          "the retraction secret is not the one this session was uploaded with",
        );
      }
      await tombstone({
        store: instance.store,
        owner,
        agent,
        session_id: sessionId,
        now: instance.now,
        reason: "retracted",
        writer: localWriter(owner),
      });
      return "retracted";
    },
  };
  return {
    sink,
    close: async () => {
      await bucket?.close();
    },
  };
}

export async function serverSink(account: Account): Promise<OpenedSink> {
  const { httpSink } = await import("@seshi/capture");
  const server = serverOf(account);
  if (server === undefined) {
    const sink: SessionSink = {
      target: "nowhere",
      ready: async () => {
        throw new SignInNeeded("not signed in: run seshi login --server <url>");
      },
      ingest: async () => {
        throw new SignInNeeded("not signed in: run seshi login --server <url>");
      },
      retract: async () => {
        throw new SignInNeeded("not signed in: run seshi login --server <url>");
      },
    };
    return { sink, close: async () => {} };
  }
  const sink = httpSink({
    target: server,
    userAgent: USER_AGENT,
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
  return { sink, close: async () => {} };
}

export async function openSink(ctx: CommandContext, account: Account): Promise<OpenedSink> {
  return isServerless(account.cli) ? serverlessSink(ctx, account) : serverSink(account);
}

interface CachedRules {
  server: string;
  etag: string;
  document: unknown;
}

function readCachedRules(file: string | undefined, server: string): CachedRules | undefined {
  if (!file) return undefined;
  try {
    const cached = JSON.parse(readFileSync(file, "utf8")) as Partial<CachedRules>;
    if (cached.server === server && typeof cached.etag === "string" && cached.document) {
      return cached as CachedRules;
    }
  } catch {}
  return undefined;
}

function withheldCallsIn(carried: Record<string, unknown> | undefined): WithheldCalls {
  const withheld: WithheldCalls = {};
  for (const [id, kind] of Object.entries(carried ?? {})) {
    if (kind === "sensitive-file" || kind === "secret-output") withheld[id] = kind;
  }
  return withheld;
}

export interface PreRedactorOptions {
  /** Where the last rules document is kept between runs (`CapturePaths.redactionRules`). */
  cacheFile?: string;
  log?: (line: string) => void;
}

export function preRedactor(account: Account, options: PreRedactorOptions = {}): PreRedactor {
  if (isServerless(account.cli)) return NO_PREREDACTION;
  const log = options.log ?? (() => {});
  let loading: Promise<{ rules: RuleSet; redact: typeof redactTranscript }> | undefined;

  async function load() {
    const { redactionRules, redactTranscript, RulePackError, ruleSetFromDocument } = await import(
      "@seshi/redact"
    );
    const { HttpSessionDB, ServerError } = await import("@seshi/client");
    const builtin = () => ({ rules: redactionRules(), redact: redactTranscript });
    const server = serverOf(account);
    if (server === undefined)
      throw new SignInNeeded("not signed in: run seshi login --server <url>");
    let credential: Awaited<ReturnType<typeof accountCredential>>;
    try {
      credential = await accountCredential(account, server, "upload");
    } catch (err) {
      if (err instanceof NotSignedIn) throw new SignInNeeded(err.message);
      throw err;
    }
    const db = new HttpSessionDB({
      server: credential.server,
      token: credential.token,
      userAgent: USER_AGENT,
      ...(credential.user ? { user: credential.user } : {}),
    });
    const cached = readCachedRules(options.cacheFile, credential.server);
    let document: unknown;
    try {
      const answer = await db.redactionRulesSince(cached?.etag);
      if (answer === null) document = cached?.document;
      else {
        document = answer.document;
        if (options.cacheFile && answer.etag) {
          const keep: CachedRules = { server: credential.server, etag: answer.etag, document };
          writePrivateFile(options.cacheFile, `${JSON.stringify(keep)}\n`);
        }
      }
    } catch (err) {
      if (err instanceof ServerError && err.status === 401) {
        throw new SignInNeeded(
          `${credential.server} refused the stored credential: ${err.message}`,
        );
      }
      if (err instanceof ServerError && err.status === 404) {
        log("the server serves no redaction rules; pre-redacting with the built-in pack");
        return builtin();
      }
      if (!cached) throw err;
      log(`could not fetch the redaction rules, using the ones fetched before: ${String(err)}`);
      document = cached.document;
    }
    try {
      const { rules, same } = ruleSetFromDocument(document);
      if (!same) log("this client's rule set differs from the server's; the server redacts again");
      return { rules, redact: redactTranscript };
    } catch (err) {
      if (!(err instanceof RulePackError)) throw err;
      log(
        `cannot use the server's redaction rules, pre-redacting with the built-in pack: ${err.message}`,
      );
      return builtin();
    }
  }

  return {
    async redact({ encoding, text, carried }) {
      loading ??= load().catch((err) => {
        loading = undefined;
        throw err;
      });
      const { rules, redact } = await loading;
      const out = redact(rules, text, encoding, withheldCallsIn(carried));
      return Object.keys(out.withheld).length > 0
        ? { text: out.text, carried: out.withheld }
        : { text: out.text };
    },
  };
}

export interface CaptureRuntime {
  host: CaptureHost;
  paths: ReturnType<typeof capturePaths>;
  account: Account;
  uploader: Uploader;
  close(): Promise<void>;
}

/** The uploader for this machine. The sink is opened on first need, so a pass with nothing to
 * send never reads a credential or builds an instance. */
export async function captureRuntime(
  ctx: CommandContext,
  options: Partial<Omit<UploaderOptions, "paths" | "host" | "agents" | "sink">> = {},
): Promise<CaptureRuntime> {
  const host = hostOf(ctx);
  const paths = capturePaths(host);
  const account = openAccount(ctx);
  let opened: OpenedSink | undefined;
  const uploader = new Uploader({
    paths,
    host,
    agents: await allCaptureAgents(),
    sink: async () => {
      opened ??= await openSink(ctx, account);
      return opened.sink;
    },
    preRedact: preRedactor(account, {
      cacheFile: paths.redactionRules,
      log: options.log ?? ((line) => appendLog(paths.log, `uploader: ${line}`)),
    }),
    git: gitIdentityIn(ctx.env),
    ...options,
  });
  return {
    host,
    paths,
    account,
    uploader,
    close: async () => {
      await opened?.close();
    },
  };
}
