import { describe, expect, it, vi } from "vitest";
import { browserCommand, openable, parseOsc11, processTerminal } from "./terminal";

/** What openUrl would have started: recorded, never run. */
const started = vi.hoisted(() => [] as string[][]);
vi.mock("node:child_process", () => ({
  spawn: (command: string, args: string[]) => {
    started.push([command, ...args]);
    return { on: () => {}, unref: () => {} };
  },
}));

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

  it("opens only a web page, never a file:, smb: or custom-scheme URL (X5.7)", async () => {
    const terminal = processTerminal();
    for (const url of ["file:///etc/passwd", "smb://evil.test/share", "x-evil:run", "not a url"]) {
      expect(openable(url)).toBe(false);
      expect(await terminal.openUrl(url)).toBe(false);
    }
    expect(started).toEqual([]);
    expect(await terminal.openUrl("https://idp.test/authorize")).toBe(true);
    expect(started).toEqual([browserCommand(process.platform, "https://idp.test/authorize")]);
  });
});
