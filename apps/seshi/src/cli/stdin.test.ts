import { describe, expect, it } from "vitest";

const reader = new URL("./stdin.ts", import.meta.url).href;

async function piped(input: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { readStdin } = await import(${JSON.stringify(reader)}); process.stdout.write(JSON.stringify(await readStdin()));`,
    ],
    { stdin: new Blob([input]), stdout: "pipe", stderr: "inherit" },
  );
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { code, out };
}

describe("readStdin", () => {
  it("reads a piped standard input to its end, in a process of its own", async () => {
    expect(await piped("sk-org-key\n")).toEqual({ code: 0, out: JSON.stringify("sk-org-key\n") });
  });

  it("reads input larger than one pipe buffer, and multi-byte text whole", async () => {
    const big = `${"ä".repeat(70_000)}\n`;
    expect(await piped(big)).toEqual({ code: 0, out: JSON.stringify(big) });
  });

  it("reads nothing from an empty input", async () => {
    expect(await piped("")).toEqual({ code: 0, out: '""' });
  });
});
