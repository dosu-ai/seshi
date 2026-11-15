/** `seshi redact` (F2): try redaction rules, and apply new ones to stored sessions.
 *
 *   seshi redact test [<file> | -] [--pack <file>]… [--config <file>] [--set path=value]…
 *                     [--agent <format> | --text] [--field text|tool_input|tool_output]
 *                     [--print] [--json]
 *   seshi redact backfill (--since <30d | time> | --all) [--owner <id>]… [--dry-run]
 *                     [--limit N] [--as <owner>] [--json] [--config <file>] [--set path=value]…
 *   seshi redact sweep [--owner <id>]… [--dry-run] [--json] [--config <file>] [--set path=value]…
 *
 * `test` builds the rule set from the built-in pack, the packs `--pack` names and, with
 * `--config`, the server's `[redaction] packs`, checks every rule against its own test strings,
 * and, given a file (or `-` for standard input), shows how often each rule fires on it and
 * where: by record for a transcript (the format is detected, or named with `--agent`; it is
 * normalized and redacted as the server would), by line for plain text (`--text`, or anything
 * no format reads; each line is a string in `--field`, `text` by default). It never shows what
 * matched; `--print` prints the redacted records or text. Nothing is sent or stored. Exit 0, 1
 * when a test string fails, 3 when a pack cannot be used, 4 for a file that is not there.
 *
 * `backfill` runs where the server's config and bucket keys are. It applies the server's
 * current rule set to the stored sessions written since `--since` (or every session with
 * `--all`) that an earlier rule set redacted, writes one new trace for each session the rules
 * change, deletes its old traces, and appends a change entry so readers pick it up (F2.5). It
 * cannot be undone; `--dry-run` says what it would do and writes nothing. Restart the server
 * with the new packs before running it, or the server keeps writing with the old rules. Each
 * session it looks at is then swept, as `sweep` does. Exit 0, 8 when a session changed while it
 * ran (run it again) or could not be rewritten.
 *
 * `sweep` (F2.5) deletes the trace objects no session's metadata names that are over an hour
 * old: what a backfill, replace or publish that stopped partway left behind. The worker does it
 * daily; this is that job as a one-shot (X7.1), for a deployment with no worker, or to finish
 * at once. Only trace objects are deleted. Exit 0, 1 when a session could not be swept. */

import { type ParseArgsConfig, parseArgs } from "node:util";
import { loadServerConfig, parseDuration } from "@seshi/config";
import { NormalizeError } from "@seshi/formats";
import type { NormalizedRecord, Writer } from "@seshi/model";
import { type BackfillSession, backfillRedaction } from "@seshi/pipeline";
import {
  APPLIES_TO,
  type AppliesTo,
  type Counts,
  compileRuleSet,
  loadPacks,
  RulePackError,
  type RuleSet,
  type RuleTestResult,
  ruleRedactor,
  runRuleTests,
  type WithheldCalls,
} from "@seshi/redact";
import { isOwner, type SweptObject, sweepTraces } from "@seshi/store";
import { EXIT, type ExitCode } from "../cli/exit";
import { emit, fail, takeJson, usageError } from "../cli/output";
import { printable, Style, styleFor } from "../cli/style";
import { buildFormats } from "../integrations";
import type { CommandContext } from "./index";
import { configFlags } from "./serve-settings";
import { openServer, SERVER_OPTIONS, serverFailure } from "./server-instance";

const USAGE = `usage: seshi redact test [<file> | -] [--pack <file>]… [--config <file>] [--set path=value]…
                         [--agent <format> | --text] [--field text|tool_input|tool_output] [--print] [--json]
       seshi redact backfill (--since <30d | time> | --all) [--owner <id>]… [--dry-run] [--limit N]
                         [--as <owner>] [--json] [--config <file>] [--set path=value]…
       seshi redact sweep [--owner <id>]… [--dry-run] [--json] [--config <file>] [--set path=value]…`;

/** The writer source id of a backfill's change entries: what rewrote the session. */
export const BACKFILL_SOURCE_ID = "redaction";

class UsageError extends Error {}

