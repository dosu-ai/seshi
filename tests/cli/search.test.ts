/** `seshi search` through the CLI's account (F10.5, F8.2): against a seshi server on 127.0.0.1
 * with the credential `seshi login` stored (`--token` overriding it), the hits styled in the
 * search colour on a terminal and plain otherwise. */

import { HttpSessionDB } from "@seshi/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Machine, startServer, type TestServer } from "../tooling/cli";
import { transcript } from "../tooling/testdata";

const SMALL = transcript("claude-basic.claude-code.jsonl");
// Long enough for the session filter, with words to find.
const CLAUDE = `${SMALL.trim()}\n${JSON.stringify({
  type: "assistant",
  uuid: "a3",
  timestamp: "2026-09-01T00:00:08.000Z",
  sessionId: "sess1",
  message: {
    role: "assistant",
    model: "claude-x",
    content: [{ type: "text", text: `The auth flow: ${"details ".repeat(400)}` }],
  },
})}\n`;

const TOKEN = "static-token-for-acme-0123456789";
const OTHER = "static-token-for-bob-01234567890";

let server: TestServer;
let machine: Machine;

beforeEach(async () => {
  server = await startServer({
    settings: {
      staticTokens: [
        { token: TOKEN, owner: "acme" },
        { token: OTHER, owner: "bob" },
      ],
    },
  });
  machine = new Machine();
  await new HttpSessionDB({ server: server.url, token: TOKEN }).ingest({
    agent: "claude-code",
    session_id: "sess1",
    transcript: CLAUDE,
    project: "github.com/acme/widget",
  });
  await server.instance.search?.catchUp();
});

afterEach(async () => {
  await server.stop();
  machine.cleanup();
});

/** A word the stored session says. */
const WORD = "flow";

describe("seshi search with the stored credential", () => {
  it("is not signed in before seshi login, and uses the login after", async () => {
    const word = WORD;
    const before = await machine.seshi(["search", word, "--server", server.url]);
    expect(before.code).toBe(5);
    expect(before.err).toContain("not signed in");

    const login = await machine.seshi(["login", "--server", server.url, "--token", "-"], {
      stdin: TOKEN,
    });
    expect(login.code, login.err).toBe(0);
    // The server login wrote to the CLI config; no --server or --token needed.
    const found = await machine.seshi(["search", word]);
    expect(found.code, found.err).toBe(0);
    expect(found.out).toContain("claude-code/sess1  acme  github.com/acme/widget");
    // Not a terminal: no colour codes.
    expect(found.out).not.toContain("\x1b[");
    const json = JSON.parse((await machine.seshi(["search", word, "--json"])).out);
    expect(json.total).toBe(1);
  });

  it("takes --token over the stored credential", async () => {
    const word = WORD;
    await machine.seshi(["login", "--server", server.url, "--token", "-"], { stdin: TOKEN });
    // bob may not read acme's session unless it is org-visible: it is (the default), so bob
    // finds it too, as bob.
    const asBob = await machine.seshi(["search", word, "--token", OTHER, "--json"]);
    expect(asBob.code, asBob.err).toBe(0);
    const wrong = await machine.seshi(["search", word, "--token", "wrong-token-0123456789"]);
    expect(wrong.code).toBe(5);
  });

  it("paints the session and the matched words on a colour terminal, and not with NO_COLOR", async () => {
    const word = WORD;
    await machine.seshi(["login", "--server", server.url, "--token", "-"], { stdin: TOKEN });
    const tty = { stdout: true, stdin: false };
    const env = { TERM: "xterm-256color", SESHI_THEME: "dark" };
    const coloured = await machine.seshi(["search", word], { tty, env });
    expect(coloured.code, coloured.err).toBe(0);
    expect(coloured.out).toContain("\x1b[38;5;");
    expect(coloured.out).toMatch(new RegExp(`\\x1b\\[38;5;\\d+m${word}\\x1b\\[39m`, "i"));
    const plain = await machine.seshi(["search", word], { tty, env: { ...env, NO_COLOR: "1" } });
    expect(plain.out).not.toContain("\x1b[");
    const json = await machine.seshi(["search", word, "--json"], { tty, env });
    expect(json.out).not.toContain("\x1b[");
  });
});
