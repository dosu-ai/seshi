/** The server's config (`seshi.toml`, F1.4): one strict schema from its sections. This file is
 * the schema index: a later branch adds or refines its section in its own file and adds one
 * line here. `spec/config.schema.json` is generated from it (`bun run schema`). */

import * as z from "zod";
import { authSection } from "./auth";
import { captureSection } from "./capture";
import { visibility } from "./common";
import { filterSection } from "./filter";
import { limitsSection } from "./limits";
import { recordsSection } from "./records";
import { redactionSection } from "./redaction";
import { reviewSection } from "./review";
import { searchSection } from "./search";
import { serverSection } from "./server";
import { sourcesSection, UPLOAD_SOURCE_ID } from "./sources";
import { storeSection } from "./store";
import { workerSection } from "./worker";

const sections = z.strictObject({
  server: serverSection,
  store: storeSection,
  auth: authSection,
  default_visibility: visibility
    .default("org")
    .describe("Visibility of a session nothing else sets (X5.10): org or owner."),
  filter: filterSection,
  limits: limitsSection,
  records: recordsSection,
  redaction: redactionSection,
  review: reviewSection,
  sources: sourcesSection,
  search: searchSection,
  worker: workerSection,
  capture: captureSection,
});

/** `scheme`, `bucket` and key prefix of a bucket URL; `undefined` for a folder. */
function bucketOf(url: string, extra = ""): { at: string; prefix: string } | undefined {
  const match = /^(s3|r2):\/\/([^/]+)\/?(.*)$/.exec(url);
  if (!match) return undefined;
  const prefix = [match[3], extra]
    .map((p) => (p ?? "").replace(/^\/+|\/+$/g, ""))
    .filter((p) => p !== "")
    .join("/");
  return { at: `${match[1]}://${match[2]}`, prefix };
}

function overlaps(a: string, b: string): boolean {
  const inside = (outer: string, inner: string) =>
    outer === "" || inner === outer || inner.startsWith(`${outer}/`);
  return inside(a, b) || inside(b, a);
}

export const serverConfigSchema = sections
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    config.sources.forEach((source, i) => {
      if (seen.has(source.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["sources", i, "id"],
          message: `id '${source.id}' is used twice`,
        });
      }
      seen.add(source.id);
      if (source.type === "s3") {
        const own = bucketOf(config.store.url);
        const read = bucketOf(source.url, source.prefix);
        if (own && read && own.at === read.at && overlaps(own.prefix, read.prefix)) {
          ctx.addIssue({
            code: "custom",
            path: ["sources", i, "url"],
            message:
              "reads seshi's own bucket and prefix (store.url); a source must point elsewhere (F6.4)",
          });
        }
      }
    });
    const keys = Object.keys(config.auth.session_keys);
    const keyId = config.auth.session_key_id;
    if (keyId !== undefined && !keys.includes(keyId)) {
      ctx.addIssue({
        code: "custom",
        path: ["auth", "session_key_id"],
        message: `names no key in auth.session_keys (${keys.join(", ") || "none"})`,
      });
    }
    if (keyId === undefined && keys.length > 1) {
      ctx.addIssue({
        code: "custom",
        path: ["auth", "session_key_id"],
        message: "required when auth.session_keys holds more than one key: which one signs",
      });
    }
    const policies = new Set<string>();
    config.review.policies.forEach((policy, i) => {
      if (policies.has(policy.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["review", "policies", i, "id"],
          message: `id '${policy.id}' is used twice`,
        });
      }
      policies.add(policy.id);
      policy.sources.forEach((id, j) => {
        if (id !== UPLOAD_SOURCE_ID && !seen.has(id)) {
          ctx.addIssue({
            code: "custom",
            path: ["review", "policies", i, "sources", j],
            message: `no source with id '${id}' (or '${UPLOAD_SOURCE_ID}' for uploads)`,
          });
        }
      });
    });
  })
  .describe(
    "seshi server configuration (seshi.toml). Precedence: flags, then SESHI_* env, then this file, then defaults.",
  );

export type ServerConfig = z.output<typeof serverConfigSchema>;

/** The session filter for `sourceId`: `[filter]` with the source's overrides. Uploads, and
 * any id not in `[[sources]]`, get `[filter]` itself. */
export function filterFor(config: ServerConfig, sourceId: string): ServerConfig["filter"] {
  const source = config.sources.find((s) => s.id === sourceId);
  const override = Object.fromEntries(
    Object.entries(source?.filter ?? {}).filter(([, value]) => value !== undefined),
  );
  return { ...config.filter, ...override };
}

/** Which key signs new session tokens: `session_key_id`, else the only key. */
export function signingKeyId(config: ServerConfig): string | undefined {
  return config.auth.session_key_id ?? Object.keys(config.auth.session_keys)[0];
}

export { type AuthSection, authSection, type OidcSection, oidcSection } from "./auth";
export { type CaptureSection, captureSection } from "./capture";
export { STORE_URL, VISIBILITIES, type Visibility } from "./common";
export { type FilterOverride, type FilterSection, filterSection } from "./filter";
export { type LimitsSection, limitsSection } from "./limits";
export { type RecordsSection, recordsSection } from "./records";
export { type RedactionSection, redactionSection } from "./redaction";
export { PROVIDERS, type ReviewPolicy, type ReviewSection, reviewSection } from "./review";
export { type SearchSection, searchSection } from "./search";
export { parseListen, ROLES, type ServerSection, serverSection } from "./server";
export {
  type SourceConfig,
  type SourceType,
  sourcesSection,
  UPLOAD_SOURCE_ID,
} from "./sources";
export { type StoreSection, storeSection, TRACE_FORMATS } from "./store";
export { type WorkerSection, workerSection } from "./worker";
