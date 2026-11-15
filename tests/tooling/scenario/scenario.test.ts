/** The scenario runner's own parts: the file format's validator (every mistake names the file
 * and the step), the fault wrappers and the clock. The scenarios themselves run in
 * tests/scenarios/scenarios.test.ts. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsStore, isPreconditionFailed } from "@seshi/store";
import { afterEach, describe, expect, it } from "vitest";
import { ScenarioClock, seededRandom } from "./clock";
import { FaultPlan, faultFetch, globRegex, ScenarioStore } from "./faults";
import { loadScenario } from "./schema";

const parse = (yaml: string) => loadScenario("x.yaml", yaml);
const problem = (yaml: string) => {
  try {
    parse(yaml);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("parsed");
};

describe("the scenario format", () => {
  it("reads every step kind, one-word steps and defaults", () => {
    const s = parse(`
name: n
description: d
setup: { mode: local, review: true, allow: [orphan_trace], repos: { code/x: { config: "capture = false" } } }
steps:
  - turns: { session: main, count: 2, secret: true, in: code/x, mark: m }
  - subagent: { parent: main, id: h }
  - compact: { session: main, mode: shrink, keep: 0 }
  - move-transcript: { session: main }
  - hook: { session: main, event: SessionEnd }
  - pass
  - capture: off --session main
  - capture: { args: resend --session nope, code: 4 }
  - clock: +90m
  - restart-server
  - rules: { add: [{ id: r, pattern: "x+" }] }
  - format-bump: claude-code
  - sweep
  - backfill
  - review: [drop, allow]
  - fault: { http: POST /v1/sessions, status: 503, times: always }
  - fault: { store: delete, key: "*/trace.*", nth: 2, error: precondition, after: true }
  - heal
  - expect: { pass: { uploaded: 1 }, sessions: { main~1: { server: stub, doctor: ok } } }
  - settle: { allow: [change_orphan] }
