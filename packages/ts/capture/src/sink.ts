/** Where the uploader sends sessions: a seshi server over HTTP (`httpSink`), or, in local mode,
 * an Instance `apps/seshi` builds in-process (it implements `SessionSink` itself, since this
 * package may not import the instance, X3.2). The credential comes from `apps/seshi` too: it
 * calls the account code (`seshi login`'s store) and hands the result in, so a renewed device
 * token is picked up on the next call. */

import { HttpSessionDB, ServerError } from "@seshi/client";
import type { Fetch, StoreSessionResult, Upload } from "@seshi/model";

/** There is no credential to upload with, or the server refused it: the person must sign in
 * (the status line's "sign in", B1.6). */
export class SignInNeeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignInNeeded";
  }
}

/** The server would not retract (F9.7): retraction is turned off there (`retract_disabled`), or
 * the secret is not the one the session was uploaded with (`bad_retract_secret`). */
export class RetractRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RetractRefused";
  }
}

export interface SessionSink {
  /** Where uploads go, for status: the server's URL, or `local: <bucket>`. */
  readonly target: string;
  /** Store a session or a chunk of one. Throws what `SessionDB.ingest` throws, `SignInNeeded`
   * for a missing or refused credential, and `StoreError` or `ServerError` otherwise. */
  ingest(upload: Upload): Promise<StoreSessionResult>;
  /** Retract a session this machine uploaded, with its secret (F9.7): `retracted` when the
   * server removed it, `absent` when it holds nothing of it (never stored, or already gone). */
  retract(agent: string, sessionId: string, secret: string): Promise<"retracted" | "absent">;
  /** Whether there is a credential to send with now, without a request: throws
   * `SignInNeeded` when there is none. Lets the status line drop "sign in" once the person
   * signed in, before anything is uploaded. */
  ready(): Promise<void>;
}

/** What the uploader sends with over HTTP: what `credentialFor(…, "upload")` gives. */
export interface UploadCredential {
  server: string;
  token: string;
  /** With the org key: the username to state (X5.7). */
  user?: string;
}

export interface HttpSinkOptions {
  /** The server, for status before any credential is read. */
  target: string;
  /** Called before each request; throws `SignInNeeded` when there is no credential. */
  credential: () => Promise<UploadCredential>;
  fetch?: Fetch;
  userAgent?: string;
}

/** A sink over the HTTP API (`POST /v1/sessions`, `DELETE /v1/sessions/…` with the secret). */
export function httpSink(options: HttpSinkOptions): SessionSink {
  const client = async () => {
    const credential = await options.credential();
    return new HttpSessionDB({
      server: credential.server,
      token: credential.token,
      ...(credential.user ? { user: credential.user } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.userAgent ? { userAgent: options.userAgent } : {}),
    });
  };
  const signIn = (err: unknown): never => {
    if (err instanceof ServerError && err.status === 401) {
      throw new SignInNeeded(`${options.target} refused the stored credential: ${err.message}`);
    }
    throw err;
  };
  return {
    target: options.target,
    async ready() {
      await options.credential();
    },
    async ingest(upload) {
      const db = await client();
      try {
        return await db.ingest(upload);
      } catch (err) {
        return signIn(err);
      }
    },
    async retract(agent, sessionId, secret) {
      const db = await client();
      try {
        const removed = await db.tombstone(agent, sessionId, { retractSecret: secret });
        return removed === null ? "absent" : "retracted";
      } catch (err) {
        if (err instanceof ServerError) {
          if (err.status === 410) return "absent";
          if (
            err.status === 403 &&
            (err.code === "retract_disabled" || err.code === "bad_retract_secret")
          ) {
            throw new RetractRefused(err.code, err.message);
          }
        }
        return signIn(err);
      }
    },
  };
}
