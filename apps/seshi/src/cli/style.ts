import type { CommandContext } from "../commands/index";
import { BRAND_COLOURS, type BrandColour } from "./brand-tokens";

export type ColourLevel = "none" | "basic" | "256" | "truecolor";
export type Theme = "dark" | "light";
export type ThemeSetting = Theme | "auto";

export type Role = "success" | "brand" | "search" | "link" | "warn" | "progress" | "error";

export interface LevelInputs {
  env: Record<string, string | undefined>;
  tty: boolean;
  json?: boolean;
  noColor?: boolean;
}

export function colourLevel(inputs: LevelInputs): ColourLevel {
  const { env } = inputs;
  if (inputs.json || !inputs.tty || inputs.noColor) return "none";
  // no-color.org: present and not empty.
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "none";
  const term = (env.TERM ?? "").toLowerCase();
  if (term === "dumb") return "none";
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor";
  if (term.includes("256")) return "256";
  return "basic";
}

function explicitTheme(value: string | undefined): Theme | undefined {
  const v = value?.trim().toLowerCase();
  return v === "dark" || v === "light" ? v : undefined;
}

/** The background `COLORFGBG` names (`"15;0"`, `"0;default;15"`: the last field is the
 * background's palette index): light for 7 and 9–15, dark for 0–6 and 8; undefined otherwise. */
export function themeFromColorFgBg(value: string | undefined): Theme | undefined {
  if (!value) return undefined;
  const bg = Number.parseInt(value.split(";").at(-1) ?? "", 10);
  if (!Number.isInteger(bg) || bg < 0 || bg > 15) return undefined;
  return bg === 7 || bg >= 9 ? "light" : "dark";
}

export interface ThemeInputs {
  env: Record<string, string | undefined>;
  setting?: ThemeSetting;
  query?: () => Promise<Theme | undefined>;
}

export async function detectTheme(inputs: ThemeInputs): Promise<Theme> {
  const fixed = explicitTheme(inputs.env.SESHI_THEME) ?? explicitTheme(inputs.setting);
  if (fixed) return fixed;
  const fromEnv = themeFromColorFgBg(inputs.env.COLORFGBG);
  if (fromEnv) return fromEnv;
  if (inputs.query) {
    try {
      const answered = await inputs.query();
      if (answered) return answered;
    } catch {}
  }
  return "dark";
}

type Ink = { token: BrandColour } | { sgr: number };

const INKS: Record<Theme, Record<Role, Ink>> = {
  dark: {
    success: { token: BRAND_COLOURS.thread_mint },
    brand: { token: BRAND_COLOURS.thread_mint },
    search: { token: BRAND_COLOURS.memory_lilac },
    link: { token: BRAND_COLOURS.memory_lilac },
    warn: { token: BRAND_COLOURS.spark },
    progress: { token: BRAND_COLOURS.spark },
    error: { sgr: 31 },
  },
  light: {
    success: { token: BRAND_COLOURS.deep_teal },
    brand: { token: BRAND_COLOURS.deep_teal },
    search: { sgr: 35 },
    link: { sgr: 35 },
    warn: { sgr: 33 },
    progress: { sgr: 33 },
    error: { sgr: 31 },
  },
};

const ESC = "\x1b[";

export class Style {
  constructor(
    readonly level: ColourLevel,
    readonly theme: Theme = "dark",
  ) {}

  static plain(): Style {
    return new Style("none");
  }

  get enabled(): boolean {
    return this.level !== "none";
  }

  open(role: Role): string {
    if (!this.enabled) return "";
    const ink = INKS[this.theme][role];
    if ("sgr" in ink) return `${ESC}${ink.sgr}m`;
    const { token } = ink;
    if (this.level === "truecolor") return `${ESC}38;2;${token.rgb.join(";")}m`;
    if (this.level === "256") return `${ESC}38;5;${token.ansi256}m`;
    return `${ESC}${token.ansi16}m`;
  }

  paint(role: Role, text: string): string {
    if (!this.enabled || text === "") return text;
    return `${this.open(role)}${text}${ESC}39m`;
  }

  success(text: string): string {
    return this.paint("success", text);
  }
  brand(text: string): string {
    return this.paint("brand", text);
  }
  search(text: string): string {
    return this.paint("search", text);
  }
  link(text: string): string {
    return this.paint("link", text);
  }
  warn(text: string): string {
    return this.paint("warn", text);
  }
  progress(text: string): string {
    return this.paint("progress", text);
  }
  error(text: string): string {
    return this.paint("error", text);
  }

  muted(text: string): string {
    return this.enabled && text !== "" ? `${ESC}2m${text}${ESC}22m` : text;
  }

  bold(text: string): string {
    return this.enabled && text !== "" ? `${ESC}1m${text}${ESC}22m` : text;
  }

  glyph(fancy: string, plain: string): string {
    return this.enabled ? fancy : plain;
  }

  status(word: string, role: Role): string {
    return this.paint(role, word);
  }
}

/** `text` safe to print on a terminal: every control character (C0, DEL, C1: escape
 * sequences, carriage returns, bells) becomes U+FFFD, a tab a space. Stored sessions are written
 * by other people and other programs, so a transcript, a project name or a token label could
 * otherwise move the cursor, rewrite earlier lines, set the window title or the clipboard
 * (OSC 52). Use it on everything a command prints that it did not write itself. */
export function printable(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters
  return text.replace(/\t/g, " ").replace(/[\x00-\x1f\x7f-\x9f]/g, "\uFFFD");
}

export function stripStyle(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching the escape character
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

export interface StyleOptions {
  json?: boolean;
  theme?: ThemeSetting;
}

export async function styleFor(ctx: CommandContext, options: StyleOptions = {}): Promise<Style> {
  const level = colourLevel({
    env: ctx.env,
    tty: ctx.tty?.stdout === true,
    json: options.json,
    noColor: ctx.noColor,
  });
  if (level === "none") return Style.plain();
  const terminal = ctx.terminal;
  const theme = await detectTheme({
    env: ctx.env,
    ...(options.theme ? { setting: options.theme } : {}),
    ...(terminal && ctx.tty?.stdin ? { query: async () => (await terminal()).background() } : {}),
  });
  return new Style(level, theme);
}
