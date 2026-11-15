/** Wiring the uploader (`@seshi/capture`) to this machine's seshi setup, for `seshi daemon` and
 * `seshi upload`: where sessions go (the server the CLI config names, with the credential
 * `seshi login` stored, or local mode's Instance), and the agents this binary captures.
 * `@seshi/capture` may not import the account code or the instance (X3.2), so they are handed
 * in from here.
 *
 * Pre-redaction (F2.4): `preRedactor` fetches the org's rules once per uploader run and
 * redacts each piece with `redactTranscript` before it is sent. */

import { readFileSync } from "node:fs";
import {
  appendLog,
  capturePaths,
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
import { localWriter } from "@seshi/model";
import type { RuleSet, redactTranscript, WithheldCalls } from "@seshi/redact";
import { type Account, accountCredential, openAccount, serverOf } from "./account/account";
import { NotSignedIn } from "./account/credential";
import { allCaptureAgents } from "./capture-agents";
import { hostOf } from "./commands/capture-host";
import type { CommandContext } from "./commands/index";

/** A sink and what to call when done with it. */
export interface OpenedSink {
  sink: SessionSink;
  close(): Promise<void>;
}

/** Uploads to local mode's bucket through an Instance (X3.5): the bucket's owner writes, and a
 * retraction checks the secret against the stored hash before the same tombstone the server
 * writes (F9.7). */
export async function localSink(ctx: CommandContext, account: Account): Promise<OpenedSink> {
  const { connect, localOwner } = await import("./connect");
  const connection = await connect({
    cli: account.cli,
    env: account.env,
    home: account.home,
    integrations: await ctx.integrations(),
  });
  const instance = connection.instance;
  if (!instance) throw new Error("local mode built no instance");
  const owner = localOwner(account.cli, account.env);
  const db = instance.localSessions(owner);
  const sink: SessionSink = {
    target: `local: ${instance.storage.url}`,
    async ready() {},
    ingest: (upload, options) => db.ingest(upload, options),
    async retract(agent, sessionId, secret) {
      if (!instance.config.capture.allow_retract) {
        throw new RetractRefused(
          "retract_disabled",
          "retraction is turned off (capture.allow_retract)",
        );
      }
      const { getSession, tombstone } = await import("@seshi/pipeline");
      const metadata = await getSession(instance.store, owner, agent, sessionId);
      if (!metadata) return "absent";
      if (metadata.status === "redacted") return "gone";
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
  return { sink, close: () => connection.close() };
}

/** Uploads to the server the CLI config names, with the stored upload credential: the device
 * token, or the org key and the username to state (F8.2, X5.7). Read again before every
 * request, so a sign-in or a renewed token is picked up without a restart. */
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

/** The sink the CLI config names: local mode, else its server. */
export async function openSink(ctx: CommandContext, account: Account): Promise<OpenedSink> {
  return account.cli.local ? localSink(ctx, account) : serverSink(account);
}

/** The org's redaction rules as last fetched from `server`, kept for If-None-Match. */
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

/** The withheld calls a piece carries over, as `redactTranscript` takes them: the state file
 * is this machine's own, but only what the redactor itself writes is passed back. */
function withheldOf(carried: Record<string, unknown> | undefined): WithheldCalls {
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

/** The pre-redaction the uploader applies (F2.4): each piece goes through the org's rule packs
 * and the built-in pack (`redactTranscript`) before it leaves the machine, so a secret the
 * rules know is never sent. The server redacts everything again either way.
 *
 * The rules are fetched (`GET /v1/redaction/rules`) once per uploader run, on the first piece,
 * with the upload credential; the document is kept in the capture folder, so the next run's
 * request names its ETag and an unchanged rule set answers 304. A server from before the rules
 * route (404), or a document this client cannot use, leaves the built-in pack. When the server
 * cannot be reached the rules last fetched are used; with none, the piece waits, as an upload
 * would. 401 is "sign in". `@seshi/redact` and the client are imported here, on first use, and
 * never on a hook's path.
 *
 * Local mode sends nothing anywhere: the Instance in this process redacts before it writes. */
export function preRedactor(account: Account, options: PreRedactorOptions = {}): PreRedactor {
  if (account.cli.local) return NO_PREREDACTION;
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
      // Once per run; a failed fetch is tried again with the next piece.
      loading ??= load().catch((err) => {
        loading = undefined;
        throw err;
      });
      const { rules, redact } = await loading;
      const out = redact(rules, text, encoding, withheldOf(carried));
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
  /** Let go of the sink (local mode's instance). */
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
