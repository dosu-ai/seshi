/** `seshi review eval` (F3.8): measure a review policy against labelled fixtures before
 * changing it: label accuracy and false drops for the decision model, recall for the redactor,
 * and what would have leaked. It runs where the server's config is and calls the policy's real
 * providers, so the fixtures (and only they) are sent to them. It reads no bucket.
 *
 *   seshi review eval [--policy <id>] [--fixtures <file or folder>] [--config <file>]
 *                     [--set path=value]… [--json]
 *
 * Without `--fixtures`, seshi's own labelled set is used. Exit 0 when every fixture came out as
 * labelled, 8 (`attention`) when any did not (a wrong label, a false or missed drop, a leak, a
 * failed call), 3 for a config or policy it cannot use, 4 for an unknown policy or a missing
 * fixtures path. */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadServerConfig } from "@seshi/config";
import {
  BUILTIN_FIXTURES,
  type EvalReport,
  evaluate,
  type Fixture,
  FixtureError,
  loadPolicy,
  parseFixtures,
  ReviewSetupError,
} from "@seshi/review";
import { EXIT } from "../cli/exit";
import { emit, fail, takeJson, usageError } from "../cli/output";
import type { CommandContext } from "./index";
import { configFlags } from "./serve-settings";
import { cwdConfigHint, SERVER_OPTIONS, serverFailure } from "./server-instance";

const USAGE =
  "usage: seshi review eval [--policy <id>] [--fixtures <file or folder>] [--config <file>] [--set path=value]… [--json]";

const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;

/** The report as lines for a terminal. */
export function reportLines(report: EvalReport): string[] {
  const lines = [
    `policy ${report.policy} (${report.policy_hash.slice(0, 12)})`,
    `decision model ${report.decision_model}, redactor ${report.redactor_model}`,
    "",
  ];
  for (const r of report.results) {
    const mark = r.got === r.expected && r.leaked === 0 ? "ok  " : "MISS";
    const detail = [
      r.got === "redact" ? `${r.findings} finding(s)` : "",
      r.leaked > 0 ? `${r.leaked} leaked` : "",
      r.failure ?? "",
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(
      `  ${mark} ${r.name.padEnd(36)} expected ${r.expected.padEnd(6)} got ${r.got}${detail ? ` (${detail})` : ""}`,
    );
  }
  lines.push(
    "",
    `fixtures ${report.fixtures}, label accuracy ${pct(report.label_accuracy)}, false drops ${report.false_drops}, missed drops ${report.missed_drops}`,
    `redactor recall ${report.redactor_recall === null ? "n/a" : pct(report.redactor_recall)}, leaked ${report.leaked}, failed ${report.failures}`,
  );
  return lines;
}

/** Fixtures from a JSON file, or every `.json` file in a folder (in name order). */
export function readFixtures(path: string): Fixture[] {
  const files = statSync(path).isDirectory()
    ? readdirSync(path)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .map((f) => join(path, f))
    : [path];
  if (files.length === 0) throw new FixtureError(`${path}: no .json files`);
  return files.flatMap((file) => {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      throw new FixtureError(`${file}: ${(err as Error).message}`);
    }
    return parseFixtures(value, file);
  });
}

export async function run(ctx: CommandContext): Promise<number> {
  const { json, rest } = takeJson(ctx.argv);
  const [sub, ...args] = rest;
  if (sub !== "eval") {
    return usageError(
      ctx,
      json,
      sub === undefined ? "review needs a subcommand" : `unknown review command '${sub}'`,
      USAGE,
    );
  }
  let values: { config?: string; set?: string[]; policy?: string; fixtures?: string };
  try {
    ({ values } = parseArgs({
      args,
      options: { ...SERVER_OPTIONS, policy: { type: "string" }, fixtures: { type: "string" } },
      strict: true,
    }));
  } catch (err) {
    return usageError(ctx, json, (err as Error).message, USAGE);
  }
  try {
    cwdConfigHint(ctx, values.config);
    const loaded = loadServerConfig({
      configFlag: values.config,
      env: ctx.env,
      flags: configFlags(values),
    });
    for (const warning of loaded.warnings) ctx.stderr(`seshi: warning: ${warning}`);
    const policies = loaded.config.review.policies;
    if (policies.length === 0) {
      return fail(ctx, json, EXIT.config, "config", "no [[review.policies]] in the config");
    }
    const chosen = values.policy ? policies.find((p) => p.id === values.policy) : policies[0];
    if (!chosen) {
      return fail(
        ctx,
        json,
        EXIT.notFound,
        "not_found",
        `no review policy '${values.policy}' (${policies.map((p) => p.id).join(", ")})`,
      );
    }
    let fixtures: Fixture[];
    if (values.fixtures) {
      try {
        fixtures = readFixtures(values.fixtures);
      } catch (err) {
        if (err instanceof FixtureError) return fail(ctx, json, EXIT.usage, "usage", err.message);
        return fail(ctx, json, EXIT.notFound, "not_found", `cannot read ${values.fixtures}`);
      }
    } else {
      fixtures = [...BUILTIN_FIXTURES];
    }
    const policy = await loadPolicy(chosen);
    ctx.stderr(
      `seshi: sending ${fixtures.length} fixture(s) to ${policy.decision.provider.endpoint} and ${policy.redactor.provider.endpoint}`,
    );
    const report = await evaluate(policy, fixtures, {
      log: { warn: (line) => ctx.stderr(`seshi: warning: ${line}`) },
    });
    emit(ctx, json, report, () => reportLines(report));
    const clean = report.results.every((r) => r.got === r.expected && r.leaked === 0);
    return clean ? EXIT.ok : EXIT.attention;
  } catch (err) {
    if (err instanceof ReviewSetupError) return fail(ctx, json, EXIT.config, "config", err.message);
    const code = serverFailure(ctx, json, err);
    if (code === undefined) throw err;
    return code;
  }
}
