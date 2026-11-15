import { describe, expect, it } from "vitest";
import { parseS3Url } from "./s3";

describe("parseS3Url", () => {
  it("splits scheme, bucket and prefix", () => {
    expect(parseS3Url("s3://b/p/q/")).toEqual({ scheme: "s3", bucket: "b", prefix: "p/q" });
    expect(parseS3Url("r2://b")).toEqual({ scheme: "r2", bucket: "b", prefix: "" });
    expect(() => parseS3Url("gs://b")).toThrow();
  });
});
