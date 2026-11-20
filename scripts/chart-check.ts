/** Checks the Helm chart (charts/seshi) without a cluster: `helm lint` and `helm template` for
 * every values file in charts/seshi/ci/, then the seshi.toml each one renders, with its drop-ins
 * and packs laid out as the pod sees them, through this checkout's own `seshi config check`.
 * Every pod spec must turn Kubernetes' service links off (a Service named seshi would otherwise
 * give the container SESHI_SERVICE_HOST, and seshi refuses an unknown SESHI_* variable). Values
 * the chart must refuse are rendered too, and must fail. With kubeconform on PATH, the rendered
 * manifests are checked against Kubernetes' schemas.
 *
 * Needs helm on PATH: bun run check:chart */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const CHART = join(ROOT, "charts/seshi");
const CI_VALUES = join(CHART, "ci");
/** Where the chart mounts its ConfigMap in the pod. */
const CONFIG_DIR = "/etc/seshi";
const RELEASE = "seshi";

/** Values the chart must refuse, each with what its error must say. */
const REFUSED: { name: string; args: string[]; error: string }[] = [
  { name: "no store", args: [], error: "store.url is required" },
  {
    name: "a file store on an emptyDir",
    args: ["--set", "store.url=file:///data/store"],
    error: "persistence.enabled is false",
  },
  {
    name: "the store in config",
    args: ["--set", "store.url=s3://b/p", "--set", "config.store.url=s3://other"],
    error: "config.store",
  },
  {
    name: "a listen address in config",
    args: ["--set", "store.url=s3://b/p", "--set", "config.server.listen=:8080"],
    error: "config.server.listen",
  },
  {
    name: "roles in config",
    args: ["--set", "store.url=s3://b/p", "--set", "config.server.roles={api}"],
    error: "config.server.roles",
  },
  {
    name: "a drop-in name with a dot",
    args: ["--set", "store.url=s3://b/p", "--set-json", 'dropIns={"a.b":{}}'],
    // values.schema.json refuses it first; Helm 3 and 4 word that differently.
    error: "a.b",
  },
];

interface Manifest {
  kind?: string;
  metadata?: { name?: string };
  data?: Record<string, string>;
  spec?: Record<string, unknown> & { template?: { spec?: Record<string, unknown> } };
}

function run(cmd: string[], env?: Record<string, string>) {
  const proc = Bun.spawnSync(cmd, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function must(cmd: string[], what: string, env?: Record<string, string>): string {
  const result = run(cmd, env);
  if (result.code !== 0) {
    throw new Error(`${what} failed (exit ${result.code}):\n${result.stdout}${result.stderr}`);
  }
  return result.stdout;
}

function manifests(rendered: string): Manifest[] {
  return rendered
    .split(/^---\s*$/m)
    .map((doc) => Bun.YAML.parse(doc) as Manifest | null)
    .filter((doc): doc is Manifest => doc !== null && typeof doc === "object" && "kind" in doc);
}

function podSpec(manifest: Manifest): Record<string, unknown> | undefined {
  if (manifest.kind === "Pod") return manifest.spec;
  return manifest.spec?.template?.spec;
}

/** Writes the ConfigMap's files where the pod would see them, under `dir` instead of
 * /etc/seshi, and returns the seshi.toml path. */
function layOut(configMap: Manifest, dir: string): string {
  const files: Record<string, string> = {};
  for (const [key, value] of Object.entries(configMap.data ?? {})) {
    const dropIn = /^dropin\.(.+)$/.exec(key);
    const pack = /^pack\.(.+)$/.exec(key);
    if (key === "seshi.toml") files["seshi.toml"] = value;
    else if (dropIn) files[`seshi.d/${dropIn[1]}`] = value;
    else if (pack) files[`packs/${pack[1]}`] = value;
    else throw new Error(`ConfigMap key ${key}: the check does not know where the pod mounts it`);
  }
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content.replaceAll(`${CONFIG_DIR}/`, `${dir}/`));
  }
  return join(dir, "seshi.toml");
}

function checkValues(file: string, scratch: string): string {
  const values = join(CI_VALUES, file);
  must(["helm", "lint", CHART, "-f", values, "--strict"], `helm lint -f ${file}`);
  const rendered = must(
    ["helm", "template", RELEASE, CHART, "-f", values],
    `helm template ${file}`,
  );
  const docs = manifests(rendered);

  for (const doc of docs) {
    const spec = podSpec(doc);
    if (spec !== undefined && spec.enableServiceLinks !== false) {
      throw new Error(`${file}: ${doc.kind} ${doc.metadata?.name} leaves service links on`);
    }
  }

  const configMap = docs.find((d) => d.kind === "ConfigMap" && d.data?.["seshi.toml"]);
  if (configMap === undefined) throw new Error(`${file}: no ConfigMap with seshi.toml`);
  const dir = join(scratch, file.replace(/\.yaml$/, ""));
  const config = layOut(configMap, dir);
  // config check reads secrets it is pointed at; the bucket's keys come from AWS_* in the pod.
  must(
    ["bun", "run", "apps/seshi/src/main.ts", "config", "check", "--config", config],
    `seshi config check for ${file}`,
    { AWS_ACCESS_KEY_ID: "check", AWS_SECRET_ACCESS_KEY: "check" },
  );
  return rendered;
}

function checkRefused(): void {
  for (const refused of REFUSED) {
    const result = run(["helm", "template", RELEASE, CHART, ...refused.args]);
    if (result.code === 0) throw new Error(`${refused.name}: the chart rendered it`);
    if (!result.stderr.includes(refused.error)) {
      throw new Error(`${refused.name}: expected "${refused.error}" in:\n${result.stderr}`);
    }
  }
}

function kubeconform(rendered: string[]): boolean {
  if (Bun.which("kubeconform") === null) return false;
  const proc = Bun.spawnSync(["kubeconform", "-strict", "-summary", "-"], {
    stdin: new TextEncoder().encode(rendered.join("\n---\n")),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`kubeconform:\n${proc.stdout.toString()}${proc.stderr.toString()}`);
  }
  return true;
}

if (import.meta.main) {
  if (Bun.which("helm") === null) {
    console.error("chart-check: helm is not on PATH");
    process.exit(2);
  }
  const scratch = mkdtempSync(join(tmpdir(), "seshi-chart-"));
  try {
    const rendered: string[] = [];
    for (const file of readdirSync(CI_VALUES)
      .filter((f) => f.endsWith("-values.yaml"))
      .sort()) {
      rendered.push(checkValues(file, scratch));
      console.log(`ok ${file}: lint, template, seshi config check`);
    }
    checkRefused();
    console.log(`ok refused: ${REFUSED.length} value sets`);
    console.log(kubeconform(rendered) ? "ok kubeconform" : "skipped kubeconform: not on PATH");
  } catch (err) {
    console.error(`chart-check: ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
