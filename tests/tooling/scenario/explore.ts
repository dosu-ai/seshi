/** The scenario explorer (33): runs generated scenarios (`generate.ts`) and, when one fails,
 * shrinks it to a minimal failing step list and writes it to tests/scenarios/found/.
 *
 * One run is one seed: `fc.check` with that seed and `numRuns: 1` draws one plan, runs its
 * scenario and, on a failure, lets fast-check shrink the plan. While shrinking, a smaller plan
 * counts as failing only when it fails the same way (the same headline, and the first line of
 * evidence still among its own, numbers and session names taken out), so the shrink does not
 * slip to a different bug; each distinct scenario runs once (candidates that make the same
 * steps are answered from a cache); and the number of scenario runs a shrink may make is
 * capped, by count, never by time. With the runner deterministic for a given scenario, the whole is deterministic for
 * a given seed and step budget: the same seed finds the same minimal scenario.
 *
 *   bun run scenarios:explore [--runs N] [--seed S] [--max-steps M] [--shrink-runs K]
 *
 * prints a summary (runs, steps, failures, the files written) and exits 1 when anything failed.
 * The test suite runs a small fixed-seed budget of the same (tests/scenarios/generated.test.ts). */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { buildScenario, type Plan, planArb, toYaml } from "./generate";
import { runScenario } from "./runner";
import { ScenarioError } from "./schema";

export const FOUND_DIR = join(import.meta.dirname, "..", "..", "scenarios", "found");

export interface ExploreOptions {
  maxSteps: number;
  /** Scenario runs a shrink may make, the first (failing) run included. */
  shrinkRuns: number;
  /** Where found files go; none written when undefined. */
  dir?: string;
}

export interface Found {
  seed: number;
  /** Steps of the scenario first generated. */
  original: number;
  /** Steps of the minimal one. */
  steps: number;
  /** The minimal scenario's failure. */
  message: string;
  signature: string;
  yaml: string;
  /** Scenario runs the shrink made. */
  shrinkRuns: number;
  file?: string;
}

export interface RunResult {
  seed: number;
  /** Steps of the scenario generated. */
  steps: number;
  ms: number;
  /** Faults that fired and uploader passes made in the scenario generated (when it passed). */
  faults: number;
  passes: number;
  found?: Found;
}

type Outcome = { ok: true; faults: number; passes: number } | { ok: false; message: string };

/** Run one scenario; every throw is a failure: an invariant, a quiet check, or an unexpected
 * exception. */
async function attempt(plan: Plan, label: string): Promise<Outcome> {
  const { scenario } = buildScenario(plan, label);
  try {
    const report = await runScenario(scenario);
    return { ok: true, faults: report.faults.length, passes: report.passes };
  } catch (err) {
    const e = err as Error;
    if (e?.name === "ScenarioFailure") return { ok: false, message: e.message };
    return {
      ok: false,
      message: `${label}: unexpected exception: ${e?.name ?? "Error"}: ${e?.message ?? String(err)}\n${(e?.stack ?? "").split("\n").slice(1, 8).join("\n")}`,
    };
  }
}