`);
    expect(s.setup).toMatchObject({ mode: "local", review: { on_failure: "drop" } });
    expect(s.steps.map((step) => step.kind)).toEqual([
      "turns",
      "subagent",
      "compact",
      "move-transcript",
      "hook",
      "pass",
      "capture",
      "capture",
      "clock",
      "restart-server",
      "rules",
      "format-bump",
      "sweep",
      "backfill",
      "review",
      "fault",
      "fault",
      "heal",
      "expect",
      "settle",
    ]);
    expect(s.steps[1]).toMatchObject({ turns: 2, hook: true });
    expect(s.steps[3]).toMatchObject({ to: "code/moved", hook: "Stop" });
    expect(s.steps[5]).toEqual({ kind: "pass", sweep: true });
    expect(s.steps[7]).toEqual({ kind: "capture", args: ["resend", "--session", "nope"], code: 4 });
    expect(s.steps[8]).toEqual({ kind: "clock", ms: 90 * 60_000 });
    expect(s.steps[15]).toMatchObject({ http: "POST /v1/sessions", nth: 1, times: "always" });
  });

  it("names the file and the step of an unknown step or field, or a bad value", () => {
    const head = "name: n\ndescription: d\nsteps:\n  - pass\n";
    expect(problem(`${head}  - wait: 2h\n`)).toMatch(/^x\.yaml: step 2: unknown step 'wait'/);
    expect(problem(`${head}  - turns: { session: a, cout: 2 }\n`)).toBe(
      "x.yaml: step 2 (turns): unknown field 'cout'",
    );
    expect(problem(`${head}  - turns: { session: a, count: 0 }\n`)).toContain(
      "step 2 (turns): 'count' must be a whole number of at least 1",
    );
    expect(problem(`${head}  - clock: soon\n`)).toContain("step 2 (clock): must be a duration");
    expect(problem(`${head}  - fault: { http: POST /v1/sessions }\n`)).toContain(
      "exactly one of status, drop-response, reset, latency",
    );
    expect(problem(`${head}  - fault: { http: POST /v1/sessions, status: 409 }\n`)).toContain(
      "a 409 needs a 'code'",
    );
    expect(problem(`${head}  - expect: { sessions: { a: { sever: present } } }\n`)).toContain(
      "step 2 (expect): sessions.a: unknown field 'sever'",
    );
    expect(problem(`${head}  - expect: { pass: { uplodaed: 1 } }\n`)).toContain(
      "'pass.uplodaed' is not a pass summary field",
    );
    expect(problem(`${head}  - turns: { session: a, in: /etc }\n`)).toContain(
      "under the machine's home",
    );
    expect(problem(`${head}  - review: [maybe]\n`)).toContain(
      "a list of allow, redact, drop, fail",
    );
    expect(problem("name: n\nsteps: [pass]\n")).toBe("x.yaml: 'description' is required");
    expect(problem("name: n\ndescription: d\nsetup: { mode: cloud }\nsteps: [pass]\n")).toContain(
      "x.yaml: setup: 'mode' must be one of server, local",
    );
    expect(problem("name: n\ndescription: d\nsteps: [pass]\nextra: 1\n")).toBe(
      "x.yaml: unknown field 'extra'",
    );
    expect(problem("name: [\n")).toMatch(/^x\.yaml: not YAML/);
  });
});

describe("faults", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("globs keys and paths, * crossing folders", () => {
    expect(globRegex("owners/*/metadata.json").test("owners/a/sessions/b/metadata.json")).toBe(
      true,
    );
    expect(globRegex("/v1/sessions").test("/v1/sessions/x")).toBe(false);
  });

  it("fires an HTTP fault on the nth matching request, as often as told, then passes through", async () => {
    const plan = new FaultPlan();
    const clock = new ScenarioClock();
    const seen: string[] = [];
    const inner = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response("ok");
    }) as typeof fetch;
    plan.http.push({
      method: "POST",
      path: globRegex("/v1/sessions"),
      action: { kind: "status", status: 409, code: "offset_mismatch", expected: 7 },
      nth: 2,
      times: 1,
      seen: 0,
      fired: 0,
      label: "409",
    });
    plan.http.push({
      path: globRegex("/drop"),
      action: { kind: "drop-response" },
      nth: 1,
      times: 1,
      seen: 0,
      fired: 0,
      label: "drop",
    });
    const f = faultFetch(plan, clock, inner);
    const post = { method: "POST" };
    expect(await (await f("http://h/v1/sessions", post)).text()).toBe("ok");
    expect(plan.pending()).toEqual(["409", "drop"]);
    const refused = await f("http://h/v1/sessions", post);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "offset_mismatch", expected: 7 } });
    expect(await (await f("http://h/v1/sessions", post)).text()).toBe("ok");
    // The server got it; the client did not.
    await expect(f("http://h/drop")).rejects.toThrow(/injected/);
    expect(seen.filter((u) => u.endsWith("/drop"))).toHaveLength(1);
    expect(plan.pending()).toEqual([]);
    expect(plan.log).toHaveLength(2);
  });

  it("fails the nth matching store write, before or after it lands, and keeps scenario ages", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seshi-scenario-test-"));
    dirs.push(dir);
    const plan = new FaultPlan();
    const clock = new ScenarioClock();
    const store = new ScenarioStore(new FsStore(`file://${dir}`), plan, clock);
    const body = new TextEncoder().encode("x");
    plan.store.push({
      op: "put",
      key: globRegex("a/*"),
      error: "precondition",
      after: false,
      nth: 1,
      times: 1,
      seen: 0,
      fired: 0,
      label: "p",
    });
    plan.store.push({
      op: "put",
      key: globRegex("b/*"),
      error: "fail",
      after: true,
      nth: 1,
      times: 1,
      seen: 0,
      fired: 0,
      label: "f",
    });
    await store.put("a/1", body).then(
      () => expect.unreachable(),
      (err) => expect(isPreconditionFailed(err)).toBe(true),
    );
    expect(await store.get("a/1")).toBeNull();
    await expect(store.put("b/1", body)).rejects.toThrow(/injected/);
    expect(await store.get("b/1")).not.toBeNull();
    const at = clock.now().getTime();
    clock.advance(3_600_000);
    const listed = await store.list("b/", { details: true });
    expect(Math.abs(Date.parse(listed.objects?.[0]?.modified as string) - at)).toBeLessThan(1000);
    expect(Math.abs(Date.parse((await store.stat("b/1"))?.modified as string) - at)).toBeLessThan(
      1000,
    );
  });
});

describe("the scenario clock", () => {
  it("moves the global Date while installed, and only forward", () => {
    const clock = new ScenarioClock();
    const real = Date.now();
    clock.install();
    try {
      expect(Date.now()).toBeLessThan(real);
      const before = Date.now();
      clock.advance(2 * 3_600_000);
      expect(Date.now() - before).toBeGreaterThanOrEqual(2 * 3_600_000);
      expect(new Date(5).getTime()).toBe(5);
      expect(new Date(0) instanceof Date).toBe(true);
      expect(() => clock.advance(-1)).toThrow();
    } finally {
      clock.restore();
    }
    expect(Math.abs(Date.now() - real)).toBeLessThan(60_000);
  });

  it("draws the same numbers from the same seed", () => {
    const a = seededRandom(7);
    const b = seededRandom(7);
    const xs = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });
});
