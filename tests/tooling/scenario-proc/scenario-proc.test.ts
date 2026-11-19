/** The process-mode runner's own parts, fast enough for `bun run test`: the format (what it
 * refuses out of process and why, and that every scenario in tests/scenarios-proc parses), the
 * fault proxy's rules against a small server on 127.0.0.1, and the process registry's cleanup.
 * The scenarios themselves run with `bun run scenarios:process`. */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listProcesses, Procs } from "./procs";
import { FaultProxy, globRegex, type ProxyAction } from "./proxy";
import { loadProcessScenario, parseProcessScenario } from "./schema";

const parse = (steps: unknown[], setup: unknown = { mode: "process" }) =>
  parseProcessScenario("x.yaml", { name: "n", description: "d", setup, steps });

describe("the process-mode format", () => {
  it("needs mode: process", () => {
    expect(() => parse(["pass"], {})).toThrow(
      "x.yaml: setup: a process-mode scenario says 'mode: process'",
    );
    expect(() => parse(["pass"], { mode: "process", seed: 2 })).toThrow(
      "'seed' is in-process only",
    );
  });

  it("refuses steps that cannot work out of process, saying why", () => {
    expect(() => parse(["pass", { clock: "+2h" }])).toThrow(
      "x.yaml: step 2 (clock): not in process mode: no time travel out of process",
    );
    expect(() => parse([{ fault: { store: "put", key: "*" } }])).toThrow(
      "store faults need the in-process store wrapper",
    );
    expect(() => parse([{ fault: { http: "POST /v1/sessions", latency: "2s" } }])).toThrow(
      "use 'delay' for real time",
    );
    expect(() => parse([{ review: ["drop"] }])).toThrow("the fake reviewer");
    expect(() => parse([{ expect: { reviewed: [{ text: "x", times: 1 }] } }])).toThrow(
      "'reviewed' reads the fake reviewer",
    );
    expect(() => parse([{ pass: { sweep: false } }])).toThrow("seshi daemon --once sweeps");
  });

  it("checks shared steps with the in-process validator, numbered for this file", () => {
    expect(() => parse(["pass", { turns: { session: "main", cout: 2 } }])).toThrow(
      "x.yaml: step 2 (turns): unknown field 'cout'",
    );
    const s = parse([{ turns: { session: "main", count: 2 } }, "pass", "settle"]);
    expect(s.steps.map((x) => x.kind)).toEqual(["turns", "pass", "settle"]);
  });

  it("reads the proxy's rules", () => {
    const s = parse([
      { fault: { http: "POST /v1/sessions", "kill-client": 300 } },
      { fault: { http: "DELETE /v1/sessions/*", "kill-server": "all", nth: 2 } },
      { fault: { http: "POST /v1/sessions", reset: true } },
      { fault: { http: "POST /v1/sessions", status: 409, code: "conflict", times: "always" } },
    ]);
    expect(s.steps).toMatchObject([
      { kind: "fault", action: { kind: "kill-client", bytes: 300 }, nth: 1, times: 1 },
      { kind: "fault", action: { kind: "kill-server", bytes: "all" }, nth: 2 },
      { kind: "fault", action: { kind: "close-request", bytes: -1 } },
      { kind: "fault", action: { kind: "status", status: 409, code: "conflict" }, times: "always" },
    ]);
    expect(() =>
      parse([{ fault: { http: "POST /v1/sessions", delay: "2s", reset: true } }]),
    ).toThrow("exactly one of");
    expect(() => parse([{ fault: { http: "POST /v1/sessions", status: 409 } }])).toThrow(
      "a 409 needs a 'code'",
    );
  });

  it("knows its runs by name", () => {
    expect(() => parse([{ join: "nobody" }])).toThrow("no run named 'nobody' before this step");
    expect(() =>
      parse([{ background: { as: "a", step: "pass" } }, { background: { as: "a", step: "pass" } }]),
    ).toThrow("'a' is already a run's name");
    expect(() => parse([{ background: { as: "a", step: { clock: "1h" } } }])).toThrow(
      "step 1 (clock): not in process mode",
    );
    const s = parse([
      { background: { as: "a", step: "pass" } },
      { daemon: { as: "d", "keep-alive": true } },
      { join: ["a"] },
      { expect: { started: { of: ["a", "d"], count: 1 }, requests: { "POST /v1/sessions": 1 } } },
      { kill: "d" },
    ]);
    expect(s.steps[1]).toEqual({ kind: "daemon", as: "d", keepAlive: true });
  });

  it("parses every scenario in tests/scenarios-proc", () => {
    const dir = join(import.meta.dirname, "../../scenarios-proc");
    const files = [
      ...readdirSync(dir).filter((n) => n.endsWith(".yaml")),
      ...readdirSync(join(dir, "cleanup")).map((n) => `cleanup/${n}`),
    ];
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const scenario = loadProcessScenario(name, readFileSync(join(dir, name), "utf8"));
      expect(scenario.setup.mode).toBe("process");
    }
  });
});

