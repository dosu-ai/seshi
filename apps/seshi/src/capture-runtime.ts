/** Wiring the uploader (`@seshi/capture`) to this machine's seshi setup, for `seshi daemon` and
 * `seshi upload`: where sessions go (the server the CLI config names, with the credential
 * `seshi login` stored, or local mode's Instance), and the agents this binary captures.
 * `@seshi/capture` may not import the account code or the instance (X3.2), so they are handed
 * in from here.
 *
 * Pre-redaction (F2.4): `preRedactor` is the seam. Branch 07 provides `redactTranscript` and
 * the rules route; once both are in the stack, it fetches the org's rules once per uploader run
 * and redacts each piece before it is sent (see the 14 build note). */

import {
  capturePaths,
  NO_PREREDACTION,
  type PreRedactor,
  RetractRefused,
  retractHash,
  type SessionSink,
  SignInNeeded,
  Uploader,
  type UploaderOptions,
} from "@seshi/capture";
import type { CaptureHost } from "@seshi/kit";
import { localWriter } from "@seshi/model";
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
    ingest: (upload) => db.ingest(upload),
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

/** The pre-redaction the uploader applies (F2.4); none until 07's rule packs are wired. */
export function preRedactor(_account: Account): PreRedactor {
  return NO_PREREDACTION;
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
    preRedact: preRedactor(account),
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
