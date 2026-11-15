/** The command registry: every `seshi` command, by name, with the module that runs it. A
 * command's module is imported only when that command runs (X3.3), so `seshi hook` and
 * `seshi statusline` never evaluate the server, protobuf or search code. Nothing here may import
 * a command module at the top level.
 *
 * Later branches add commands here, one entry each. */

import type { Integration } from "@seshi/kit";

/** What a command gets from the router. */
export interface CommandContext {
  /** The arguments after the command name. */
  argv: string[];
  env: Record<string, string | undefined>;
  stdout(line: string): void;
  stderr(line: string): void;
  /** The integrations this binary was built with (the static registry), loaded on demand. */
  integrations(): Promise<readonly Integration[]>;
}

export interface CommandModule {
  /** Runs the command. The exit code, or `undefined` for a command that keeps the process
   * running (a server) and exits on its own. */
  run(ctx: CommandContext): Promise<number | undefined>;
}

export interface CommandSpec {
  /** One line for `seshi --help`. */
  summary: string;
  load(): Promise<CommandModule>;
}

export const COMMANDS: Readonly<Record<string, CommandSpec>> = {
  config: {
    summary: "check the config, or show every value and where it came from",
    load: () => import("./config"),
  },
  serve: {
    summary: "run the server: the HTTP API over one bucket",
    load: () => import("./serve"),
  },
};
