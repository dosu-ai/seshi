import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, serverConfigSchema } from "@seshi/config";
import { buildInstance } from "@seshi/instance";
import { archiveId, openStore, readChanges, readMetadata } from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../cli/exit";
import { buildFormats } from "../integrations";
import { main } from "../main";

let dir: string;
let bucket: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-redact-"));
  bucket = join(dir, "bucket");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function seshi(argv: string[], env: Record<string, string> = {}, stdin?: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {
    env: { SESHI_STORE__URL: `file://${bucket}`, ...env },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    ...(stdin !== undefined ? { stdin: async () => stdin } : {}),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const ACME = `id = "acme"
disable = ["entropy"]

[[rules]]
id = "acme-key"
description = "Acme API keys"
pattern = 'ACME-[0-9]{4}'
tests.match = ["key ACME-1234"]
tests.no_match = ["ACME-12"]

[[rules]]
id = "row-id"
pattern = 'ROW-[0-9]+'
applies_to = ["tool_output"]
`;

function file(name: string, text: string): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

const ts = "2026-11-14T09:00:00Z";
const jsonl = (...rows: object[]) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
const TRANSCRIPT = jsonl(
  { role: "meta", source: "trajectory" },
  { role: "user", content: `ACME-1234 and ACME-9999 for ROW-7 ${"x".repeat(2000)}`, timestamp: ts },
  {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "c1", name: "Read", args: JSON.stringify({ file_path: ".env" }) }],
    timestamp: ts,
  },
  { role: "tool", tool_call_id: "c1", content: "SECRET=1", timestamp: ts },
  { role: "assistant", content: "done with ghp_abcdefghijklmnopqrstuvwx0123456789", timestamp: ts },
);

describe("seshi redact test", () => {
  it("checks the packs' test strings with no input", async () => {
    const pack = file("acme.toml", ACME);
    const result = await seshi(["redact", "test", "--pack", pack]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.out).toMatch(
      /^rule set [0-9a-f]{12}: built-in seshi\/rules\/3, packs acme; \d+ rules on, off: entropy$/m,
    );
    expect(result.out).toMatch(/tests: \d+ passed, 0 failed/);
  });

  it("fails, naming them, when a rule misses its test strings", async () => {
    const pack = file("acme.toml", ACME.replace('"ACME-12"', '"ACME-1234"'));
    const result = await seshi(["redact", "test", "--pack", pack]);
    expect(result.code).toBe(EXIT.failure);
    expect(result.out).toContain('acme/acme-key: matches "ACME-1234"');
  });

  it("shows how often each rule fires on a transcript, and where, never what matched", async () => {
    const pack = file("acme.toml", ACME);
    const input = file("session.jsonl", TRANSCRIPT);
    const result = await seshi(["redact", "test", input, "--pack", pack, "--agent", "trajectory"]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.out).toContain("trajectory transcript: 5 record(s)");
    expect(result.out).toMatch(/acme-key\s+2\s+records 2$/m);
    expect(result.out).toMatch(/sensitive-file\s+1\s+records 3$/m);
    expect(result.out).toMatch(/github-token\s+1\s+records 5$/m);
    // ROW-7 sits in a user message; the rule applies to tool output only.
    expect(result.out).not.toContain("row-id");
    expect(result.out).not.toContain("ACME-1234");
    expect(result.out).not.toContain("ghp_");
  });

  it("detects the format, reads standard input, and prints the redacted records with --print", async () => {
    const result = await seshi(["redact", "test", "-", "--print"], {}, TRANSCRIPT);
    expect(result.code).toBe(EXIT.ok);
    const records = result.out.split("\n").map((l) => JSON.parse(l));
    expect(records).toHaveLength(5);
    expect(records[3]).toMatchObject({ content: "[redacted:sensitive-file]" });
    expect(result.err).toContain("trajectory transcript: 5 record(s)");
  });

  it("treats anything no format reads as lines of text, in the field asked for", async () => {
    const pack = file("acme.toml", ACME);
    const text = file("notes.txt", "first ROW-1\nsecond ACME-1234\n");
    const asText = await seshi(["redact", "test", text, "--pack", pack, "--json"]);
    const doc = JSON.parse(asText.out);
    expect(doc.input).toEqual({ kind: "text", items: 2 });
    expect(doc.matches).toEqual({ "acme-key": { count: 1, at: [2] } });
    const asOutput = await seshi([
      "redact",
      "test",
      text,
      "--pack",
      pack,
      "--text",
      "--field",
      "tool_output",
      "--json",
      "--print",
    ]);
    const out = JSON.parse(asOutput.out);
    expect(out.matches).toEqual({
      "row-id": { count: 1, at: [1] },
      "acme-key": { count: 1, at: [2] },
    });
    expect(out.output).toEqual(["first [redacted:row-id]", "second [redacted:acme-key]"]);
    expect(out.rule_set).toMatch(/^[0-9a-f]{64}$/);
    expect(out.packs).toEqual(["acme"]);
    expect(out.rules.find((r: { id: string }) => r.id === "acme-key")).toMatchObject({
      pack: "acme",
      engine: "re2",
      enabled: true,
    });
  });

  it("takes the server's packs from --config", async () => {
    const pack = file("acme.toml", ACME);
    const config = file(
      "seshi.toml",
      `[store]\nurl = "file://${bucket}"\n\n[redaction]\npacks = ["${pack}"]\n`,
    );
    const result = await seshi(["redact", "test", "--config", config, "--json"]);
    expect(result.code).toBe(EXIT.ok);
    expect(JSON.parse(result.out).packs).toEqual(["acme"]);
  });

  it("refuses a pack it cannot use (3), a missing file (4) and a bad command line (2)", async () => {
    const bad = file("bad.toml", 'id = "x"\n[[rules]]\nid = "y"\npattern = "(?<=a)b"\n');
    const refused = await seshi(["redact", "test", "--pack", bad]);
    expect(refused.code).toBe(EXIT.config);
    expect(refused.err).toContain(
      `${bad} (pack x): rules[0] (y): pattern '(?<=a)b' is not a usable RE2 pattern`,
    );
    expect((await seshi(["redact", "test", "--pack", join(dir, "none.toml")])).code).toBe(
      EXIT.notFound,
    );
    expect((await seshi(["redact", "test", join(dir, "none.jsonl")])).code).toBe(EXIT.notFound);
    expect((await seshi(["redact", "test", "--field", "logs"])).code).toBe(EXIT.usage);
    expect((await seshi(["redact", "test", "--agent", "x", "--text"])).code).toBe(EXIT.usage);
    expect((await seshi(["redact"])).code).toBe(EXIT.usage);
    expect((await seshi(["redact", "nope"])).code).toBe(EXIT.usage);
    const json = await seshi(["redact", "test", "--pack", bad, "--json"]);
    expect(JSON.parse(json.err)).toMatchObject({ error: { code: "bad_pack" } });
  });
});

