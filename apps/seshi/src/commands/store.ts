/** `seshi store` (31): the bucket itself.
 *
 *   seshi store check [--owner <id>]… [--json] [--config <file>] [--set path=value]…
 *
 * `check` reads the bucket the server config names and says where it breaks the invariants of
 * `spec/layout.md` (`@seshi/store`'s `checkStore`): the layout marker, every session's
 * metadata, head, traces and their continuation chain, stubs and tombstoned sessions, old
 * trace objects no metadata names, the change feed, span records and their stored messages,
 * and token records (never their contents). `--owner` (repeatable) checks only those owners'
 * sessions and change feeds. It reads only: nothing is written, deleted or claimed, so it is
 * safe against a live bucket.
 *
 * The config is found as `seshi workers status` finds it (`admin-target.ts`), but there is no
 * server to ask: `--config` or `--set`; else `SESHI_CONFIG` or `/etc/seshi/seshi.toml`; else
 * the CLI config's `[local] config` (local mode's bucket); else `SESHI_*` env alone. A
 * `./seshi.toml` is never read unasked.
 *
 * Exit 0 when nothing is wrong (warnings alone included), 8 (`attention`) when there is an
 * error finding, 2 for bad usage, 3 when the config or the bucket URL cannot be used. */

import { existsSync } from "node:fs";
import { type ParseArgsConfig, parseArgs } from "node:util";
import { ConfigError, findServerConfig, loadServerConfig } from "@seshi/config";
import { storeOptions } from "@seshi/instance";
import { type CheckReport, checkStore, type Finding, isOwner, openStore } from "@seshi/store";
import { openAccount } from "../account/account";
import { EXIT } from "../cli/exit";
import { emit, fail, takeJson, usageError } from "../cli/output";
import { printable, type Style, styleFor } from "../cli/style";
import { expandHome } from "../connect";
import type { CommandContext } from "./index";
import { configFlags } from "./serve-settings";
import { cwdConfigHint, SERVER_OPTIONS, serverFailure } from "./server-instance";

const USAGE =
  "usage: seshi store check [--owner <id>]… [--json] [--config <file>] [--set path=value]…";

class UsageError extends Error {}

interface CheckValues {
  config?: string;
  set?: string[];
  owner?: string[];
}

export async function run(ctx: CommandContext): Promise<number> {
  const { json, rest } = takeJson(ctx.argv);
  const [sub, ...args] = rest;
  if (sub !== "check") {
    return usageError(
      ctx,
      json,
      sub === undefined ? "store needs check" : `unknown store command '${sub}'`,
      USAGE,
    );
  }
  try {
    return await check(ctx, json, args);
  } catch (err) {
    if (err instanceof UsageError) return usageError(ctx, json, err.message, USAGE);
    const code = serverFailure(ctx, json, err);
    if (code !== undefined) return code;
    throw err;
  }
}

function parse(args: string[], options: NonNullable<ParseArgsConfig["options"]>) {
  try {
    return parseArgs({ args, options, strict: true, allowPositionals: true }) as unknown as {
      values: CheckValues;
      positionals: string[];
    };
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

/** The server config file to read: what was named, else local mode's, else none (the usual
 * lookup, then `SESHI_*` env). */
function configFile(ctx: CommandContext, values: CheckValues): string | undefined {
  if (values.config !== undefined || (values.set?.length ?? 0) > 0) return values.config;
  const found = findServerConfig({ env: ctx.env, cwd: process.cwd(), exists: existsSync });
  if (found.path !== undefined) return undefined;
  cwdConfigHint(ctx, undefined);
  const account = openAccount(ctx);
  return account.cli.local ? expandHome(account.cli.local.config, account.home) : undefined;
}

async function check(ctx: CommandContext, json: boolean, args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    ...SERVER_OPTIONS,
    owner: { type: "string", multiple: true },
  });
  if (positionals.length > 0) throw new UsageError(`unexpected argument '${positionals[0]}'`);
  for (const owner of values.owner ?? []) {
    if (!isOwner(owner)) throw new UsageError(`'${owner}' is not an owner id`);
  }
  const file = configFile(ctx, values);
  const loaded = loadServerConfig({ configFlag: file, env: ctx.env, flags: configFlags(values) });
  for (const warning of loaded.warnings) ctx.stderr(`seshi: warning: ${warning}`);
  let opened: ReturnType<typeof openStore>;
  try {
    opened = openStore(loaded.config.store.url, { ...storeOptions(loaded.config), env: ctx.env });
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    return fail(ctx, json, EXIT.config, "config", (err as Error).message);
  }
  const { store } = opened;
  const report = await checkStore(store, values.owner ? { owners: values.owner } : {});
  const style = await styleFor(ctx, { json });
  emit(ctx, json, { store: store.url, ...report }, () => lines(store.url, report, style));
  return report.counts.errors > 0 ? EXIT.attention : EXIT.ok;
}

function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

/** The summary line, then the findings grouped by session (B1.4: the severity is a word,
 * coloured after padding; text from the bucket goes through `printable`). */
export function lines(url: string, report: CheckReport, style: Style): string[] {
  const c = report.counts;
  const kinds = [
    c.stubs > 0 ? plural(c.stubs, "stub") : "",
    c.redacted > 0 ? `${c.redacted} deleted` : "",
  ].filter(Boolean);
  const looked = [
    plural(c.owners, "owner"),
    `${plural(c.sessions, "session")}${kinds.length > 0 ? ` (${kinds.join(", ")})` : ""}`,
    plural(c.trace_objects, "trace object"),
    plural(c.change_entries, "change entry", "change entries"),
    plural(c.span_records, "span record"),
    plural(c.tokens, "token"),
  ].join(", ");
  const verdict =
    c.errors === 0 && c.warns === 0
      ? style.success("no problems")
      : [
          c.errors > 0 ? style.error(plural(c.errors, "error")) : "",
          c.warns > 0 ? style.warn(plural(c.warns, "warning")) : "",
        ]
          .filter(Boolean)
          .join(", ");
  const out = [`checked ${printable(url)}: ${looked}: ${verdict}`];
  const groups = new Map<string, Finding[]>();
  for (const f of report.findings) {
    const group =
      f.owner === undefined
        ? "the bucket"
        : f.archive_id === undefined
          ? `${f.owner} (change feed)`
          : `${f.owner} ${f.archive_id}`;
    groups.set(group, [...(groups.get(group) ?? []), f]);
  }
  const width = Math.max(0, ...report.findings.map((f) => f.code.length));
  for (const [group, findings] of groups) {
    out.push("", style.bold(printable(group)));
    for (const f of findings) {
      const word = f.severity.padEnd(5);
      const painted = style.status(word, f.severity === "error" ? "error" : "warn");
      out.push(`  ${painted}  ${f.code.padEnd(width)}  ${printable(f.message)}`);
      if (f.key !== undefined)
        out.push(`         ${" ".repeat(width)}  ${style.muted(printable(f.key))}`);
    }
  }
  return out;
}
