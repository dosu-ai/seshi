import { asTranscript } from "@seshi/formats";
import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_FORMAT } from "./index";

const SESSION = "5f0c0000-0000-4000-8000-0000000000bb";
const row = (n: number, type: string, message: Record<string, unknown>) =>
  JSON.stringify({
    type,
    uuid: `00000000-0000-4000-8000-00000000000${n}`,
    parentUuid: n > 1 ? `00000000-0000-4000-8000-00000000000${n - 1}` : null,
    sessionId: SESSION,
    timestamp: `2026-11-20T00:00:0${n}.000Z`,
    cwd: "/repo",
    message,
  });

describe("Claude Code tool results", () => {
  it("keeps the tools a ToolSearch result loaded, and an image as a placeholder", () => {
    const log = [
      row(1, "user", { role: "user", content: "Find the deploy tool" }),
      row(2, "assistant", {
        role: "assistant",
        model: "claude-x",
        content: [
          { type: "tool_use", id: "toolu_1", name: "ToolSearch", input: { query: "deploy" } },
        ],
      }),
      row(3, "user", {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [
              { type: "tool_reference", tool_name: "mcp__ci__deploy" },
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "iVBORw0K" },
              },
            ],
          },
        ],
      }),
    ].join("\n");
    const { records } = asTranscript(CLAUDE_CODE_FORMAT.normalize(`${log}\n`));
    const result = records.find((r) => r.role === "tool");
    expect(result?.content).toContain("tool_reference: mcp__ci__deploy");
    expect(result?.content).toContain("[image]");
    expect(result?.content).not.toContain("iVBORw0K");
  });
});
