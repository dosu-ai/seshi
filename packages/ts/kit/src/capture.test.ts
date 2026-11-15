import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CaptureAgent,
  capturesOf,
  commandLine,
  expandTilde,
  hookHandler,
  isSeshiHook,
  isSeshiStatusline,
  payloadObject,
  readJsonConfig,
  stringField,
  writeFileAtomic,
} from "./index";

const agent = (name: string): CaptureAgent => ({
  name,
  format: name,
  encoding: "jsonl",
  chunkable: true,
  hooks: [{ event: "Stop", parse: () => ({ captures: [] }) }],
  sweep: [],
  identify: () => null,
});

describe("the capture contract", () => {
  it("lists each agent once", () => {
    const a = agent("a");
    expect(capturesOf([{ name: "x", capture: a }, { name: "y" }])).toEqual([a]);
    expect(() =>
      capturesOf([
        { name: "x", capture: a },
        { name: "y", capture: agent("a") },
      ]),
    ).toThrow("capture agent 'a' is provided by both 'x' and 'y'");
  });

  it("finds a handler by its exact event name", () => {
    expect(hookHandler(agent("a"), "Stop")?.event).toBe("Stop");
    expect(hookHandler(agent("a"), "stop")).toBeUndefined();
  });

  it("reads payload fields", () => {
    expect(() => payloadObject(null, "a")).toThrow("not a JSON object");
    expect(stringField({ a: "x", b: "", c: 1 }, "a")).toBe("x");
    expect(stringField({ a: "x", b: "", c: 1 }, "b")).toBeUndefined();
    expect(stringField({ a: "x", b: "", c: 1 }, "c")).toBeUndefined();
  });

  it("expands ~", () => {
    expect(expandTilde("~", "/h")).toBe("/h");
    expect(expandTilde("~/x", "/h")).toBe("/h/x");
    expect(expandTilde("~x", "/h")).toBe("~x");
  });
});

describe("hook commands", () => {
  it("quotes only words that need it", () => {
    expect(commandLine(["seshi", "hook", "claude-code", "Stop"])).toBe(
      "seshi hook claude-code Stop",
    );
    expect(commandLine(["C:\\Program Files\\seshi\\seshi.exe", "hook"])).toBe(
      '"C:/Program Files/seshi/seshi.exe" hook',
    );
    expect(commandLine(["C:\\Users\\dev\\AppData\\Local\\Programs\\seshi\\seshi.exe"])).toBe(
      "C:/Users/dev/AppData/Local/Programs/seshi/seshi.exe",
    );
  });

  it.skipIf(!existsSync("/bin/sh"))(
    "gives sh (Git Bash on Windows) back the same words, Windows paths included",
    () => {
      const cases = [
        ["C:\\Users\\dev\\AppData\\Local\\Programs\\seshi\\seshi.exe", "hook", "claude-code"],
        ["C:\\Program Files\\seshi\\seshi.exe", "statusline"],
        ["\\\\server\\share\\seshi.exe", "hook"],
        ["/opt/se shi/seshi", 'say "hi"', "back\\slash", "trailing\\", 'mid\\"quote'],
      ];
      for (const words of cases) {
        const line = commandLine(words);
        const run = Bun.spawnSync(["/bin/sh", "-c", `printf '%s\\n' ${line}`]);
        const got = run.stdout.toString().split("\n").slice(0, -1);
        // Windows paths come back with forward slashes, which Windows takes as the same path.
        const want = words.map((w) =>
          /^(?:[A-Za-z]:\\|\\\\)/.test(w) ? w.replace(/\\/g, "/") : w,
        );
        expect(got, line).toEqual(want);
      }
    },
  );

  it("tells seshi's own entries from everyone else's", () => {
    expect(isSeshiHook("seshi hook claude-code Stop", "claude-code")).toBe(true);
    expect(isSeshiHook("/opt/bin/seshi hook claude-code Stop", "claude-code")).toBe(true);
    expect(isSeshiHook('"C:\\seshi\\seshi.exe" hook cursor stop', "cursor")).toBe(true);
    expect(isSeshiHook("seshi hook codex notify", "claude-code")).toBe(false);
    expect(isSeshiHook("notseshi hook claude-code Stop", "claude-code")).toBe(false);
    expect(isSeshiHook("say seshi", "claude-code")).toBe(false);
    expect(isSeshiHook(undefined, "claude-code")).toBe(false);
    expect(isSeshiStatusline("/opt/seshi statusline")).toBe(true);
    expect(isSeshiStatusline("my-line")).toBe(false);
  });
});

describe("config files", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seshi-kit-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads a missing or empty JSON file as {}, and refuses one that is not an object", () => {
    expect(readJsonConfig(join(dir, "none.json"))).toEqual({});
    writeFileSync(join(dir, "empty.json"), "\n");
    expect(readJsonConfig(join(dir, "empty.json"))).toEqual({});
    writeFileSync(join(dir, "list.json"), "[]");
    expect(() => readJsonConfig(join(dir, "list.json"))).toThrow(/JSON object/);
  });

  it("writes whole files and keeps an existing file's mode", () => {
    const file = join(dir, "sub", "c.json");
    writeFileAtomic(file, "a", 0o600);
    writeFileAtomic(file, "b");
    expect(readFileSync(file, "utf8")).toBe("b");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
