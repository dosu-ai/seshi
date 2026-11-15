/** What the write path refuses, as one vocabulary whichever backend raised it: the pipeline
 * over a store throws these directly, and the HTTP backend turns the server's responses back
 * into them, so a caller's `catch` reads the same either way. The server does the reverse:
 * `SessionRejected` is a 422 with its `code`, `OffsetMismatch` a 409 with `expected`,
 * `SessionConflict` a 409 `conflict`, `Forbidden` a 403. */

/** A transcript the pipeline refuses: nothing in it, not readable by the adapter, a chunk that
 * is not whole lines, over a cap, or a session that was redacted. Final for that upload:
 * resending the same bytes cannot succeed. `code` is what the server reports. */
export class SessionRejected extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SessionRejected";
  }
}

/** The store's own refusals, a subset of `SessionRejected` with a closed set of codes. */
export class IngestRejected extends SessionRejected {
  constructor(
    override readonly code: "too_large" | "invalid" | "redacted",
    message: string,
  ) {
    super(code, message);
    this.name = "IngestRejected";
  }
}

/** A chunk that does not start where the session's log ends: nothing is stored. The client
 * resumes from `expected` (0 when the session has no chunk state: it sends the whole log). */
export class OffsetMismatch extends Error {
  readonly code = "offset_mismatch";
  constructor(
    readonly offset: number,
    readonly expected: number,
  ) {
    super(`chunk starts at byte ${offset}; the session's log ends at ${expected}`);
    this.name = "OffsetMismatch";
  }
}

/** A whole upload that does not extend the stored session (X4.6): its records do not start
 * with what the session already holds. Nothing is stored. The session's original writer, or an
 * admin, can send it again with `replace` to rewrite the session. The server answers 409
 * `conflict`. */
export class SessionConflict extends Error {
  readonly code = "conflict";
  constructor(message: string) {
    super(message);
    this.name = "SessionConflict";
  }
}

/** The caller may not do this to the session: replace one another writer wrote (X4.6), or
 * write for an owner its credential does not cover. Nothing is stored. The server answers 403
 * `forbidden`. */
export class Forbidden extends Error {
  readonly code = "forbidden";
  constructor(message: string) {
    super(message);
    this.name = "Forbidden";
  }
}

/** The store, or the server in front of it, failed or could not be reached: a fault to retry,
 * not a refusal. Raised by every store driver and by the HTTP client. */
export class StoreError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "StoreError";
  }
}
