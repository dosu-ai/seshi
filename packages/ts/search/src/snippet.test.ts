import { describe, expect, it } from "vitest";
import { highlights, indexText, MATCH_END, MATCH_START, MAX_INDEXED_CHARS } from "./snippet";

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
