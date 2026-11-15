/** `seshi serve` (`bun start`): the server from the environment (Bun reads `.env` on its own).
 * The environment is today's sessiondb one, unchanged; branch 02 replaces it with the config
 * loader (F1).
 *
 * - `SESSIONDB_TOKENS`     who may use the server: `name:token` pairs separated by commas, one
 *                          per person (`alice:…,bob:…`). Each person's sessions are
 *                          filed under `owners/<name>/` and a token reads only its own. 16+ chars
 * - `SESSIONDB_TOKEN`      one token for a one-person install; its sessions file under
 *                          `owners/default/`
 * - `SESSIONDB_TOKEN_SECRET`
 *                          for a hosted server: tokens signed with this secret (HS256 JWT,
 *                          `sub` the owner, `exp` required) are accepted too, so an issuer
 *                          that shares it (Dosu's backend) mints one per person and the
 *                          list above can be empty. 32+ characters
 * - `SESSIONDB_STORE_URL`  where sessions go: `s3://bucket/prefix`, `r2://bucket/prefix`, or
 *                          `file:///path` for one box
 * - bucket credentials     `s3://`: `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (or `S3_*`),
 *                          `AWS_REGION`; `r2://`: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
 *                          `R2_SECRET_ACCESS_KEY`; S3-compatible: `S3_ENDPOINT` with the `AWS_*` keys
 * - `SESSIONDB_REDACTION_FILE`
 *                          optional: a JSON file of the operator's own redaction, added to the
 *                          built-in rules (`patterns`, `sensitive_files`, `secret_commands`;
 *                          see docs/server.md). The server refuses to start on a bad pattern
 * - `SESSIONDB_FORMAT`     how traces are written: `letta` (default; trajectory-v1 records) or
 *                          `otlp` (OTLP/HTTP JSON GenAI spans). A bucket holds one format, set
 *                          by its first writer; the server refuses to start on the other
 * - `PORT`                 default 7200
 */

import { createApp, type TokenGrant } from "@seshi/api";
import { MIN_SECRET_LENGTH } from "@seshi/auth";
import type { FormatRegistry } from "@seshi/formats";
import { isTraceFormat, TRACE_FORMATS, type TraceFormat, VERSION } from "@seshi/model";
import { parseRedactionConfig, type RedactionRules } from "@seshi/redact";
import {
  assertOwner,
  ensureLayout,
  openStore,
  probe,
  type StorageView,
  type Store,
} from "@seshi/store";
import { buildFormats } from "../integrations";
import type { CommandContext } from "./index";

/** A setting the server cannot start with: printed as `sessiondb: <message>`, exit 1. */
export class ServeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServeConfigError";
  }
}

function fail(message: string): never {
  throw new ServeConfigError(message);
}

/** What the environment says, checked; nothing is read or opened yet. */
export interface ServeSettings {
  tokens: TokenGrant[];
  tokenSecret: string | undefined;
  owners: string[];
  url: string;
  format: TraceFormat;
  redactionFile: string | undefined;
  port: number;
}

