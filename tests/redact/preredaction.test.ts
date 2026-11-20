/** Client pre-redaction end to end (F2.4): a client fetches the org's rule packs over HTTP,
 * builds the same rule set as the server, redacts a transcript before it leaves, and uploads
 * it; the server redacts again and records its own rule set. */

import { HttpSessionDB } from "@seshi/client";
import { compileRuleSet, redactTranscript, ruleSetFromDocument, validatePack } from "@seshi/redact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempStore, testApp } from "../tooling/instance";

const TOKEN = "static-token-0123456789abcdef";
let temp: ReturnType<typeof tempStore>;
beforeEach(() => {
  temp = tempStore("seshi-preredact-");
});
afterEach(() => temp.cleanup());

const rules = compileRuleSet({
  packs: [
    validatePack(
      { id: "acme", rules: [{ id: "acme-key", pattern: "ACME-\\d{4}" }] },
      { source: "acme.toml" },
    ),
  ],
});

const ts = "2026-11-14T09:00:00Z";
const transcript = `${[
  { role: "meta", source: "trajectory" },
  { role: "user", content: `deploy with ACME-1234 ${"x".repeat(2000)}`, timestamp: ts },
  { role: "assistant", content: "done, key ghp_abcdefghijklmnopqrstuvwx0123456789", timestamp: ts },
]
  .map((r) => JSON.stringify(r))
  .join("\n")}\n`;

describe("client pre-redaction (F2.4)", () => {
  it("fetches the server's packs, redacts before upload, and the server agrees", async () => {
    const app = testApp({
      store: temp.store,
      tokens: [{ token: TOKEN, owner: "alice" }],
      redaction: rules,
    });
    const sent: string[] = [];
    const client = new HttpSessionDB({
      server: "http://seshi.test",
      token: TOKEN,
      gzipFrom: Number.POSITIVE_INFINITY,
      fetch: async (url, init) => {
        if (typeof init?.body === "string") sent.push(init.body);
        else if (init?.body) sent.push(new TextDecoder().decode(init.body as Uint8Array));
        return app.fetch(new Request(url, init));
      },
    });

    const { rules: local, same } = ruleSetFromDocument(await client.redactionRules());
    expect(same).toBe(true);
    expect(local.hash).toBe(rules.hash);

    const clean = redactTranscript(local, transcript, "jsonl");
    expect(clean.summary.counts).toEqual({ "acme-key": 1, "github-token": 1 });
    const stored = await client.ingest({
      format: "trajectory",
      session_id: "s1",
      transcript: clean.text,
    });
    expect(stored.status).toBe("stored");
    // Nothing secret left the machine.
    expect(sent.join("\n")).not.toContain("ACME-1234");
    expect(sent.join("\n")).not.toContain("ghp_");
    // The server redacted again with its own rules: nothing left to count, its hash recorded.
    const session = await client.getSession("trajectory", "s1");
    expect(session?.redaction).toEqual({ rule_set: rules.hash, counts: {} });
  });
});
