import { describe, expect, it } from "vitest";
import { parseQuery } from "./query";
import {
  EXCERPT_WORDS,
  excerpt,
  highlights,
  indexText,
  MATCH_END,
  MATCH_START,
  MAX_INDEXED_CHARS,
} from "./snippet";

const m = (text: string) => `${MATCH_START}${text}${MATCH_END}`;

describe("highlights", () => {
  it("turns marked matches into plain text and ranges", () => {
    expect(highlights(`fix the ${m("flaky")} ${m("test")} now`)).toEqual({
      snippet: "fix the flaky test now",
      highlights: [
        [8, 13],
        [14, 18],
      ],
    });
    expect(highlights("…no match here…")).toEqual({ snippet: "…no match here…", highlights: [] });
  });

  it("merges touching ranges, ends an unclosed one with the text, ignores stray ends", () => {
    expect(highlights(`${m("src")}${m("app")}`).highlights).toEqual([[0, 6]]);
    expect(highlights(`a ${MATCH_START}bc`)).toEqual({ snippet: "a bc", highlights: [[2, 4]] });
    expect(highlights(`a${MATCH_END}b ${m("")}`)).toEqual({ snippet: "ab ", highlights: [] });
  });

  it("counts offsets in UTF-16 code units, as JavaScript strings do", () => {
    const { snippet, highlights: ranges } = highlights(`🎉 ${m("party")}`);
    expect(snippet.slice(...(ranges[0] as [number, number]))).toBe("party");
  });
});

describe("indexText", () => {
  it("removes the markers from what is indexed and caps it", () => {
    expect(indexText(`a${MATCH_START}b${MATCH_END}c`)).toBe("a b c");
    expect(indexText("x".repeat(MAX_INDEXED_CHARS + 10))).toHaveLength(MAX_INDEXED_CHARS);
  });
});

describe("excerpt", () => {
  const marked = (text: string, q: string) =>
    excerpt(text, parseQuery(q).match).replaceAll(MATCH_START, "[").replaceAll(MATCH_END, "]");

  it("marks the query's words, ignoring case and accents, and a phrase as one match", () => {
    expect(marked("Deploy the widget service to staging", "deploy staging")).toBe(
      "[Deploy] the widget service to [staging]",
    );
    expect(marked("Déployer le café", "deployer CAFE")).toBe("[Déployer] le [café]");
    expect(marked("fix the flaky test in src/app.ts now", "src/app.ts")).toBe(
      "fix the flaky test in [src/app.ts] now",
    );
    expect(marked("the auth flow, then auth and flow", '"auth flow"')).toBe(
      "the [auth flow], then auth and flow",
    );
  });

  it("marks a prefix's words, either side of OR, and never an excluded word", () => {
    expect(marked("deployment deploys a dep", "deplo*")).toBe("[deployment] [deploys] a dep");
    expect(marked("redis or memcached", "redis OR memcached")).toBe("[redis] or [memcached]");
    expect(marked("deploy to staging", "deploy -staging")).toBe("[deploy] to staging");
  });

  it("takes the window with the most matches, with … where the text goes on", () => {
    const words = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");
    const one = marked(`${words("w", 60)} needle here ${words("v", 60)}`, "needle");
    expect(one.startsWith("…w57 w58 w59 [needle] here v0")).toBe(true);
    expect(one.endsWith("…")).toBe(true);
    expect(one.slice(1, -1).split(" ")).toHaveLength(EXCERPT_WORDS);
    const two = marked(`redis ${words("w", 30)} redis cache`, "redis cache");
    expect(two.startsWith("…")).toBe(true);
    expect(two.endsWith("[redis] [cache]")).toBe(true);
  });

  it("shows a phrase that crosses the window's edge whole", () => {
    const filler = Array.from({ length: 22 }, (_, i) => `w${i}`).join(" ");
    const tail = Array.from({ length: 30 }, (_, i) => `v${i}`).join(" ");
    const text = marked(`needle ${filler} auth flow ${tail}`, 'needle OR "auth flow"');
    expect(text.startsWith("[needle] w0 ")).toBe(true);
    expect(text.endsWith(" w21 [auth flow]…")).toBe(true);
  });

  it("starts the text when nothing is found, and reads as highlights() expects", () => {
    expect(marked("nothing to see", "zzz")).toBe("nothing to see");
    expect(excerpt(`a${MATCH_START}b`, parseQuery("b").match)).toBe(`a ${m("b")}`);
    expect(highlights(excerpt("deploy the widget", parseQuery("widget").match))).toEqual({
      snippet: "deploy the widget",
      highlights: [[11, 17]],
    });
  });
});
