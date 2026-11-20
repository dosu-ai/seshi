import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { distTag, type Exec, isPublished, isTransient, publishAll } from "./publish-npm";

/** A stand-in npm: records every call; `published` lists `name@version`s the registry has. */
function fakeNpm(published: string[] = [], failPublish?: string) {
  const calls: string[][] = [];
  const exec: Exec = async (argv) => {
    calls.push(argv);
    if (argv[0] === "view") {
      const spec = argv[1] as string;
      return published.includes(spec)
        ? { code: 0, out: `"${spec.split("@").at(-1)}"\n`, err: "" }
        : { code: 1, out: "", err: `npm error code E404\nnpm error 404 Not Found - GET ${spec}` };
    }
    if (argv[0] === "publish" && failPublish && (argv[1] as string).endsWith(failPublish)) {
      return { code: 1, out: "", err: "npm error 403 Forbidden" };
    }
    return { code: 0, out: "", err: "" };
  };
  return { exec, calls };
}

describe("publishAll", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seshi-publish-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function layout(version: string, packages: { name: string; dir: string; private?: boolean }[]) {
    for (const p of packages) {
      mkdirSync(join(dir, p.dir), { recursive: true });
      writeFileSync(
        join(dir, p.dir, "package.json"),
        JSON.stringify({ name: p.name, version, ...(p.private ? { private: true } : {}) }),
      );
    }
    writeFileSync(
      join(dir, "packages.json"),
      JSON.stringify(packages.map((p) => ({ name: p.name, dir: p.dir }))),
    );
  }

  const PACKAGES = [
    { name: "@dosu/seshi-darwin-arm64", dir: "cli-darwin-arm64" },
    { name: "@dosu/seshi-model", dir: "model" },
    { name: "seshi", dir: "seshi" },
  ];

  it("publishes in packages.json's order, public, with provenance when asked", async () => {
    layout("1.2.3", PACKAGES);
    const npm = fakeNpm();
    const done = await publishAll({ dir, exec: npm.exec, provenance: true });
    expect(done.map((d) => [d.name, d.action])).toEqual(PACKAGES.map((p) => [p.name, "published"]));
    const publishes = npm.calls.filter((c) => c[0] === "publish");
    expect(publishes).toEqual(
      PACKAGES.map((p) => [
        "publish",
        join(dir, p.dir),
        "--access",
        "public",
        "--tag",
        "latest",
        "--provenance",
      ]),
    );
  });

  it("skips what the registry already has, so a failed run can be run again", async () => {
    layout("1.2.3", PACKAGES);
    const first = fakeNpm([], "seshi");
    await expect(publishAll({ dir, exec: first.exec })).rejects.toThrow(/npm publish seshi@1.2.3/);
    const second = fakeNpm(["@dosu/seshi-darwin-arm64@1.2.3", "@dosu/seshi-model@1.2.3"]);
    const done = await publishAll({ dir, exec: second.exec });
    expect(done.map((d) => d.action)).toEqual(["skipped", "skipped", "published"]);
    expect(second.calls.filter((c) => c[0] === "publish")).toHaveLength(1);
  });

  it("publishes a prerelease under next, and passes --dry-run", async () => {
    layout("1.3.0-rc.1", PACKAGES.slice(0, 1));
    const npm = fakeNpm();
    await publishAll({ dir, exec: npm.exec, dryRun: true });
    expect(npm.calls.at(-1)).toEqual([
      "publish",
      join(dir, "cli-darwin-arm64"),
      "--access",
      "public",
      "--tag",
      "next",
      "--dry-run",
    ]);
  });

  const TLOG =
    "npm error code TLOG_CREATE_ENTRY_ERROR\nnpm error error creating tlog entry - (409) an equivalent entry already exists in the transparency log";

  /** npm whose publish fails with `errors` in turn, then succeeds; `lands` marks a failure
   * after which the registry has the package anyway. */
  function flakyNpm(errors: string[], lands = false) {
    const calls: string[][] = [];
    let landed = false;
    const exec: Exec = async (argv) => {
      calls.push(argv);
      if (argv[0] === "view") {
        return landed
          ? { code: 0, out: '"1.2.3"\n', err: "" }
          : { code: 1, out: "", err: "npm error code E404" };
      }
      const err = errors.shift();
      if (err === undefined) return { code: 0, out: "", err: "" };
      landed = lands;
      return { code: 1, out: "", err };
    };
    return { exec, calls, publishes: () => calls.filter((c) => c[0] === "publish").length };
  }
  const noSleep = async () => {};

  it("retries a publish that Sigstore's transparency log or the registry failed", async () => {
    layout("1.2.3", PACKAGES.slice(0, 1));
    const npm = flakyNpm([TLOG, "npm error code E503"]);
    const lines: string[] = [];
    const done = await publishAll({
      dir,
      exec: npm.exec,
      sleep: noSleep,
      log: (l) => lines.push(l),
    });
    expect(done.map((d) => d.action)).toEqual(["published"]);
    expect(npm.publishes()).toBe(3);
    expect(lines.filter((l) => l.includes("retrying"))).toHaveLength(2);
  });

  it("does not publish again when the failed try reached the registry", async () => {
    layout("1.2.3", PACKAGES.slice(0, 1));
    const npm = flakyNpm(["npm error code ETIMEDOUT"], true);
    const done = await publishAll({ dir, exec: npm.exec, sleep: noSleep });
    expect(done.map((d) => d.action)).toEqual(["published"]);
    expect(npm.publishes()).toBe(1);
  });

  it("gives up after its tries, and never retries a failure of the package itself", async () => {
    layout("1.2.3", PACKAGES.slice(0, 1));
    const always = flakyNpm([TLOG, TLOG, TLOG, TLOG]);
    await expect(
      publishAll({ dir, exec: always.exec, sleep: noSleep, attempts: 3 }),
    ).rejects.toThrow(/TLOG_CREATE_ENTRY_ERROR/);
    expect(always.publishes()).toBe(3);
    const forbidden = flakyNpm(["npm error code E403\nnpm error 403 Forbidden"]);
    await expect(publishAll({ dir, exec: forbidden.exec, sleep: noSleep })).rejects.toThrow(/403/);
    expect(forbidden.publishes()).toBe(1);
  });

  it("reports a failed optional package and goes on; a required one still fails", async () => {
    layout("1.2.3", [
      { name: "@dosu/seshi", dir: "seshi" },
      { name: "seshi", dir: "launcher-seshi" },
    ]);
    writeFileSync(
      join(dir, "packages.json"),
      JSON.stringify([
        { name: "@dosu/seshi", dir: "seshi" },
        { name: "seshi", dir: "launcher-seshi", optional: true },
      ]),
    );
    const npm = fakeNpm([], "launcher-seshi");
    const lines: string[] = [];
    const done = await publishAll({ dir, exec: npm.exec, log: (l) => lines.push(l) });
    expect(done.map((d) => [d.name, d.action])).toEqual([
      ["@dosu/seshi", "published"],
      ["seshi", "failed"],
    ]);
    expect(lines.at(-1)).toMatch(/seshi@1.2.3: not published, and optional.*403/s);
    await expect(publishAll({ dir, exec: fakeNpm([], "/seshi").exec })).rejects.toThrow(
      /npm publish @dosu\/seshi@1.2.3/,
    );
  });

  it("refuses a private package or a folder holding another package", async () => {
    layout("1.2.3", [{ name: "seshi", dir: "seshi", private: true }]);
    await expect(publishAll({ dir, exec: fakeNpm().exec })).rejects.toThrow(/private/);
    layout("1.2.3", [{ name: "seshi", dir: "seshi" }]);
    writeFileSync(
      join(dir, "packages.json"),
      JSON.stringify([{ name: "@dosu/seshi-client", dir: "seshi" }]),
    );
    await expect(publishAll({ dir, exec: fakeNpm().exec })).rejects.toThrow(
      /expected @dosu\/seshi-client/,
    );
  });
});

describe("isPublished", () => {
  it("treats only E404 as not published; other failures are errors", async () => {
    const outage: Exec = async () => ({ code: 1, out: "", err: "npm error code ETIMEDOUT" });
    await expect(isPublished(outage, "seshi", "1.0.0")).rejects.toThrow(/ETIMEDOUT/);
    expect(await isPublished(fakeNpm().exec, "seshi", "1.0.0")).toBe(false);
    expect(await isPublished(fakeNpm(["seshi@1.0.0"]).exec, "seshi", "1.0.0")).toBe(true);
  });

  it("isTransient tells a registry or Sigstore failure from a package's", () => {
    expect(isTransient("npm error code TLOG_CREATE_ENTRY_ERROR")).toBe(true);
    expect(isTransient("npm error 502 Bad Gateway")).toBe(true);
    expect(isTransient("npm error code E403")).toBe(false);
    expect(isTransient("npm error code EPUBLISHCONFLICT")).toBe(false);
  });

  it("distTag keeps prereleases off latest", () => {
    expect(distTag("1.0.0")).toBe("latest");
    expect(distTag("1.0.0-beta.2")).toBe("next");
  });
});
