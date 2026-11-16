import * as z from "zod";
import { httpUrl } from "./server/common";

export const THEMES = ["auto", "dark", "light"] as const;

/** What a laptop's search index holds (F11.9): only your sessions, yours and the org's, or
 * also others' owner-only sessions. */
export const SEARCH_SCOPES = ["mine", "visible", "all"] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

export const capturePath = z
  .strictObject({
    path: z.string().min(1).describe("A folder; ~ is the home folder. Matched by path prefix."),
    capture: z.boolean().describe("Capture sessions under it, or not."),
  })
  .describe("A personal capture rule for a folder (F9.5).");

export const cliConfigSchema = z
  .strictObject({
    server: httpUrl
      .optional()
      .describe("The seshi server this CLI talks to (seshi login --server)."),
    local: z
      .strictObject({
        config: z
          .string()
          .min(1)
          .describe(
            "A server config (seshi.toml) naming the bucket; ~ is the home folder. Its keys must be able to write the bucket.",
          ),
        owner: z
          .string()
          .min(1)
          .optional()
          .describe("The owner id sessions are stored under; user, else the OS user, when unset."),
      })
      .optional()
      .describe(
        "The old name of [serverless] (F11.1): config names a server config whose [store] gives the bucket. Still read; seshi config check prints the new table.",
      ),
    serverless: z
      .strictObject({
        url: z
          .string()
          .regex(/^(s3|r2|file):\/\//, "s3://, r2:// or file://")
          .optional()
          .describe(
            "The bucket and prefix sessions are written to: s3://bucket/prefix, r2://bucket/prefix or file:///path. Required unless config names a server config with a [store].",
          ),
        region: z.string().min(1).optional().describe("The bucket's region, as [store] region."),
        endpoint: httpUrl.optional().describe("An S3-compatible endpoint, as [store] endpoint."),
        account_id: z
          .string()
          .min(1)
          .optional()
          .describe("Cloudflare account id for r2://, as [store] account_id."),
        owner: z
          .string()
          .min(1)
          .optional()
          .describe("The owner id sessions are stored under; user, else the OS user, when unset."),
        config: z
          .string()
          .min(1)
          .optional()
          .describe(
            "A local server config (seshi.toml) layered over the bucket's shared config/seshi.toml; ~ is the home folder.",
          ),
      })
      .optional()
      .describe(
        "Serverless mode (F11): this machine runs the pipeline and writes its owner's folder of a shared bucket directly; the bucket's permissions decide what it may do. Set server or serverless, not both.",
      ),
    search: z
      .strictObject({
        enabled: z
          .boolean()
          .optional()
          .describe(
            "Serverless mode: whether this machine keeps a search index (F11.9); the shared config's search.enabled when unset.",
          ),
        scope: z
          .enum(SEARCH_SCOPES)
          .default("visible")
          .describe(
            "Serverless mode: which sessions the index holds: mine, visible (yours and the org's) or all (also others' owner-only sessions).",
          ),
      })
      .prefault({})
      .describe("This machine's search index in serverless mode (F11.9)."),
    user: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The username stated with the org key (X5.7); else git user.email, then the OS user.",
      ),
    theme: z
      .enum(THEMES)
      .default("auto")
      .describe("Terminal colours (B1.4): auto detects the background."),
    keychain: z
      .boolean()
      .default(true)
      .describe(
        "Keep credentials in the OS keychain (F8.2). false keeps them in credentials.json (mode 0600) next to this file, for machines whose keychain prompts, hangs or is absent.",
      ),
    capture: z
      .strictObject({
        enabled: z.boolean().default(true).describe("Capture for this user (F9.5, global level)."),
        paths: z
          .array(capturePath)
          .default([])
          .describe("Rules by folder; the longest match decides."),
        remotes: z
          .array(z.string().min(1))
          .default([])
          .describe(
            "The org rule (F9.5): when set, only repos with a git remote matching one of these patterns are captured (github.com/acme, github.com/acme/*). It can only turn capture off.",
          ),
      })
      .prefault({})
      .describe("Personal capture rules (F9.5)."),
  })
  .superRefine((config, ctx) => {
    if (config.server !== undefined && config.local !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["local"],
        message: "set server (a seshi server) or local (a bucket you own), not both",
      });
    }
    if (config.server !== undefined && config.serverless !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["serverless"],
        message: "set server (a seshi server) or serverless (a shared bucket), not both",
      });
    }
    if (config.local !== undefined && config.serverless !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["local"],
        message: "local is the old name of serverless: keep [serverless] and remove [local]",
      });
    }
    const serverless = config.serverless;
    if (serverless && serverless.url === undefined && serverless.config === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["serverless", "url"],
        message: "set url (the bucket), or config (a server config with a [store])",
      });
    }
  })
  .describe("seshi CLI configuration (~/.config/seshi/config.toml).");

export type CliConfig = z.output<typeof cliConfigSchema>;
export type CapturePath = z.output<typeof capturePath>;
