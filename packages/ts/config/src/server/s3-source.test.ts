/** The `s3` source's settings that the S3 poller (F6) reads. */

import { describe, expect, it } from "vitest";
import { S3_PATH_PLACEHOLDERS, serverConfigSchema } from "./index";

const parse = (source: Record<string, unknown>, store = "s3://seshi/prod") =>
  serverConfigSchema.safeParse({
    store: { url: store },
    sources: [{ id: "in", type: "s3", url: "s3://evals/runs", ...source }],
  });

const issues = (source: Record<string, unknown>, store?: string) => {
  const result = parse(source, store);
  if (result.success) throw new Error("expected issues");
  return result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("an s3 source's path template", () => {
  it("takes the known placeholders", () => {
    const result = parse({ path: "{username}/{project}/{session}.jsonl" });
    expect(result.success).toBe(true);
    expect(S3_PATH_PLACEHOLDERS).toContain("git_email");
    expect(parse({ path: S3_PATH_PLACEHOLDERS.map((p) => `{${p}}`).join("/") }).success).toBe(true);
  });

  it("refuses unknown and repeated placeholders, stray braces and a leading /", () => {
    expect(issues({ path: "{owner}/{session}" })[0]).toContain(
      "sources.0.path: unknown placeholder {owner}",
    );
    expect(issues({ path: "{session}/{session}" })[0]).toContain("{session} appears twice");
    expect(issues({ path: "{session" })[0]).toContain("unmatched");
    expect(issues({ path: "/{session}" })[0]).toContain("no leading /");
  });
});

describe("a folder source (file://)", () => {
  it("may not read seshi's own folder (F6.4)", () => {
    expect(issues({ url: "file:///data/seshi/inbox" }, "file:///data/seshi")[0]).toContain(
      "reads seshi's own bucket",
    );
    expect(issues({ url: "/data" }, "file:///data/seshi")[0]).toContain("reads seshi's own bucket");
    expect(issues({ url: "file:///data/drop/../seshi/./in" }, "file:///data/seshi")[0]).toContain(
      "reads seshi's own bucket",
    );
    expect(parse({ url: "file:///data/drop" }, "file:///data/seshi").success).toBe(true);
    expect(parse({ url: "file:///data/seshi2" }, "file:///data/seshi").success).toBe(true);
    // A folder and a bucket never overlap.
    expect(parse({ url: "file:///seshi/prod" }).success).toBe(true);
  });
});
