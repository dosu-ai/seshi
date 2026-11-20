import { labelProblem, MAX_LABELS } from "@seshi/model/labels";
import * as z from "zod";
import { excludeEntry } from "./server/capture";
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

export const labelValue = z
  .union([
    z.string().describe("A fixed value."),
    z
      .strictObject({
        env: z
          .string()
          .min(1)
          .describe(
            "An environment variable of the agent the session runs in; the label is absent when it is unset or empty.",
          ),
      })
      .describe("A value read from the agent's environment when the session is first seen."),
  ])
  .describe('A label\'s value: a string, or { env = "NAME" }.');

export const labelPath = z
  .object({
    path: z
      .string()
      .min(1)
      .describe("A folder; ~ is the home folder. Matched as [[capture.paths]] is."),
  })
  .catchall(labelValue)
  .describe(
    "Labels for sessions in a folder: every other key is a label. The longest matching folder wins, key by key.",
  );

export const labelsSection = z
  .object({
    paths: z
      .array(labelPath)
      .default([])
      .describe("Labels by folder; they win over the labels set here."),
  })
  .catchall(labelValue)
  .prefault({})
  .describe(
    'Labels attached to each session when it is first seen (keys [a-z0-9][a-z0-9._-]{0,63}, values up to 512 characters, at most 32): every key but paths is a label, a string or { env = "NAME" }. Per key, a [[labels.paths]] entry wins, then these, then the repo\'s .seshi/config.toml.',
  );

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
        exclude: z
          .array(excludeEntry)
          .default([])
          .describe(
            "An exclude list of this machine's, added to the server's (the org's list, [capture] exclude, which the uploader downloads): sessions in these repositories (owner/name on any host, host/owner/name on one) or folders (starting with /, ~, a drive or \\\\server, and everything under them) are never captured. * matches within a path segment, ** across any number of them; blank entries and # comments are skipped. It can only turn capture off.",
          ),
        redact_tool_calls: z
          .array(excludeEntry)
          .default([])
          .describe(
            "A list of this machine's, added to the server's ([capture] redact_tool_calls, which the uploader downloads), of places whose sessions are uploaded with every tool call's input and output replaced by [redacted:tool-call]: prompts, replies, reasoning, tool names, call ids, their order and whether each failed are kept. Entries are written and matched as in capture.exclude, which wins for a place on both lists.",
          ),
      })
      .prefault({})
      .describe("Personal capture rules (F9.5)."),
    labels: labelsSection,
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

/** zod types `[labels]` with an index signature `paths` cannot satisfy: `LabelsConfig` says it. */
export type CliConfig = Omit<z.output<typeof cliConfigSchema>, "labels"> & { labels: LabelsConfig };
export type CapturePath = z.output<typeof capturePath>;
export type LabelValue = z.output<typeof labelValue>;
/** `[labels]` as loaded: `paths`, and every other key a label. */
export interface LabelsConfig {
  paths: ({ path: string } & Record<string, LabelValue>)[];
  [key: string]: LabelValue | LabelsConfig["paths"];
}

/** The labels of a `[labels]` table or a `[[labels.paths]]` entry, without `paths` or `path`. */
export function labelEntries(
  table: Readonly<Record<string, unknown>>,
  reserved: "paths" | "path",
): [string, LabelValue][] {
  return Object.entries(table).filter(([key]) => key !== reserved) as [string, LabelValue][];
}

/** What is wrong with the CLI config's labels: a key or fixed value out of the limits, an entry
 * that would give a session more than the labels allowed. Not a load error: a hook drops such a
 * label and logs why; `seshi config check` and `seshi doctor` report it. */
export function cliLabelProblems(labels: LabelsConfig): string[] {
  const problems: string[] = [];
  const check = (entries: [string, LabelValue][], where: string) => {
    for (const [key, value] of entries) {
      const problem = labelProblem(key, typeof value === "string" ? value : "x");
      if (problem) problems.push(`${where}: ${problem}`);
    }
  };
  const top = labelEntries(labels, "paths");
  check(top, "[labels]");
  const keys = new Set(top.map(([key]) => key));
  if (keys.size > MAX_LABELS) {
    problems.push(`[labels]: ${keys.size} labels; at most ${MAX_LABELS} are allowed`);
  }
  for (const entry of labels.paths) {
    const own = labelEntries(entry, "path");
    const where = `[[labels.paths]] ${entry.path}`;
    check(own, where);
    const all = new Set([...keys, ...own.map(([key]) => key)]);
    if (all.size > MAX_LABELS && keys.size <= MAX_LABELS) {
      problems.push(
        `${where}: with [labels], ${all.size} labels; at most ${MAX_LABELS} are allowed`,
      );
    }
  }
  return problems;
}
