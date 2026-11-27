import { isAbsolute } from "node:path";
import { DEFAULT_SEARCH_MAX_CHARS, MAX_SEARCH_CHARS } from "@seshi/model";
import * as z from "zod";
import { bytes, duration } from "../units";
import { storeUrl } from "./common";
import { bucketCredentials, credentialsMismatch } from "./store";

export const SEARCH_EVENT_ROLES = [
  "user",
  "assistant",
  "tool_call",
  "tool_result",
  "system",
  "observation",
  "reasoning",
] as const;

export const SEARCH_BACKENDS = ["sqlite", "lance"] as const;

/** The least a role's cap may be: enough for a command's error or a file's head. */
const MIN_SEARCH_CHARS = 256;

const roleCap = (role: (typeof SEARCH_EVENT_ROLES)[number]) =>
  z
    .int()
    .min(MIN_SEARCH_CHARS)
    .max(MAX_SEARCH_CHARS)
    .default(DEFAULT_SEARCH_MAX_CHARS[role])
    .describe(`Characters of a ${role} event indexed (${DEFAULT_SEARCH_MAX_CHARS[role]}).`);

export const maxCharsSection = z
  .strictObject(
    Object.fromEntries(SEARCH_EVENT_ROLES.map((role) => [role, roleCap(role)])) as {
      [R in (typeof SEARCH_EVENT_ROLES)[number]]: ReturnType<typeof roleCap>;
    },
  )
  .prefault({})
  .describe(
    `How much of each role's text is indexed, in characters (${MIN_SEARCH_CHARS} to ${MAX_SEARCH_CHARS}): the rest is not searched, and read_session reads it from the store. Tool output and observations 8192, the rest 32768. Changing one rebuilds the index.`,
  );

export const lanceSection = z
  .strictObject({
    uri: storeUrl
      .optional()
      .describe(
        "Where the index lives, as a store URL (s3://, r2://, az://, gs://, file:///path). Default: search/<deployment>/ in the store's bucket, with [store]'s keys.",
      ),
    credentials: bucketCredentials
      .optional()
      .describe(
        "Keys for uri, when it is not in the store's bucket; the same fields as [store] credentials.",
      ),
    region: z.string().min(1).optional().describe("uri's region (s3://)."),
    endpoint: z
      .string()
      .min(1)
      .optional()
      .describe("uri's S3-compatible endpoint, or its Azure blob endpoint, as [store] endpoint."),
    account_id: z.string().min(1).optional().describe("uri's Cloudflare account id (r2://)."),
    account_name: z.string().min(1).optional().describe("uri's Azure storage account (az://)."),
    read_consistency: duration()
      .prefault("5s")
      .describe(
        "How soon an API instance sees what the worker committed. 0 checks the bucket on every read.",
      ),
    optimize: duration()
      .refine((ms) => ms > 0, "must be above 0")
      .prefault("1h")
      .describe(
        "How often the worker compacts the tables and adds new rows to their indexes, and only after a commit.",
      ),
    scrub: duration()
      .refine((ms) => ms > 0, "must be above 0")
      .prefault("24h")
      .describe(
        "How often, at most, the worker rewrites the tables so that deleted, retracted and redacted text leaves the bucket (F10.12). seshi search --scrub asks for one sooner.",
      ),
    max_scored_rows: z
      .int()
      .min(100)
      .default(10_000)
      .describe(
        "Records a relevance search scores at most; past it the total is a lower bound (at least N).",
      ),
    max_recent_rows: z
      .int()
      .min(100)
      .default(100_000)
      .describe("Records a search sorted by recency reads at most."),
  })
  .superRefine((section, ctx) => {
    if (section.uri === undefined) {
      for (const key of [
        "credentials",
        "region",
        "endpoint",
        "account_id",
        "account_name",
      ] as const) {
        if (section[key] !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: "is for uri; without one the index is in the store's bucket, with [store]'s",
          });
        }
      }
      return;
    }
    const mismatch = credentialsMismatch(section.uri, section.credentials);
    if (mismatch) ctx.addIssue({ code: "custom", path: ["credentials"], message: mismatch });
  })
  .prefault({})
  .describe(
    'The LanceDB index (backend = "lance"): one index in object storage, written by the worker and read by every API instance (F10.6–F10.12).',
  );

export type LanceSection = z.output<typeof lanceSection>;

