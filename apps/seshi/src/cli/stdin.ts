/** All of standard input, as UTF-8. Through `process.stdin` rather than `Bun.stdin.text()`: on
 * Windows the latter never settles for a piped stdin, and the process then exits with nothing
 * done. */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString("utf8");
}
