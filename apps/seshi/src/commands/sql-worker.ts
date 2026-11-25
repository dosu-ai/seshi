import { helpOrUsageError, takeJson } from "../cli/output";
import type { CommandContext } from "./index";

const USAGE = [
  "usage: seshi sql-worker",
  "",
  "A sql worker process, which the server and seshi sql start themselves: it answers requests on",
  "stdin, one JSON object a line, until stdin closes. Not for people to run.",
].join("\n");

/** `seshi sql-worker` (hidden): a `sql` worker process, started by the API's pool or a
 * serverless laptop's `seshi sql` (docs/seshi/session-tools.md, "The worker"). */
export async function run(ctx: CommandContext): Promise<number> {
  const { json, rest } = takeJson(ctx.argv);
  if (rest.length > 0) return helpOrUsageError(ctx, json, "sql-worker takes no arguments", USAGE);
  const { runSqlWorker } = await import("@seshi/search");
  await runSqlWorker();
  return 0;
}
