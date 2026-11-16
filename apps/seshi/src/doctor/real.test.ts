/** The doctor's real redaction helpers over the built-in pack, and `seshi doctor`'s flags. */

import type { NormalizedRecord } from "@seshi/model";
import { redactionRules, ruleRedactor } from "@seshi/redact";
import { describe, expect, it } from "vitest";
import { parseDoctorArgs } from "../commands/doctor";
import { residueOf, ruleRedaction } from "./real";

/** A token the built-in github-token rule matches, split so no scanner reads it here. */
const TOKEN = `${"gh"}p_${"abcdefghijklmnopqrstuvwx0123456789"}`;

describe("residueOf", () => {
  const rules = redactionRules();
  const records = [
    { role: "meta", source: "claude-code", cwd: "/repo" },
    { role: "user", content: "read .env please" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "t1", name: "Read", args: JSON.stringify({ file_path: ".env" }) }],
    },
    { role: "tool", tool_call_id: "t1", content: "API_KEY=hunter2hunter2" },
    { role: "assistant", content: "done" },
  ] as unknown as NormalizedRecord[];

  it("finds nothing in records the rules already redacted, withheld results included", () => {
    const stored = ruleRedactor(rules).redact(records).records;
    expect(residueOf(rules, stored)).toEqual([]);
  });

  it("names the rule and the record of a secret left in, never the text", () => {
    const stored = ruleRedactor(rules).redact(records).records;
    stored[4] = { role: "assistant", content: `pushed with ${TOKEN}` } as NormalizedRecord;
    const hits = residueOf(rules, stored);
    expect(hits).toEqual([{ index: 4, rules: ["github-token"] }]);
    expect(JSON.stringify(hits)).not.toContain(TOKEN);
  });

  it("pre-redacts transcripts only where the uploader does", () => {
    const line = `${JSON.stringify({ content: `push ${TOKEN}` })}\n`;
    expect(ruleRedaction(rules, "built-in", true).transcript(line, "jsonl")).not.toContain(TOKEN);
    expect(ruleRedaction(rules, "local", false).transcript(line, "jsonl")).toBe(line);
  });
});

describe("seshi doctor's flags", () => {
  it("takes --session with or without an id, and the rest", () => {
    expect(parseDoctorArgs([])).toEqual({});
    expect(parseDoctorArgs(["--session"])).toEqual({ session: true });
    expect(parseDoctorArgs(["--session", "abc", "--agent", "codex", "--deep"])).toEqual({
      session: "abc",
      agent: "codex",
      deep: true,
    });
    expect(parseDoctorArgs(["--since", "7d", "--server", "https://s.test"])).toEqual({
      since: "7d",
      server: "https://s.test",
    });
  });

  it("refuses what it does not know", () => {
    expect(parseDoctorArgs(["--bogus"])).toContain("unknown option");
    expect(parseDoctorArgs(["stray"])).toContain("unexpected");
    expect(parseDoctorArgs(["--agent"])).toContain("needs a value");
    expect(parseDoctorArgs(["--session", "x", "--since", "1d"])).toContain("--since");
  });
});
