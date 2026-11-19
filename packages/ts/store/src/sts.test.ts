import { describe, expect, it } from "vitest";
import { S3HttpError } from "./s3-fetch";
import { assumeRole } from "./sts";

const credentials = { accessKeyId: "AKID", secretAccessKey: "secret" };

const OK = `<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <AssumeRoleResult><Credentials>
    <AccessKeyId>ASIAEXAMPLE</AccessKeyId>
    <SecretAccessKey>s3cr3t</SecretAccessKey>
    <SessionToken>tok&amp;en</SessionToken>
    <Expiration>2026-11-14T13:00:00Z</Expiration>
  </Credentials></AssumeRoleResult></AssumeRoleResponse>`;

function sts(respond: () => Response) {
  const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fetch = async (input: string, init?: RequestInit) => {
    seen.push({
      url: input,
      headers: init?.headers as Record<string, string>,
      body: new TextDecoder().decode(init?.body as Uint8Array),
    });
    return respond();
  };
  return { fetch, seen };
}

describe("assumeRole", () => {
  it("posts a signed AssumeRole with the external id and returns the role's keys", async () => {
    const { fetch, seen } = sts(() => new Response(OK));
    const keys = await assumeRole({
      roleArn: "arn:aws:iam::123456789012:role/seshi-read",
      sessionName: "seshi-evals",
      externalId: "ext-1",
      credentials,
      fetch,
    });
    expect(keys).toEqual({
      accessKeyId: "ASIAEXAMPLE",
      secretAccessKey: "s3cr3t",
      sessionToken: "tok&en",
      expiration: new Date("2026-11-14T13:00:00Z"),
    });
    expect(seen[0]?.url).toBe("https://sts.amazonaws.com/");
    const form = new URLSearchParams(seen[0]?.body);
    expect(Object.fromEntries(form)).toEqual({
      Action: "AssumeRole",
      Version: "2011-06-15",
      RoleArn: "arn:aws:iam::123456789012:role/seshi-read",
      RoleSessionName: "seshi-evals",
      DurationSeconds: "3600",
      ExternalId: "ext-1",
    });
    expect(seen[0]?.headers.authorization).toContain("/us-east-1/sts/aws4_request");
    expect(seen[0]?.headers["content-type"]).toContain("x-www-form-urlencoded");
  });

  it("uses the regional endpoint when a region is set", async () => {
    const { fetch, seen } = sts(() => new Response(OK));
    await assumeRole({ roleArn: "r", sessionName: "s", credentials, region: "eu-west-1", fetch });
    expect(seen[0]?.url).toBe("https://sts.eu-west-1.amazonaws.com/");
    expect(seen[0]?.headers.authorization).toContain("/eu-west-1/sts/aws4_request");
    expect(new URLSearchParams(seen[0]?.body).has("ExternalId")).toBe(false);
  });

  it("throws STS's refusal, and an answer without keys", async () => {
    const denied = sts(
      () =>
        new Response(
          "<ErrorResponse><Error><Code>AccessDenied</Code><Message>no</Message></Error></ErrorResponse>",
          { status: 403 },
        ),
    );
    const err = await assumeRole({
      roleArn: "r",
      sessionName: "s",
      credentials,
      fetch: denied.fetch,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(S3HttpError);
    expect((err as S3HttpError).code).toBe("AccessDenied");
    expect(String(err)).toContain("403 AccessDenied: no");
    const empty = sts(() => new Response("<AssumeRoleResponse/>"));
    await expect(
      assumeRole({ roleArn: "r", sessionName: "s", credentials, fetch: empty.fetch }),
    ).rejects.toThrow(/without credentials/);
  });
});
