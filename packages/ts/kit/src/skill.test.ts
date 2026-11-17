import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CAPTURE_COMMAND,
  captureCommandPrompt,
  captureSkill,
  installSkill,
  removeSkill,
  SKILL_MARKER,
  skillFile,
} from "./index";

describe("the session-capture command", () => {
  it("is generic, not seshi's name", () => {
    expect(CAPTURE_COMMAND).toBe("session-capture");
    expect(captureSkill(["seshi"])).toMatch(/^---\nname: session-capture\n/);
  });

  it("reads only /session-capture and $session-capture, alone in the prompt", () => {
    expect(captureCommandPrompt("/session-capture off")).toBe("off");
    expect(captureCommandPrompt("$session-capture On!")).toBe("on");
    expect(captureCommandPrompt("/session-capture")).toBe("status");
    expect(captureCommandPrompt("/seshi off")).toBeUndefined();
    expect(captureCommandPrompt("/session-capture pause")).toBeUndefined();
  });
});

describe("the skill on disk", () => {
  let dir: string;
  const old = () => join(dir, "seshi", "SKILL.md");
  const writeOld = (text: string) => {
    mkdirSync(join(dir, "seshi"), { recursive: true });
    writeFileSync(old(), text);
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seshi-skill-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("replaces seshi's skill under its old name with the new one", () => {
    writeOld(`---\nname: seshi\n---\n${SKILL_MARKER}\n`);
    const report = installSkill(dir, ["seshi"]);
    expect(report.changed).toEqual([old(), skillFile(dir)]);
    expect(existsSync(join(dir, "seshi"))).toBe(false);
    expect(readFileSync(join(dir, "session-capture", "SKILL.md"), "utf8")).toBe(
      captureSkill(["seshi"]),
    );
  });

  it("leaves someone else's skill under either name", () => {
    writeOld("my own seshi skill\n");
    mkdirSync(join(dir, "session-capture"));
    writeFileSync(skillFile(dir), "my own\n");
    const report = installSkill(dir, ["seshi"]);
    expect(report.changed).toEqual([]);
    expect(report.notes).toHaveLength(1);
    expect(removeSkill(dir)).toEqual([]);
    expect(readFileSync(old(), "utf8")).toBe("my own seshi skill\n");
    expect(readFileSync(skillFile(dir), "utf8")).toBe("my own\n");
  });

  it("removes its skill under both names on uninstall", () => {
    installSkill(dir, ["seshi"]);
    writeOld(`${SKILL_MARKER}\n`);
    expect(removeSkill(dir)).toEqual([skillFile(dir), old()]);
    expect(existsSync(join(dir, "session-capture"))).toBe(false);
    expect(existsSync(join(dir, "seshi"))).toBe(false);
    expect(removeSkill(dir)).toEqual([]);
  });
});
