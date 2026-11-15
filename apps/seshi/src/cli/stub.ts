/** A command that is part of seshi (F8.1) but owned by a later branch. It says so and exits
 * `notImplemented`, so scripts and agents can tell "not built yet" from a failure. The branch
 * that builds it replaces the command's own file; this helper goes once none use it. */

import type { CommandContext, CommandModule } from "../commands/index";
import { EXIT } from "./exit";
import { fail, takeJson } from "./output";

export function notImplemented(command: string, branch: string): CommandModule {
  return {
    async run(ctx: CommandContext) {
      const { json } = takeJson(ctx.argv);
      return fail(
        ctx,
        json,
        EXIT.notImplemented,
        "not_implemented",
        `${command}: not implemented yet in this build (branch ${branch})`,
      );
    },
  };
}
