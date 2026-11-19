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
import { emit, fail, helpOrUsageError, takeJson } from "../cli/output";
import type { CommandContext } from "./index";
import { configFlags } from "./serve-settings";
import { cwdConfigHint, SERVER_OPTIONS, serverFailure } from "./server-instance";

const USAGE = [
  "usage: seshi review eval [--policy <id>] [--fixtures <file or folder>] [--config <file>] [--set path=value]… [--json]",
  "       seshi review key set <provider> [--key -]   store a model review key on this machine (serverless mode)",
].join("\n");

const PROVIDER = /^[a-z][a-z0-9-]{0,39}$/;

/** `seshi review key set <provider>` (F11): keep a review key in the keychain. It fills a
 * policy's `api_key = { env = "…" }` for that provider when the variable is unset. */
async function keySet(ctx: CommandContext, json: boolean, args: string[]): Promise<number> {
  let values: { key?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args,
      options: { key: { type: "string" } },
      strict: true,
      allowPositionals: true,
    }));
  } catch (err) {
    return helpOrUsageError(ctx, json, (err as Error).message, USAGE);
  }
  const [verb, provider, ...extra] = positionals;
  if (verb !== "set" || provider === undefined || extra.length > 0) {
    return helpOrUsageError(ctx, json, "review key set takes one provider", USAGE);
  }
  if (!PROVIDER.test(provider)) {
    return helpOrUsageError(ctx, json, `'${provider}' is not a provider name (anthropic)`, USAGE);
  }
  let key: string;
  if (values.key !== undefined && values.key !== "-") {
    return helpOrUsageError(
      ctx,
      json,
      "pass the key on standard input (--key -), not on the command line",
      USAGE,
    );
  }
  if (values.key === "-") {
    if (!ctx.stdin) return fail(ctx, json, EXIT.usage, "usage", "no standard input to read from");
    key = (await ctx.stdin()).trim();
  } else if (ctx.terminal && ctx.tty?.stdin) {
    key = (await (await ctx.terminal()).ask(`${provider} key: `, { hidden: true })).trim();
  } else {
    return helpOrUsageError(
      ctx,
      json,
      "no terminal to ask in: use --key - and pipe the key",
      USAGE,
    );
  }
  if (!key) return fail(ctx, json, EXIT.usage, "usage", "no key given");
  const { openAccount } = await import("../account/account");
  const { saveReviewKey } = await import("../serverless/keys");
  const account = openAccount(ctx);
  await saveReviewKey(account.secrets, provider, key);
  emit(ctx, json, { provider, stored_in: account.secrets.kind }, () => [
    `Stored the ${provider} review key in the ${account.secrets.kind}.`,
    "Review policies for it use this key when their api_key's variable is unset. Check with: seshi doctor",
  ]);
  return EXIT.ok;
}

const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;

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
  if (sub === "key") return keySet(ctx, json, args);
  if (sub !== "eval") {
    return helpOrUsageError(
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
    return helpOrUsageError(ctx, json, (err as Error).message, USAGE);
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