const generic = (text: string) =>
  text
    // Bucket keys carry hashes, times and random ids: one placeholder.
    .replace(/\(?\bowners\/\S+/g, "KEY")
    .replace(/\b(main|a|b|agent-[xy])(~\d+)?\b/g, "S")
    .replace(/[0-9a-f]{12,}/g, "H")
    .replace(/\d+/g, "N")
    .replace(/\s+/g, " ")
    .trim();

/** A failure's shape: its headline (without the file and the step) and a key per line of
 * evidence (the line made generic, cut after its second `: `-separated part, so
 * `S: records: the transcript's…` is `S: records`). */
export interface FailureShape {
  head: string;
  keys: string[];
}

export function shapeOf(message: string): FailureShape {
  const lines = message.split("\n");
  const head = generic(
    (lines[0] ?? "").replace(/^.*?: (?:step \d+ \(.*?\)|at the end|setup): /, ""),
  );
  const keys: string[] = [];
  for (const line of lines.slice(1)) {
    // Evidence is indented two spaces; detail four; then the faults and the capture log.
    if (/^ {2}(faults fired|capture log)/.test(line)) break;
    if (!/^ {2}\S/.test(line)) continue;
    keys.push(generic(line).split(": ").slice(0, 2).join(": ").slice(0, 160));
  }
  return { head, keys };
}

/** The signature failures are grouped by: the headline and the first evidence key. */
export function signatureOf(shape: FailureShape): string {
  return shape.keys[0] ? `${shape.head} | ${shape.keys[0]}` : shape.head;
}

/** While shrinking, a candidate fails "the same way" when its headline is the original's and
 * its evidence still holds the original's first key (other findings may come and go). */
export function sameFailure(original: FailureShape, candidate: FailureShape): boolean {
  if (candidate.head !== original.head) return false;
  const key = original.keys[0];
  return key === undefined || candidate.keys.includes(key);
}

/** A line of a failure for a found file's header: the run's temporary folders named, not
 * spelled out, and long lines cut. */
function tidy(line: string): string {
  const named = line
    .replace(/(?:\/private)?\/(?:var\/folders\/[^\s"]*?|tmp)\/seshi-cli-\w+/g, "<home>")
    .replace(/(?:\/private)?\/(?:var\/folders\/[^\s"]*?|tmp)\/seshi-scenario-\w+/g, "<world>")
    .replace(/-(?:private-)?(?:var-folders-[^\s"/]*?|tmp)-seshi-cli-\w+/g, "-<home>")
    .replace(/http:\/\/127\.0\.0\.1:\d+/g, "<server>");
  return named.length > 240 ? `${named.slice(0, 239)}…` : named;
}

function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

/** One seed: generate, run, and shrink on a failure. */
export async function exploreOne(seed: number, options: ExploreOptions): Promise<RunResult> {
  const label = `generated:${seed}`;
  const started = performance.now();
  let runs = 0;
  let steps = 0;
  let original: FailureShape | undefined;
  let lastMessage = "";
  let faults = 0;
  let passes = 0;
  // Many candidates fast-check tries while shrinking make the same steps (a number that shrinks
  // but picks the same option): each distinct scenario runs once.
  const seen = new Map<string, boolean>();
  // A plan the validator refuses is the generator's own bug: it stops the run, never shrinks.
  let invalid: ScenarioError | undefined;
  const property = fc.asyncProperty(planArb(options.maxSteps), async (plan) => {
    if (invalid) return true;
    let raw: Record<string, unknown>;
    try {
      raw = buildScenario(plan, label).raw;
    } catch (err) {
      if (!(err instanceof ScenarioError)) throw err;
      invalid = err;
      return true;
    }
    const key = JSON.stringify(raw);
    const known = seen.get(key);
    if (known !== undefined) return known;
    runs++;
    if (runs === 1) steps = (raw.steps as unknown[]).length;
    // The shrink budget: past it every candidate "passes", which ends the shrink with the
    // smallest failing plan found so far. Counted, so it is the same on every machine.
    else if (runs > options.shrinkRuns) return true;
    const outcome = await attempt(plan, label);
    if (runs === 1 && outcome.ok) {
      faults = outcome.faults;
      passes = outcome.passes;
    }
    let passed = true;
    if (!outcome.ok) {
      const shape = shapeOf(outcome.message);
      original ??= shape;
      if (sameFailure(original, shape)) {
        lastMessage = outcome.message;
        passed = false;
      }
    }
    seen.set(key, passed);
    return passed;
  });
  const check = await fc.check(property, { seed, numRuns: 1 });
  const ms = Math.round(performance.now() - started);
  if (invalid) throw invalid;
  if (!check.failed) return { seed, steps, ms, faults, passes };
  if (!check.counterexample)
    throw new Error(`seed ${seed}: fast-check stopped without a counterexample`);
  const [plan] = check.counterexample;
  const { raw, scenario } = buildScenario(plan, label);
  const message = lastMessage.replaceAll(`${label}: `, "");
  const found: Found = {
    seed,
    original: steps,
    steps: scenario.steps.length,
    message,
    signature: signatureOf(original as FailureShape),
    yaml: "",
    shrinkRuns: Math.min(runs, options.shrinkRuns),
  };
  const body = toYaml({
    ...raw,
    name: `found by seed ${seed}`,
    description: `A generated scenario (seed ${seed}) shrunk from ${steps} to ${scenario.steps.length} steps; the header says how it failed.`,
  });
  found.yaml = [
    "# Found by the scenario explorer (tests/tooling/scenario/explore.ts); see tests/scenarios/README.md.",
    `# seed: ${seed} (bun run scenarios:explore --seed ${seed} --runs 1 --max-steps ${options.maxSteps})`,
    `# original length: ${steps} steps; shrunk to ${scenario.steps.length} in ${found.shrinkRuns} runs`,
    "# failure:",
    ...message
      .split("\n")
      .slice(0, 24)
      .map((l) => `#   ${tidy(l)}`),
    body,
  ].join("\n");
  if (options.dir) {
    mkdirSync(options.dir, { recursive: true });
    found.file = join(options.dir, `${seed}-${shortHash(body)}.yaml`);
    writeFileSync(found.file, found.yaml);
  }
  return { seed, steps, ms, faults, passes, found };
}

interface Args {
  runs: number;
  seed: number;
  maxSteps: number;
  shrinkRuns: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    runs: 200,
    seed: Math.floor(Math.random() * 1_000_000_000),
    maxSteps: 25,
    shrinkRuns: 300,
  };
  const names: Record<string, keyof Args> = {
    "--runs": "runs",
    "--seed": "seed",
    "--max-steps": "maxSteps",
    "--shrink-runs": "shrinkRuns",
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = (argv[i] as string).split("=", 2) as [string, string | undefined];
    const key = names[flag];
    const value = Number(inline ?? argv[++i]);
    if (!key || !Number.isInteger(value) || value < (key === "seed" ? 0 : 1)) {
      console.error(
        "usage: bun run scenarios:explore [--runs N] [--seed S] [--max-steps M] [--shrink-runs K]",
      );
      process.exit(2);
    }
    out[key] = value;
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const started = performance.now();
  console.log(
    `exploring ${args.runs} generated scenarios from seed ${args.seed} (up to ${args.maxSteps} steps each)`,
  );
  let steps = 0;
  let faults = 0;
  let passes = 0;
  const found: Found[] = [];
  for (let i = 0; i < args.runs; i++) {
    const seed = args.seed + i;
    const result = await exploreOne(seed, {
      maxSteps: args.maxSteps,
      shrinkRuns: args.shrinkRuns,
      dir: FOUND_DIR,
    });
    steps += result.steps;
    faults += result.faults;
    passes += result.passes;
    if (result.found) {
      found.push(result.found);
      console.log(
        `seed ${seed}: FAILED, ${result.found.original} → ${result.found.steps} steps: ${result.found.signature}\n  ${result.found.file}`,
      );
    } else if ((i + 1) % 50 === 0) {
      console.log(`  ${i + 1} runs, ${found.length} failed`);
    }
  }
  const secs = ((performance.now() - started) / 1000).toFixed(1);
  console.log(
    `\n${args.runs} runs, ${steps} steps, ${found.length} failed, ${secs} s (seeds ${args.seed}–${args.seed + args.runs - 1})`,
  );
  console.log(
    `in the runs that passed: ${passes} uploader passes, ${faults} faults fired; shrunk files in ${FOUND_DIR}`,
  );
  const distinct = new Map<string, Found[]>();
  for (const f of found) distinct.set(f.signature, [...(distinct.get(f.signature) ?? []), f]);
  for (const [sig, list] of distinct) {
    console.log(`\n${list.length}× ${sig}`);
    for (const f of list) console.log(`  ${f.file}`);
  }
  process.exit(found.length > 0 ? 1 : 0);
}

if (import.meta.main) await main();
