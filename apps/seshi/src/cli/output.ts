/** Output conventions every command follows (F8.1): readable lines by default; with `--json`,
 * exactly one JSON document on stdout, and errors as `{"error": {"code", "message"}}` on
 * stderr. Imported by `seshi hook`, so this file imports nothing heavy. */

import type { CommandContext } from "../commands/index";
import { EXIT, type ExitCode } from "./exit";

/** Whether `--json` is among `argv`, and the rest without it. */
export function takeJson(argv: readonly string[]): { json: boolean; rest: string[] } {
  const rest = argv.filter((a) => a !== "--json");
  return { json: rest.length !== argv.length, rest };
}

/** Print `value`: as JSON with `json`, else the lines `human` gives. */
export function emit(
  ctx: CommandContext,
  json: boolean,
  value: unknown,
  human: () => readonly string[],
): void {
  if (json) ctx.stdout(JSON.stringify(value, null, 2));
  else for (const line of human()) ctx.stdout(line);
}

/** Report an error and return its exit code: `seshi: <message>` on stderr, or the JSON error
 * object with `json`. */
export function fail(
  ctx: CommandContext,
  json: boolean,
  code: ExitCode,
  errorCode: string,
  message: string,
): ExitCode {
  if (json) ctx.stderr(JSON.stringify({ error: { code: errorCode, message } }));
  else ctx.stderr(`seshi: ${message}`);
  return code;
}

/** A usage error: the message and the usage line, exit `usage`. */
export function usageError(
  ctx: CommandContext,
  json: boolean,
  message: string,
  usage: string,
): ExitCode {
  if (json) return fail(ctx, true, EXIT.usage, "usage", `${message}\n${usage}`);
  ctx.stderr(`seshi: ${message}`);
  ctx.stderr(usage);
  return EXIT.usage;
}
