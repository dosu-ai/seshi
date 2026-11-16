import type { CommandContext } from "../commands/index";
import { EXIT, type ExitCode } from "./exit";

export function takeJson(argv: readonly string[]): { json: boolean; rest: string[] } {
  const rest = argv.filter((a) => a !== "--json");
  return { json: rest.length !== argv.length, rest };
}

export function emit(
  ctx: CommandContext,
  json: boolean,
  value: unknown,
  human: () => readonly string[],
): void {
  if (json) ctx.stdout(JSON.stringify(value, null, 2));
  else for (const line of human()) ctx.stdout(line);
}

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

export function asksForHelp(argv: readonly string[]): boolean {
  const end = argv.indexOf("--");
  return (end === -1 ? argv : argv.slice(0, end)).some((a) => a === "--help" || a === "-h");
}

export function usageError(
  ctx: CommandContext,
  json: boolean,
  message: string,
  usage: string,
): ExitCode {
  if (asksForHelp(ctx.argv)) {
    ctx.stdout(json ? JSON.stringify({ usage }) : usage);
    return EXIT.ok;
  }
  if (json) return fail(ctx, true, EXIT.usage, "usage", `${message}\n${usage}`);
  ctx.stderr(`seshi: ${message}`);
  ctx.stderr(usage);
  return EXIT.usage;
}
