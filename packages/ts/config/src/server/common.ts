import * as z from "zod";

export const VISIBILITIES = ["org", "owner"] as const;
export const visibility = z.enum(VISIBILITIES);
export type Visibility = z.output<typeof visibility>;

export const STORE_URL = /^(?:file:\/\/\/?.*|\/.*|(?:s3|r2):\/\/[^/\s]+(?:\/.*)?)$/;

export const storeUrl = z
  .string()
  .regex(STORE_URL, "a store URL: s3://bucket/prefix, r2://bucket/prefix or file:///path");

export const httpUrl = z.url({ protocol: /^https?$/, error: "an http:// or https:// URL" });

export const sourceId = z
  .string()
  .max(63)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "lower-case letters and digits, words joined by single -, up to 63 characters",
  );
