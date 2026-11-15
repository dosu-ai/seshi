/** `seshi reprocess` (X4.9): rebuild sessions by asking their source again, since no raw is
 * stored (X6.3). For a polled source it rewinds the checkpoint, so the next run reads again
 * from `--since` (through the connector) or from the start, and the pipeline writes new heads
 * and change entries for what changed; resends of what did not are deduplicated (X4.7). It
 * works only while the source still has the data.
 *
 *   seshi reprocess --source <id> [--since <time>] [--dry-run] [--run] [--json]
 *                   [--config <file>] [--set path=value]…
 *
 * `--run` polls the source once right away instead of waiting for the worker. Uploads (source
 * `upload`) are refused: they are not polled, and the uploader resend X4.9 describes (from the
 * machines that hold the transcripts) is not built yet (14's "Still to check"). */

import { isDeepStrictEqual, parseArgs } from "node:util";
import { SourceError } from "@seshi/sources";
import { isPreconditionFailed } from "@seshi/store";
import { EXIT, type ExitCode } from "../cli/exit";
import { emit, fail, takeJson, usageError } from "../cli/output";
import type { CommandContext } from "./index";
import { openServer, SERVER_OPTIONS, serverFailure } from "./server-instance";

const USAGE =
  "usage: seshi reprocess --source <id> [--since <time>] [--dry-run] [--run] [--json] [--config <file>] [--set path=value]…";

export async function run(ctx: CommandContext): Promise<number> {
  const { json, rest } = takeJson(ctx.argv);
  let values: {
    config?: string;
    set?: string[];
    source?: string;
    since?: string;
    "dry-run"?: boolean;
    run?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        ...SERVER_OPTIONS,
        source: { type: "string" },
        since: { type: "string" },
        "dry-run": { type: "boolean" },
        run: { type: "boolean" },
      },
      strict: true,
    }));
  } catch (err) {
    return usageError(ctx, json, (err as Error).message, USAGE);
  }
  const id = values.source;
  if (!id) return usageError(ctx, json, "reprocess needs --source <id>", USAGE);
  let since: Date | undefined;
  if (values.since !== undefined) {
    since = new Date(values.since);
    if (Number.isNaN(since.getTime())) {
      return usageError(ctx, json, "--since must be a date or time", USAGE);
    }
    // Nothing after now can be read again; a mistyped year would otherwise pass silently.
    if (since.getTime() > Date.now()) {
      return usageError(ctx, json, `--since ${since.toISOString()} is in the future`, USAGE);
    }
  }
  const dryRun = values["dry-run"] === true;
  if (dryRun && values.run) return usageError(ctx, json, "--dry-run and --run conflict", USAGE);
  try {
    const { instance } = await openServer(ctx, values, {
      roles: [],
      probe: [],
      initialize: !dryRun,
    });
    try {
      const rewind = await instance.sources.rewind(id, { ...(since ? { since } : {}), dryRun });
      const report = values.run ? await instance.sources.run(id) : undefined;
      emit(ctx, json, { rewind, ...(report ? { run: report } : {}) }, () => {
        const target = since ? `to ${since.toISOString()}` : "to the start";
        const lines = [
          `${dryRun ? "would rewind" : "rewound"} source ${id} ${target}: checkpoint ${JSON.stringify(rewind.before)} → ${JSON.stringify(rewind.after)}`,
        ];
        if (since && rewind.before !== null && isDeepStrictEqual(rewind.before, rewind.after)) {
          // A rewind never moves a checkpoint forward past what the source has not read.
          lines.push(
            `checkpoint unchanged: the source has read nothing since ${since.toISOString()} yet`,
          );
        }
        if (report) {
          lines.push(
            `ran once: ${report.outcome}, ${report.submitted} envelope(s) submitted${report.error ? ` (${report.error})` : ""}`,
          );
        } else if (!dryRun) {
          lines.push(`the worker reads it again on its next run (or: seshi sync run ${id})`);
        }
        return lines;
      });
      if (report?.outcome === "discarded") return EXIT.conflict;
      if (report?.outcome === "error") return EXIT.failure;
      return EXIT.ok;
    } finally {
      await instance.close();
    }
  } catch (err) {
    if (err instanceof SourceError) {
      const code: ExitCode =
        err.code === "unknown_source"
          ? EXIT.notFound
          : err.code === "busy"
            ? EXIT.conflict
            : EXIT.failure;
      return fail(ctx, json, code, err.code, err.message);
    }
    if (isPreconditionFailed(err)) {
      return fail(
        ctx,
        json,
        EXIT.conflict,
        "conflict",
        `a run moved the checkpoint of source ${id} while it was rewound; run reprocess again`,
      );
    }
    const code = serverFailure(ctx, json, err);
    if (code === undefined) throw err;
    return code;
  }
}
