import { describe, expect, it } from "vitest";
import { browserCommand, parseOsc11 } from "./terminal";

describe("the background query (OSC 11)", () => {
  it("reads the answer's colour, ended by BEL or ST, 1 to 4 digits a channel", () => {
    expect(parseOsc11("\x1b]11;rgb:0000/0000/0000\x07")).toBe("dark");
    expect(parseOsc11("\x1b]11;rgb:ffff/ffff/ffff\x1b\\")).toBe("light");
    expect(parseOsc11("\x1b]11;rgb:f6/f4/ee\x07")).toBe("light"); // paper
    expect(parseOsc11("\x1b]11;rgb:1717/1d1d/2a2a\x07")).toBe("dark"); // night ink
    expect(parseOsc11("\x1b]11;rgba:ffff/ffff/ffff/ffff\x07")).toBe("light");
    expect(parseOsc11("garbage")).toBeUndefined();
  });
});

describe("opening a browser", () => {
  it("uses each platform's opener, never a shell", () => {
    const url = "https://idp.test/authorize?a=1&b=2";
    expect(browserCommand("darwin", url)).toEqual(["open", url]);
    expect(browserCommand("linux", url)).toEqual(["xdg-open", url]);
    expect(browserCommand("win32", url)).toEqual(["rundll32", "url.dll,FileProtocolHandler", url]);
  });
});
