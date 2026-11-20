import { describe, expect, it } from "vitest";
import {
  excludeEntryProblem,
  excludingEntry,
  maskedEntry,
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

  it("gives one repository one name, whatever the case it was cloned with", () => {
    for (const remote of [
      "https://github.com/acme/App.GIT",
      "https://GitHub.com/Acme/App.git",
      "git@github.com:ACME/app.git",
      "ssh://git@github.com:22/Acme/App",
    ]) {
      expect(normalizeRemote(remote), remote).toBe("github.com/acme/app");
    }
    expect(repoKey("https://github.com/Acme/App")).toBe(repoKey("git@github.com:acme/app.git"));
  });

  it("keeps an @ in the path, reads a bare host/path, and a numeric owner as an owner", () => {
    expect(normalizeRemote("https://user:p/w@host.example/acme/app@v2")).toBe(
      "host.example/acme/app@v2",
    );
    expect(normalizeRemote("GitHub.com/acme/app/")).toBe("github.com/acme/app");
    expect(normalizeRemote("git@github.com:1234/app.git")).toBe("github.com/1234/app");
    expect(normalizeRemote("http://user:pass@GitHub.com:8443/acme/app/")).toBe(
      "github.com/acme/app",
    );
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
    expect(excludeEntryProblem("acme/my app")).toBe("has a space, which no repository name has");
    expect(excludeEntryProblem("https://bot:tok@github.com/acme/app")).toMatch(/credential/);
    expect(excludeEntryProblem("bot:tok@github.com/acme/app")).toMatch(/credential/);
    expect(excludeEntryProblem("acme/\u0007app")).toBe("has a control character");
  });

  it("shows an entry in a message with its credential masked", () => {
    expect(maskedEntry("https://bot:ghp_x@github.com/acme/app")).toBe(
      "https://***@github.com/acme/app",
    );
    expect(maskedEntry("bot:tok@github.com/acme/app")).toBe("***@github.com/acme/app");
    expect(maskedEntry(" acme/my app ")).toBe("acme/my app");
    expect(maskedEntry("git@github.com:acme/app.git")).toBe("git@github.com:acme/app.git");
  });
});
