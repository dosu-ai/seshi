import { describe, expect, it } from "vitest";
import type { CommandContext } from "../commands/index";
import { BRAND_COLOURS } from "./brand-tokens";
import { colourLevel, detectTheme, Style, stripStyle, styleFor, themeFromColorFgBg } from "./style";
import type { Terminal } from "./terminal";

const TTY = { env: { TERM: "xterm" }, tty: true };

describe("colour level (B1.4)", () => {
  it("is off without a terminal, with NO_COLOR, --no-color, --json or a dumb terminal", () => {
    expect(colourLevel({ ...TTY, tty: false })).toBe("none");
    expect(colourLevel({ ...TTY, env: { TERM: "xterm", NO_COLOR: "1" } })).toBe("none");
    expect(colourLevel({ ...TTY, noColor: true })).toBe("none");
    expect(colourLevel({ ...TTY, json: true })).toBe("none");
    expect(colourLevel({ ...TTY, env: { TERM: "dumb" } })).toBe("none");
    // no-color.org: an empty NO_COLOR does not count.
    expect(colourLevel({ ...TTY, env: { TERM: "xterm", NO_COLOR: "" } })).toBe("basic");
  });

  it("is truecolor when COLORTERM says so, 256 when TERM does, else the basic sixteen", () => {
    expect(colourLevel({ ...TTY, env: { COLORTERM: "truecolor", TERM: "xterm" } })).toBe(
      "truecolor",
    );
    expect(colourLevel({ ...TTY, env: { COLORTERM: "24bit" } })).toBe("truecolor");
    expect(colourLevel({ ...TTY, env: { TERM: "xterm-256color" } })).toBe("256");
    expect(colourLevel(TTY)).toBe("basic");
  });
});

describe("theme", () => {
  it("reads COLORFGBG's background", () => {
    expect(themeFromColorFgBg("15;0")).toBe("dark");
    expect(themeFromColorFgBg("0;15")).toBe("light");
    expect(themeFromColorFgBg("0;default;7")).toBe("light");
    expect(themeFromColorFgBg("7;8")).toBe("dark");
    expect(themeFromColorFgBg("x")).toBeUndefined();
    expect(themeFromColorFgBg("0;99")).toBeUndefined();
    expect(themeFromColorFgBg(undefined)).toBeUndefined();
  });

  it("takes SESHI_THEME, then the config, then COLORFGBG, then the terminal, then dark", async () => {
    const light = async () => "light" as const;
    expect(await detectTheme({ env: { SESHI_THEME: "light" }, setting: "dark" })).toBe("light");
    expect(await detectTheme({ env: { SESHI_THEME: "auto" }, setting: "light" })).toBe("light");
    expect(await detectTheme({ env: { COLORFGBG: "0;15" }, query: async () => "dark" })).toBe(
      "light",
    );
    expect(await detectTheme({ env: {}, setting: "auto", query: light })).toBe("light");
    expect(await detectTheme({ env: {}, query: async () => undefined })).toBe("dark");
    expect(
      await detectTheme({
        env: {},
        query: async () => {
          throw new Error("no terminal");
        },
      }),
    ).toBe("dark");
    expect(await detectTheme({ env: {} })).toBe("dark");
  });
});

