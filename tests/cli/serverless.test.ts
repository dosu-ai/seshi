/** Serverless mode from the command line (F11): setting a machine up, the bucket's admin
 * commands, the review key, and what a held upload says. */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FsStore, getBytes, LAYOUT_KEY, readLayout } from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Machine } from "../tooling/cli";
import { transcript } from "../tooling/testdata";

const SMALL = transcript("claude-basic.claude-code.jsonl");
const CLAUDE = `${SMALL.trim()}\n${JSON.stringify({
  type: "assistant",
  uuid: "a3",
  timestamp: "2026-09-01T00:00:08.000Z",
  sessionId: "sess1",
  message: {
    role: "assistant",
    model: "claude-x",
    content: [{ type: "text", text: `The auth flow: ${"details ".repeat(400)}` }],
  },
})}\n`;

let machine: Machine;
let url: string;

beforeEach(() => {
  machine = new Machine();
  url = `file://${join(machine.dir, "bucket")}`;
});

afterEach(() => {
  machine.cleanup();
});

const decode = (bytes: Uint8Array | null) => (bytes ? new TextDecoder().decode(bytes) : null);

describe("seshi init --serverless", () => {
  it("tests the store, creates the marker, and points the CLI config at the bucket", async () => {
    machine.cliConfig('server = "https://seshi.example"\ntheme = "dark"\n');
    const run = await machine.seshi(["init", "--serverless", "--url", url, "--owner", "Alice"]);
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain(`This machine now writes ${url} directly, as alice.`);
    expect(run.out).toContain("conditional uploads ok; conditional deletes ok");
    expect(run.out).toContain("this machine now writes the bucket instead");
    const marker = await readLayout(new FsStore(join(machine.dir, "bucket")));
    expect(marker).toMatchObject({ schema: "seshi/layout/2", mode: "serverless" });
    const cli = readFileSync(join(machine.configDir, "config.toml"), "utf8");
    expect(cli).toBe(
      `theme = "dark"\n\n[serverless]\nurl = "${url}"\nowner = "alice"\n\n[search]\nenabled = true\nscope = "visible"\n`,
    );
    const who = await machine.seshi(["whoami"]);
    expect(who.out).toContain("alice in serverless mode");
  });

  it("writes a starter shared config with --admin, once", async () => {
    const init = ["init", "--serverless", "--url", url, "--owner", "ops", "--admin", "--json"];
    const run = await machine.seshi(init);
    expect(run.code, run.err).toBe(0);
    expect(JSON.parse(run.out)).toMatchObject({ shared_config_written: true });
    const bucket = new FsStore(join(machine.dir, "bucket"));
    expect(decode(await getBytes(bucket, "config/seshi.toml"))).toContain("[review]");
    const again = await machine.seshi(init);
    expect(JSON.parse(again.out)).toMatchObject({
      shared_config_written: false,
      marker: { created: false },
    });
  });

  it("asks for --serverless, --url, and an owner when it cannot name one", async () => {
    expect((await machine.seshi(["init"])).code).toBe(2);
    expect((await machine.seshi(["init", "--serverless"])).err).toContain("--url is required");
    const gcs = await machine.seshi(["init", "--serverless", "--url", "gs://b/p"]);
    expect(gcs.err).toContain("--url is s3://, r2://, az:// or file://");
    const unnamed = await machine.seshi(["init", "--serverless", "--url", url]);
    expect(unnamed.err).toContain("name the owner: --owner <id>");
  });
});

