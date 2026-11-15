/** The folder store's file modes: owner-only folders and files, the lock and temp file
 * included. Its own file, since it wraps `rename` to look at the lock and the temp file while a
 * write holds them. */

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FsStore } from "./fs";

/** The modes of the temp file and the key's lock, seen as each temp file is renamed into
 * place: the moment a write holds both. */
const held: { tmp: number; lock: number }[] = [];

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    rename: async (from: string, to: string) => {
      if (from.endsWith(".tmp") && !from.endsWith(".~lock.tmp")) {
        held.push({
          tmp: (await fs.stat(from)).mode & 0o777,
          lock: (await fs.stat(`${to}.~lock`)).mode & 0o777,
        });
      }
      return fs.rename(from, to);
    },
  };
});

const mode = (path: string) => statSync(path).mode & 0o777;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-fs-modes-"));
  held.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(process.platform === "win32")("FsStore file modes", () => {
  it("creates the root and every folder 0700, and writes objects, temp files and locks 0600", async () => {
    const root = join(dir, "bucket");
    const store = new FsStore(`file://${root}`);
    await store.put("alice/sessions/a1/metadata.json", new TextEncoder().encode("{}"));
    await store.put("alice/sessions/a1/metadata.json", new TextEncoder().encode("{ }"), {
      ifMatch: (await store.get("alice/sessions/a1/metadata.json"))?.etag,
    });
    await store.put("top.json", new TextEncoder().encode("1"));

    for (const folder of [root, "alice", "alice/sessions", "alice/sessions/a1"]) {
      expect(mode(folder === root ? root : join(root, folder))).toBe(0o700);
    }
    expect(mode(join(root, "alice/sessions/a1/metadata.json"))).toBe(0o600);
    expect(mode(join(root, "top.json"))).toBe(0o600);
    expect(held).toHaveLength(3);
    for (const seen of held) expect(seen).toEqual({ tmp: 0o600, lock: 0o600 });
  });
});
