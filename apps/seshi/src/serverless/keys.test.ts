import { describe, expect, it } from "vitest";
import type { SecretBackend } from "../account/secrets";
import { bucketKeyCredentials, bucketKeyFromEnv, readBucketKey, saveBucketKey } from "./keys";

function memory(): SecretBackend {
  const kept = new Map<string, string>();
  return {
    kind: "test",
    get: async (name) => kept.get(name) ?? null,
    set: async (name, value) => {
      kept.set(name, value);
    },
    delete: async (name) => kept.delete(name),
  };
}

describe("a bucket key", () => {
  it("is taken from AZURE_STORAGE_KEY, else AZURE_STORAGE_SAS_TOKEN, for az://", () => {
    const env = { AWS_ACCESS_KEY_ID: "AKID", AWS_SECRET_ACCESS_KEY: "s" };
    expect(bucketKeyFromEnv({ ...env, AZURE_STORAGE_KEY: "k" }, "az://c/p")).toEqual({
      account_key: "k",
    });
    expect(bucketKeyFromEnv({ AZURE_STORAGE_SAS_TOKEN: "sig=x" }, "az://c")).toEqual({
      sas_token: "sig=x",
    });
    expect(bucketKeyFromEnv(env, "az://c")).toBeUndefined();
    expect(bucketKeyFromEnv({ ...env, AZURE_STORAGE_KEY: "k" }, "s3://b")).toEqual({
      access_key_id: "AKID",
      secret_access_key: "s",
    });
  });

  it("is the key file GOOGLE_APPLICATION_CREDENTIALS names, for gs://", () => {
    const read = (path: string) => `{"path":"${path}"}`;
    expect(
      bucketKeyFromEnv({ GOOGLE_APPLICATION_CREDENTIALS: "/k.json" }, "gs://b/p", read),
    ).toEqual({ service_account_key: '{"path":"/k.json"}' });
    expect(bucketKeyFromEnv({ AWS_ACCESS_KEY_ID: "a" }, "gs://b", read)).toBeUndefined();
  });

  it("is kept and read back in each of its kinds, as the store takes it", async () => {
    const secrets = memory();
    for (const key of [
      { access_key_id: "AKID", secret_access_key: "s", session_token: "t" },
      { account_key: "k" },
      { sas_token: "sig=x" },
      { service_account_key: '{"type":"service_account"}' },
    ]) {
      await saveBucketKey(secrets, "az://c", key);
      expect(await readBucketKey(secrets, "az://c")).toEqual(key);
    }
    expect(bucketKeyCredentials({ account_key: "k" })).toEqual({ accountKey: "k" });
    expect(bucketKeyCredentials({ sas_token: "sig=x" })).toEqual({ sasToken: "sig=x" });
    expect(bucketKeyCredentials({ service_account_key: "{}" })).toEqual({
      serviceAccountKey: "{}",
    });
    expect(bucketKeyCredentials({ access_key_id: "a", secret_access_key: "s" })).toEqual({
      accessKeyId: "a",
      secretAccessKey: "s",
    });
  });
});
