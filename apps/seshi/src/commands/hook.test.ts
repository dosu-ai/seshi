import { describe, expect, it } from "vitest";
import { shared } from "./hook";

describe("what /session-capture share says", () => {
  it("marks a share ✓, never ◉, which agents read as 'captured'", () => {
    const said = shared("share", {
      code: 0,
      said: { visibility: "org", readers: "every member may read it", subagents: ["a1", "a2"] },
    });
    expect(said).toBe(
      "Session Capture ✓ · shared this session, with its 2 subagent sessions: visibility is org, so every member may read it",
    );
    expect(said).not.toMatch(/[◉⏸]/);
  });

  it("leaves a share that missed a subagent unmarked, naming it", () => {
    expect(
      shared("unshare", {
        code: 8,
        said: {
          visibility: "owner",
          readers: "only its owner (and admins) may read it",
          subagents: [],
          failed: [{ session_id: "a1", error: "Forbidden" }],
        },
      }),
    ).toBe(
      "Session Capture · unshared this session: visibility is owner, so only its owner (and admins) may read it; subagent session a1 not changed: Forbidden",
    );
  });

  it("says why it refused: the whole message, or a usage error without its usage", () => {
    expect(
      shared("share", {
        code: 4,
        said: { error: { code: "not_found", message: "not in the store yet: try again\nlater" } },
      }),
    ).toBe(
      "Session Capture · could not share this session: not in the store yet: try again\nlater",
    );
    expect(
      shared("share", {
        code: 2,
        said: { error: { code: "usage", message: "which session?\nusage: seshi share …" } },
      }),
    ).toBe("Session Capture · could not share this session: which session?");
    expect(shared("share", { code: 3, said: {} })).toBe(
      "Session Capture · could not share this session: exit 3",
    );
  });
});