export async function run(ctx: CommandContext): Promise<number> {
  const { json, rest } = takeJson(ctx.argv);
  const [sub, ...args] = rest;
  try {
    if (sub === "test") return await test(ctx, json, args);
    if (sub === "backfill") return await backfill(ctx, json, args);
    if (sub === "sweep") return await sweep(ctx, json, args);
  } catch (err) {
    if (err instanceof UsageError) return usageError(ctx, json, err.message, USAGE);
    throw err;
  }
  return usageError(
    ctx,
    json,
    sub === undefined ? "redact needs test, backfill or sweep" : `unknown redact command '${sub}'`,
    USAGE,
  );
}

function parse<T>(args: string[], options: NonNullable<ParseArgsConfig["options"]>) {
  try {
    return parseArgs({ args, options, strict: true, allowPositionals: true }) as unknown as {
      values: T;
      positionals: string[];
    };
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

// --- test ---------------------------------------------------------------------------

interface TestValues {
  pack?: string[];
  config?: string;
  set?: string[];
  agent?: string;
  text?: boolean;
  field?: string;
  print?: boolean;
}

/** Where a rule fired: record numbers (1-based) or line numbers. */
interface RuleHits {
  count: number;
  at: number[];
}

/** The input to `test`, redacted. */
interface ReadInput {
  kind: "records" | "text";
  agent?: string;
  items: number;
  hits: Record<string, RuleHits>;
  output: string[];
}

async function test(ctx: CommandContext, json: boolean, args: string[]): Promise<number> {
  const { values, positionals } = parse<TestValues>(args, {
    ...SERVER_OPTIONS,
    pack: { type: "string", multiple: true },
    agent: { type: "string" },
    text: { type: "boolean" },
    field: { type: "string" },
    print: { type: "boolean" },
  });
  if (positionals.length > 1) throw new UsageError("one file at a time");
  if (values.agent !== undefined && values.text)
    throw new UsageError("--agent and --text conflict");
  const field = (values.field ?? "text") as AppliesTo;
  if (!APPLIES_TO.includes(field)) {
    throw new UsageError(`--field must be one of ${APPLIES_TO.join(", ")}`);
  }

  // The rule set: the server's packs (with --config), then the ones named here.
  const paths: string[] = [];
  if (values.config !== undefined || values.set !== undefined) {
    let loaded: ReturnType<typeof loadServerConfig>;
    try {
      loaded = loadServerConfig({
        configFlag: values.config,
        env: ctx.env,
        flags: configFlags(values),
      });
    } catch (err) {
      const code = serverFailure(ctx, json, err);
      if (code === undefined) throw err;
      return code;
    }
    paths.push(...loaded.config.redaction.packs);
  }
  paths.push(...(values.pack ?? []));
  let rules: RuleSet;
  try {
    const files: { path: string; text: string }[] = [];
    for (const path of paths) {
      const file = Bun.file(path);
      if (!(await file.exists())) {
        return fail(ctx, json, EXIT.notFound, "not_found", `no such pack: ${path}`);
      }
      files.push({ path, text: await file.text() });
    }
    const loaded = loadPacks(files);
    rules = compileRuleSet({
      packs: loaded.map((l) => l.pack),
      sources: Object.fromEntries(loaded.map((l) => [l.pack.id, l.source])),
    });
  } catch (err) {
    if (err instanceof RulePackError) {
      if (json) return fail(ctx, true, EXIT.config, "bad_pack", err.message);
      for (const p of err.problems) ctx.stderr(`seshi: ${p.where}: ${p.message}`);
      return EXIT.config;
    }
    throw err;
  }
  const tests = runRuleTests(rules);
  const failed = tests.filter((t) => !t.ok);

  const path = positionals[0];
  let input: ReadInput | undefined;
  if (path !== undefined) {
    const read = await readInput(ctx, json, path, values, rules, field);
    if (typeof read === "number") return read;
    input = read;
  }

  const document = {
    rule_set: rules.hash,
    builtin: rules.builtinVersion,
    packs: rules.packs.map((p) => p.id),
    rules: rules.catalogue,
    tests: { passed: tests.length - failed.length, failed },
    ...(input
      ? {
          input: {
            kind: input.kind,
            ...(input.agent ? { agent: input.agent } : {}),
            items: input.items,
          },
          matches: input.hits,
          ...(values.print ? { output: input.output } : {}),
        }
      : {}),
  };
  if (json) {
    ctx.stdout(JSON.stringify(document, null, 2));
  } else {
    if (values.print && input) {
      for (const line of input.output) ctx.stdout(line);
    }
    const out = (line: string) => (values.print ? ctx.stderr(line) : ctx.stdout(line));
    // Colour only where the report goes to a terminal's standard output (B1.4); with --print
    // it goes to stderr, which may not be one.
    const style = values.print ? Style.plain() : await styleFor(ctx, { json });
    for (const line of testLines(rules, tests, failed, input, style)) out(line);
  }
  return failed.length > 0 ? EXIT.failure : EXIT.ok;
}

function testLines(
  rules: RuleSet,
  tests: RuleTestResult[],
  failed: RuleTestResult[],
  input: ReadInput | undefined,
  style: Style = Style.plain(),
): string[] {
  const enabled = rules.catalogue.filter((r) => r.enabled).length;
  const off = rules.catalogue.filter((r) => !r.enabled).map((r) => r.id);
  const lines = [
    `rule set ${rules.hash.slice(0, 12)}: built-in ${rules.builtinVersion}${
      rules.packs.length > 0 ? `, packs ${rules.packs.map((p) => p.id).join(", ")}` : ""
    }; ${enabled} rules on${off.length > 0 ? `, off: ${off.join(", ")}` : ""}`,
  ];
  if (input) {
    const unit = input.kind === "records" ? "record" : "line";
    lines.push(
      `${input.kind === "records" ? `${input.agent} transcript` : "text"}: ${input.items} ${unit}(s)`,
    );
    const ids = Object.keys(input.hits);
    if (ids.length === 0) {
      lines.push(`  ${style.muted("no rule matched")}`);
    } else {
      const width = Math.max(...ids.map((id) => id.length));
      for (const id of ids.sort()) {
        const hits = input.hits[id] as RuleHits;
        const at = hits.at.slice(0, 12).join(", ") + (hits.at.length > 12 ? ", …" : "");
        lines.push(`  ${id.padEnd(width)}  ${String(hits.count).padStart(4)}  ${unit}s ${at}`);
      }
      const total = Object.values(input.hits).reduce((n, h) => n + h.count, 0);
      lines.push(
        `${style.status("Redacted", "success")}: ${ids.length} rule(s) matched ${total} time(s); what they matched is not shown (--print shows the redacted ${input.kind === "records" ? "records" : "text"})`,
      );
    }
  }
  const passed = `${tests.length - failed.length} passed`;
  lines.push(
    `tests: ${style.status(passed, "success")}, ${
      failed.length > 0 ? style.status(`${failed.length} failed`, "error") : "0 failed"
    }`,
  );
  for (const f of failed) {
    lines.push(
      `  ${style.status("FAIL", "error")} ${f.pack}/${f.rule}: ${f.expect === "match" ? "does not match" : "matches"} ${JSON.stringify(f.input)}`,
    );
  }
  return lines;
}

/** Read and redact the input, counting where each rule fired. */
async function readInput(
  ctx: CommandContext,
  json: boolean,
  path: string,
  values: TestValues,
  rules: RuleSet,
  field: AppliesTo,
): Promise<number | ReadInput> {
  let text: string;
  if (path === "-") {
    if (!ctx.stdin) throw new UsageError("no standard input here; name a file");
    text = await ctx.stdin();
  } else {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      return fail(ctx, json, EXIT.notFound, "not_found", `no such file: ${path}`);
    }
    text = await file.text();
  }
  const hits: Record<string, RuleHits> = {};
  const note = (counts: Counts, at: number) => {
    for (const [id, n] of Object.entries(counts)) {
      const hit = hits[id] ?? { count: 0, at: [] };
      hits[id] = hit;
      hit.count += n;
      if (hit.at.at(-1) !== at) hit.at.push(at);
    }
  };

  let agent: string | undefined;
  if (!values.text) {
    const formats = buildFormats(await ctx.integrations());
    agent = values.agent ?? formats.detect(text) ?? undefined;
    if (values.agent !== undefined && !formats.has(values.agent)) {
      throw new UsageError(
        `no normalizer for '${values.agent}' (one of ${formats.sources.join(", ")})`,
      );
    }
    if (agent !== undefined) {
      let records: NormalizedRecord[];
      try {
        records = formats.normalize({ source: agent, transcript: text }).records;
      } catch (err) {
        if (err instanceof NormalizeError)
          return fail(ctx, json, EXIT.failure, err.code, err.message);
        throw err;
      }
      // Record by record, carrying withheld calls, as the pipeline's one pass would.
      const redactor = ruleRedactor(rules);
      let withheld: WithheldCalls = {};
      const output: string[] = [];
      records.forEach((record, i) => {
        const out = redactor.redact([record], withheld);
        withheld = out.withheld;
        note(out.summary.counts, i + 1);
        output.push(JSON.stringify(out.records[0]));
      });
      return { kind: "records", agent, items: records.length, hits, output };
    }
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const output = lines.map((line, i) => {
    const counts: Counts = {};
    const out = rules.redactString(line, field, counts);
    note(counts, i + 1);
    return out;
  });
  return { kind: "text", items: lines.length, hits, output };
}

// --- backfill -----------------------------------------------------------------------

interface BackfillValues {
  config?: string;
  set?: string[];
  since?: string;
  all?: boolean;
  owner?: string[];
  "dry-run"?: boolean;
  limit?: string;
  as?: string;
}

/** `--since`: a duration back from now (`30d`) or a date or time. */
function sinceOf(value: string, now: Date): Date {
  const ms = parseDuration(value);
  if (ms !== undefined) return new Date(now.getTime() - ms);
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) {
    throw new UsageError("--since must be a duration (30d, 12h) or a date or time");
  }
  return at;
}

function sessionLine(s: BackfillSession, dryRun: boolean): string {
  const what =
    s.outcome === "rewritten"
      ? `${dryRun ? "would rewrite" : "rewrote"} (${Object.entries(s.counts ?? {})
          .map(([id, n]) => `${id} ${n}`)
          .join(", ")})`
      : `${s.outcome}: ${s.message ?? ""}`;
  return `  ${s.owner}/${s.agent}/${s.session_id}: ${what}`;
}

/** What a sweep did, for the end of `backfill` and `sweep`: nothing when it found nothing. */
function sweepLines(
  sweep: { deleted: number; young: number; errors: number; error?: string },
  dryRun: boolean,
): string[] {
  const lines: string[] = [];
  if (sweep.deleted > 0) {
    lines.push(
      `${dryRun ? "would delete" : "deleted"} ${sweep.deleted} trace object${sweep.deleted === 1 ? "" : "s"} no session names (left by a write that stopped partway)`,
    );
  }
  if (sweep.young > 0) {
    lines.push(
      `kept ${sweep.young} unnamed trace object${sweep.young === 1 ? "" : "s"} under an hour old (a write may be in flight)`,
    );
  }
  if (sweep.errors > 0) {
    lines.push(
      `could not sweep ${sweep.errors} session${sweep.errors === 1 ? "" : "s"}: ${printable(sweep.error ?? "")}`,
    );
  }
  return lines;
}

function sweptLine(o: SweptObject, dryRun: boolean): string {
  return `  ${o.owner}/${o.archive_id.slice(0, 12)}: ${dryRun ? "would delete" : "deleted"} trace ${o.content_hash.slice(0, 12)} (written ${o.modified})`;
}

async function backfill(ctx: CommandContext, json: boolean, args: string[]): Promise<number> {
  const { values, positionals } = parse<BackfillValues>(args, {
    ...SERVER_OPTIONS,
    since: { type: "string" },
    all: { type: "boolean" },
    owner: { type: "string", multiple: true },
    "dry-run": { type: "boolean" },
    limit: { type: "string" },
    as: { type: "string" },
  });
  if (positionals.length > 0) throw new UsageError(`unexpected argument '${positionals[0]}'`);
  if ((values.since === undefined) === (values.all !== true)) {
    throw new UsageError("backfill needs --since <30d | time> or --all (one of them)");
  }
  const since = values.since !== undefined ? sinceOf(values.since, new Date()) : undefined;
  let limit: number | undefined;
  if (values.limit !== undefined) {
    limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1)
      throw new UsageError("--limit must be a whole number ≥ 1");
  }
  for (const owner of [...(values.owner ?? []), ...(values.as ? [values.as] : [])]) {
    if (!isOwner(owner)) throw new UsageError(`'${owner}' is not an owner id`);
  }
  const dryRun = values["dry-run"] === true;
  const writer: Writer = {
    kind: "admin",
    principal: values.as ?? "admin",
    source_id: BACKFILL_SOURCE_ID,
  };

  let opened: Awaited<ReturnType<typeof openServer>>;
  try {
    opened = await openServer(ctx, values, { roles: [], probe: [], initialize: false });
  } catch (err) {
    const code = serverFailure(ctx, json, err);
    if (code === undefined) throw err;
    return code;
  }
  const { instance } = opened;
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  try {
    const rules = instance.redaction;
    if (!json) {
      ctx.stdout(
        `${dryRun ? "dry run: " : ""}applying rule set ${rules.hash.slice(0, 12)} (built-in ${rules.builtinVersion}${
          rules.packs.length > 0 ? `, packs ${rules.packs.map((p) => p.id).join(", ")}` : ""
        }) to sessions ${since ? `written since ${since.toISOString()}` : "of every age"}`,
      );
    }
    const report = await backfillRedaction({
      store: instance.store,
      redactor: ruleRedactor(rules),
      writer,
      dryRun,
      ...(since ? { since } : {}),
      ...(values.owner ? { owners: values.owner } : {}),
      ...(limit !== undefined ? { limit } : {}),
      signal: controller.signal,
      onSession: (s) => {
        if (
          !json &&
          (s.outcome === "rewritten" || s.outcome === "conflict" || s.outcome === "failed")
        ) {
          ctx.stdout(sessionLine(s, dryRun));
        }
      },
    });
    const o = report.outcomes;
    emit(ctx, json, report, () => {
      const lines = [
        `${dryRun ? "would rewrite" : "rewrote"} ${o.rewritten}, ${o.unchanged} unchanged, ${o.current} already current, ${o.skipped} skipped${
          o.conflict + o.failed > 0 ? `, ${o.conflict} changed meanwhile, ${o.failed} failed` : ""
        }`,
      ];
      const counts = Object.entries(report.counts);
      if (counts.length > 0) {
        lines.push(`taken out: ${counts.map(([id, n]) => `${id} ${n}`).join(", ")}`);
      }
      if (report.spans > 0) {
        lines.push(
          `${dryRun ? "would redact" : "redacted"} ${report.spans} span record${report.spans === 1 ? "" : "s"} again`,
        );
      }
      lines.push(...sweepLines(report.sweep, dryRun));
      if (report.more) lines.push("stopped before the end: run it again to go on");
      if (o.conflict > 0) lines.push("run it again for the sessions that changed meanwhile");
      return lines;
    });
    const code: ExitCode = o.conflict + o.failed > 0 ? EXIT.attention : EXIT.ok;
    return code;
  } finally {
    process.off("SIGINT", stop);
    await instance.close();
  }
}

