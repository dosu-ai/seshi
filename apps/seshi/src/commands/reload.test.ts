/** `seshi serve` applying config changes without a restart (F1.5, revised): SIGHUP and
 * `POST /v1/admin/reload` against a running server process. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const MAIN = join(import.meta.dirname, "..", "main.ts");

let dir: string;
let file: string;
let pack: string;
let server: ReturnType<typeof Bun.spawn> | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-reload-"));
  file = join(dir, "seshi.toml");
  pack = join(dir, "org.toml");
});
afterEach(async () => {
  server?.kill();
  await server?.exited;
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(extra = ""): void {
  writeFileSync(
    file,
    `[server]
listen = "127.0.0.1:0"
[store]
url = "file://${join(dir, "bucket")}"
[search]
path = "${join(dir, "search.sqlite")}"
[redaction]
packs = ["${pack}"]
${extra}`,
    { mode: 0o600 },
  );
}

const env = () => ({ PATH: process.env.PATH ?? "", HOME: dir });

async function adminToken(): Promise<string> {
  const proc = Bun.spawn(
    ["bun", MAIN, "admin", "init", "--json", "--owner", "ops", "--config", file],
    {
      cwd: dir,
      env: env(),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited, await new Response(proc.stderr).text()).toBe(0);
  return JSON.parse(out).admin.token as string;
}

async function serve(): Promise<{ proc: ReturnType<typeof Bun.spawn>; base: string }> {
  const proc = Bun.spawn(["bun", MAIN, "serve", "--config", file], {
    cwd: dir,
    env: env(),
    stdout: "pipe",
    stderr: "pipe",
  });
  server = proc;
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  let out = "";
  while (!/127\.0\.0\.1:(\d+)/.test(out)) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`server stopped: ${out}`);
    out += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const port = (/127\.0\.0\.1:(\d+)/.exec(out) as RegExpExecArray)[1];
  return { proc, base: `http://127.0.0.1:${port}` };
}

describe("seshi serve reloads its config", () => {
  it("on SIGHUP and on POST /v1/admin/reload, without restarting", async () => {
    writeFileSync(pack, 'id = "org"\n');
    writeConfig();
    const token = await adminToken();
    const { proc, base } = await serve();
    const get = async (path: string) =>
      (await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } })).json();
    const rules = async () =>
      (
        await fetch(`${base}/v1/redaction/rules`, { headers: { authorization: `Bearer ${token}` } })
      ).headers.get("etag");

    const before = await get("/v1/admin/reload");
    expect(before).toMatchObject({ generation: 1, reloadable: true, last_reload: null });
    const etag = await rules();

    // An edited rule pack, applied by SIGHUP.
    writeFileSync(
      pack,
      'id = "org"\n[[rules]]\nid = "org-key"\npattern = "ORG-[0-9]{4}"\ntests.match = ["ORG-1234"]\n',
    );
    proc.kill("SIGHUP");
    const end = Date.now() + 5000;
    let status = before;
    while (status.generation === 1 && Date.now() < end) {
      await Bun.sleep(25);
      status = await get("/v1/admin/reload");
    }
    expect(status).toMatchObject({
      generation: 2,
      last_reload: { trigger: "signal", outcome: "applied", changed: ["redaction"] },
    });
    expect(await rules()).not.toBe(etag);
    expect(await rules()).toBe(`"${status.rule_set}"`);

    // A source added in a drop-in, applied through the API.
    mkdirSync(join(dir, "seshi.d"));
    writeFileSync(join(dir, "seshi.d", "adx.toml"), '[[sources]]\nid = "otel"\ntype = "otlp"\n');
    const post = () =>
      fetch(`${base}/v1/admin/reload`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
    const applied = await post();
    expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({
      reload: { trigger: "api", outcome: "applied", sources: { added: ["otel"] } },
      config: { generation: 3 },
    });
    const sources = (await get("/v1/admin/sources")) as { sources: { id: string }[] };
    expect(sources.sources.map((s) => s.id)).toEqual(["otel", "upload"]);

    // A broken file is refused and the running config stays.
    writeFileSync(file, "[store\n");
    const refused = await post();
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({
      error: { code: "reload_rejected" },
      config: { generation: 3 },
    });
    expect(proc.exitCode).toBeNull();
  }, 30_000);
});
