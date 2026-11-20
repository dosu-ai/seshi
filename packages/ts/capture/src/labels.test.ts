import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type LabelRules, labelRules, resolveLabels } from "./labels";
import { parseRepoConfig, placeOf } from "./place";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "seshi-labels-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const folder = (path: string) => {
  const full = join(dir, path);
  mkdirSync(full, { recursive: true });
  return full;
};

const rules = (config: Record<string, unknown>, paths: Record<string, unknown>[] = []) =>
  labelRules({ ...config, paths: paths as LabelRules["paths"] } as never, dir);

const resolve = (r: LabelRules | undefined, cwd: string, env: Record<string, string> = {}) =>
  resolveLabels(r, placeOf(cwd), env, process.platform);

describe("resolving a session's labels", () => {
  it("gives a fixed label, and an env label only while its variable is set", () => {
    const here = folder("w");
    const r = rules({ team: "platform", "dosu.project": { env: "DOSU_PROJECT" } });
    expect(resolve(r, here, { DOSU_PROJECT: "github.com/acme/app" })).toEqual({
      labels: { team: "platform", "dosu.project": "github.com/acme/app" },
      problems: [],
    });
    expect(resolve(r, here).labels).toEqual({ team: "platform" });
    expect(resolve(r, here, { DOSU_PROJECT: "" }).labels).toEqual({ team: "platform" });
  });

  it("lets a [[labels.paths]] entry win over [labels], the longest folder first, key by key", () => {
    const billing = folder("code/monorepo/packages/billing");
    const web = folder("code/monorepo/packages/web");
    folder("code/monorepo-other");
    const r = rules({ "dosu.project": { env: "DOSU_PROJECT" }, team: "platform" }, [
      { path: "~/code/monorepo", "dosu.project": "github.com/acme/monorepo", team: "infra" },
      { path: "~/code/monorepo/packages/billing", "dosu.project": "github.com/acme/billing" },
    ]);
    const env = { DOSU_PROJECT: "from-env" };
    expect(resolve(r, billing, env).labels).toEqual({
      "dosu.project": "github.com/acme/billing",
      team: "infra",
    });
    expect(resolve(r, web, env).labels).toEqual({
      "dosu.project": "github.com/acme/monorepo",
      team: "infra",
    });
    // Folder boundaries: monorepo-other is not inside monorepo.
    expect(resolve(r, join(dir, "code/monorepo-other"), env).labels).toEqual({
      "dosu.project": "from-env",
      team: "platform",
    });
  });

  it("lets an unset env reference in a folder entry fall through", () => {
    const here = folder("w");
    const r = rules({ "dosu.project": "fixed" }, [{ path: here, "dosu.project": { env: "P" } }]);
    expect(resolve(r, here, { P: "folder" }).labels).toEqual({ "dosu.project": "folder" });
    expect(resolve(r, here).labels).toEqual({ "dosu.project": "fixed" });
  });

  it("matches a folder entry through a symbolic link, as [[capture.paths]] does", () => {
    const real = folder("real/app");
    symlinkSync(join(dir, "real"), join(dir, "link"));
    const viaLink = rules({}, [{ path: join(dir, "link/app"), team: "a" }]);
    expect(resolve(viaLink, real).labels).toEqual({ team: "a" });
    const viaReal = rules({}, [{ path: real, team: "b" }]);
    expect(resolve(viaReal, join(dir, "link/app")).labels).toEqual({ team: "b" });
  });

  it("falls back to the repo's .seshi/config.toml, plain strings only", () => {
    const repo = folder("repo");
    folder("repo/.git");
    writeFileSync(join(repo, ".git/HEAD"), "ref: refs/heads/main\n");
    folder("repo/.seshi");
    writeFileSync(
      join(repo, ".seshi/config.toml"),
      '[labels]\n"dosu.project" = "github.com/acme/monorepo"\nteam = "repo"\nsecret = { env = "AWS_SECRET_ACCESS_KEY" }\n',
    );
    const r = rules({ team: { env: "TEAM" } });
    const env = { TEAM: "mine", AWS_SECRET_ACCESS_KEY: "hunter2" };
    const resolved = resolve(r, repo, env);
    expect(resolved.labels).toEqual({ "dosu.project": "github.com/acme/monorepo", team: "mine" });
    expect(resolved.problems).toEqual([
      "label 'secret' must be a string (a repo cannot read the environment)",
    ]);
    expect(JSON.stringify(resolved)).not.toContain("hunter2");
    // With the CLI's unset, the repo's gives the key; with no CLI labels at all, too.
    expect(resolve(r, repo).labels.team).toBe("repo");
    expect(resolve(undefined, repo).labels.team).toBe("repo");
  });

  it("drops labels out of the limits and says why, never failing", () => {
    const here = folder("w");
    const many: Record<string, string> = {};
    for (let i = 0; i < 34; i++) many[`k${String(i).padStart(2, "0")}`] = "v";
    const r = rules({ ...many, Bad: "x", long: { env: "LONG" }, blank: "" });
    const resolved = resolve(r, here, { LONG: "x".repeat(513) });
    expect(Object.keys(resolved.labels)).toHaveLength(32);
    expect(resolved.labels).not.toHaveProperty("Bad");
    expect(resolved.labels).not.toHaveProperty("long");
    expect(resolved.labels).not.toHaveProperty("blank");
    expect(resolved.problems).toEqual([
      "label 'blank' must not be empty",
      "label 'k32' is past the 32 allowed",
      "label 'k33' is past the 32 allowed",
      expect.stringContaining("label key 'Bad'"),
      "label 'long' is 513 characters long; at most 512 are allowed",
    ]);
  });

  it("keeps the highest-precedence labels past the cap: a folder's over [labels]", () => {
    const here = folder("w");
    const many: Record<string, string> = {};
    for (let i = 0; i < 32; i++) many[`a${String(i).padStart(2, "0")}`] = "v";
    const r = rules(many, [{ path: here, "zz.project": "github.com/acme/app" }]);
    const resolved = resolve(r, here);
    expect(resolved.labels["zz.project"]).toBe("github.com/acme/app");
    expect(resolved.labels).not.toHaveProperty("a31");
    expect(resolved.problems).toEqual(["label 'a31' is past the 32 allowed"]);
  });

  it("leaves a fixed empty value out, saying so, and lets the next one down give the key", () => {
    const here = folder("w");
    const r = rules({ team: "platform" }, [{ path: here, team: "" }]);
    expect(resolve(r, here)).toEqual({
      labels: { team: "platform" },
      problems: ["label 'team' must not be empty"],
    });
  });
});

describe("a repo's labels", () => {
  it("are a table of strings; anything else is left out, and capture stays on", () => {
    expect(parseRepoConfig('[labels]\nteam = "a"\n')).toEqual({ labels: { team: "a" } });
    expect(parseRepoConfig('labels = "x"\n')).toEqual({
      labelProblems: ["[labels] must be a table"],
    });
    expect(parseRepoConfig("capture = true\n[labels]\nn = 3\n")).toEqual({
      capture: true,
      labelProblems: ["label 'n' must be a string (a repo cannot read the environment)"],
    });
  });
});
