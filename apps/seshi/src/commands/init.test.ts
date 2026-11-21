import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT } from "../cli/exit";
import { Cancelled, type Terminal } from "../cli/terminal";
import { main } from "../main";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("seshi init --serverless", () => {
  it("says cancelled when the key prompt is cancelled, for every kind of bucket", async () => {
    for (const url of ["s3://b/p", "az://c/p", "gs://b/p"]) {
      const home = mkdtempSync(join(tmpdir(), "seshi-init-"));
      homes.push(home);
      const err: string[] = [];
      const terminal = {
        ask: async () => {
          throw new Cancelled();
        },
      } as unknown as Terminal;
      const code = await main(["init", "--serverless", "--url", url, "--owner", "alice"], {
        env: { HOME: home, AZURE_STORAGE_ACCOUNT: "acct" },
        stdout: () => {},
        stderr: (line) => err.push(line),
        tty: { stdout: true, stdin: true },
        terminal: async () => terminal,
        integrations: async () => [],
      });
      expect(code, url).toBe(EXIT.failure);
      expect(err.join("\n"), url).toContain("cancelled");
      expect(err.join("\n"), url).not.toContain("GOOGLE_APPLICATION_CREDENTIALS");
    }
  });
});
