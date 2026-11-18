/** A cloud hook's upload in the foreground: what it says when nothing could run. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireUploaderLock, capturePaths, readState } from "@seshi/capture";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INTEGRATIONS } from "../integrations";
import type { CommandContext } from "./index";
import { uploadNow } from "./upload-now";

let home: string;
let err: string[];
let ctx: CommandContext;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "seshi-upload-now-"));
  err = [];
  ctx = {
    argv: [],
    env: { HOME: home, XDG_CONFIG_HOME: join(home, "config") },
    stdout: () => {},
    stderr: (line) => err.push(line),
    integrations: async () => INTEGRATIONS,
  };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("uploadNow", () => {
  it("says so when another uploader kept the lock, though the session never reached the state", async () => {
    const paths = capturePaths({ env: ctx.env, home, platform: process.platform });
    const held = acquireUploaderLock(paths);
    expect(held).not.toBeNull();
    try {
      const result = await uploadNow(ctx, paths, ["cursor:c1"], { deadlineMs: 300 });
      expect(readState(paths).sessions["cursor:c1"]).toBeUndefined();
      expect(result.failed).toEqual([
        {
          key: "cursor:c1",
          message: "another uploader kept the lock while this hook waited",
        },
      ]);
      expect(err).toEqual([
        "seshi: cursor:c1 was not uploaded: another uploader kept the lock while this hook waited",
      ]);
    } finally {
      held?.release();
    }
  });
});
