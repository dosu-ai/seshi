/** `seshi review eval` against a local server that imitates the provider APIs; nothing reaches a
 * real API. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_FIXTURES, type Fixture } from "@seshi/review";
import { type FakeServer, fakeProviderServer, KeywordModel } from "@seshi/review/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../cli/exit";
import { main } from "../main";

let dir: string;
let server: FakeServer | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-review-"));
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** A model that answers every built-in fixture as labelled. */
function oracle(fixtures: readonly Fixture[]): KeywordModel {
  return new KeywordModel({
    drop: fixtures.filter((f) => f.label === "drop").map((f) => f.sensitive[0] as string),
    sensitive: fixtures
      .filter((f) => f.label === "redact")
      .flatMap((f) => f.sensitive.map((text) => ({ text, category: "secret" }))),
  });
}

async function seshi(argv: string[], policies: string) {
  const file = join(dir, "seshi.toml");
  writeFileSync(file, `[store]\nurl = "file://${join(dir, "bucket")}"\n${policies}`, {
    mode: 0o600,
  });
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {
    env: { SESHI_CONFIG: file },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    integrations: async () => [],
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const policy = (id: string, url: string) =>
  `[[review.policies]]\nid = "${id}"\nretries = 0\ndecision = { api_key = "sk-test", base_url = "${url}" }\n`;

describe("seshi review eval", () => {
  it("scores the first policy on seshi's fixtures through its real provider", async () => {
    server = fakeProviderServer({ model: oracle(BUILTIN_FIXTURES) });
    const { code, out, err } = await seshi(["review", "eval"], policy("default", server.url));
    expect(err).toContain(`sending ${BUILTIN_FIXTURES.length} fixture(s) to ${server.url}`);
    expect(code).toBe(EXIT.ok);
    expect(out).toContain("policy default (");
    expect(out).toContain("decision model anthropic/claude-haiku-5-5");
    expect(out).toContain("label accuracy 100%, false drops 0, missed drops 0");
    expect(out).toContain("redactor recall 100%, leaked 0, failed 0");
    // Only the Messages API was called, and nothing outside the fixtures was sent.
    expect(new Set(server.requests.map((r) => r.api))).toEqual(new Set(["anthropic"]));
  });

  it("answers in JSON, picks a policy by id, reads fixtures from a folder, and asks for attention on a miss", async () => {
    server = fakeProviderServer({ model: new KeywordModel({ drop: ["ordinary"] }) });
    const folder = join(dir, "fixtures");
    mkdirSync(folder);
    writeFileSync(
      join(folder, "a.json"),
      JSON.stringify({
        name: "plain",
        label: "allow",
        records: [
          { role: "user", content: "an ordinary question", timestamp: "2026-11-01T00:00:00Z" },
        ],
      }),
    );
    const { code, out } = await seshi(
      ["review", "eval", "--policy", "second", "--fixtures", folder, "--json"],
      policy("first", "http://127.0.0.1:1") + policy("second", server.url),
    );
    expect(code).toBe(EXIT.attention);
    const report = JSON.parse(out);
    expect(report).toMatchObject({
      policy: "second",
      fixtures: 1,
      false_drops: 1,
      results: [{ name: "plain", expected: "allow", got: "drop" }],
    });
  });

  it("reports provider failures per fixture", async () => {
    server = fakeProviderServer({ reply: () => ({ status: 401 }) });
    const { code, out } = await seshi(["review", "eval", "--json"], policy("p", server.url));
    expect(code).toBe(EXIT.attention);
    const report = JSON.parse(out);
    expect(report.failures).toBe(BUILTIN_FIXTURES.length);
    expect(report.results[0]).toMatchObject({ got: "failed", failure: "decision: http_401" });
  });

  it("refuses what it cannot run", async () => {
    expect((await seshi(["review"], "")).code).toBe(EXIT.usage);
    expect((await seshi(["review", "judge"], "")).code).toBe(EXIT.usage);
    expect((await seshi(["review", "eval", "--nope"], "")).code).toBe(EXIT.usage);
    const none = await seshi(["review", "eval"], "");
    expect(none).toMatchObject({ code: EXIT.config });
    expect(none.err).toContain("no [[review.policies]]");
    const unknown = await seshi(
      ["review", "eval", "--policy", "x"],
      policy("p", "http://127.0.0.1:1"),
    );
    expect(unknown).toMatchObject({ code: EXIT.notFound });
    expect(unknown.err).toContain("no review policy 'x' (p)");
    const missing = await seshi(
      ["review", "eval", "--fixtures", join(dir, "nope.json")],
      policy("p", "http://127.0.0.1:1"),
    );
    expect(missing.code).toBe(EXIT.notFound);
    writeFileSync(
      join(dir, "bad.json"),
      JSON.stringify([{ name: "x", label: "maybe", records: [{}] }]),
    );
    const bad = await seshi(
      ["review", "eval", "--fixtures", join(dir, "bad.json")],
      policy("p", "http://127.0.0.1:1"),
    );
    expect(bad.code).toBe(EXIT.usage);
    expect(bad.err).toContain("label must be allow, redact or drop");
    const noKey = await seshi(["review", "eval"], `[[review.policies]]\nid = "p"\n`);
    expect(noKey.code).toBe(EXIT.config);
    const noPrompt = await seshi(
      ["review", "eval"],
      `[[review.policies]]\nid = "p"\ndecision = { api_key = "k", prompt_file = "${join(dir, "missing.md")}" }\n`,
    );
    expect(noPrompt.code).toBe(EXIT.config);
    expect(noPrompt.err).toContain("cannot read prompt_file");
  });
});
