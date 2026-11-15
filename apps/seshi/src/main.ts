#!/usr/bin/env bun
/** `seshi`: the one binary (X2.2). The router reads the command name and imports that command's
 * module only then (X3.3); everything else stays unevaluated.
 *
 *   seshi serve          run the server
 *   seshi --version      print the version
 *   seshi --help         list the commands
 *
 * Exit codes are stable (F8.1, `cli/exit.ts`): 2 for a command line it cannot read. */

import { VERSION } from "@seshi/model";
import { COMMANDS, type CommandContext, type CommandSpec } from "./commands/index";

export interface MainOptions {
  env?: Record<string, string | undefined>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** The command registry; the built-in one by default. */
  commands?: Readonly<Record<string, CommandSpec>>;
  integrations?: CommandContext["integrations"];
  stdin?: CommandContext["stdin"];
  /** Whether output and input are terminals: this process's own when `stdout` is not given,
   * else neither. */
  tty?: CommandContext["tty"];
  terminal?: CommandContext["terminal"];
  secrets?: CommandContext["secrets"];
}

/** `argv` without `--no-color` (before a `--`), and whether it was there (B1.4). */
export function takeNoColor(argv: readonly string[]): { noColor: boolean; rest: string[] } {
  const end = argv.indexOf("--");
  const head = end === -1 ? argv : argv.slice(0, end);
  const tail = end === -1 ? [] : argv.slice(end);
  const kept = head.filter((a) => a !== "--no-color");
  return { noColor: kept.length !== head.length, rest: [...kept, ...tail] };
}

function usage(commands: Readonly<Record<string, CommandSpec>>): string {
  const names = Object.keys(commands).sort();
  const width = Math.max(...names.map((name) => name.length), "--version".length);
  const lines = names.map((name) => `  ${name.padEnd(width)}  ${commands[name].summary}`);
  return [
    "usage: seshi <command> [options]",
    "",
    "commands:",
    ...lines,
    "",
    `  ${"--version".padEnd(width)}  print the version`,
    `  ${"--help".padEnd(width)}  show this help`,
    "",
    "every command takes --json (one JSON document on stdout) and --no-color (also NO_COLOR)",
  ].join("\n");
}

/** Runs `argv` (the arguments after the program name). The exit code, or `undefined` when the
 * command keeps the process running. */
export async function main(argv: string[], options: MainOptions = {}): Promise<number | undefined> {
  const commands = options.commands ?? COMMANDS;
  const stdout = options.stdout ?? ((line: string) => console.log(line));
  const stderr = options.stderr ?? ((line: string) => console.error(line));
  const [name, ...rest] = argv;

  if (name === "--version" || name === "-v" || name === "version") {
    stdout(`seshi ${VERSION}`);
    return 0;
  }
  if (name === undefined || name === "--help" || name === "-h" || name === "help") {
    (name === undefined ? stderr : stdout)(usage(commands));
    return name === undefined ? 2 : 0;
  }
  const spec = Object.hasOwn(commands, name) ? commands[name] : undefined;
  if (!spec) {
    stderr(`seshi: unknown command '${name}'\n\n${usage(commands)}`);
    return 2;
  }
  const command = await spec.load();
  const { noColor, rest: args } = takeNoColor(rest);
  const tty =
    options.tty ??
    (options.stdout === undefined
      ? { stdout: process.stdout.isTTY === true, stdin: process.stdin.isTTY === true }
      : { stdout: false, stdin: false });
  const terminal =
    options.terminal ??
    (options.stdout === undefined && tty.stdout && tty.stdin
      ? () => import("./cli/terminal").then((m) => m.processTerminal())
      : undefined);
  return command.run({
    argv: args,
    env: options.env ?? process.env,
    stdout,
    stderr,
    integrations:
      options.integrations ?? (() => import("./integrations").then((m) => m.INTEGRATIONS)),
    stdin: options.stdin ?? (() => Bun.stdin.text()),
    tty,
    ...(noColor ? { noColor } : {}),
    ...(terminal ? { terminal } : {}),
    ...(options.secrets ? { secrets: options.secrets } : {}),
  });
}

if (import.meta.main) {
  // No top-level await: the compiled binary is bytecode, which needs a CommonJS-shaped entry.
  void main(process.argv.slice(2)).then((code) => {
    if (code !== undefined) process.exit(code);
  });
}