export const sqlSection = z
  .strictObject({
    workers: z
      .int()
      .min(1)
      .max(16)
      .optional()
      .describe(
        "Worker processes that run sql statements, one at a time each: 2 on a server, 1 on a serverless laptop when unset.",
      ),
    timeout: duration()
      .refine((ms) => ms >= 1000, "must be at least 1s")
      .prefault("15s")
      .describe(
        "How long a statement may run. On SQLite the worker is killed at this time (SQLite has no interrupt) and a new one started.",
      ),
    memory: bytes()
      .refine((n) => n >= 16 * 1024 ** 2, "must be at least 16MiB")
      .prefault("1GiB")
      .describe(
        "Memory a statement may use inside the engine: on SQLite its hard_heap_limit, which Bun's own SQLite on Linux holds and macOS's system SQLite ignores; on LanceDB DuckDB's memory_limit, with nothing spilled to disk.",
      ),
    threads: z
      .int()
      .min(1)
      .max(64)
      .default(2)
      .describe("Threads DuckDB runs a statement on, per worker (LanceDB only; SQLite uses one)."),
    worker_memory: bytes()
      .refine((n) => n >= 64 * 1024 ** 2, "must be at least 64MiB")
      .prefault("2GiB")
      .describe(
        "The watchdog kills a worker whose resident memory passes this, answers its statement with sql_memory, and starts another.",
      ),
    max_rows: z
      .int()
      .min(1)
      .max(1000)
      .default(1000)
      .describe("Rows an answer holds at most (a caller can ask for fewer); then it is truncated."),
    extensions: z
      .string()
      .min(1)
      // The sql workers run in a private temporary folder: a relative path would mean nothing.
      .refine(isAbsolute, "must be an absolute path")
      .optional()
      .describe(
        "The folder holding DuckDB's extensions (<folder>/<duckdb version>/<platform>/lance.duckdb_extension), an absolute path, for sql on a LanceDB index. Default: duckdb/ beside the seshi binary, where the seshi-server-sql archive and image put it.",
      ),
    storage: bucketCredentials
      .optional()
      .describe(
        "A read-only credential for the LanceDB index, which only the sql workers hold (the same fields as [store] credentials): a Google service account key with storage.objectViewer on the index's prefix (gs://), an access key allowed GetObject and ListBucket on it (s3://, r2://), or a SAS token with read and list on it (az://). DuckDB's lance extension does not honour DuckDB's own lock-down, so this is what keeps a statement from reading or writing anything else. Without it the workers use the index's own credential.",
      ),
    members: z
      .boolean()
      .default(false)
      .describe(
        'Give members the sql scope. Only with backend = "lance": sql on a SQLite index is for admins, service tokens and a laptop\'s own user, and is not for production use with members.',
      ),
  })
  .prefault({})
  .describe(
    "sql: one read-only SELECT over the views sessions, events and llm_calls (POST /v1/sql, seshi sql), in worker processes. On a SQLite index SQLite itself runs it over the index file; on a LanceDB index DuckDB runs it over the Lance tables, in the seshi-server-sql build only.",
  );

export type SqlSection = z.output<typeof sqlSection>;

export const searchSection = z
  .strictObject({
    enabled: z
      .boolean()
      .default(true)
      .describe(
        "Serve search (GET /v1/search, seshi search) from a local index built from the change feed.",
      ),
    backend: z
      .enum(SEARCH_BACKENDS)
      .default("sqlite")
      .describe(
        'The index backend: "sqlite", a file on each API instance (F10.3), or "lance", one index in object storage that the worker writes and every API instance reads (F10.6). A server option: serverless laptops always use SQLite.',
      ),
    path: z
      .string()
      .min(1)
      .optional()
      .describe(
        'The SQLite index file on local disk; ":memory:" keeps it in memory. Default: seshi/search/<deployment>.sqlite in the user cache folder. Not read with backend = "lance".',
      ),
    interval: duration()
      .refine((ms) => ms > 0, "must be above 0")
      .prefault("15s")
      .describe("How long the indexer waits after catching up before it reads the feed again."),
    events: z
      .array(z.enum(SEARCH_EVENT_ROLES))
      .min(1)
      .default([...SEARCH_EVENT_ROLES])
      .describe(
        "Which trace events are indexed, by role: every role by default (F10.1), each cut to its max_chars. Changing it rebuilds the index.",
      ),
    max_chars: maxCharsSection,
    lance: lanceSection,
    sql: sqlSection,
  })
  .superRefine((section, ctx) => {
    if (section.sql.storage !== undefined && section.backend !== "lance") {
      ctx.addIssue({
        code: "custom",
        path: ["sql", "storage"],
        message: 'is for backend = "lance": sql on SQLite reads the index file on this disk',
      });
    }
    if (section.sql.members && section.backend !== "lance") {
      ctx.addIssue({
        code: "custom",
        path: ["sql", "members"],
        message:
          'needs backend = "lance": sql on a SQLite index has no wall below its statement check and is not for production use with members (docs/search.md)',
      });
    }
  })
  .prefault({})
  .describe("Session search (F10).");

export type SearchSection = z.output<typeof searchSection>;
