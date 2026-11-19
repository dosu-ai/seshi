import { describe, expect, it } from "vitest";
import {
  type Fetch,
  INSTALL_ACCEPT,
  installedNames,
  missing,
  packumentUrl,
  waitForNpm,
} from "./wait-npm";

const REGISTRY = "https://registry.example";

/** A stand-in registry: `serves(name, poll)` lists the versions it serves on that poll (1-based),
 * or a status code; every request is recorded. */
function fakeRegistry(serves: (name: string, poll: number) => string[] | number | Error) {
  const polls = new Map<string, number>();
  const requests: { url: string; accept: string }[] = [];
  const fetch: Fetch = async (url, init) => {
    requests.push({ url, accept: init.headers.accept as string });
    const name = decodeURIComponent(url.slice(REGISTRY.length + 1));
    const poll = (polls.get(name) ?? 0) + 1;
    polls.set(name, poll);
    const got = serves(name, poll);
    if (got instanceof Error) throw got;
    if (typeof got === "number") return { status: got, json: async () => ({ error: "Not found" }) };
    return {
      status: 200,
      json: async () => ({ name, versions: Object.fromEntries(got.map((v) => [v, {}])) }),
    };
  };
  return { fetch, requests };
}

function clock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe("wait-npm", () => {
  it("names the launcher and every platform package", () => {
    expect(installedNames()).toEqual([
      "@dosu/seshi",
      "@dosu/seshi-darwin-arm64",
      "@dosu/seshi-darwin-x64",
      "@dosu/seshi-linux-x64",
      "@dosu/seshi-linux-arm64",
      "@dosu/seshi-windows-x64",
      "@dosu/seshi-windows-arm64",
    ]);
  });

  it("asks for the install packument of the scoped name", async () => {
    expect(packumentUrl(`${REGISTRY}/`, "@dosu/seshi")).toBe(`${REGISTRY}/@dosu%2fseshi`);
    const reg = fakeRegistry(() => ["1.0.0"]);
    expect(await missing(reg.fetch, REGISTRY, "@dosu/seshi", "1.0.0")).toBeNull();
    expect(reg.requests).toEqual([{ url: `${REGISTRY}/@dosu%2fseshi`, accept: INSTALL_ACCEPT }]);
  });

  it("says why a version is not served", async () => {
    const at = (got: string[] | number | Error) => fakeRegistry(() => got).fetch;
    expect(await missing(at(404), REGISTRY, "@dosu/seshi", "1.0.0")).toBe("HTTP 404");
    expect(await missing(at(["0.9.0"]), REGISTRY, "@dosu/seshi", "1.0.0")).toBe(
      "1.0.0 not listed yet",
    );
    expect(await missing(at(new Error("ECONNRESET")), REGISTRY, "@dosu/seshi", "1.0.0")).toBe(
      "request failed: ECONNRESET",
    );
  });

  it("returns once every package serves the version, polling only the ones still missing", async () => {
    // a: there at once; b: 404 twice, then served; c: an older version first, then this one.
    const reg = fakeRegistry((name, poll) => {
      if (name === "b") return poll <= 2 ? 404 : ["1.0.0"];
      if (name === "c") return poll === 1 ? ["0.9.0"] : ["0.9.0", "1.0.0"];
      return ["1.0.0"];
    });
    const c = clock();
    const lines: string[] = [];
    await waitForNpm({
      names: ["a", "b", "c"],
      version: "1.0.0",
      registry: REGISTRY,
      fetch: reg.fetch,
      ...c,
      intervalMs: 10_000,
      log: (l) => lines.push(l),
    });
    expect(reg.requests.map((r) => r.url.slice(REGISTRY.length + 1))).toEqual([
      "a",
      "b",
      "c",
      "b",
      "c",
      "b",
    ]);
    expect(c.now()).toBe(20_000);
    expect(lines[1]).toBe("waiting 10s for b (HTTP 404), c (1.0.0 not listed yet)");
  });

  it("gives up after the timeout, naming what is still missing", async () => {
    const reg = fakeRegistry((name) => (name === "gone" ? 404 : ["1.0.0"]));
    const c = clock();
    await expect(
      waitForNpm({
        names: ["here", "gone"],
        version: "1.0.0",
        registry: REGISTRY,
        fetch: reg.fetch,
        ...c,
        timeoutMs: 60_000,
        intervalMs: 15_000,
      }),
    ).rejects.toThrow("after 60s the registry still does not serve 1.0.0 of gone (HTTP 404)");
    expect(reg.requests.filter((r) => r.url.endsWith("/gone"))).toHaveLength(5);
  });
});
