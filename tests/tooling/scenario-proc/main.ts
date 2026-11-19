/** `bun run scenarios:process [files…] [--keep] [--trace]`: run process-mode scenarios with real
 * seshi processes, one after another (each on its own folder and ports). With no files, every
 * `tests/scenarios-proc/*.yaml`, then the cleanup proof: a scenario made to fail while a server,
 * a held pass and a service daemon are running must leave no process behind. `--keep` keeps a
 * failing scenario's folder (its logs, bucket and state); `--trace` prints the requests the
 * proxy saw. Not part of `bun run test`: it is slow and needs free ports.
 * `SCENARIO_SESHI_BIN=dist/seshi` runs the compiled binary instead of the source. */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pidAlive } from "./procs";
import { runProcessScenario, ScenarioFailure } from "./runner";
import { loadProcessScenario, type Scenario, ScenarioError } from "./schema";

const REPO = resolve(import.meta.dirname, "../../..");
const DIR = join(REPO, "tests/scenarios-proc");
const CLEANUP_PROOF = join(DIR, "cleanup/fails-midway.yaml");

function load(path: string): Scenario {
  const file = relative(REPO, resolve(path));
  return loadProcessScenario(file, readFileSync(path, "utf8"));
}

/** Run the scenario made to fail, and prove nothing it started is left: what was running when it
 * failed (the server, a long-running daemon, a held pass) is gone, by pid and by process group. */
async function cleanupProof(): Promise<string | undefined> {
  const scenario = load(CLEANUP_PROOF);
  try {
    await runProcessScenario(scenario);
  } catch (err) {
    if (!(err instanceof ScenarioFailure)) return `the cleanup proof crashed: ${err}`;
    if (!err.message.includes("expectation not met")) {
      return `the cleanup proof failed for another reason than meant:\n${err.message}`;
    }
    const wanted = ["serve", "daemon (long)", "daemon --once (held)"];
    const missing = wanted.filter((w) => !err.running.some((r) => r.startsWith(`${w} `)));
    if (missing.length > 0) {
      return `the cleanup proof failed without ${missing.join(", ")} running (running: ${err.running.join(", ")})`;
    }
    const left = err.running
      .map((r) => Number(/pid (\d+)/.exec(r)?.[1]))
      .filter((pid) => pidAlive(pid));
    if (err.survivors.length > 0 || left.length > 0) {
      return `a failing scenario left processes:\n${[...err.survivors, ...left.map(String)].join("\n")}`;
    }
    console.log(`  running when it failed, all gone since: ${err.running.join(", ")}`);
    return undefined;
  }
  return "the cleanup proof's scenario passed, but it is made to fail";
}

async function main(argv: string[]): Promise<number> {
  const unknown = argv.filter((a) => a.startsWith("--") && a !== "--keep" && a !== "--trace");
  if (unknown.length > 0) {
    console.error(`usage: bun run scenarios:process [files…] [--keep] [--trace] (not ${unknown})`);
    return 2;
  }
  const keep = argv.includes("--keep");
  const trace = argv.includes("--trace");
  const files = argv.filter((a) => !a.startsWith("--"));
  const paths =
    files.length > 0
      ? files.map((f) => resolve(f))
      : readdirSync(DIR)
          .filter((n) => n.endsWith(".yaml"))
          .sort()
          .map((n) => join(DIR, n));
  const started = performance.now();
  let failed = 0;
  for (const path of paths) {
    const t0 = performance.now();
    let scenario: Scenario;
    try {
      scenario = load(path);
    } catch (err) {
      if (!(err instanceof ScenarioError)) throw err;
      console.log(`✗ ${relative(REPO, path)}\n${err.message}\n`);
      failed++;
      continue;
    }
    try {
      const report = await runProcessScenario(scenario, { keepOnFailure: keep, trace });
      console.log(
        `✓ ${relative(REPO, path)}: ${scenario.name} (${(report.ms / 1000).toFixed(1)} s, ${report.processes} processes, ${report.faults.length} rules fired)`,
      );
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      console.log(
        `✗ ${relative(REPO, path)}: ${scenario.name} (${((performance.now() - t0) / 1000).toFixed(1)} s)\n${message}\n`,
      );
    }
  }
  if (files.length === 0) {
    const t0 = performance.now();
    const problem = await cleanupProof();
    if (problem) {
      failed++;
      console.log(`✗ cleanup proof\n${problem}\n`);
    } else {
      console.log(
        `✓ cleanup proof: a failing scenario left no process behind (${((performance.now() - t0) / 1000).toFixed(1)} s)`,
      );
    }
  }
  const total = ((performance.now() - started) / 1000).toFixed(1);
  console.log(
    failed > 0
      ? `\n${failed} failed (${total} s)`
      : `\nall ${paths.length} scenarios passed (${total} s)`,
  );
  return failed > 0 ? 1 : 0;
}

process.exit(await main(process.argv.slice(2)));
