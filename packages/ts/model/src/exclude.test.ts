import { describe, expect, it } from "vitest";
import {
  excludeEntryProblem,
  excludingEntry,
  normalizeRemote,
  readExcludeEntry,
  repoExcludes,
  repoKey,
} from "./exclude";

describe("one repository normalizer for every path", () => {
  // How Cursor's Cloud Agents API names an agent's repository, and how a laptop's git config
  // names the same repository's remote.
  const cloud = [
    "https://github.com/acme/app",
    "https://github.com/acme/app.git",
    "https://x-access-token:ghs_abc@github.com/acme/app.git",
    "https://GitHub.com/acme/app/",
  ];
  const laptop = [
    "git@github.com:acme/app.git",
    "github.com:acme/app",
    "ssh://git@github.com/acme/app.git",
    "ssh://git@github.com:22/acme/app",
    "https://me:p%40ss@github.com/acme/app.git",
    "https://me:pa/ss@github.com/acme/app.git",
    "git+ssh://git@GITHUB.COM/acme/app.GIT",
  ];

  it("names a cloud agent's repository and a laptop's remote for it alike", () => {
    for (const url of [...cloud, ...laptop])
      expect(normalizeRemote(url)).toBe("github.com/acme/app");
  });

  it("compares without regard to case", () => {
    expect(normalizeRemote("https://github.com/Acme/App")).toBe("github.com/Acme/App");
    expect(repoKey("https://github.com/Acme/App")).toBe(repoKey("git@github.com:acme/app.git"));
  });

  it("never keeps a credential or a port", () => {
    for (const url of [...cloud, ...laptop]) {
      expect(normalizeRemote(url)).not.toMatch(/@|:|ghs_|p%40ss|pa\//);
    }
    expect(normalizeRemote("https://git.acme.com:8443/team/app.git")).toBe("git.acme.com/team/app");
  });
});

describe("the server's exclude list", () => {
  const list = repoExcludes([
    "",
    "# the org's sensitive repositories",
    "acme/payroll",
    "github.com/acme/hr-*",
    "~/clients/**",
    "/srv/secret",
  ]);

  it("keeps the repository entries; folders are a laptop's", () => {
    expect(list.repos.map((r) => r.entry)).toEqual(["acme/payroll", "github.com/acme/hr-*"]);
    expect(excludingEntry(list, ["/srv/secret", "~/clients/x"])).toBeUndefined();
  });

  it("names the entry for any of the repositories given, in any form", () => {
    expect(excludingEntry(list, ["https://github.com/acme/app"])).toBeUndefined();
    expect(
      excludingEntry(list, ["https://github.com/acme/app", "git@gitlab.com:acme/payroll.git"]),
    ).toBe("acme/payroll");
    expect(excludingEntry(list, ["https://bot:t@github.com/Acme/HR-portal.git"])).toBe(
      "github.com/acme/hr-*",
    );
    expect(excludingEntry(list, ["https://gitlab.com/acme/hr-portal"])).toBeUndefined();
    expect(excludingEntry(list, [])).toBeUndefined();
    expect(excludingEntry(list, ["", "  "])).toBeUndefined();
  });

  it("reads an entry as the CLI's capture.exclude does", () => {
    expect(readExcludeEntry(" # x ")).toBeUndefined();
    expect(readExcludeEntry("~/work")).toEqual({ entry: "~/work", folder: "~/work" });
    expect(readExcludeEntry("C:\\work")).toEqual({ entry: "C:\\work", folder: "C:\\work" });
    expect(readExcludeEntry("Acme/App.git")).toEqual({ entry: "Acme/App.git", repo: "acme/app" });
  });

  it("finds what an admin wrote by mistake", () => {
    expect(excludeEntryProblem("acme/app")).toBeUndefined();
    expect(excludeEntryProblem("# acme/my app")).toBeUndefined();
    expect(excludeEntryProblem("~/my clients")).toBeUndefined();
    expect(excludeEntryProblem("https://github.com/acme/app.git")).toBeUndefined();
    expect(excludeEntryProblem("git@github.com:acme/app.git")).toBeUndefined();
    expect(excludeEntryProblem("acme/my app")).toBe("a repository has no spaces");
    expect(excludeEntryProblem("https://bot:tok@github.com/acme/app")).toMatch(/credential/);
    expect(excludeEntryProblem("bot:tok@github.com/acme/app")).toMatch(/credential/);
    expect(excludeEntryProblem("acme/\u0007app")).toBe("has a control character");
  });
});
