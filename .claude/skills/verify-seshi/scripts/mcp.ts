#!/usr/bin/env bun
// mcp.ts: an MCP client for verification. It spawns `seshi mcp` (the run's `seshi` on PATH, so
// run it inside `eval "$($C env)"`) over stdio with the SDK's own Client, as an agent would, and
// prints what it answers.
//
//   bun mcp.ts list [-- <seshi mcp args…>]                 the tools, with each description
//   bun mcp.ts call <tool> '<json args>' [-- <seshi mcp args…>]
//                                                          one call: its text, then
//                                                          isError and structuredContent
//
// Exit 0 when the call answered without isError, 1 when it answered an error, 2 on misuse.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const argv = process.argv.slice(2);
const split = argv.indexOf("--");
const own = split === -1 ? argv : argv.slice(0, split);
const mcpArgs = split === -1 ? [] : argv.slice(split + 1);
const [command, tool, json] = own;

if (command !== "list" && command !== "call") {
  console.error("usage: mcp.ts list | call <tool> '<json args>' [-- <seshi mcp args…>]");
  process.exit(2);
}

const client = new Client({ name: "verify-seshi", version: "0" });
await client.connect(
  new StdioClientTransport({
    command: "seshi",
    args: ["mcp", ...mcpArgs],
    env: process.env as Record<string, string>,
    stderr: "inherit",
  }),
);
let code = 0;
try {
  if (command === "list") {
    for (const t of (await client.listTools()).tools) {
      console.log(`## ${t.name}\n${t.description ?? ""}\n`);
    }
  } else {
    const result = await client.callTool({
      name: tool as string,
      arguments: JSON.parse(json ?? "{}") as Record<string, unknown>,
    });
    for (const c of (result.content as { type: string; text?: string }[]) ?? []) {
      if (c.type === "text") console.log(c.text);
    }
    console.log(`\nisError: ${result.isError === true}`);
    if (result.structuredContent !== undefined) {
      console.log(`structuredContent: ${JSON.stringify(result.structuredContent)}`);
    }
    if (result.isError) code = 1;
  }
} finally {
  await client.close();
}
process.exit(code);
