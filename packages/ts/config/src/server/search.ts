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
      .default(["user", "assistant", "tool_call"])
      .describe(
        "Which trace events are indexed, by role: prompts, assistant text, and tool calls (names and inputs, so file paths and commands) by default (F10.1).",
      ),
    lance: lanceSection,
  })
  .prefault({})
  .describe("Session search (F10).");

export type SearchSection = z.output<typeof searchSection>;
