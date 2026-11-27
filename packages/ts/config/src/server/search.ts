import { DEFAULT_SEARCH_MAX_CHARS, MAX_SEARCH_CHARS } from "@seshi/model";
import * as z from "zod";
import { duration } from "../units";
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
  })
  .prefault({})
  .describe("Session search (F10).");

export type SearchSection = z.output<typeof searchSection>;
