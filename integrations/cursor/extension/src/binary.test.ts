import { describe, expect, it } from "vitest";
import { programFromHooks, seshiProgram } from "./binary";

const hooks = (command: string) =>
  JSON.stringify({ version: 1, hooks: { stop: [{ command: "./audit.sh" }, { command }] } });

describe("the seshi program", () => {
  it("is the setting, else what seshi's own Cursor hook runs, else seshi on the PATH", () => {
    const written = hooks("/Users/me/.local/bin/seshi hook cursor stop");
    expect(seshiProgram("/opt/seshi", written)).toBe("/opt/seshi");
    expect(seshiProgram("", written)).toBe("/Users/me/.local/bin/seshi");
    expect(seshiProgram(undefined, undefined)).toBe("seshi");
    expect(seshiProgram(undefined, "{ not json")).toBe("seshi");
  });

  it("reads a quoted Windows path, and gives up on a command of several words", () => {
    expect(programFromHooks(hooks('"C:/Program Files/seshi/seshi.exe" hook cursor stop'))).toBe(
      "C:/Program Files/seshi/seshi.exe",
    );
    expect(programFromHooks(hooks("C:/tools/seshi.exe hook cursor sessionEnd"))).toBe(
      "C:/tools/seshi.exe",
    );
    expect(programFromHooks(hooks("npx seshi hook cursor stop"))).toBeUndefined();
    expect(programFromHooks(hooks("./audit.sh"))).toBeUndefined();
    // Another tool's hook in the same shape is not seshi's.
    expect(
      programFromHooks(
        hooks("'/Applications/Foundation.app/Contents/Resources/foundation' hook cursor capture"),
      ),
    ).toBeUndefined();
    expect(
      programFromHooks(
        JSON.stringify({
          hooks: {
            stop: [
              { command: "'/Applications/Foundation.app/foundation' hook cursor capture" },
              { command: "/Users/me/.local/bin/seshi hook cursor stop" },
            ],
          },
        }),
      ),
    ).toBe("/Users/me/.local/bin/seshi");
    // The hook an earlier seshi committed to a repository for Cursor Cloud is a shell line, not a
    // program: never taken, even in a home folder that is also a repository.
    const committed =
      '[ -e "${XDG_STATE_HOME:-$HOME/.local/state}/seshi/cursor-cloud" ] || exit 0; s=$(command -v seshi || echo "$HOME/.local/bin/seshi"); [ -x "$s" ] || exit 0; exec "$s" hook cursor stop --cloud';
    expect(programFromHooks(hooks(committed))).toBeUndefined();
    expect(
      programFromHooks(
        JSON.stringify({
          hooks: {
            stop: [{ command: committed }, { command: "/opt/seshi/seshi hook cursor stop" }],
          },
        }),
      ),
    ).toBe("/opt/seshi/seshi");
  });
});
