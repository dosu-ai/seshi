import { ServerError } from "@seshi/client";
import { ConfigError } from "@seshi/config";
import { Forbidden, SessionRejected, StoreError, Unauthorized } from "@seshi/model";
import {
  IndexUnavailable,
  SearchQueryError,
  SearchUnavailable,
  SessionReadError,
} from "@seshi/search";
import { accessDeniedIn } from "@seshi/store";
import { NotSignedIn } from "../account/credential";
import { BadServerUrl } from "../account/logins";
import { SignInError } from "../account/oidc";
import { BadUsername } from "../account/user";
import type { CommandContext } from "../commands/index";
import { refusedMessage } from "../serverless/refusal";
import { EXIT, type ExitCode } from "./exit";
import { fail } from "./output";
import { Cancelled } from "./terminal";

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

export class ServeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServeConfigError";
  }
}

export function classify(
  err: unknown,
): { exit: ExitCode; code: string; message: string } | undefined {
  if (err instanceof Refused) return { exit: err.exit, code: err.code, message: err.message };
  const denied = accessDeniedIn(err);
  if (denied) {
    return { exit: EXIT.auth, code: "access_denied", message: refusedMessage(denied) };
  }
  if (err instanceof NotSignedIn)
    return { exit: EXIT.auth, code: "not_signed_in", message: err.message };
  if (err instanceof ConfigError) {
    return { exit: EXIT.config, code: "config", message: err.issues.join("\n") };
  }
  if (err instanceof ServeConfigError || (err instanceof Error && err.name === "InstanceError")) {
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
    if (err.status === 409 && err.code === "head_changed") {
      return { exit: EXIT.conflict, code: err.code, message: err.message };
    }
    if (err.status >= 500) {
      return {
        exit: EXIT.unavailable,
        code: err.code,
        message: `the server failed: ${err.message}`,
      };
    }
    return { exit: EXIT.failure, code: err.code, message: err.message };
  }
  if (err instanceof SessionReadError) {
    const exit =
      err.status === 400 ? EXIT.usage : err.status === 409 ? EXIT.conflict : EXIT.notFound;
    return { exit, code: err.code, message: err.message };
  }
  if (err instanceof SearchQueryError) {
    return { exit: EXIT.usage, code: err.code, message: err.message };
  }
  if (err instanceof SearchUnavailable || err instanceof IndexUnavailable) {
    return { exit: EXIT.unavailable, code: err.code, message: err.message };
  }
  if (err instanceof StoreError) {
    return { exit: EXIT.unavailable, code: "unavailable", message: err.message };
  }
  if (err instanceof SessionRejected) {
    return { exit: EXIT.failure, code: err.code, message: err.message };
  }
  if (err instanceof Error && typeof (err as NodeJS.ErrnoException).syscall === "string") {
    return { exit: EXIT.failure, code: "io", message: err.message };
  }
  return undefined;
}

export function failWith(ctx: CommandContext, json: boolean, err: unknown): ExitCode {
  const known = classify(err);
  if (!known) throw err;
  return fail(ctx, json, known.exit, known.code, known.message);
}
