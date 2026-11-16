import type { FormatAdapter } from "@seshi/model";
import { describe, expect, it } from "vitest";
import {
  CheckpointLost,
  type Connector,
  connectorsOf,
  defineIntegration,
  formatsOf,
  type Integration,
} from "./index";

const adapter = (source: string): FormatAdapter => ({
  source,
  chunkable: true,
  normalize: () => [],
});

describe("defineIntegration", () => {
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

const connector = (kind: string): Connector => ({ kind, run: async () => undefined });

describe("connectorsOf", () => {
  it("lists every integration's connectors in registry order", () => {
    const integrations: Integration[] = [
      { name: "a", connectors: [connector("datadog")] },
      { name: "b" },
      { name: "c", connectors: [connector("cursor-cloud")] },
    ];
    expect(connectorsOf(integrations).map((c) => c.kind)).toEqual(["datadog", "cursor-cloud"]);
  });

  it("refuses two connectors for one source type", () => {
    expect(() =>
      connectorsOf([
        { name: "a", connectors: [connector("datadog")] },
        { name: "b", connectors: [connector("datadog")] },
      ]),
    ).toThrow(/provided by both 'a' and 'b'/);
  });
});

describe("CheckpointLost", () => {
  it("names the source whose run is discarded", () => {
    const err = new CheckpointLost("dd-prod");
    expect(err.sourceId).toBe("dd-prod");
    expect(err.message).toMatch(/dd-prod.*discarded/);
    expect(err).toBeInstanceOf(Error);
  });
});
