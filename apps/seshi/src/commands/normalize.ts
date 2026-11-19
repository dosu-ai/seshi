import { parseArgs } from "node:util";
import { NormalizeError } from "@seshi/formats";
import { normalizeTranscript } from "@seshi/pipeline";
import { EXIT } from "../cli/exit";
import { fail, helpOrUsageError, takeJson } from "../cli/output";
import { buildFormats } from "../integrations";
import type { CommandContext } from "./index";

const USAGE = "usage: seshi normalize [--agent <format>] [--json] [<file> | -]";

export async function run(ctx: CommandContext): Promise<number> {
  const { json, rest } = takeJson(ctx.argv);
  let values: { agent?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: rest,
      options: { agent: { type: "string" } },
      strict: true,
      allowPositionals: true,
    }));
  } catch (err) {
    return helpOrUsageError(ctx, json, (err as Error).message, USAGE);
  }
  if (positionals.length > 1) return helpOrUsageError(ctx, json, "one file at a time", USAGE);
  const path = positionals[0] ?? "-";

  let transcript: string;
  if (path === "-") {
    if (!ctx.stdin)
      return helpOrUsageError(ctx, json, "no standard input here; name a file", USAGE);
    transcript = await ctx.stdin();
  } else {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      return fail(ctx, json, EXIT.notFound, "not_found", `no such file: ${path}`);
    }
    transcript = await file.text();
  }

  const formats = buildFormats(await ctx.integrations());
  const agent = values.agent ?? formats.detect(transcript);
  if (!agent) {
    return fail(
      ctx,
      json,
      EXIT.failure,
      "unknown_format",
      `cannot tell which agent wrote this; name it with --agent (one of ${formats.sources.join(", ")})`,
    );
  }
  if (!formats.has(agent)) {
    return helpOrUsageError(
      ctx,
      json,
      `no normalizer for '${agent}' (one of ${formats.sources.join(", ")})`,
      USAGE,
    );
  }
  let records: unknown[];
  let calls: unknown[] | undefined;
  try {
    const outcome = normalizeTranscript(formats, { source: agent, transcript });
    if (outcome.empty) ctx.stderr("seshi: no conversation in this transcript");
    records = outcome.records;
    calls = outcome.empty ? undefined : outcome.llm_calls;
  } catch (err) {
    if (err instanceof NormalizeError) return fail(ctx, json, EXIT.failure, err.code, err.message);
    throw err;
  }
  if (json) {
    ctx.stdout(JSON.stringify({ agent, records, ...(calls ? { llm_calls: calls } : {}) }, null, 2));
  } else for (const record of records) ctx.stdout(JSON.stringify(record));
  return EXIT.ok;
}
