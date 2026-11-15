import { BUILTIN_FORMATS } from "@seshi/formats";
import { describe, expect, it } from "vitest";
import { buildFormats, INTEGRATIONS } from "./integrations";

describe("the integration registry", () => {
  it("names each integration once", () => {
    const names = INTEGRATIONS.map((integration) => integration.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("reads every format the server has always accepted", () => {
    expect(buildFormats().sources.sort()).toEqual(
      [
        "claude-code",
        "cursor",
        "codex",
        "opencode",
        "pi",
        "gemini-cli",
        "atif",
        "datadog-trajectory",
        "otlp-genai",
        "trajectory",
      ].sort(),
    );
  });

  it("lists the integrations' formats first, then the built-in ones", () => {
    const sources = buildFormats().sources;
    expect(sources.slice(-BUILTIN_FORMATS.length)).toEqual(BUILTIN_FORMATS.map((f) => f.source));
    expect(sources[0]).toBe("claude-code");
  });

  it("builds a registry from any list of integrations", () => {
    expect(buildFormats([]).sources).toEqual(BUILTIN_FORMATS.map((f) => f.source));
  });
});
