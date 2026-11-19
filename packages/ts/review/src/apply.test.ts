import type { NormalizedRecord } from "@seshi/model";
import { describe, expect, it } from "vitest";
import {
  applyFindings,
  checkFindings,
  checkLabel,
  MIN_FINDING_CHARS,
  type RawFinding,
} from "./apply";
import { ProviderError } from "./provider";
import { entriesOf } from "./render";

const ts = "2026-11-01T00:00:00Z";
const RECORDS = [
  {
    role: "user",
    content: "login ops / Tangerine-1987 then ping Tangerine-1987 again",
    timestamp: ts,
  },
  {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "c1", name: "Bash", args: '{"command":"PGPASSWORD=Zr9-hush psql"}' }],
    timestamp: ts,
  },
  { role: "tool", tool_call_id: "c1", content: "id | name\n1 | Ana Pereira", timestamp: ts },
] as unknown as NormalizedRecord[];
const SHOWN = entriesOf(RECORDS);
const CATEGORIES = new Set(["secret", "personal"]);

const finding = (f: Partial<RawFinding>): RawFinding => ({
  record: 0,
  field: "content",
  text: "Tangerine-1987",
  category: "secret",
  action: "redact",
  ...f,
});

describe("checkLabel", () => {
  it("refuses anything else as an answer that does not fit, which is retried", () => {
    for (const answer of [
      { label: "maybe" },
      { label: "allow", reason: "looks fine" },
      { labels: ["allow"] },
      "allow",
      null,
      ["allow"],
    ]) {
      const err = (() => {
        try {
          checkLabel(answer);
        } catch (e) {
          return e;
        }
      })() as ProviderError;
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.code).toBe("invalid_answer");
      expect(err.retryable).toBe(true);
    }
  });
});

describe("checkFindings", () => {
  it("takes findings of the right shape", () => {
    expect(checkFindings({ findings: [] })).toEqual([]);
    expect(checkFindings({ findings: [finding({})] })).toEqual([finding({})]);
  });

  it("refuses a wrong shape", () => {
    for (const answer of [
      {},
      { findings: "none" },
      { findings: [{ ...finding({}), record: "0" }] },
      { findings: [{ ...finding({}), record: 1.5 }] },
      { findings: [{ ...finding({}), action: "rewrite" }] },
      { findings: [{ ...finding({}), text: 3 }] },
      { findings: [null] },
    ]) {
      expect(() => checkFindings(answer)).toThrow(ProviderError);
    }
  });
});

describe("applyFindings", () => {
  it("removes every occurrence of the text from that field only, and records where, never what", () => {
    const applied = applyFindings(
      RECORDS,
      [{ findings: [finding({})], shown: SHOWN }],
      CATEGORIES,
      0,
    );
    expect((applied.records[0] as { content: string }).content).toBe(
      "login ops / [redacted:secret] then ping [redacted:secret] again",
    );
    expect(applied.findings).toEqual([
      { record: 0, field: "content", category: "secret", action: "redact" },
    ]);
    expect(applied.unmatched).toBe(0);
    expect(JSON.stringify(applied.findings)).not.toContain("Tangerine");
    // The input is never changed.
    expect((RECORDS[0] as { content: string }).content).toContain("Tangerine-1987");
  });

  it("removes text from a tool call's arguments", () => {
    const applied = applyFindings(
      RECORDS,
      [
        {
          findings: [finding({ record: 1, field: "tool_calls[0].args", text: "Zr9-hush" })],
          shown: SHOWN,
        },
      ],
      CATEGORIES,
      0,
    );
    const calls = (applied.records[1] as { tool_calls: { args: string }[] }).tool_calls;
    expect(calls[0]?.args).toBe('{"command":"PGPASSWORD=[redacted:secret] psql"}');
  });

  it("withholds a whole tool result, marked withheld: review", () => {
    const applied = applyFindings(
      RECORDS,
      [
        {
          findings: [
            finding({ record: 2, text: "Ana Pereira", category: "personal", action: "withhold" }),
          ],
          shown: SHOWN,
        },
      ],
      CATEGORIES,
      1,
    );
    expect(applied.records[2]).toMatchObject({
      role: "tool",
      tool_call_id: "c1",
      content: "[redacted:personal]",
      withheld: "review",
    });
    // Indexes are the written trace's: the meta record comes first.
    expect(applied.findings).toEqual([
      { record: 3, field: "content", category: "personal", action: "withhold" },
    ]);
  });

  it("takes withhold outside a tool result as removing the text it names", () => {
    const applied = applyFindings(
      RECORDS,
      [{ findings: [finding({ action: "withhold" })], shown: SHOWN }],
      CATEGORIES,
      0,
    );
    expect(applied.records[0]).not.toHaveProperty("withheld");
    expect(applied.findings[0]?.action).toBe("redact");
  });

  it("files a category the policy does not have under other", () => {
    const applied = applyFindings(
      RECORDS,
      [{ findings: [finding({ category: "made-up" })], shown: SHOWN }],
      CATEGORIES,
      0,
    );
    expect((applied.records[0] as { content: string }).content).toContain("[redacted:other]");
    expect(applied.findings[0]?.category).toBe("other");
  });

  it("counts findings that name nothing it was given as unmatched, and removes nothing for them", () => {
    const shownFirstOnly = SHOWN.filter((e) => e.record === 0);
    const applied = applyFindings(
      RECORDS,
      [
        {
          findings: [
            finding({ text: "not in the record" }),
            finding({ text: "ops" }), // shorter than MIN_FINDING_CHARS
            finding({ record: 2, text: "Ana Pereira" }), // a record this part did not show
            finding({ record: 9 }),
            finding({ field: "timestamp", text: ts }),
          ],
          shown: shownFirstOnly,
        },
      ],
      CATEGORIES,
      0,
    );
    expect("ops".length).toBeLessThan(MIN_FINDING_CHARS);
    expect(applied.unmatched).toBe(5);
    expect(applied.findings).toEqual([]);
    expect(applied.records).toEqual(RECORDS);
  });

  it("merges overlapping and repeated findings into one marker and one recorded location", () => {
    const applied = applyFindings(
      RECORDS,
      [
        { findings: [finding({}), finding({ text: "ops / Tangerine" })], shown: SHOWN },
        { findings: [finding({})], shown: SHOWN },
      ],
      CATEGORIES,
      0,
    );
    expect((applied.records[0] as { content: string }).content).toBe(
      "login [redacted:secret] then ping [redacted:secret] again",
    );
    expect(applied.findings).toHaveLength(1);
  });
});
