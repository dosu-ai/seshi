import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configJsonSchemas } from "@seshi/config";

export function schemaFiles(): Array<{ path: string; text: string }> {
  const { server, cli } = configJsonSchemas();
  return [
    { path: "spec/config.schema.json", text: `${JSON.stringify(server, null, 2)}\n` },
    { path: "spec/cli-config.schema.json", text: `${JSON.stringify(cli, null, 2)}\n` },
  ];
}

export function staleFiles(root: string): string[] {
  return schemaFiles()
    .filter(({ path, text }) => {
      try {
        return readFileSync(join(root, path), "utf8") !== text;
      } catch {
        return true;
      }
    })
    .map(({ path }) => path);
}

if (import.meta.main) {
  const root = join(import.meta.dirname, "..");
  if (process.argv.includes("--check")) {
    const stale = staleFiles(root);
    if (stale.length > 0) {
      console.error(`stale: ${stale.join(", ")}; run \`bun run schema\``);
      process.exit(1);
    }
  } else {
    for (const { path, text } of schemaFiles()) writeFileSync(join(root, path), text);
  }
}
