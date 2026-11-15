import type { FormatAdapter } from "@seshi/model";
import { describe, expect, it } from "vitest";
import { defineIntegration, formatsOf, type Integration } from "./index";

const adapter = (source: string): FormatAdapter => ({
  source,
  chunkable: true,
  normalize: () => [],
});

describe("defineIntegration", () => {
  it("returns the integration unchanged", () => {
    const integration = { name: "claude-code", formats: [adapter("claude-code")] };
    expect(defineIntegration(integration)).toBe(integration);
  });

  it("refuses a name that is not a lowercase slug", () => {
    for (const name of ["", "Claude", "claude code", "claude/code", "-claude", "claude-"]) {
      expect(() => defineIntegration({ name })).toThrow(/lowercase slug/);
    }
  });

  it("refuses a format listed twice", () => {
    expect(() => defineIntegration({ name: "x", formats: [adapter("x"), adapter("x")] })).toThrow(
      /lists format 'x' twice/,
    );
  });
});

describe("formatsOf", () => {
  it("lists every integration's formats in registry order", () => {
    const integrations: Integration[] = [
      { name: "a", formats: [adapter("a1"), adapter("a2")] },
      { name: "b" },
      { name: "c", formats: [adapter("c1")] },
    ];
    expect(formatsOf(integrations).map((f) => f.source)).toEqual(["a1", "a2", "c1"]);
  });

  it("refuses two integrations with one name", () => {
    expect(() => formatsOf([{ name: "a" }, { name: "a" }])).toThrow(/registered twice/);
  });

  it("refuses one format from two integrations", () => {
    expect(() =>
      formatsOf([
        { name: "a", formats: [adapter("x")] },
        { name: "b", formats: [adapter("x")] },
      ]),
    ).toThrow(/provided by both 'a' and 'b'/);
  });
});
