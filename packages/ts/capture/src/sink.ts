import { HttpSessionDB, ServerError } from "@seshi/client";
import type { Fetch, IngestOptions, StaleSession, StoreSessionResult, Upload } from "@seshi/model";
import type { CaptureRulesAnswer } from "./org-rules";

/** Uploads wait until the person does something: sign in (the status line's "sign in",
 * B1.6), or, in serverless mode, set a review key, update seshi, or get a key the bucket
 * accepts (F11). `word` is what the status line shows. */
export class SignInNeeded extends Error {
  constructor(
    message: string,
    readonly word: HoldWord = "sign in",
  ) {
    super(message);
    this.name = "SignInNeeded";
  }
}

export type HoldWord =
  | "sign in"
  | "needs review key"
  | "needs update"
  | "bucket refused"
  | "bad shared settings";

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

export type RetractOutcome = "retracted" | "gone" | "absent";

export interface SessionSink {
  /** Where uploads go, for status: the server's URL, or `local: <bucket>`. */
  readonly target: string;
  /** Store a session or a chunk of one. Throws what `SessionDB.ingest` throws, `SignInNeeded`
   * for a missing or refused credential, and `StoreError` or `ServerError` otherwise. A
   * `replace` carries the session's retraction secret (`options`), which the org key needs. */
  ingest(upload: Upload, options?: IngestOptions): Promise<StoreSessionResult>;
  /** Retract a session this machine uploaded, with its secret (F9.7): `retracted` when the
   * server removed it, `gone` when it was already removed, `absent` when the server holds no
   * such session for this credential (never stored, or stored under another owner). */
  retract(format: string, sessionId: string, secret: string): Promise<RetractOutcome>;
  /** The sessions of this credential's owner that an older normalizer built (X4.9), every
   * page of them: the uploader sends the ones it holds again whole with `rebuild`. A sink
   * without it is never asked. */
  stale?(): Promise<StaleSession[]>;
  /** The server's capture rules (its exclude list), `etag` from the copy held. A sink without
   * it has no server to ask (a bucket of one's own): its own config is the only list. */
  captureRules?(etag?: string): Promise<CaptureRulesAnswer>;
  /** Whether there is a credential to send with now, without a request: throws
   * `SignInNeeded` when there is none. Lets the status line drop "sign in" once the person
   * signed in, before anything is uploaded. */
  ready(): Promise<void>;
}

export interface UploadCredential {
  server: string;
  token: string;
  /** With the org key: the username to state (X5.7). */
  user?: string;
}

export interface HttpSinkOptions {
  target: string;
  /** Called before each request; throws `SignInNeeded` when there is no credential. */
  credential: () => Promise<UploadCredential>;
  fetch?: Fetch;
  userAgent?: string;
}

const STALE_PAGES = 100;

export async function allStale(
  page: (after: string | undefined) => Promise<{
    sessions: StaleSession[];
    cursor: string | undefined;
    truncated: boolean;
  }>,
): Promise<StaleSession[]> {
  const out: StaleSession[] = [];
  let after: string | undefined;
  for (let n = 0; n < STALE_PAGES; n++) {
    const next = await page(after);
    out.push(...next.sessions);
    if (!next.truncated || next.cursor === undefined || next.cursor === after) break;
    after = next.cursor;
  }
  return out;
}

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
    async ingest(upload, ingestOptions) {
      const db = await client();
      try {
        return await db.ingest(upload, ingestOptions);
      } catch (err) {
        return signIn(err);
      }
    },
    async captureRules(etag) {
      const db = await client();
      let answer: Awaited<ReturnType<HttpSessionDB["captureRulesSince"]>>;
      try {
        answer = await db.captureRulesSince(etag);
      } catch (err) {
        if (err instanceof ServerError && err.status === 404) return "none";
        return signIn(err);
      }
      if (answer === null) return "unchanged";
      const exclude = (answer.document as { exclude?: unknown } | null)?.exclude;
      if (!Array.isArray(exclude) || !exclude.every((e) => typeof e === "string")) {
        throw new Error(`${options.target} answered capture rules without an exclude list`);
      }
      return { exclude, ...(answer.etag ? { etag: answer.etag } : {}) };
    },
    async stale() {
      const db = await client();
      try {
        return await allStale((after) =>
          db.staleSessions({ ...(after !== undefined ? { after } : {}) }),
        );
      } catch (err) {
        return signIn(err);
      }
    },
    async retract(format, sessionId, secret) {
      const db = await client();
      try {
        const removed = await db.tombstone(format, sessionId, { retractSecret: secret });
        return removed === null ? "absent" : "retracted";
      } catch (err) {
        if (err instanceof ServerError) {
          if (err.status === 410) return "gone";
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