describe("seshi redact backfill (F2.5)", () => {
  /** A session stored by a server with the built-in pack only. */
  async function storeSession(sessionId: string, content: string) {
    const config = loadConfig(serverConfigSchema, {
      env: { SESHI_STORE__URL: `file://${bucket}` },
    }).config;
    const instance = await buildInstance(config, { formats: buildFormats(), env: {} });
    try {
      await instance.localSessions("alice").ingest({
        agent: "trajectory",
        session_id: sessionId,
        transcript: jsonl(
          { role: "meta", source: "trajectory" },
          { role: "user", content: `${content} ${"x".repeat(2000)}`, timestamp: ts },
          { role: "assistant", content: "ok", timestamp: ts },
        ),
      });
    } finally {
      await instance.close();
    }
  }

  it("needs --since or --all, and refuses an owner that is not one", async () => {
    expect((await seshi(["redact", "backfill"])).code).toBe(EXIT.usage);
    expect((await seshi(["redact", "backfill", "--since", "30d", "--all"])).code).toBe(EXIT.usage);
    expect((await seshi(["redact", "backfill", "--since", "whenever"])).code).toBe(EXIT.usage);
    expect((await seshi(["redact", "backfill", "--all", "--limit", "0"])).code).toBe(EXIT.usage);
    expect((await seshi(["redact", "backfill", "--all", "--owner", "no one"])).code).toBe(
      EXIT.usage,
    );
  });

  it("refuses a bucket no server has used, rather than claiming it", async () => {
    const result = await seshi(["redact", "backfill", "--all"]);
    expect(result.code).toBe(EXIT.config);
    expect(result.err).toContain("no seshi deployment");
  });

  it("applies new packs to stored sessions, saying what it did", async () => {
    await storeSession("s1", "key ACME-1234");
    await storeSession("s2", "nothing secret");
    const pack = file("acme.toml", ACME);
    const env = { SESHI_REDACTION__PACKS: pack };

    const dry = await seshi(["redact", "backfill", "--since", "30d", "--dry-run"], env);
    expect(dry.code).toBe(EXIT.ok);
    expect(dry.out).toMatch(
      /^dry run: applying rule set [0-9a-f]{12} \(built-in seshi\/rules\/3, packs acme\)/,
    );
    expect(dry.out).toContain("alice/trajectory/s1: would rewrite (acme-key 1)");
    expect(dry.out).toContain("would rewrite 1, 1 unchanged, 0 already current, 0 skipped");

    const archive = archiveId("alice", "trajectory", "s1");
    const { store } = openStore(`file://${bucket}`);
    const before = await readMetadata(store, "alice", archive);
    const real = await seshi(
      ["redact", "backfill", "--all", "--as", "ops@acme.com", "--json"],
      env,
    );
    expect(real.code).toBe(EXIT.ok);
    const report = JSON.parse(real.out);
    expect(report.outcomes).toMatchObject({ rewritten: 1, unchanged: 1 });
    expect(report.counts).toEqual({ "acme-key": 1 });

    const after = await readMetadata(store, "alice", archive);
    expect(after?.head).not.toBe(before?.head);
    expect(after?.redaction?.counts).toEqual({ "acme-key": 1 });
    const { entries } = await readChanges(store, "alice");
    const last = entries.at(-1)?.entry;
    expect(last).toMatchObject({
      kind: "published",
      replace: true,
      reason: "redacted",
      writer: { kind: "admin", principal: "ops@acme.com", source_id: "redaction" },
    });

    const again = await seshi(["redact", "backfill", "--all"], env);
    expect(again.out).toContain("rewrote 0, 0 unchanged, 2 already current, 0 skipped");
  });
});
