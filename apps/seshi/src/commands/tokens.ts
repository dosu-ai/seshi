import { parseArgs } from "node:util";
import type { Scope, TokenInfo, TokenKind, TokenRequest } from "@seshi/client";
import { parseDuration } from "@seshi/config";
import { type Account, openAccount } from "../account/account";
import { type Backend, openBackend } from "../backend";
import { EXIT } from "../cli/exit";
import { failWith, Refused } from "../cli/failures";
import { emit, takeJson, usageError } from "../cli/output";
import { printable, type Style, styleFor } from "../cli/style";
import type { CommandContext } from "./index";

const USAGE = `usage: seshi tokens ls [--owner <id>] [--kind <kind>] [--all]
       seshi tokens create org|admin|device|service [--owner <id>] [--service <name>] [--scope <s>]...
                           [--visibility org|owner] [--expires <30d|date>] [--label <text>]
       seshi tokens revoke <id>
       seshi tokens revoke --owner <id> [--kind <kind>]
       (each also takes --server <url> and --json)`;

const KINDS: readonly TokenKind[] = ["org", "admin", "device", "service"];
const SCOPES: readonly Scope[] = [
  "sessions:write",
  "sessions:read",
  "sessions:delete",
  "search",
  "sources:admin",
  "tokens:admin",
];

const OPTIONS = {
  server: { type: "string" },
  owner: { type: "string" },
  kind: { type: "string" },
  all: { type: "boolean" },
  service: { type: "string" },
  scope: { type: "string", multiple: true },
  visibility: { type: "string" },
  expires: { type: "string" },
  label: { type: "string" },
} as const;

interface Values {
  server?: string;
  owner?: string;
  kind?: string;
  all?: boolean;
  service?: string;
  scope?: string[];
  visibility?: string;
  expires?: string;
  label?: string;
}

class UsageError extends Error {}

function kindOf(value: string | undefined): TokenKind | undefined {
  if (value === undefined) return undefined;
  if (!(KINDS as readonly string[]).includes(value)) {
    throw new UsageError(`a token kind is one of ${KINDS.join(", ")}`);
  }
  return value as TokenKind;
}

export function expiresAt(value: string, now: Date): string {
  const ms = parseDuration(value);
  const at = ms !== undefined ? new Date(now.getTime() + ms) : new Date(value);
  if (Number.isNaN(at.getTime())) {
    throw new UsageError("--expires is a duration (30d, 12h) or a date (2027-01-31)");
  }
  if (at.getTime() <= now.getTime()) throw new UsageError("--expires must be in the future");
  return at.toISOString();
}

export function tokenState(
  token: TokenInfo,
  now: Date,
): { word: string; role: "success" | "warn" } {
  if (token.revoked) return { word: "revoked", role: "warn" };
  if (token.expires_at && Date.parse(token.expires_at) <= now.getTime()) {
    return { word: "expired", role: "warn" };
  }
  return { word: "live", role: "success" };
}

function listLines(tokens: TokenInfo[], style: Style, now: Date): string[] {
  if (tokens.length === 0) return ["No tokens."];
  const header = `${"ID".padEnd(20)}  ${"KIND".padEnd(7)}  ${"OWNER".padEnd(24)}  ${"STATE".padEnd(7)}  ${"EXPIRES".padEnd(10)}  LABEL`;
  const lines = [style.muted(header)];
  for (const t of tokens) {
    const { word, role } = tokenState(t, now);
    const expires = (t.expires_at ?? "never").slice(0, 10).padEnd(10);
    lines.push(
      `${printable(t.id).padEnd(20)}  ${t.kind.padEnd(7)}  ${printable(t.owner).padEnd(24)}  ${style.status(word.padEnd(7), role)}  ${expires}  ${printable(t.label ?? "")}`.trimEnd(),
    );
  }
  return lines;
}

