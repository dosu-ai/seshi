import { describe, expect, it } from "vitest";
import { BUILTIN_FIXTURES, evaluate, type Fixture, FixtureError, parseFixtures } from "./eval";
import type { Policy } from "./policy";
import { DEFAULT_CATEGORIES } from "./prompts";
import { FakeProvider, KeywordModel } from "./testing";

function policyWith(model: KeywordModel, extra: Partial<Policy> = {}): Policy {
  return {
    id: "candidate",
    hash: "b".repeat(64),
    sources: ["only-this-source"],
    agents: [],
    repos: [],
    onFailure: "drop",
    retries: 0,
    maxInputChars: 100_000,
    decision: {
      provider: new FakeProvider({ model: "judge", keywords: model }),
      prompt: "judge",
      maxTokens: 10,
      timeoutMs: 10,
    },
    redactor: {
      provider: new FakeProvider({ model: "finder", keywords: model }),
      prompt: "find",
      maxTokens: 10,
      timeoutMs: 10,
      categories: DEFAULT_CATEGORIES,
    },
    ...extra,
  };
}

/** A model that knows the answers: what each fixture says. */
function oracle(fixtures: readonly Fixture[]): KeywordModel {
  return new KeywordModel({
    drop: fixtures.filter((f) => f.label === "drop").map((f) => f.sensitive[0] as string),
    sensitive: fixtures
      .filter((f) => f.label === "redact")
      .flatMap((f) => f.sensitive.map((text) => ({ text, category: "secret" }))),
  });
}

describe("BUILTIN_FIXTURES", () => {
  it("are valid fixtures covering every label, and their sensitive text is in them", () => {
    expect(parseFixtures(BUILTIN_FIXTURES, "builtin")).toHaveLength(BUILTIN_FIXTURES.length);
    expect(new Set(BUILTIN_FIXTURES.map((f) => f.label))).toEqual(
      new Set(["allow", "redact", "drop"]),
    );
    for (const fixture of BUILTIN_FIXTURES) {
      const text = JSON.stringify(fixture.records);
      for (const s of fixture.sensitive) expect(text).toContain(s);
      if (fixture.label !== "allow") expect(fixture.sensitive.length).toBeGreaterThan(0);
    }
  });
});

describe("evaluate", () => {
  it("scores a policy that gets everything right (F3.8)", async () => {
    const report = await evaluate(policyWith(oracle(BUILTIN_FIXTURES)), BUILTIN_FIXTURES, {
      sleep: async () => {},
    });
    expect(report).toMatchObject({
      policy: "candidate",
      policy_hash: "b".repeat(64),
      decision_model: "fake/judge",
      redactor_model: "fake/finder",
      fixtures: BUILTIN_FIXTURES.length,
      label_accuracy: 1,
      false_drops: 0,
      missed_drops: 0,
      redactor_recall: 1,
      leaked: 0,
      failures: 0,
    });
  });

  it("counts false drops, missed drops, recall and leaks", async () => {
    const fixtures: Fixture[] = [
      { name: "fine", label: "allow", sensitive: [], records: [rec("BAD ordinary")] },
      {
        name: "two-secrets",
        label: "redact",
        sensitive: ["alpha-secret", "beta-secret"],
        records: [rec("alpha-secret and beta-secret")],
      },
      { name: "should-drop", label: "drop", sensitive: ["dump"], records: [rec("dump of rows")] },
    ];
    // Drops anything with BAD; finds only alpha; never drops a dump.
    const model = new KeywordModel({
      drop: ["BAD"],
      sensitive: [{ text: "alpha-secret", category: "secret" }],
    });
    const report = await evaluate(policyWith(model), fixtures, { sleep: async () => {} });
    expect(report.results).toEqual([
      { name: "fine", expected: "allow", got: "drop", findings: 0, leaked: 0 },
      { name: "two-secrets", expected: "redact", got: "redact", findings: 1, leaked: 1 },
      { name: "should-drop", expected: "drop", got: "allow", findings: 0, leaked: 1 },
    ]);
    expect(report).toMatchObject({
      label_accuracy: 1 / 3,
      false_drops: 1,
      missed_drops: 1,
      redactor_recall: 0.5,
      leaked: 2,
    });
  });

  it("reports failures by step and code, not as labels", async () => {
    const policy = policyWith(new KeywordModel({}));
    policy.decision.provider = new FakeProvider({ model: "down" });
    const report = await evaluate(policy, BUILTIN_FIXTURES.slice(0, 2), { sleep: async () => {} });
    expect(report.failures).toBe(2);
    expect(report.results[0]).toMatchObject({ got: "failed", failure: "decision: http_500" });
    expect(report.redactor_recall).toBeNull();
  });
});

describe("parseFixtures", () => {
  it("names what is wrong", () => {
    expect(() => parseFixtures({ name: "x", label: "maybe", records: [{}] }, "f.json")).toThrow(
      new FixtureError("f.json[0]: label must be allow, redact or drop"),
    );
    expect(() => parseFixtures([{ name: "x", label: "allow", records: [] }], "f.json")).toThrow(
      "records must be a non-empty list",
    );
    expect(() =>
      parseFixtures({ name: "x", label: "allow", sensitive: [""], records: [{}] }, "f.json"),
    ).toThrow("sensitive");
    expect(
      parseFixtures({ name: "x", label: "allow", records: [{}] }, "f.json")[0]?.sensitive,
    ).toEqual([]);
  });
});

function rec(content: string) {
  return { role: "user", content, timestamp: "2026-11-01T00:00:00Z" } as never;
}
