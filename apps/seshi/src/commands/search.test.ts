/** `seshi search` (F10.5): in-process against a server config, in local mode, and against a
 * server over HTTP (a local `Bun.serve` of the real routes), with its output, `--json`, the
 * index commands and the exit codes. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@seshi/api";
import { loadConfig, serverConfigSchema } from "@seshi/config";
import { BUILTIN_FORMATS, FormatRegistry } from "@seshi/formats";
import { Instance } from "@seshi/instance";
import type { SearchResults } from "@seshi/model";
import { StoreSessionDB } from "@seshi/pipeline";
import { ensureLayout, FsStore } from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../cli/exit";
import { Style, stripStyle } from "../cli/style";
import { INTEGRATIONS } from "../integrations";
import { main } from "../main";
import { highlighted, searchLines, timeArg } from "./search";

const formats = new FormatRegistry(BUILTIN_FORMATS);
const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;
function log(prompt: string): string {
  return (
    line({ role: "meta", source: "trajectory" }) +
    line({
      role: "user",
      content: `${prompt}\n${"context ".repeat(260)}`,
      timestamp: "2026-11-01T10:00:00Z",
    }) +
    line({
      role: "assistant",
      content: null,
      timestamp: "2026-11-01T10:00:05Z",
      tool_calls: [{ id: "c1", name: "Bash", args: '{"command":"kubectl rollout restart"}' }],
    })
  );
}

const TOKEN = "seshi-search-test-token-0123";

let dir: string;
let home: string;
let bucket: string;
let toml: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "seshi-search-cmd-"));
  home = join(dir, "home");
  mkdirSync(home);
  bucket = `file://${join(dir, "bucket")}`;
  await ensureLayout(new FsStore(bucket), { createdBy: "test" });
  toml = join(dir, "seshi.toml");
  writeFileSync(
    toml,
    `[store]\nurl = "${bucket}"\n[search]\npath = "${join(dir, "index.sqlite")}"\n[auth.tokens]\nacme = "${TOKEN}"\n`,
    { mode: 0o600 },
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function write(
  owner: string,
  id: string,
  prompt: string,
  project?: string,
  labels?: Record<string, string>,
) {
  await new StoreSessionDB({ store: new FsStore(bucket), owner, formats }).ingest({
    agent: "trajectory",
    session_id: id,
    transcript: log(prompt),
    ...(project ? { project } : {}),
    ...(labels ? { labels } : {}),
  });
}

async function seshi(argv: string[], env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(["search", ...argv], {
    env: { HOME: home, ...env },
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    integrations: async () => INTEGRATIONS,
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("seshi search, in-process", () => {
  it("builds the index on first use and prints what matches", async () => {
    await write("alice", "s1", "restart the payments deployment", "github.com/acme/payments");
    await write("bob", "s2", "write the release notes");
    const first = await seshi(["payments", "--config", toml]);
    expect(first.code).toBe(EXIT.ok);
    expect(first.err).toContain("building the search index");
    expect(first.out).toContain("trajectory/s1  alice  github.com/acme/payments  2026-11-01 10:00");
    expect(first.out).toContain("  user: restart the payments deployment context");
    expect(first.out).toContain("1 session match.");
    // Whoever holds the bucket keys reads everything, and tool calls are searchable.
    const again = await seshi(["kubectl", "rollout", "--config", toml]);
    expect(again.err).toBe("");
    expect(again.out).toContain("tool_call Bash:");
    expect(again.out).toContain("2 sessions match.");
  });

  it("finds sessions written since the last search, and filters", async () => {
    await write("alice", "s1", "first topic");
    await seshi(["topic", "--config", toml]);
    await write("alice", "s2", "second topic", "github.com/acme/widget");
    const json = await seshi(["topic", "--config", toml, "--json"]);
    const results = JSON.parse(json.out) as SearchResults;
    expect(results.total).toBe(2);
    const filtered = await seshi(["topic", "--repo", "widget", "--config", toml, "--json"]);
    expect((JSON.parse(filtered.out) as SearchResults).results.map((r) => r.session_id)).toEqual([
      "s2",
    ]);
    const old = await seshi(["topic", "--until", "2026-10-01", "--config", toml]);
    expect(old.out).toBe("Exploring: no sessions match.");
    const paged = await seshi(["topic", "--limit", "1", "--config", toml]);
    expect(paged.out).toContain("1 of 2 sessions shown; more with --cursor 1");
    const bare = await seshi([
      "topic",
      "--sort",
      "recent",
      "--matches",
      "0",
      "--config",
      toml,
      "--json",
    ]);
    const sessions = JSON.parse(bare.out) as SearchResults;
    expect(sessions.total).toBe(2);
    expect(sessions.results.map((r) => r.matches)).toEqual([[], []]);
  });

  it("filters by --label key=value, each one a session must carry", async () => {
    await write("alice", "s1", "label topic", undefined, { team: "platform", "dosu.project": "a" });
    await write("alice", "s2", "label topic", undefined, { team: "platform" });
    await write("alice", "s3", "label topic");
    const ids = async (...args: string[]) =>
      (
        JSON.parse(
          (await seshi(["topic", ...args, "--config", toml, "--json"])).out,
        ) as SearchResults
      ).results
        .map((r) => r.session_id)
        .sort();
    expect(await ids("--label", "team=platform")).toEqual(["s1", "s2"]);
    expect(await ids("--label", "team=platform", "--label", "dosu.project=a")).toEqual(["s1"]);
    const bad = await seshi(["topic", "--label", "team", "--config", toml]);
    expect(bad.code).toBe(EXIT.usage);
    expect(bad.err).toContain("--label: 'team' is not key=value");
    const twice = await seshi(["topic", "--label", "t=a", "--label", "t=b", "--config", toml]);
    expect(twice.code).toBe(EXIT.usage);
    expect(twice.err).toContain("--label: t is given twice");
  });

  it("shows and rebuilds the local index", async () => {
    await write("alice", "s1", "anything at all");
    const before = await seshi(["--status", "--config", toml]);
    expect(before.code).toBe(EXIT.ok);
    expect(before.out).toContain(`index ${join(dir, "index.sqlite")}`);
    expect(before.out).toContain("not built yet");
    const rebuilt = await seshi(["--rebuild", "--config", toml, "--json"]);
    expect(JSON.parse(rebuilt.out)).toMatchObject({ ready: true, sessions: 1 });
    const after = await seshi(["--status", "--config", toml]);
    expect(after.out).toContain("1 sessions, 2 records indexed");
  });

  it("finds the server's config where serve would, and says when search is off", async () => {
    await write("alice", "s1", "anything at all");
    const found = await seshi(["anything"], { SESHI_CONFIG: toml });
    expect(found.code).toBe(EXIT.ok);
    const off = await seshi(["anything", "--config", toml, "--set", "search.enabled=false"]);
    expect(off.code).toBe(EXIT.config);
    expect(off.err).toContain("search is turned off");
  });

  it("refuses a query with nothing to find, and bad flags", async () => {
    expect((await seshi(['"', "--config", toml])).code).toBe(EXIT.usage);
    expect((await seshi(["--config", toml])).code).toBe(EXIT.usage);
    expect((await seshi(["x", "--limit", "many", "--config", toml])).code).toBe(EXIT.usage);
    expect((await seshi(["x", "--since", "whenever", "--config", toml])).code).toBe(EXIT.usage);
    expect((await seshi(["x", "--sort", "random", "--config", toml])).code).toBe(EXIT.usage);
    expect((await seshi(["x", "--nope"])).code).toBe(EXIT.usage);
    expect((await seshi(["x", "--status"])).code).toBe(EXIT.usage);
    expect((await seshi(["--status", "--rebuild"])).code).toBe(EXIT.usage);
    const json = await seshi(["--json"]);
    expect(JSON.parse(json.err)).toMatchObject({ error: { code: "usage" } });
  });

  it("says when nothing is configured", async () => {
    const result = await seshi(["anything"]);
    expect(result.code).toBe(EXIT.config);
    expect(result.err).toContain("no server or bucket configured");
  });
});

describe("seshi search, local mode (X3.5)", () => {
  it("uses the server config named by [local] in the CLI config", async () => {
    await write("alice", "s1", "local mode works");
    mkdirSync(join(home, ".config", "seshi"), { recursive: true });
    writeFileSync(join(home, ".config", "seshi", "config.toml"), `[local]\nconfig = "${toml}"\n`);
    const result = await seshi(["local", "mode"]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.out).toContain("trajectory/s1  alice");
  });
});

describe("seshi search, against a server", () => {
  let server: ReturnType<typeof Bun.serve>;
  let instance: Instance;
  let url: string;

  beforeEach(() => {
    const config = loadConfig(serverConfigSchema, {
      env: {
        SESHI_STORE__URL: bucket,
        SESHI_SEARCH__PATH: ":memory:",
        SESHI_AUTH__TOKENS__ACME: TOKEN,
      },
    }).config;
    instance = new Instance({
      config,
      store: new FsStore(bucket),
      storage: { url: bucket },
      formats,
      deployment: "test",
      roles: ["api"],
    });
    const app = createApp(instance);
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    url = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    server.stop(true);
    await instance.close();
  });

  it("asks the server, with the token", async () => {
    await write("acme", "s1", "served over http");
    const building = await seshi(["served", "--server", url, "--token", TOKEN]);
    expect(building.code).toBe(EXIT.unavailable);
    expect(building.err).toContain("being built");
    await instance.search?.catchUp();
    const result = await seshi(["served", "--server", url, "--token", TOKEN]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.out).toContain("trajectory/s1  acme");
    // The server named in the CLI config.
    mkdirSync(join(home, ".config", "seshi"), { recursive: true });
    writeFileSync(join(home, ".config", "seshi", "config.toml"), `server = "${url}"\n`);
    const json = await seshi(["served", "--token", TOKEN, "--json"]);
    expect((JSON.parse(json.out) as SearchResults).total).toBe(1);
  });

  it("maps the server's refusals to exit codes", async () => {
    await instance.search?.catchUp();
    const noToken = await seshi(["x", "--server", url]);
    expect(noToken.code).toBe(EXIT.auth);
    expect(noToken.err).toContain("not signed in");
    expect((await seshi(["x", "--server", url, "--token", "wrong-token-0123456789"])).code).toBe(
      EXIT.auth,
    );
    const bad = await seshi(["x", "--owner", "a/b", "--server", url, "--token", TOKEN]);
    expect(bad.code).toBe(EXIT.usage);
    expect((await seshi(["--status", "--server", url, "--token", TOKEN])).code).toBe(EXIT.usage);
    const gone = await seshi(["x", "--server", "http://127.0.0.1:1", "--token", TOKEN]);
    expect(gone.code).toBe(EXIT.unavailable);
  });
});

describe("the command's pieces", () => {
  const now = new Date("2026-11-14T12:00:00.000Z");

  it("paints the matched words from their offsets, folding white space around them", () => {
    const style = new Style("truecolor", "dark");
    const open = style.open("search");
    const line = highlighted(
      "  git push\n\n--force now",
      [
        [14, 19],
        [2, 5],
      ],
      style,
    );
    expect(line).toBe(`${open}git\x1b[39m push --${open}force\x1b[39m now`);
    expect(stripStyle(line)).toBe("git push --force now");
    expect(
      highlighted(
        "abc",
        [
          [1, 99],
          [0, 0],
        ],
        Style.plain(),
      ),
    ).toBe("abc");
  });

  it("prints stored text without its control characters", () => {
    const lines = searchLines({
      query: "x",
      total: 1,
      index: { ready_at: "", sessions: 1 },
      results: [
        {
          owner: "alice",
          agent: "claude-code",
          session_id: "a\x1b]0;pwned\x07",
          archive_id: "0".repeat(64),
          project: "p\x1b[2J",
          visibility: "org",
          updated_at: "2026-11-14T09:05:00.000Z",
          score: 1,
          hits: 1,
          matches: [
            {
              content_hash: "0".repeat(64),
              event_index: 0,
              role: "user",
              snippet: "see \x1b]52;c;Zm9v\x07 here",
              highlights: [[0, 3]],
            },
          ],
        },
      ],
    });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: checking none are printed
    for (const line of lines) expect(line).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
  });

  it("reads times as dates, RFC 3339 or ages", () => {
    expect(timeArg("7d", "since", now)).toBe("2026-11-07T12:00:00.000Z");
    expect(timeArg("2026-11-01", "since", now)).toBe("2026-11-01T00:00:00.000Z");
    expect(timeArg("2026-11-01T09:30:00+01:00", "since", now)).toBe("2026-11-01T08:30:00.000Z");
    expect(() => timeArg("soon", "since", now)).toThrow(/--since/);
  });

  it("prints a session per result and a line per match", () => {
    const lines = searchLines({
      query: "x",
      total: 3,
      cursor: "1",
      index: { ready_at: "2026-11-14T00:00:00.000Z", sessions: 3 },
      results: [
        {
          owner: "alice",
          agent: "claude-code",
          session_id: "abc",
          archive_id: "0".repeat(64),
          project: "acme/widget",
          branch: "main",
          visibility: "org",
          updated_at: "2026-11-14T09:05:00.000Z",
          score: 1,
          hits: 1,
          matches: [
            {
              content_hash: "0".repeat(64),
              event_index: 2,
              role: "tool_call",
              tool_name: "Bash",
              snippet: "git push\n--force",
              highlights: [[0, 3]],
            },
          ],
        },
      ],
    });
    expect(lines).toEqual([
      "claude-code/abc  alice  acme/widget @ main  2026-11-14 09:05  1 match",
      "  tool_call Bash: git push --force",
      "",
      "1 of 3 sessions shown; more with --cursor 1",
    ]);
    expect(
      searchLines({
        query: "x",
        total: 3,
        results: [],
        index: { ready_at: "", sessions: 0 },
      }),
    ).toEqual(["Exploring: no more sessions match."]);
  });
});
