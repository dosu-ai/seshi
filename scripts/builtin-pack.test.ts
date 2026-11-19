import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BUILTIN_PACK_TOML } from "@seshi/redact";
import { describe, expect, it } from "vitest";
import { GENERATED_PATH, isStale, PACK_PATH } from "./builtin-pack";

const root = join(import.meta.dirname, "..");

describe("the generated built-in pack", () => {
  it("is current (run `bun run packs` after editing packs/builtin.toml)", () => {
    expect(isStale(root)).toBe(false);
  });

  it("holds the TOML's exact text", async () => {
    expect(BUILTIN_PACK_TOML).toBe(await Bun.file(join(root, PACK_PATH)).text());
  });

  it("is found stale when the TOML changes or the module is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "seshi-pack-"));
    try {
      mkdirSync(dirname(join(dir, PACK_PATH)), { recursive: true });
      mkdirSync(dirname(join(dir, GENERATED_PATH)), { recursive: true });
      cpSync(join(root, PACK_PATH), join(dir, PACK_PATH));
      expect(isStale(dir)).toBe(true);
      cpSync(join(root, GENERATED_PATH), join(dir, GENERATED_PATH));
      expect(isStale(dir)).toBe(false);
      writeFileSync(join(dir, PACK_PATH), `${BUILTIN_PACK_TOML}\n# edited\n`);
      expect(isStale(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
