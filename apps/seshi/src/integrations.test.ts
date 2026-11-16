import { BUILTIN_FORMATS } from "@seshi/formats";
import { connectorsOf } from "@seshi/kit";
import { describe, expect, it } from "vitest";
import { buildFormats, INTEGRATIONS } from "./integrations";

describe("the integration registry", () => {
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
        "datadog-llmobs",
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

  it("schedules the Datadog LLM Observability poller for datadog sources", () => {
    expect(connectorsOf(INTEGRATIONS).map((c) => c.kind)).toEqual(["datadog"]);
  });

  it("builds a registry from any list of integrations", () => {
    expect(buildFormats([]).sources).toEqual(BUILTIN_FORMATS.map((f) => f.source));
  });
});
