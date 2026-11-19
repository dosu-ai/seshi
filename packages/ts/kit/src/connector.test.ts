import { describe, expect, it } from "vitest";
import { abortableSleep, apiUrlOverride, secretValue, serviceEnvelopeIdentity } from "./connector";

describe("connector helpers", () => {
  it("reveals a secret, and names the source and field when it is missing", () => {
    expect(secretValue("k", "datadog", "api_key")).toBe("k");
    expect(secretValue({ reveal: () => "s" }, "cursor-cloud", "api_key")).toBe("s");
    expect(() => secretValue("", "cursor-cloud", "api_key")).toThrow(
      "the cursor-cloud source needs api_key",
    );
  });

  it("takes an https API URL, or http to localhost only", () => {
    expect(apiUrlOverride(undefined, "x", "the key")).toBeUndefined();
    expect(apiUrlOverride("https://api.example.com", "x", "the key")).toBe(
      "https://api.example.com",
    );
    expect(apiUrlOverride("http://127.0.0.1:8080", "x", "the key")).toBe("http://127.0.0.1:8080");
    expect(() => apiUrlOverride("http://example.com", "x", "the key")).toThrow(
      "the x source's api_url must be https (plain http would send the key in clear); http is allowed for localhost only",
    );
    expect(() => apiUrlOverride("ftp://example.com", "x", "the key")).toThrow("must be https");
    expect(() => apiUrlOverride("not a url", "x", "the key")).toThrow("is not a URL");
  });

  it("files a poller's envelopes under its service account", () => {
    expect(serviceEnvelopeIdentity("cursor-team")).toEqual({
      caller: { kind: "service", principal: "svc:cursor-team" },
      owner: "svc:cursor-team",
      owner_basis: "service",
    });
  });

  it("sleeps until the signal aborts", async () => {
    const controller = new AbortController();
    const sleeping = abortableSleep(60_000, controller.signal);
    controller.abort(new Error("stop"));
    await expect(sleeping).rejects.toThrow("stop");
    await expect(abortableSleep(1, new AbortController().signal)).resolves.toBeUndefined();
  });
});
