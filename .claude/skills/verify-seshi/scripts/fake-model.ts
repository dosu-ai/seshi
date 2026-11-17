/** A fake OpenAI-compatible chat completions endpoint for driving real agents (pi, OpenCode)
 * with no model spend: every request gets a canned reply, streamed or not, long enough (about
 * 2,300 characters) that a one-turn session clears the server's size filter.
 *
 *   bun .claude/skills/verify-seshi/scripts/fake-model.ts [port]     # default 8799
 *
 * Point an agent at http://127.0.0.1:<port>/v1 as provider `fake`, model `fake-1`
 * (features/pi-opencode.md has the config for each). */

const port = Number(process.argv[2] ?? 8799);
const PARAGRAPH =
  "The login handler lives in src/auth/login.ts: it checks the password hash with bcrypt, issues a session cookie, and redirects to the dashboard. Logout clears the cookie in src/auth/logout.ts and revokes the refresh token. ";
let n = 0;

Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/models")) {
      return Response.json({ object: "list", data: [{ id: "fake-1", object: "model" }] });
    }
    if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
    const body = (await req.json()) as { stream?: boolean; messages?: unknown[] };
    n++;
    const text = `fake reply ${n} (${body.messages?.length ?? 0} messages in). ${PARAGRAPH.repeat(10).trim()}`;
    const id = `chatcmpl-${n}`;
    const created = Math.floor(Date.now() / 1000);
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    if (!body.stream) {
      return Response.json({
        id,
        object: "chat.completion",
        created,
        model: "fake-1",
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage,
      });
    }
    const chunks = [
      { choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
    ];
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          const event = { id, object: "chat.completion.chunk", created, model: "fake-1", ...chunk };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  },
});
console.log(`fake model on http://127.0.0.1:${port}/v1`);