describe("Style", () => {
  it("writes nothing extra when off", () => {
    const plain = Style.plain();
    expect(plain.enabled).toBe(false);
    for (const text of [
      plain.success("ok"),
      plain.warn("ok"),
      plain.error("ok"),
      plain.search("ok"),
      plain.link("ok"),
      plain.brand("ok"),
      plain.progress("ok"),
      plain.muted("ok"),
      plain.bold("ok"),
      plain.status("ok", "success"),
    ]) {
      expect(text).toBe("ok");
    }
    expect(plain.glyph("✓", "ok")).toBe("ok");
  });

  it("paints mint for success on dark, at each level, setting the foreground only", () => {
    const mint = BRAND_COLOURS.thread_mint;
    expect(new Style("truecolor", "dark").success("ok")).toBe(
      `\x1b[38;2;${mint.rgb.join(";")}mok\x1b[39m`,
    );
    expect(new Style("256", "dark").success("ok")).toBe(`\x1b[38;5;${mint.ansi256}mok\x1b[39m`);
    expect(new Style("basic", "dark").success("ok")).toBe(`\x1b[${mint.ansi16}mok\x1b[39m`);
    // Never a background (48;… or 40–47, 100–107).
    for (const level of ["truecolor", "256", "basic"] as const) {
      for (const theme of ["dark", "light"] as const) {
        const style = new Style(level, theme);
        for (const role of ["success", "search", "warn", "error", "brand"] as const) {
          expect(style.open(role)).not.toMatch(/\[(48;|4\dm|10\dm)/);
        }
      }
    }
  });

  it("uses deep teal on light, and the terminal's own magenta and yellow for lilac and spark", () => {
    const light = new Style("truecolor", "light");
    expect(light.success("ok")).toContain(BRAND_COLOURS.deep_teal.rgb.join(";"));
    expect(light.search("hit")).toBe("\x1b[35mhit\x1b[39m");
    expect(light.warn("careful")).toBe("\x1b[33mcareful\x1b[39m");
    const dark = new Style("truecolor", "dark");
    expect(dark.search("hit")).toContain(BRAND_COLOURS.memory_lilac.rgb.join(";"));
    expect(dark.warn("careful")).toContain(BRAND_COLOURS.spark.rgb.join(";"));
    // Errors are the terminal's own red on either.
    expect(light.error("x")).toBe("\x1b[31mx\x1b[39m");
    expect(dark.error("x")).toBe("\x1b[31mx\x1b[39m");
  });

  it("keeps the word: stripped of colour, a status reads the same", () => {
    const style = new Style("256", "dark");
    const line = `${style.status("running", "success")} ${style.muted("2s ago")} ${style.bold("x")}`;
    expect(line).not.toBe("running 2s ago x");
    expect(stripStyle(line)).toBe("running 2s ago x");
    expect(style.glyph("✓", "ok")).toBe("✓");
    expect(style.paint("success", "")).toBe("");
  });
});

describe("styleFor", () => {
  const ctx = (over: Partial<CommandContext>): CommandContext => ({
    argv: [],
    env: { TERM: "xterm-256color" },
    stdout: () => {},
    stderr: () => {},
    integrations: async () => [],
    ...over,
  });
  const terminal = (theme: "dark" | "light" | undefined, asked: string[]): Terminal => ({
    ask: async () => "",
    background: async () => {
      asked.push("background");
      return theme;
    },
    openUrl: async () => true,
  });

  it("is plain off a terminal, with --json and with --no-color, and asks nothing", async () => {
    const asked: string[] = [];
    const term = async () => terminal("light", asked);
    expect((await styleFor(ctx({ terminal: term }))).enabled).toBe(false);
    const tty = { stdout: true, stdin: true };
    expect((await styleFor(ctx({ tty, terminal: term }), { json: true })).enabled).toBe(false);
    expect((await styleFor(ctx({ tty, noColor: true, terminal: term }))).enabled).toBe(false);
    expect(asked).toEqual([]);
  });

  it("asks the terminal for its background only when nothing else says", async () => {
    const asked: string[] = [];
    const tty = { stdout: true, stdin: true };
    const style = await styleFor(ctx({ tty, terminal: async () => terminal("light", asked) }));
    expect(style.level).toBe("256");
    expect(style.theme).toBe("light");
    expect(asked).toEqual(["background"]);
    const fixed = await styleFor(ctx({ tty, terminal: async () => terminal("light", asked) }), {
      theme: "dark",
    });
    expect(fixed.theme).toBe("dark");
    expect(asked).toEqual(["background"]);
    // No terminal to ask: dark.
    expect((await styleFor(ctx({ tty: { stdout: true, stdin: false } }))).theme).toBe("dark");
  });
});
