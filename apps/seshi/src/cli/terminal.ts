/** The terminal a person runs seshi in: questions (a confirmation, an org key typed without
 * echo), the background colour (B1.4: an OSC 11 query with a short timeout), and opening a
 * browser for sign-in (X5.7). The router hands commands a `Terminal` only when standard input
 * and output are both terminals; tests hand them a fake. Questions and prompts go to standard
 * error, so standard output stays the command's answer. */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Theme } from "./style";

export interface Terminal {
  /** Ask on the terminal and answer the line typed; without echo when `hidden`. Rejects when
   * the person presses Ctrl-C or input ends. */
  ask(question: string, options?: { hidden?: boolean }): Promise<string>;
  /** The background's lightness, from an OSC 11 query; undefined when the terminal does not
   * answer within `timeoutMs`. */
  background(timeoutMs?: number): Promise<Theme | undefined>;
  /** Open `url` in the person's browser; false when no browser could be started. */
  openUrl(url: string): Promise<boolean>;
}

/** The person stopped a question (Ctrl-C, end of input). */
export class Cancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "Cancelled";
  }
}

/** How long the background query waits: long enough for a local terminal, short enough that
 * one that never answers costs nothing noticeable (B1.4). */
export const BACKGROUND_TIMEOUT_MS = 100;

/** The theme an OSC 11 answer describes (`ESC ] 11 ; rgb:RRRR/GGGG/BBBB` ended by BEL or ST,
 * each channel 1–4 hex digits): light when its relative luminance is over one half. */
export function parseOsc11(answer: string): Theme | undefined {
  const m = /\]11;rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i.exec(answer);
  if (!m) return undefined;
  const channel = (hex: string) => Number.parseInt(hex, 16) / (16 ** hex.length - 1);
  const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => linear(channel(h as string))) as [
    number,
    number,
    number,
  ];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? "light" : "dark";
}

/** The command that opens a URL on this platform. */
export function browserCommand(platform: NodeJS.Platform, url: string): string[] {
  if (platform === "darwin") return ["open", url];
  // `start` would read `&` in the URL as a command separator; the URL handler does not.
  if (platform === "win32") return ["rundll32", "url.dll,FileProtocolHandler", url];
  return ["xdg-open", url];
}

/** Whether `openUrl` may hand `url` to the OS opener: `http:` and `https:` only, never `file:`,
 * `smb:` or a custom scheme a server or IdP named (X5.7). */
export function openable(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/** The process's own terminal. */
export function processTerminal(): Terminal {
  const stdin = process.stdin;
  const stderr = process.stderr;

  async function askHidden(question: string): Promise<string> {
    stderr.write(question);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    return new Promise<string>((resolve, reject) => {
      let typed = "";
      const done = (error?: Error) => {
        stdin.off("data", onData);
        stdin.setRawMode(wasRaw);
        stdin.pause();
        stderr.write("\n");
        if (error) reject(error);
        else resolve(typed);
      };
      const onData = (chunk: Buffer) => {
        for (const ch of chunk.toString("utf8")) {
          if (ch === "\r" || ch === "\n") return done();
          if (ch === "\u0003" || ch === "\u0004") return done(new Cancelled());
          if (ch === "\u007f" || ch === "\b") typed = typed.slice(0, -1);
          else if (ch >= " ") typed += ch;
        }
      };
      stdin.on("data", onData);
    });
  }

  return {
    async ask(question, options = {}) {
      if (options.hidden && stdin.isTTY) return askHidden(question);
      const rl = createInterface({ input: stdin, output: stderr, terminal: true });
      try {
        return await new Promise<string>((resolve, reject) => {
          rl.once("close", () => reject(new Cancelled()));
          rl.question(question, (answer) => resolve(answer));
        });
      } finally {
        rl.removeAllListeners("close");
        rl.close();
      }
    },

    async background(timeoutMs = BACKGROUND_TIMEOUT_MS) {
      if (!stdin.isTTY || !process.stdout.isTTY) return undefined;
      const wasRaw = stdin.isRaw;
      stdin.setRawMode(true);
      stdin.resume();
      return new Promise<Theme | undefined>((resolve) => {
        let answer = "";
        const finish = (theme: Theme | undefined) => {
          clearTimeout(timer);
          stdin.off("data", onData);
          stdin.setRawMode(wasRaw);
          stdin.pause();
          resolve(theme);
        };
        const onData = (chunk: Buffer) => {
          answer += chunk.toString("latin1");
          if (answer.includes("\u0007") || answer.includes("\u001b\\")) finish(parseOsc11(answer));
        };
        const timer = setTimeout(() => finish(undefined), timeoutMs);
        stdin.on("data", onData);
        process.stdout.write("\u001b]11;?\u0007");
      });
    },

    async openUrl(url) {
      // The OS opener launches whatever handles a scheme: only a web page is opened.
      if (!openable(url)) return false;
      const [command, ...args] = browserCommand(process.platform, url);
      try {
        const child = spawn(command as string, args, { stdio: "ignore", detached: true });
        child.on("error", () => {});
        child.unref();
        return true;
      } catch {
        return false;
      }
    },
  };
}