describe("a serverless machine", () => {
  beforeEach(async () => {
    const run = await machine.seshi(["init", "--serverless", "--url", url, "--owner", "alice"]);
    expect(run.code, run.err).toBe(0);
  });

  it("refuses an ordinary command against a bucket nobody set up", async () => {
    machine.cliConfig(`[serverless]\nurl = "${url}-other"\nowner = "alice"\n`);
    const ls = await machine.seshi(["sessions", "ls"]);
    expect(ls.code).toBe(3);
    expect(ls.err).toContain(`no seshi bucket at ${url}-other: run seshi init --serverless`);
    expect(await getBytes(new FsStore(join(machine.dir, "bucket-other")), LAYOUT_KEY)).toBeNull();
  });

  it("sets the mode and minimum version, and holds uploads below it", async () => {
    expect((await machine.seshi(["admin", "mode", "server"])).code).toBe(0);
    const warned = await machine.seshi(["sessions", "ls"]);
    expect(warned.err).toContain("is in server mode");
    expect((await machine.seshi(["admin", "mode", "serverless"])).code).toBe(0);

    expect((await machine.seshi(["admin", "layout", "--min-version", "99.0.0"])).code).toBe(0);
    const file = join(machine.dir, "s1.jsonl");
    writeFileSync(file, CLAUDE);
    const held = await machine.seshi(["upload", "--agent", "claude-code", file]);
    expect(held.code).toBe(3);
    expect(held.out).toContain("needs update: this bucket needs seshi 99.0.0 or newer");
    const status = await machine.seshi(["statusline", "--json"]);
    expect(status.out).toContain("needs update");

    expect((await machine.seshi(["admin", "layout", "--clear-min-version"])).code).toBe(0);
    const sent = await machine.seshi(["upload", "--agent", "claude-code", file]);
    expect(sent.code, sent.out + sent.err).toBe(0);
    expect((await machine.seshi(["sessions", "ls"])).out).toContain("claude-code/s1");
    expect((await machine.seshi(["admin", "layout"])).code).toBe(2);
  });

  it("pulls and pushes the shared settings, checked and without lost updates", async () => {
    const dir = join(machine.dir, "shared");
    expect((await machine.seshi(["admin", "config", "pull", dir])).code).toBe(0);
    writeFileSync(
      join(dir, "seshi.toml"),
      '[[review.policies]]\nid = "p"\ndecision = { api_key = "sk-literal" }\n',
    );
    const literal = await machine.seshi(["admin", "config", "push", dir]);
    expect(literal.code).toBe(3);
    expect(literal.err).toContain("a secret's value in the shared config");

    writeFileSync(
      join(dir, "seshi.toml"),
      '[store.credentials]\naccess_key_id = "AKIA"\nsecret_access_key = "s3cret"\n',
    );
    const ignoredSecret = await machine.seshi(["admin", "config", "push", dir]);
    expect(ignoredSecret.code).toBe(3);
    expect(ignoredSecret.err).toContain("store.credentials.secret_access_key");

    writeFileSync(
      join(dir, "seshi.toml"),
      'default_visibility = "owner"\n[server]\nlisten = ":9000"\n',
    );
    const dry = await machine.seshi(["admin", "config", "push", dir, "--dry-run"]);
    expect(dry.out).toContain("Would push seshi.toml (create)");
    expect(dry.out).toContain("[server]");
    expect((await machine.seshi(["admin", "config", "push", dir])).code).toBe(0);

    const other = join(machine.dir, "other");
    expect((await machine.seshi(["admin", "config", "pull", other])).code).toBe(0);
    writeFileSync(join(other, "seshi.toml"), 'default_visibility = "org"\n');
    expect((await machine.seshi(["admin", "config", "push", other])).code).toBe(0);
    writeFileSync(join(dir, "seshi.toml"), 'default_visibility = "owner"\n# mine\n');
    const stale = await machine.seshi(["admin", "config", "push", dir]);
    expect(stale.code).toBe(6);
    expect(stale.err).toContain("changed since this folder was pulled");
  });

  it("holds uploads for a required review key, until one is stored", async () => {
    const dir = join(machine.dir, "shared");
    await machine.seshi(["admin", "config", "pull", dir]);
    writeFileSync(
      join(dir, "seshi.toml"),
      '[review]\nrequired = true\n[[review.policies]]\nid = "team"\ndecision = { api_key = { env = "ANTHROPIC_API_KEY" } }\n',
    );
    expect((await machine.seshi(["admin", "config", "push", dir])).code).toBe(0);
    const file = join(machine.dir, "s1.jsonl");
    writeFileSync(file, CLAUDE);
    const held = await machine.seshi(["upload", "--agent", "claude-code", file]);
    expect(held.code).toBe(3);
    expect(held.out).toContain(
      "needs review key: this team requires model review, and no key for anthropic is set.",
    );
    expect(held.out).toContain("seshi review key set anthropic");
    expect((await machine.seshi(["sessions", "ls"])).out).not.toContain("claude-code/s1");
    const doctor = await machine.seshi(["doctor"]);
    expect(doctor.out).toContain("Serverless bucket");
    expect(doctor.out).toMatch(/fail\s+Model review/);

    const set = await machine.seshi(["review", "key", "set", "anthropic", "--key", "-"], {
      stdin: "sk-test\n",
    });
    expect(set.code, set.err).toBe(0);
    expect(await machine.secrets.get("review anthropic")).toBe("sk-test");
    const after = await machine.seshi(["doctor", "--json"]);
    const review = JSON.parse(after.out).bucket.find((c: { id: string }) => c.id === "review");
    expect(review.status).toBe("ok");
  });

  it("reads this machine's drop and failure records, and says what needs a server", async () => {
    const dropped = await machine.seshi(["sync", "dropped", "upload"]);
    expect(dropped.code, dropped.err).toBe(0);
    expect(dropped.out).toContain("no dropped records for upload");
    const run = await machine.seshi(["sync", "run", "dd"]);
    expect(run.code).toBe(3);
    expect(run.err).toContain("needs a server");
    expect((await machine.seshi(["workers", "status"])).err).toContain("runs no workers");
  });
});
