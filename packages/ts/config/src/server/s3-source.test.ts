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

describe("a source's labels", () => {
  it("are strings under keys as labels are, at most 32", () => {
    expect(parse({ labels: { "dosu.member": "alice", team: "evals" } }).success).toBe(true);
    expect(issues({ labels: { Team: "x" } })[0]).toContain("sources.0.labels.Team");
    expect(issues({ labels: { team: "" } })[0]).toContain("sources.0.labels.team");
    expect(issues({ labels: { team: "x".repeat(513) } })[0]).toContain("sources.0.labels.team");
    expect(issues({ labels: { team: { env: "X" } } })[0]).toContain("sources.0.labels.team");
    const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, "v"]));
    expect(issues({ labels: many })[0]).toContain("at most 32 labels");
  });
});

describe("an Azure source (az://)", () => {
  it("takes an account name and key, and never reads seshi's own container", () => {
    expect(
      parse({ url: "az://evals/runs", account_name: "acct", credentials: { sas_token: "sig=x" } })
        .success,
    ).toBe(true);
    expect(issues({ url: "az://seshi/prod/inbox" }, "az://seshi/prod")[0]).toContain(
      "reads seshi's own bucket",
    );
    expect(parse({ url: "az://seshi/staging" }, "az://seshi/prod").success).toBe(true);
    // An S3 bucket and an Azure container of the same name are different buckets.
    expect(parse({ url: "az://seshi/prod" }, "s3://seshi/prod").success).toBe(true);
  });

  it("refuses a role, which is AWS STS, and S3 keys", () => {
    expect(issues({ url: "az://evals", role: { arn: "arn:aws:iam::1:role/r" } })).toEqual([
      "sources.0.role: role applies to s3:// sources (AWS STS); an az:// source takes keys or workload identity",
    ]);
    expect(
      issues({ url: "az://evals", credentials: { access_key_id: "a", secret_access_key: "s" } })[0],
    ).toContain("an az:// bucket takes account_key or sas_token");
  });
});

describe("a Google Cloud Storage source (gs://)", () => {
  it("takes a service account key or none, and never reads seshi's own bucket", () => {
    expect(
      parse({ url: "gs://evals/runs", credentials: { service_account_key: "{}" } }).success,
    ).toBe(true);
    expect(parse({ url: "gs://evals/runs" }).success).toBe(true);
    expect(issues({ url: "gs://seshi/prod/inbox" }, "gs://seshi/prod")[0]).toContain(
      "reads seshi's own bucket",
    );
    expect(parse({ url: "gs://seshi/prod" }, "s3://seshi/prod").success).toBe(true);
  });

  it("refuses a role and keys for other buckets", () => {
    expect(issues({ url: "gs://evals", role: { arn: "arn:aws:iam::1:role/r" } })).toEqual([
      "sources.0.role: role applies to s3:// sources (AWS STS); a gs:// source takes a service account key or Application Default Credentials",
    ]);
    expect(issues({ url: "gs://evals", credentials: { sas_token: "sig=x" } })[0]).toContain(
      "a gs:// bucket takes service_account_key",
    );
  });
});
