import { describe, expect, it } from "vitest";
import { focusedConversation, type GroupView } from "./focus";

const chats = (labels: string[], active: number): GroupView => ({
  isActive: true,
  tabs: labels.map((label, i) => ({ isActive: i === active, label, hasInput: false })),
});

describe("the focused chat (as Cursor 3.21 shows it)", () => {
  it("is the open id at the active chat tab's position", () => {
    const settings: GroupView = {
      isActive: false,
      tabs: [{ isActive: true, label: "Cursor Settings", hasInput: false }],
    };
    expect(
      focusedConversation(["887c", "3b03"], [settings, chats(["Testing", "Casual"], 1)]),
    ).toEqual({
      session_id: "3b03",
      title: "Casual",
    });
    expect(
      focusedConversation(["887c", "3b03"], [settings, chats(["Testing", "Casual"], 0)]),
    ).toEqual({
      session_id: "887c",
      title: "Testing",
    });
  });

  it("is unknown when the tabs and ids disagree, or there is nothing to choose", () => {
    // A new chat's tab appears before its id.
    expect(focusedConversation(["2de7"], [chats(["New Agent", "New Agent"], 1)])).toBeUndefined();
    expect(focusedConversation(["a", "b"], [chats(["x", "y", "z"], 0)])).toBeUndefined();
    expect(focusedConversation(["a"], [chats(["x"], 0)])).toBeUndefined();
    const files: GroupView = {
      isActive: true,
      tabs: [
        { isActive: true, label: "a.ts", hasInput: true },
        { isActive: false, label: "b.ts", hasInput: true },
      ],
    };
    expect(focusedConversation(["a", "b"], [files])).toBeUndefined();
    // Two groups that could be the chats, and neither or both active: no guess.
    expect(
      focusedConversation(
        ["a", "b"],
        [
          { ...chats(["x", "y"], 0), isActive: false },
          { ...chats(["p", "q"], 1), isActive: false },
        ],
      ),
    ).toBeUndefined();
  });
});
