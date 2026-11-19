import type { FormatAdapter, NormalizedRecord } from "@seshi/model";
import { describe, expect, it } from "vitest";
import { BUILTIN_FORMATS, lettaAdapter, TRAJECTORY_VERSION } from "./index";
import { compareNormalizerVersions, FormatRegistry, NORMALIZER, NormalizeError } from "./registry";

const META = { role: "meta", source: "a" } as NormalizedRecord;
const USER = { role: "user", content: "hi", timestamp: "2026-09-01T00:00:00Z" } as NormalizedRecord;

function adapter(source: string, overrides: Partial<FormatAdapter> = {}): FormatAdapter {
  return { source, chunkable: true, normalize: () => [META, USER], ...overrides };
}

const codeError = (code: string) => Object.assign(new Error(`failed: ${code}`), { code });

describe("FormatRegistry", () => {
  it("lists its formats in the order given", () => {
    const registry = new FormatRegistry([adapter("b"), adapter("a")]);
    expect(registry.sources).toEqual(["b", "a"]);
    expect(registry.has("a")).toBe(true);
    expect(registry.has("c")).toBe(false);
    expect(registry.get("b")?.source).toBe("b");
  });

  it("refuses two adapters with one name", () => {
    expect(() => new FormatRegistry([adapter("a"), adapter("a")])).toThrow(/two format adapters/);
  });

  it("says which formats can arrive in chunks", () => {
    const registry = new FormatRegistry([adapter("log"), adapter("doc", { chunkable: false })]);
    expect(registry.isChunkable("log")).toBe(true);
    expect(registry.isChunkable("doc")).toBe(false);
  });

  it("normalizes through the adapter, then the postprocess", () => {
    const registry = new FormatRegistry([adapter("a")]);
    expect(registry.normalize({ source: "a", transcript: "x" })).toEqual({ records: [META, USER] });
    const outcome = registry.normalize(
      { source: "a", transcript: "x" },
      { postprocess: (records) => records.slice(1) },
    );
    expect(outcome).toEqual({ records: [USER] });
  });

  it("is empty for a blank transcript without asking the adapter", () => {
    const registry = new FormatRegistry([
      adapter("a", {
        normalize: () => {
          throw new Error("asked");
        },
      }),
    ]);
    expect(registry.normalize({ source: "a", transcript: " \n" })).toEqual({
      records: [],
      empty: true,
    });
  });

  it("is empty for a chunk with no records left, not for a whole log", () => {
    const registry = new FormatRegistry([adapter("a", { normalize: () => [] })]);
    const chunk = { offset: 4, session_id: "s" };
    expect(registry.normalize({ source: "a", transcript: "x\n", chunk })).toEqual({
      records: [],
      empty: true,
    });
    expect(registry.normalize({ source: "a", transcript: "x\n" })).toEqual({ records: [] });
  });

  it("calls a log with no conversation empty, and wraps every other failure", () => {
    for (const code of ["missing_user_records", "missing_assistant_records"]) {
      const registry = new FormatRegistry([
        adapter("a", {
          normalize: () => {
            throw codeError(code);
          },
        }),
      ]);
      expect(registry.normalize({ source: "a", transcript: "x" })).toEqual({
        records: [],
        empty: true,
      });
    }
    const coded = new FormatRegistry([
      adapter("a", {
        normalize: () => {
          throw codeError("invalid_input");
        },
      }),
    ]);
    expect(() => coded.normalize({ source: "a", transcript: "x" })).toThrow(
      expect.objectContaining({ name: "NormalizeError", code: "invalid_input" }),
    );
    const plain = new FormatRegistry([
      adapter("a", {
        normalize: () => {
          throw new Error("boom");
        },
      }),
    ]);
    expect(() => plain.normalize({ source: "a", transcript: "x" })).toThrow(
      expect.objectContaining({ code: "normalize_failed", message: "boom" }),
    );
  });

  it("refuses a format it does not know", () => {
    const registry = new FormatRegistry([]);
    expect(() => registry.normalize({ source: "nope", transcript: "x" })).toThrow(NormalizeError);
  });

  it("detects through the adapters' own rules", () => {
    const registry = new FormatRegistry([
      adapter("doc", { detect: { document: (head) => head.get("kind")?.text === "doc" } }),
      adapter("log", { detect: { record: (row) => row.kind === "log" } }),
      adapter("other", { detect: { record: (row) => row.kind === "other" } }),
      adapter("silent"),
    ]);
    expect(registry.detect('{"kind": "doc", "body": [1, 2')).toBe("doc");
    expect(registry.detect('{"kind":"log"}\n{"kind":"log"}\n{"kind":"lo')).toBe("log");
    expect(registry.detect('{"kind":"log"}\n{"kind":"other"}\n')).toBeNull();
    expect(registry.detect('{"kind":"unknown"}\n')).toBeNull();
    expect(registry.detect("")).toBeNull();
  });

  it("knows the built-in formats", () => {
    const registry = new FormatRegistry(BUILTIN_FORMATS);
    expect(registry.sources).toEqual(["atif", "trajectory"]);
    expect(registry.isChunkable("atif")).toBe(false);
    expect(registry.detect('{"schema_version": "ATIF-v1.7", "steps": [')).toBe("atif");
  });
});

describe("NORMALIZER", () => {
  it("keeps the name traces have always recorded", () => {
    expect(NORMALIZER.name).toBe("@dosu/sessiondb");
    expect(NORMALIZER.version).toMatch(/^\d+\.\d+\.\d+.*\+trajectory\./);
  });
});

describe("normalizer versions (X4.9)", () => {
  it("compares versions number by number", () => {
    expect(compareNormalizerVersions("1", "1")).toBe(0);
    expect(compareNormalizerVersions("1", "2")).toBeLessThan(0);
    expect(compareNormalizerVersions("1+trajectory.0.3.0", "1+trajectory.0.10.0")).toBeLessThan(0);
    expect(compareNormalizerVersions("2+trajectory.0.3.0", "1+trajectory.0.9.0")).toBeGreaterThan(
      0,
    );
    // A number missing is 0, so an adapter that starts naming its library is newer.
    expect(compareNormalizerVersions("1", "1+trajectory.0.3.0")).toBeLessThan(0);
    expect(compareNormalizerVersions("1.0", "1")).toBe(0);
  });

  it("gives each format its version, 1 by default, and says what is stale", () => {
    const registry = new FormatRegistry([adapter("a"), adapter("b", { version: "3" })]);
    expect(registry.versionOf("a")).toBe("1");
    expect(registry.versionOf("b")).toBe("3");
    expect(registry.versionOf("c")).toBeUndefined();
    expect(registry.normalizerFor("b")).toEqual({ ...NORMALIZER, format_version: "3" });
    expect(registry.isStale("b", "2")).toBe(true);
    expect(registry.isStale("b", "3")).toBe(false);
    expect(registry.isStale("b", "4")).toBe(false);
    // Nothing recorded: built before versions were.
    expect(registry.isStale("a", undefined)).toBe(true);
    // A format this deployment does not read cannot be rebuilt here.
    expect(registry.isStale("c", undefined)).toBe(false);
  });

  it("names the library a Letta-based adapter runs, so a new library makes sessions stale", () => {
    const atif = new FormatRegistry([...BUILTIN_FORMATS]);
    expect(atif.versionOf("atif")).toBe(`1+trajectory.${TRAJECTORY_VERSION}`);
    const revised = lettaAdapter({ source: "pi", revision: 2 });
    expect(revised.version).toBe(`2+trajectory.${TRAJECTORY_VERSION}`);
  });
});