/** The environment's settings, or `ServeConfigError` for the first one that is wrong. */
export function readServeEnv(env: Record<string, string | undefined>): ServeSettings {
  const tokens: TokenGrant[] = [];
  const single = env.SESSIONDB_TOKEN?.trim();
  if (single) tokens.push({ token: single, owner: "default" });
  for (const entry of (env.SESSIONDB_TOKENS ?? "").split(",")) {
    const pair = entry.trim();
    if (!pair) continue;
    const at = pair.indexOf(":");
    if (at < 1) fail(`SESSIONDB_TOKENS entries are name:token, got '${pair.slice(0, 8)}…'`);
    const owner = pair.slice(0, at).trim();
    try {
      assertOwner(owner);
    } catch {
      fail(`'${owner}' is not a valid name: letters, digits, . _ - (up to 128)`);
    }
    tokens.push({ token: pair.slice(at + 1).trim(), owner });
  }
  const tokenSecret = env.SESSIONDB_TOKEN_SECRET?.trim() || undefined;
  if (tokens.length === 0 && tokenSecret === undefined) {
    fail("SESSIONDB_TOKENS (name:token,…), SESSIONDB_TOKEN or SESSIONDB_TOKEN_SECRET is required");
  }
  if (tokenSecret !== undefined && tokenSecret.length < MIN_SECRET_LENGTH) {
    fail(
      `SESSIONDB_TOKEN_SECRET must be ${MIN_SECRET_LENGTH}+ characters (try: openssl rand -hex 32)`,
    );
  }
  for (const { token } of tokens) {
    if (token.length < 16) fail("every token must be 16+ characters (try: openssl rand -hex 24)");
  }
  if (new Set(tokens.map((t) => t.token)).size !== tokens.length) {
    fail("the same token is listed twice");
  }
  const owners = [...new Set(tokens.map((t) => t.owner))];

  const url = env.SESSIONDB_STORE_URL;
  if (!url)
    fail("SESSIONDB_STORE_URL is required (s3://bucket/prefix, r2://bucket/prefix, file:///path)");

  const formatSetting = env.SESSIONDB_FORMAT?.trim().toLowerCase() || "letta";
  if (!isTraceFormat(formatSetting)) {
    fail(`SESSIONDB_FORMAT must be one of ${TRACE_FORMATS.join(", ")}, got '${formatSetting}'`);
  }
  const format: TraceFormat = formatSetting;
  const redactionFile = env.SESSIONDB_REDACTION_FILE?.trim() || undefined;
  const port = Number.parseInt(env.PORT ?? "7200", 10);
  return { tokens, tokenSecret, owners, url, format, redactionFile, port };
}

/** Read the redaction file, open the bucket, check it can be written, then serve until a
 * signal. Every failure before serving is a `ServeConfigError`. */
async function start(ctx: CommandContext, formats: FormatRegistry): Promise<void> {
  const { tokens, tokenSecret, owners, url, format, redactionFile, port } = readServeEnv(ctx.env);
  const client = `sessiondb-server/${VERSION}`;

  let redaction: RedactionRules | undefined;
  if (redactionFile) {
    let text: string;
    try {
      text = await Bun.file(redactionFile).text();
    } catch (err) {
      fail(
        `cannot read SESSIONDB_REDACTION_FILE: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      redaction = parseRedactionConfig(text);
    } catch (err) {
      fail(`${redactionFile}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let store: Store;
  let storage: StorageView;
  try {
    ({ store, storage } = openStore(url));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  // Fail at boot, not on the first session, when the bucket or its keys are wrong.
  try {
    await ensureLayout(store, client, format);
    for (const owner of owners) await probe(store, owner);
  } catch (err) {
    fail(`cannot write to ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const app = createApp({
    store,
    storage,
    formats,
    tokens,
    tokenSecret,
    client,
    redaction,
    format,
  });

  const server = Bun.serve({
    port,
    // A raw transcript can be large; gzipped uploads are decoded after this check.
    maxRequestBodySize: 256 * 1024 * 1024,
    // A large upload or a long list against a bucket can take more than Bun's 10s default.
    idleTimeout: 120,
    fetch: app.fetch,
  });

  const who = [...owners, ...(tokenSecret ? ["whoever holds a signed token"] : [])].join(", ");
  ctx.stdout(
    `sessiondb-server ${VERSION} listening on http://localhost:${server.port}, writing ${format} traces to ${url} for ${who}`,
  );
  if (redaction) {
    ctx.stdout(
      `redaction from ${redactionFile}: ${redaction.patterns.length} pattern(s) on top of the built-in rules`,
    );
  }

  function shutdown(): void {
    server.stop();
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** Serves until a signal; returns 1 when a setting stops it from starting. */
export async function run(ctx: CommandContext): Promise<number | undefined> {
  try {
    await start(ctx, buildFormats(await ctx.integrations()));
    return undefined;
  } catch (err) {
    if (!(err instanceof ServeConfigError)) throw err;
    ctx.stderr(`sessiondb: ${err.message}`);
    return 1;
  }
}
