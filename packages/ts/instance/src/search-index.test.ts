import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  checkServerConfig,
  loadConfig,
  type ServerConfig,
  serverConfigSchema,
} from "@seshi/config";
import { BUILTIN_FORMATS, FormatRegistry } from "@seshi/formats";
import { provideLance } from "@seshi/search";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildInstance, InstanceError } from "./instance";
import { LanceMissing, lanceLocation, revealedAccess, searchOpener } from "./search-index";
import { SEARCH_JOB } from "./search-job";

const formats = new FormatRegistry([...BUILTIN_FORMATS]);

function config(toml: string, env: Record<string, string> = {}): ServerConfig {
  return loadConfig(serverConfigSchema, {
    file: "seshi.toml",
    env,
    fs: { readFile: () => toml, mode: () => 0o100600 },
  }).config;
}

const LANCE = '[search]\nbackend = "lance"\n';

describe("lanceLocation (F10.9)", () => {
  it("puts the index under search/<deployment> in a folder store", () => {
    const c = config(`[store]\nurl = "file:///srv/seshi"\n${LANCE}`);
    expect(lanceLocation(c, "dep-1", {})).toEqual({
      uri: "/srv/seshi/search/dep-1",
      storageOptions: {},
    });
  });

  it("gives LanceDB [store]'s S3 keys as options, never in the URI", () => {
    const c = config(
      `[store]\nurl = "s3://acme/seshi/"\nendpoint = "http://127.0.0.1:9000"\nregion = "eu-west-1"\ncredentials = { access_key_id = "AKID", secret_access_key = "SECRET" }\n${LANCE}`,
    );
    const where = lanceLocation(c, "dep-1", {});
    expect(where.uri).toBe("s3://acme/seshi/search/dep-1");
    expect(where.uri).not.toContain("SECRET");
    expect(where.storageOptions).toEqual({
      aws_access_key_id: "AKID",
      aws_secret_access_key: "SECRET",
      aws_endpoint: "http://127.0.0.1:9000",
      aws_region: "eu-west-1",
      allow_http: "true",
    });
  });

  it("reads the same environment the store does: S3_*, AWS_*, R2_*", () => {
    const s3 = config(`[store]\nurl = "s3://acme"\n${LANCE}`);
    expect(
      lanceLocation(s3, "d", {
        S3_ACCESS_KEY_ID: "k",
        AWS_SECRET_ACCESS_KEY: "s",
        AWS_SESSION_TOKEN: "t",
        AWS_REGION: "us-west-2",
      }).storageOptions,
    ).toEqual({
      aws_access_key_id: "k",
      aws_secret_access_key: "s",
      aws_session_token: "t",
      aws_region: "us-west-2",
    });
    const r2 = config(`[store]\nurl = "r2://acme/p"\naccount_id = "abc"\n${LANCE}`);
    expect(lanceLocation(r2, "d", { R2_ACCESS_KEY_ID: "rk", R2_SECRET_ACCESS_KEY: "rs" })).toEqual({
      uri: "s3://acme/p/search/d",
      storageOptions: {
        aws_access_key_id: "rk",
        aws_secret_access_key: "rs",
        aws_endpoint: "https://abc.r2.cloudflarestorage.com",
        aws_region: "auto",
      },
    });
  });

  it("maps Azure and Google keys to their own options", () => {
    const az = config(
      `[store]\nurl = "az://sessions/p"\naccount_name = "acct"\ncredentials = { sas_token = "?sv=1&sig=x" }\n${LANCE}`,
    );
    expect(lanceLocation(az, "d", {})).toEqual({
      uri: "az://sessions/p/search/d",
      storageOptions: { azure_storage_account_name: "acct", azure_storage_sas_token: "sv=1&sig=x" },
    });
    const gs = config(
      `[store]\nurl = "gs://b/p"\ncredentials = { service_account_key = "{}" }\n${LANCE}`,
    );
    expect(lanceLocation(gs, "d", {})).toEqual({
      uri: "gs://b/p/search/d",
      storageOptions: { google_service_account_key: "{}" },
    });
  });

  it("takes search.lance.uri with its own keys, or [store]'s for another prefix of the same bucket", () => {
    const store = `[store]\nurl = "s3://acme/seshi"\ncredentials = { access_key_id = "STORE", secret_access_key = "S" }\n`;
    const same = config(`${store}${LANCE}[search.lance]\nuri = "s3://acme/index"\n`);
    expect(lanceLocation(same, "d", {})).toMatchObject({
      uri: "s3://acme/index",
      storageOptions: { aws_access_key_id: "STORE" },
    });
    const other = config(
      `${store}${LANCE}[search.lance]\nuri = "s3://elsewhere/index"\nregion = "us-east-2"\ncredentials = { access_key_id = "OWN", secret_access_key = "O" }\n`,
    );
    expect(lanceLocation(other, "d", {}).storageOptions).toMatchObject({
      aws_access_key_id: "OWN",
      aws_region: "us-east-2",
    });
    expect(revealedAccess(other)).toMatchObject({ region: "us-east-2" });
    // Another bucket with no keys of its own does not borrow [store]'s.
    const bare = config(`${store}${LANCE}[search.lance]\nuri = "s3://elsewhere/index"\n`);
    expect(lanceLocation(bare, "d", {}).storageOptions.aws_access_key_id).toBeUndefined();
    const folder = config(`${store}${LANCE}[search.lance]\nuri = "file:///var/lib/seshi"\n`);
    expect(lanceLocation(folder, "d", {}).uri).toBe("/var/lib/seshi");
  });
});