async function create(
  ctx: CommandContext,
  json: boolean,
  backend: Backend,
  kind: TokenKind,
  values: Values,
  style: Style,
) {
  for (const s of values.scope ?? []) {
    if (!(SCOPES as readonly string[]).includes(s)) {
      throw new UsageError(`a scope is one of ${SCOPES.join(", ")}`);
    }
  }
  if (
    values.visibility !== undefined &&
    values.visibility !== "org" &&
    values.visibility !== "owner"
  ) {
    throw new UsageError("--visibility must be org or owner");
  }
  const request: TokenRequest = {
    kind,
    ...(values.owner ? { owner: values.owner } : {}),
    ...(values.service ? { service: values.service } : {}),
    ...(values.scope?.length ? { scopes: values.scope as Scope[] } : {}),
    ...(values.visibility ? { visibility: values.visibility as "org" | "owner" } : {}),
    ...(values.expires ? { expires_at: expiresAt(values.expires, new Date()) } : {}),
    ...(values.label ? { label: values.label } : {}),
  };
  const issued = await backend.createToken(request);
  emit(ctx, json, issued, () => [
    `${style.status("Created", "success")} a ${issued.record.kind} token ${issued.record.id} for ${issued.record.owner}${issued.record.expires_at ? `, expires ${issued.record.expires_at.slice(0, 10)}` : ""}.`,
    style.warn("Shown once; store it now:"),
    issued.token,
  ]);
  return EXIT.ok;
}

async function revoke(
  ctx: CommandContext,
  json: boolean,
  backend: Backend,
  id: string | undefined,
  values: Values,
  style: Style,
) {
  if ((id === undefined) === (values.owner === undefined)) {
    throw new UsageError("tokens revoke takes a token id, or --owner <id>");
  }
  if (id !== undefined) {
    if (values.kind !== undefined) throw new UsageError("--kind goes with --owner");
    const token = await backend.revokeToken(id);
    if (!token) throw new Refused(EXIT.notFound, "not_found", `no token ${id}`);
    emit(ctx, json, { token }, () => [
      `${style.status("Revoked", "success")} ${token.kind} token ${token.id} of ${token.owner}.`,
    ]);
    return EXIT.ok;
  }
  const revoked = await backend.revokeOwnerTokens(values.owner as string, kindOf(values.kind));
  emit(ctx, json, { revoked }, () => [
    revoked.length === 0
      ? `${values.owner} had no live tokens${values.kind ? ` of kind ${values.kind}` : ""}.`
      : `${style.status("Revoked", "success")} ${revoked.length} token(s) of ${values.owner}: ${revoked.map((t) => t.id).join(", ")}.`,
  ]);
  return EXIT.ok;
}

export async function run(ctx: CommandContext): Promise<number> {
  const { json, rest } = takeJson(ctx.argv);
  const [sub, ...args] = rest;
  if (!sub || !["ls", "list", "create", "revoke"].includes(sub)) {
    return usageError(
      ctx,
      json,
      sub === undefined ? "tokens needs a subcommand" : `unknown tokens command '${sub}'`,
      USAGE,
    );
  }
  let values: Values;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args,
      options: OPTIONS,
      strict: true,
      allowPositionals: true,
    }));
  } catch (err) {
    return usageError(ctx, json, (err as Error).message, USAGE);
  }
  let account: Account | undefined;
  let backend: Backend | undefined;
  try {
    let kind: TokenKind | undefined;
    if (sub === "create") {
      if (positionals.length !== 1) throw new UsageError("tokens create takes one kind");
      kind = kindOf(positionals[0]);
    } else if (sub === "revoke") {
      if (positionals.length > 1) throw new UsageError("tokens revoke takes one token id");
    } else if (positionals.length > 0) {
      throw new UsageError("tokens ls takes no arguments");
    }
    account = openAccount(ctx);
    const style = await styleFor(ctx, { json, theme: account.cli.theme });
    backend = await openBackend(ctx, account, values.server ? { server: values.server } : {});
    if (sub === "create") return await create(ctx, json, backend, kind as TokenKind, values, style);
    if (sub === "revoke") return await revoke(ctx, json, backend, positionals[0], values, style);
    const tokens = await backend.listTokens({
      ...(values.owner ? { owner: values.owner } : {}),
      ...(values.kind ? { kind: kindOf(values.kind) } : {}),
      ...(values.all ? { all: true } : {}),
    });
    const now = new Date();
    emit(ctx, json, { tokens }, () => listLines(tokens, style, now));
    return EXIT.ok;
  } catch (err) {
    if (err instanceof UsageError) return usageError(ctx, json, err.message, USAGE);
    return failWith(ctx, json, err);
  } finally {
    await backend?.close();
  }
}
