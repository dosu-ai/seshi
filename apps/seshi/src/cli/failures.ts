/** The errors the client-side commands (login, sessions, tokens, remote status) meet, as the
 * stable exit codes (F8.1) and one message each that says what to do. */

import { ServerError } from "@seshi/client";
import { ConfigError } from "@seshi/config";
import { Forbidden, SessionRejected, StoreError, Unauthorized } from "@seshi/model";
import { NotSignedIn } from "../account/credential";
import { BadServerUrl } from "../account/logins";
import { SignInError } from "../account/oidc";
import { BadUsername } from "../account/user";
import type { CommandContext } from "../commands/index";
import { EXIT, type ExitCode } from "./exit";
import { fail } from "./output";
import { Cancelled } from "./terminal";

/** A command line that makes sense but asks for something this setup cannot do. */
export class Refused extends Error {
  constructor(
    readonly exit: ExitCode,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "Refused";
  }
}

/** The exit code, error code and message for `err`; undefined for an error no command
 * expects (a bug: the caller rethrows it). */
export function classify(
  err: unknown,
): { exit: ExitCode; code: string; message: string } | undefined {
  if (err instanceof Refused) return { exit: err.exit, code: err.code, message: err.message };
  if (err instanceof NotSignedIn)
    return { exit: EXIT.auth, code: "not_signed_in", message: err.message };
  if (err instanceof ConfigError) {
    return { exit: EXIT.config, code: "config", message: err.issues.join("\n") };
  }
  // Local mode's instance (by name: importing @seshi/instance here would load the server for
  // every client command).
  if (err instanceof Error && (err.name === "InstanceError" || err.name === "ServeConfigError")) {
    return { exit: EXIT.config, code: "config", message: err.message };
  }
  if (err instanceof BadServerUrl) return { exit: EXIT.usage, code: "usage", message: err.message };
  if (err instanceof BadUsername)
    return { exit: EXIT.config, code: "config", message: err.message };
  if (err instanceof Cancelled)
    return { exit: EXIT.failure, code: "cancelled", message: "cancelled" };
  if (err instanceof SignInError) {
    const exit = err.code === "idp_unreachable" ? EXIT.unavailable : EXIT.auth;
    return { exit, code: err.code, message: err.message };
  }
  if (err instanceof Forbidden) {
    return { exit: EXIT.auth, code: "forbidden", message: `not allowed: ${err.message}` };
  }
  if (err instanceof Unauthorized) {
    return { exit: EXIT.auth, code: "unauthorized", message: err.message };
  }
  if (err instanceof ServerError) {
    if (err.status === 401) {
      return {
        exit: EXIT.auth,
        code: "unauthorized",
        message: `the server refused the stored credential (expired or revoked): run seshi login`,
      };
    }
    if (err.status === 403) {
      return { exit: EXIT.auth, code: err.code, message: `not allowed: ${err.message}` };
    }
    if (err.status === 404 || err.status === 410) {
      return { exit: EXIT.notFound, code: err.code, message: err.message };
    }
    if (err.status === 400) return { exit: EXIT.usage, code: err.code, message: err.message };
    if (err.status >= 500) {
      return {
        exit: EXIT.unavailable,
        code: err.code,
        message: `the server failed: ${err.message}`,
      };
    }
    return { exit: EXIT.failure, code: err.code, message: err.message };
  }
  if (err instanceof StoreError) {
    return { exit: EXIT.unavailable, code: "unavailable", message: err.message };
  }
  if (err instanceof SessionRejected) {
    return { exit: EXIT.failure, code: err.code, message: err.message };
  }
  return undefined;
}

/** Report `err` and return its exit code; rethrows an error no command expects. */
export function failWith(ctx: CommandContext, json: boolean, err: unknown): ExitCode {
  const known = classify(err);
  if (!known) throw err;
  return fail(ctx, json, known.exit, known.code, known.message);
}
