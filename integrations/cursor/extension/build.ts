/** Bundles the extension into dist/extension.js: CommonJS for Cursor's extension host, with
 * `vscode` left to the host. `--vsix <file>` also packages it, with vsce. */
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const here = import.meta.dirname;
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { vsix: { type: "string" } },
});

rmSync(join(here, "dist"), { recursive: true, force: true });
const built = await Bun.build({
  entrypoints: [join(here, "src", "extension.ts")],
  outdir: join(here, "dist"),
  target: "node",
  format: "cjs",
  external: ["vscode"],
  minify: false,
});
if (!built.success) {
  for (const log of built.logs) console.error(log);
  process.exit(1);
}
cpSync(join(here, "..", "..", "..", "LICENSE"), join(here, "LICENSE"));
console.log(`extension: ${join(here, "dist", "extension.js")}`);

if (values.vsix) {
  const out = resolve(values.vsix);
  mkdirSync(dirname(out), { recursive: true });
  const vsce = Bun.spawn(
    ["bunx", "@vscode/vsce@3.7.1", "package", "--no-dependencies", "--out", out],
    { cwd: here, stdout: "inherit", stderr: "inherit" },
  );
  if ((await vsce.exited) !== 0) process.exit(1);
  console.log(`vsix: ${out}`);
}
