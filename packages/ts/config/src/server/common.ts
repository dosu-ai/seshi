/** Field types several sections share. */

import * as z from "zod";

/** Who may read a session (X5.10): `org`, every member; `owner`, only its owner. Admins and
 * services always see everything. */
export const VISIBILITIES = ["org", "owner"] as const;
export const visibility = z.enum(VISIBILITIES);
export type Visibility = z.output<typeof visibility>;

/** Where sessions are kept, or where a source reads from: `s3://bucket/prefix`,
 * `r2://bucket/prefix`, or `file:///path` (a bare absolute path too). */
export const STORE_URL = /^(?:file:\/\/\/?.*|\/.*|(?:s3|r2):\/\/[^/\s]+(?:\/.*)?)$/;

export const storeUrl = z
  .string()
  .regex(STORE_URL, "a store URL: s3://bucket/prefix, r2://bucket/prefix or file:///path");

/** An `http(s)://` URL. */
export const httpUrl = z.url({ protocol: /^https?$/, error: "an http:// or https:// URL" });

/** A source id: lower-case letters, digits and `-`, as in `datadog-prod`. Its service account
 * is `svc:<id>` (X5.4). */
export const sourceId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "lower-case letters, digits and -, up to 63 characters");
