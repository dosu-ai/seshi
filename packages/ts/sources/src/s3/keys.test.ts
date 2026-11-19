import { describe, expect, it } from "vitest";
import { KeyFilter, metadataFields, PathTemplate } from "./keys";

describe("path templates (F6)", () => {
  it("reads placeholders from the key under the prefix", () => {
    const t = new PathTemplate("{username}/{project}/{session}.jsonl");
    expect(t.match("alice/app/abc-123.jsonl")).toEqual({
      username: "alice",
      project: "app",
      session: "abc-123",
    });
    expect(t.match("alice/app/abc-123.json")).toBeNull();
    expect(t.match("alice/abc-123.jsonl")).toBeNull();
    // A placeholder never spans a `/`.
    expect(t.match("alice/app/x/abc.jsonl")).toBeNull();
  });

  it("matches * within a segment, ** across segments, ? one character", () => {
    expect(new PathTemplate("runs/*/{session}.json").match("runs/2026-11/s1.json")).toEqual({
      session: "s1",
    });
    expect(new PathTemplate("runs/*/{session}.json").match("runs/a/b/s1.json")).toBeNull();
    const deep = new PathTemplate("**/{email}/{session}.jsonl");
    expect(deep.match("a@b.co/s.jsonl")).toEqual({ email: "a@b.co", session: "s" });
    expect(deep.match("x/y/a@b.co/s.jsonl")).toEqual({ email: "a@b.co", session: "s" });
    expect(new PathTemplate("logs/**").match("logs/a/b/c")).toEqual({});
    expect(new PathTemplate("s?.jsonl").match("s1.jsonl")).toEqual({});
    expect(new PathTemplate("s?.jsonl").match("s12.jsonl")).toBeNull();
  });

  it("takes regex characters literally", () => {
    const t = new PathTemplate("a.b+(c)/{session}");
    expect(t.match("a.b+(c)/x")).toEqual({ session: "x" });
    expect(t.match("aXb+(c)/x")).toBeNull();
  });

  it("names every field a key can carry", () => {
    const t = new PathTemplate("{format}/{branch}/{name}/{git_email}/{git_name}/{session}");
    expect(t.match("codex/main/Ann/a@x.io/ann/s")).toEqual({
      format: "codex",
      branch: "main",
      name: "Ann",
      git_email: "a@x.io",
      git_name: "ann",
      session: "s",
    });
  });

  it("refuses unknown, repeated and unmatched placeholders", () => {
    expect(() => new PathTemplate("{owner}/{session}")).toThrow(/unknown placeholder \{owner\}/);
    expect(() => new PathTemplate("{session}/{session}")).toThrow(/appears twice/);
    expect(() => new PathTemplate("{session")).toThrow(/unmatched \{/);
    expect(() => new PathTemplate("session}")).toThrow(/unmatched \}/);
  });
});

describe("include globs", () => {
  it("includes every key without globs, else keys any glob matches", () => {
    expect(new KeyFilter([]).includes("anything/at/all")).toBe(true);
    const f = new KeyFilter(["**/*.jsonl", "exports/*.json"]);
    expect(f.includes("a/b/c.jsonl")).toBe(true);
    expect(f.includes("c.jsonl")).toBe(true);
    expect(f.includes("exports/x.json")).toBe(true);
    expect(f.includes("exports/deep/x.json")).toBe(false);
    expect(f.includes("notes.txt")).toBe(false);
  });
});

describe("object metadata", () => {
  it("reads x-amz-meta-seshi-* fields, - for _", () => {
    expect(
      metadataFields({
        "seshi-session": " s-9 ",
        "seshi-format": "atif",
        "seshi-git-email": "dev@x.io",
        "seshi-owner": "ignored",
        other: "ignored",
        "seshi-email": "  ",
      }),
    ).toEqual({ session: "s-9", format: "atif", git_email: "dev@x.io" });
  });
});
