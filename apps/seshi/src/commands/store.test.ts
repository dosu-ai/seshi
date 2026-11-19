import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_FORMATS, FormatRegistry } from "@seshi/formats";
import type { StoreSessionResult } from "@seshi/model";
import { Pipeline, uploadEnvelope } from "@seshi/pipeline";
import { archiveId, FsStore, keys, LAYOUT_KEY, readMetadata } from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../cli/exit";
import { main } from "../main";

let dir: string;
let bucket: string;
let home: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-store-check-"));
  bucket = join(dir, "bucket");
  home = join(dir, "home");
  mkdirSync(home);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Run seshi with no server config but what `env` gives, and a home of its own (so the
 * developer's CLI config is never read). */
async function seshi(argv: string[], env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {
    env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), ...env },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const inBucket = () => ({ SESHI_STORE__URL: `file://${bucket}` });

const ts = "2026-11-14T09:00:00Z";
const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;
const transcript =
  line({ role: "meta", source: "trajectory" }) +
  line({ role: "user", content: `hello ${"x".repeat(2000)}`, timestamp: ts }) +
  line({ role: "assistant", content: "hi", timestamp: ts });

async function write(owner: string, sessionId: string): Promise<string> {
  const store = new FsStore(bucket);
  const pipeline = new Pipeline({ store, formats: new FormatRegistry(BUILTIN_FORMATS) });
  const result = (await pipeline.submit(
    uploadEnvelope(
      { owner, agent: "trajectory", session_id: sessionId, transcript, format: "jsonl" },
      { caller: { kind: "static", principal: owner }, owner_basis: "verified" },
    ),
  )) as StoreSessionResult;
  expect(result.status).toBe("stored");
  return archiveId(owner, "trajectory", sessionId);
}

describe("seshi store check (31)", () => {
  it("says the bucket is fine, exit 0, and --json gives the report", async () => {
    await write("alice", "s1");
    await write("bob", "s2");
    const result = await seshi(["store", "check"], inBucket());
    expect(result.code).toBe(EXIT.ok);
    expect(result.out).toBe(
      `checked file://${bucket}: 2 owners, 2 sessions, 2 trace objects, 2 change entries, 0 span records, 0 tokens: no problems`,
    );
    const json = await seshi(["store", "check", "--json"], inBucket());
    expect(json.code).toBe(EXIT.ok);
    expect(JSON.parse(json.out)).toEqual({
      store: `file://${bucket}`,
      findings: [],
      counts: expect.objectContaining({ owners: 2, sessions: 2, errors: 0, warns: 0 }),
    });
  });

  it("exits attention on an error, groups findings by session, and --owner narrows it", async () => {
    const alice = await write("alice", "s1");
    await write("bob", "s2");
    const head = (await readMetadata(new FsStore(bucket), "alice", alice))?.head as string;
    rmSync(join(bucket, ...keys.trace("alice", alice, head).split("/")));
    const result = await seshi(["store", "check"], inBucket());
    expect(result.code).toBe(EXIT.attention);
    const lines = result.out.split("\n");
    expect(lines[0]).toMatch(/: 1 error$/);
    expect(lines).toContain(`alice ${alice}`);
    expect(result.out).toMatch(/^ {2}error {2}head_missing {2}head [0-9a-f]{12}… has no object$/m);
    expect(result.out).toContain(keys.trace("alice", alice, head));
    const json = await seshi(["store", "check", "--json"], inBucket());
    expect(json.code).toBe(EXIT.attention);
    expect(JSON.parse(json.out).findings).toEqual([
      expect.objectContaining({ severity: "error", code: "head_missing", owner: "alice" }),
    ]);
    expect((await seshi(["store", "check", "--owner", "bob"], inBucket())).code).toBe(EXIT.ok);
    expect((await seshi(["store", "check", "--owner", "alice"], inBucket())).code).toBe(
      EXIT.attention,
    );
  });

  it("exits 0 with warnings alone", async () => {
    const alice = await write("alice", "s1");
    const orphan = join(bucket, ...keys.trace("alice", alice, "a".repeat(64)).split("/"));
    writeFileSync(orphan, "left behind");
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(orphan, old, old);
    const result = await seshi(["store", "check"], inBucket());
    expect(result.code).toBe(EXIT.ok);
    expect(result.out).toMatch(/: 1 warning$/m);
    expect(result.out).toMatch(/^ {2}warn {3}orphan_trace {2}/m);
  });

  it("changes nothing: an unused bucket is not claimed", async () => {
    mkdirSync(bucket);
    const result = await seshi(["store", "check"], inBucket());
    expect(result.code).toBe(EXIT.ok);
    expect(existsSync(join(bucket, LAYOUT_KEY))).toBe(false);
  });

  it("checks local mode's bucket, from the CLI config's [local]", async () => {
    const alice = await write("alice", "s1");
    rmSync(join(bucket, ...keys.metadata("alice", alice).split("/")));
    const toml = join(dir, "seshi.toml");
    writeFileSync(toml, `[store]\nurl = "file://${bucket}"\n`);
    mkdirSync(join(home, ".config", "seshi"), { recursive: true });
    writeFileSync(join(home, ".config", "seshi", "config.toml"), `[local]\nconfig = "${toml}"\n`);
    const result = await seshi(["store", "check", "--json"]);
    expect(result.code).toBe(EXIT.ok);
    expect(JSON.parse(result.out)).toMatchObject({
      store: `file://${bucket}`,
      findings: [expect.objectContaining({ code: "change_orphan", severity: "warn" })],
    });
    // --config names another bucket, over local mode's.
    const other = join(dir, "other.toml");
    writeFileSync(other, `[store]\nurl = "file://${dir}/empty"\n`);
    const named = await seshi(["store", "check", "--json", "--config", other]);
    expect(JSON.parse(named.out).store).toBe(`file://${dir}/empty`);
  });

  it("prints its usage, and refuses bad usage and an unusable bucket", async () => {
    const help = await seshi(["store", "check", "--help"]);
    expect(help.code).toBe(EXIT.ok);
    expect(help.out).toContain("usage: seshi store check");
    expect((await seshi(["store"])).code).toBe(EXIT.usage);
    expect((await seshi(["store", "fix"])).code).toBe(EXIT.usage);
    expect((await seshi(["store", "check", "extra"], inBucket())).code).toBe(EXIT.usage);
    expect((await seshi(["store", "check", "--owner", "no one"], inBucket())).code).toBe(
      EXIT.usage,
    );
    const bad = await seshi(["store", "check", "--json"], { SESHI_STORE__URL: "ftp://nowhere" });
    expect(bad.code).toBe(EXIT.config);
    expect(JSON.parse(bad.err)).toMatchObject({ error: { code: "config" } });
  });
});
