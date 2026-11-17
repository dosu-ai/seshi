import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSeshi, statusArgs } from "./seshi";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-ext-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("asking seshi", () => {
  it("passes the folders, the focused chat and the open ones", () => {
    expect(statusArgs({ folders: ["/a", "/b"], focused: "f", selected: ["f", "g"] })).toEqual([
      "statusline",
      "--agent",
      "cursor",
      "--json",
      "--folder",
      "/a",
      "--folder",
      "/b",
      "--session",
      "f",
      "--selected",
      "f,g",
    ]);
    expect(statusArgs({ folders: ["/a"] })).toEqual([
      "statusline",
      "--agent",
      "cursor",
      "--json",
      "--folder",
      "/a",
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "parses its answer, its JSON error, and a missing program",
    async () => {
      const fake = join(dir, "seshi");
      const script = (body: string) => {
        writeFileSync(fake, `#!/bin/sh\n${body}\n`);
        chmodSync(fake, 0o755);
      };
      script(`echo '{"capturing":true}'`);
      expect(await runSeshi(fake, ["statusline"])).toEqual({ ok: true, json: { capturing: true } });
      script(`echo '{"error":{"code":"x","message":"no such session"}}' >&2; exit 4`);
      expect(await runSeshi(fake, [])).toEqual({
        ok: false,
        kind: "failed",
        message: "no such session",
      });
      expect(await runSeshi(join(dir, "nope"), [])).toMatchObject({ ok: false, kind: "missing" });
    },
  );
});