describe("[search.lance] config", () => {
  it("refuses keys for a uri it does not have, and keys of the wrong kind", () => {
    const store = '[store]\nurl = "s3://acme"\n';
    expect(() => config(`${store}${LANCE}[search.lance]\nregion = "x"\n`)).toThrow(ConfigError);
    expect(() =>
      config(
        `${store}${LANCE}[search.lance]\nuri = "az://c/p"\ncredentials = { access_key_id = "a", secret_access_key = "b" }\n`,
      ),
    ).toThrow(/account_key or sas_token/);
  });

  it("warns that search.path is not read with LanceDB", () => {
    const c = config(`[store]\nurl = "s3://acme"\n${LANCE}path = "/tmp/x.sqlite"\n`);
    expect(checkServerConfig(c).warnings.join("\n")).toContain("search.path is not read");
  });
});

describe("searchOpener and the search job's placement (F10.8)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seshi-search-index-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const toml = (backend: string) =>
    `[store]\nurl = "file://${join(dir, "bucket")}"\n[search]\nbackend = "${backend}"\n[search.lance]\nread_consistency = "2s"\nmax_scored_rows = 500\n`;

  it("SQLite needs no opener", () => {
    expect(
      searchOpener(config(toml("sqlite")), { deployment: "d", env: {}, readOnly: false }),
    ).toBeUndefined();
  });

  it("a binary without LanceDB refuses backend = lance, saying which build has it", async () => {
    expect(() =>
      searchOpener(config(toml("lance")), { deployment: "d", env: {}, readOnly: true }),
    ).toThrow(LanceMissing);
    await expect(
      buildInstance(config(toml("lance")), { formats, env: {}, id: "t" }),
    ).rejects.toThrow(InstanceError);
  });

  it("opens LanceDB read-only on API instances; the worker alone runs the indexer", async () => {
    const opened: { readOnly?: boolean; readConsistency?: number; maxScoredRows?: number }[] = [];
    provideLance((options) => {
      opened.push(options);
      return () => Promise.reject(new Error("not opened in this test"));
    });
    const c = config(toml("lance"));
    const jobsOf = async (roles: ("api" | "worker")[]) => {
      const instance = await buildInstance(c, { formats, env: {}, id: "t", roles });
      try {
        return {
          shared: instance.search?.shared,
          job: instance.jobs.list().find((j) => j.name === SEARCH_JOB)?.placement,
        };
      } finally {
        await instance.close();
      }
    };
    expect(await jobsOf(["api"])).toEqual({ shared: true, job: undefined });
    expect(await jobsOf(["worker"])).toEqual({ shared: true, job: "worker" });
    expect(await jobsOf(["api", "worker"])).toEqual({ shared: true, job: "worker" });
    expect(opened.map((o) => o.readOnly)).toEqual([true, false, false]);
    expect(opened[0]).toMatchObject({ readConsistency: 2, maxScoredRows: 500 });

    // SQLite: every API instance indexes its own file; a worker without the api role, none.
    const sqlite = config(`${toml("sqlite")}`, { SESHI_SEARCH__PATH: ":memory:" });
    const api = await buildInstance(sqlite, { formats, env: {}, id: "t", roles: ["worker"] });
    expect(api.jobs.list().some((j) => j.name === SEARCH_JOB)).toBe(false);
    await api.close();
  });
});