// --- sweep --------------------------------------------------------------------------

interface SweepValues {
  config?: string;
  set?: string[];
  owner?: string[];
  "dry-run"?: boolean;
}

async function sweep(ctx: CommandContext, json: boolean, args: string[]): Promise<number> {
  const { values, positionals } = parse<SweepValues>(args, {
    ...SERVER_OPTIONS,
    owner: { type: "string", multiple: true },
    "dry-run": { type: "boolean" },
  });
  if (positionals.length > 0) throw new UsageError(`unexpected argument '${positionals[0]}'`);
  for (const owner of values.owner ?? []) {
    if (!isOwner(owner)) throw new UsageError(`'${owner}' is not an owner id`);
  }
  const dryRun = values["dry-run"] === true;
  let opened: Awaited<ReturnType<typeof openServer>>;
  try {
    opened = await openServer(ctx, values, { roles: [], probe: [], initialize: false });
  } catch (err) {
    const code = serverFailure(ctx, json, err);
    if (code === undefined) throw err;
    return code;
  }
  const { instance } = opened;
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  try {
    const report = await sweepTraces(instance.store, {
      dryRun,
      ...(values.owner ? { owners: values.owner } : {}),
      signal: controller.signal,
      onSwept: (o) => {
        if (!json) ctx.stdout(sweptLine(o, dryRun));
      },
    });
    emit(ctx, json, report, () => {
      const lines = [
        `${dryRun ? "dry run: " : ""}looked at ${report.traces} trace object${report.traces === 1 ? "" : "s"} in ${report.sessions} session${report.sessions === 1 ? "" : "s"}`,
        ...sweepLines(report, dryRun),
      ];
      if (report.deleted === 0) lines.push("nothing to delete: every old trace object is named");
      if (report.more) lines.push("stopped before the end: run it again to go on");
      return lines;
    });
    return report.errors > 0 ? EXIT.failure : EXIT.ok;
  } finally {
    process.off("SIGINT", stop);
    await instance.close();
  }
}
