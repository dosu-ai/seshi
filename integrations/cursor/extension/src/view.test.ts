import { describe, expect, it } from "vitest";
import type { StatusJson } from "./seshi";
import { toggled, viewOf } from "./view";

const now = new Date("2026-11-17T12:00:00Z");
const base: StatusJson = {
  capturing: true,
  level: "global",
  reason: "capture is on (global)",
  problems: [],
  session: { session_id: "887c0332-aaaa", by: "focused" },
  candidates: [],
  attention: null,
  installed: true,
};

describe("the status bar item", () => {
  it("says on or off for the chat in view, and a click turns it the other way", () => {
    const on = viewOf(base, now, "Testing discussion");
    expect(on.text).toBe("Session Capture ◉");
    expect(on.tooltip).toBe(
      '`Session Capture` on for the chat `887c0332` "Testing discussion"\n\nClick to toggle',
    );
    expect(on.action).toEqual({ kind: "toggle", to: "off", session: "887c0332-aaaa", pick: false });
    const off = viewOf(
      { ...base, capturing: false, level: "session", reason: "turned off for this session" },
      now,
    );
    expect(off.text).toBe("Session Capture ⏸");
    expect(off.action).toMatchObject({ kind: "toggle", to: "on" });
  });

  it("shows what needs action, coloured, and at most two problems", () => {
    const view = viewOf(
      { ...base, problems: ["sign in", "upload failing", "3 queued"], attention: "error" },
      now,
    );
    expect(view.text).toBe("Session Capture ◉ · sign in · upload failing");
    expect(view.background).toBe("error");
  });

  it("asks which chat when it had to guess, and explains a shared rule instead of toggling", () => {
    const guessed = viewOf(
      {
        ...base,
        session: { session_id: "p1", by: "prompt", at: "2026-11-17T11:58:00Z" },
        candidates: [{ session_id: "p2", by: "prompt" }],
      },
      now,
    );
    expect(guessed.tooltip).toBe(
      "`Session Capture` on for the chat `p1` (the last chat you messaged, 2 min ago)\n\nClick to choose the chat and toggle",
    );
    expect(guessed.action).toMatchObject({ kind: "toggle", pick: true });
    const team = viewOf(
      { ...base, capturing: false, level: "repo", reason: "the repo turns capture off" },
      now,
    );
    expect(team.tooltip).toBe(
      "`Session Capture` off for the chat `887c0332`\n\nOff because the repo turns capture off: a team rule, not a toggle.",
    );
    expect(team.action).toEqual({
      kind: "explain",
      message: "Session Capture is off for this chat: the repo turns capture off.",
    });
  });

  it("says what is missing: no chat yet, Cursor not installed, an old seshi", () => {
    expect(viewOf({ ...base, session: null }, now).action).toEqual({ kind: "status" });
    expect(viewOf({ ...base, installed: false }, now)).toMatchObject({
      text: "Session Capture ⏸ · not installed",
      action: { kind: "install" },
    });
    const { session: _, ...old } = base;
    expect(viewOf(old, now).text).toBe("$(warning) Session Capture · update seshi");
  });
});

describe("what a toggle says", () => {
  it("names a retraction, and a fresh or unfrozen upload", () => {
    expect(toggled("off", { retracting: true })).toContain("being retracted");
    expect(toggled("off", {})).toContain("nothing of it was uploaded");
    expect(toggled("on", { fresh: true })).toBe(
      "Session Capture is on for this chat; it is uploaded again from its start.",
    );
  });
});