describe("the fault proxy", () => {
  const seen: { method: string; path: string; body: string }[] = [];
  let upstream: ReturnType<typeof Bun.serve> | undefined;
  let proxy: FaultProxy | undefined;
  const killed: string[] = [];

  afterEach(() => {
    proxy?.stop();
    upstream?.stop(true);
    seen.length = 0;
    killed.length = 0;
  });

  function start(rules: { http: string; action: ProxyAction; nth?: number }[] = []) {
    upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = await request.text();
        seen.push({ method: request.method, path: new URL(request.url).pathname, body });
        return Response.json({ ok: true, length: body.length }, { status: 201 });
      },
    });
    proxy = new FaultProxy(upstream.port as number, {
      killClient: async () => void killed.push("client"),
      killServer: async () => void killed.push("server"),
    });
    for (const rule of rules) {
      const [method, path] = rule.http.split(" ") as [string, string];
      proxy.rules.push({
        label: rule.http,
        method,
        path: globRegex(path),
        nth: rule.nth ?? 1,
        times: 1,
        seen: 0,
        fired: 0,
        action: rule.action,
      });
    }
    proxy.start();
    return proxy.url;
  }

  const post = (url: string, body = "x".repeat(2000)) =>
    fetch(`${url}/v1/sessions`, { method: "POST", body });

  it("forwards requests, one per connection, and records them", async () => {
    const url = start();
    for (let i = 0; i < 3; i++) {
      const res = await post(url);
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ ok: true, length: 2000 });
    }
    expect(seen).toHaveLength(3);
    expect(proxy?.requests.map((r) => [r.method, r.path, r.status])).toEqual([
      ["POST", "/v1/sessions", 201],
      ["POST", "/v1/sessions", 201],
      ["POST", "/v1/sessions", 201],
    ]);
  });

  it("answers a canned status without asking the server", async () => {
    const url = start([{ http: "POST /v1/sessions", action: { kind: "status", status: 503 } }]);
    const res = await post(url);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("injected");
    expect(seen).toHaveLength(0);
    expect((await post(url)).status).toBe(201);
  });

  it("drops an answer the server committed", async () => {
    const url = start([{ http: "POST /v1/sessions", action: { kind: "drop-response" } }]);
    await expect(post(url)).rejects.toThrow();
    expect(seen).toHaveLength(1);
  });

  it("cuts a request after N body bytes, so the server never sees it whole", async () => {
    const url = start([
      { http: "POST /v1/sessions", action: { kind: "close-request", bytes: 100 } },
      { http: "POST /v1/sessions", action: { kind: "close-request", bytes: -1 } },
    ]);
    await expect(post(url)).rejects.toThrow();
    await expect(post(url)).rejects.toThrow();
    await Bun.sleep(50);
    expect(seen).toHaveLength(0);
    expect(proxy?.requests.map((r) => r.outcome)).toEqual([
      "closed after 100 of 2000 body bytes",
      "reset",
    ]);
  });

  it("cuts an answer after N bytes", async () => {
    const url = start([
      { http: "POST /v1/sessions", action: { kind: "close-response", bytes: 20 } },
    ]);
    await expect(post(url).then((r) => r.text())).rejects.toThrow();
    expect(seen).toHaveLength(1);
    expect(proxy?.requests[0]?.outcome).toBe("closed after 20 response bytes");
  });

  it("holds a request for a delay", async () => {
    const url = start([{ http: "POST /v1/sessions", action: { kind: "delay", ms: 300 } }]);
    const t0 = performance.now();
    expect((await post(url)).status).toBe(201);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(290);
  });

  it("calls the kill hooks at the byte asked, and counts by nth", async () => {
    const url = start([
      { http: "POST /v1/sessions", action: { kind: "kill-client", bytes: 500 }, nth: 2 },
      { http: "GET /v1/*", action: { kind: "kill-server", bytes: 0 } },
    ]);
    expect((await post(url)).status).toBe(201);
    await expect(post(url)).rejects.toThrow();
    expect(killed).toEqual(["client"]);
    expect(proxy?.requests[1]?.outcome).toBe("client killed after 500 of 2000 body bytes");
    await expect(fetch(`${url}/v1/me`)).rejects.toThrow();
    expect(killed).toEqual(["client", "server"]);
    expect(proxy?.pending()).toEqual([]);
  });
});

describe("the process registry", () => {
  it("kills what a child started too, and proves nothing is left", async () => {
    const procs = new Procs();
    const child = procs.spawn(["sh", "-c", "sleep 30 & sleep 30"], {
      label: "sleeper",
      cwd: import.meta.dirname,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    await Bun.sleep(200);
    expect(listProcesses().filter((p) => p.pgid === child.pid).length).toBeGreaterThanOrEqual(2);
    expect(procs.survivors().length).toBeGreaterThanOrEqual(2);
    await procs.killAll();
    expect(procs.survivors()).toEqual([]);
    expect((await child.done).signal).toBe("SIGKILL");
  });
});
