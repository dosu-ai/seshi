/** The Docker Sandboxes kit (deploy/sandbox/) read as files: the descriptor installs this
 * repository's version, its token goes only where its network rule lets it, its hooks run a
 * helper the image carries and see the variables they read, it never names a `SESHI_*`
 * variable seshi would refuse, and its base image is pinned. The example environment files
 * hold no secret. scripts/sandbox-kit-smoke.sh builds the kit and runs it for real. */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cliConfigSchema, isSettingName, shapeOf } from "@seshi/config";
import { NOT_SETTINGS_ENV } from "@seshi/config/paths";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const SANDBOX = join(ROOT, "deploy", "sandbox");
const KIT = join(SANDBOX, "seshi-sandbox-kit");
const read = (path: string) => readFileSync(path, "utf8");

type Hook = { command: string | string[]; user?: string; env?: string[]; background?: boolean };
type Capability = { type: string; optional?: boolean; config: Record<string, unknown> };
type Descriptor = {
  schemaVersion: string;
  kind: string;
  args: Record<string, { default?: string; pattern?: string; buildArg?: string }>;
  provides: string[];
  integrates: string[];
  capabilities: Capability[];
};

const descriptorText = read(join(KIT, "seshi-sandbox-kit.yaml"));
const descriptor = Bun.YAML.parse(descriptorText) as Descriptor;
const dockerfile = read(join(KIT, "seshi-sandbox-kit.dockerfile"));
const helper = read(join(KIT, "seshi-sandbox"));
const demo = read(join(SANDBOX, "demo.sh"));
const capability = (type: string) => {
  const found = descriptor.capabilities.filter((c) => c.type === type);
  expect(found, type).toHaveLength(1);
  return found[0] as Capability;
};
const network = capability("com.docker.sandbox/network-policy@1").config as {
  runtime: { allow: string[] };
};
const credential = capability("com.docker.sandbox/credential@1");
const lifecycle = capability("com.docker.sandbox/lifecycle@1").config as {
  install: Hook[];
  startup: Hook[];
};
const examples = ["claude.sbxenv.yaml", "codex.sbxenv.yaml"].map((name) => ({
  name,
  text: read(join(SANDBOX, "examples", name)),
}));

describe("deploy/sandbox/seshi-sandbox-kit", () => {
  it("is a v3 mixin the kit frontend builds", () => {
    expect(descriptorText.split("\n")[0]).toBe("# syntax=docker/sandbox-kit:3");
    expect(descriptor.schemaVersion).toBe("3");
    expect(descriptor.kind).toBe("mixin");
    // Orders its hooks after the stock agents', whose settings it adds to.
    expect(descriptor.integrates).toEqual(["claude", "codex"]);
  });

  it("installs this repository's version, which a release rewrites", () => {
    const model = JSON.parse(read(join(ROOT, "packages/ts/model/package.json")));
    expect(descriptor.args.version?.default).toBe(model.version);
    expect(descriptor.args.version?.buildArg).toBe("SESHI_VERSION");
    expect(dockerfile).toContain("ARG SESHI_VERSION");
    expect(descriptor.provides).toEqual(["seshi@${{ kit.args.version }}"]);
  });

  it("declares every arg it references", () => {
    for (const [, name] of descriptorText.matchAll(/\$\{\{ kit\.args\.(\w+) \}\}/g)) {
      expect(descriptor.args, name).toHaveProperty(name as string);
    }
  });

  it("sends the token only to the server its network rule allows", () => {
    expect(credential.optional).toBe(true);
    const config = credential.config as {
      service: string;
      phase: string;
      apiKey: { name: string; proxyManaged: boolean; inject: { domain: string; format: string }[] };
    };
    expect(config.service).toBe("seshi");
    expect(config.phase).toBe("runtime");
    expect(config.apiKey.proxyManaged).toBe(true);
    expect(config.apiKey.inject.length).toBeGreaterThan(0);
    for (const rule of config.apiKey.inject) {
      expect(network.runtime.allow).toContain(rule.domain);
      expect(rule.format).toBe("Bearer %s");
    }
    expect(network.runtime.allow).toEqual(["${{ kit.args.host }}"]);
    // The startup hook signs in with it, so it must see the variable.
    expect(lifecycle.startup[0]?.env).toContain(config.apiKey.name);
  });

  it("runs a helper the image carries, as the agent", () => {
    const hooks = [...lifecycle.install, ...lifecycle.startup];
    expect(hooks.length).toBe(2);
    for (const hook of hooks) {
      expect(hook.user).toBe("agent");
      expect([hook.command].flat()[0]).toBe("/usr/local/bin/seshi-sandbox");
    }
    expect([lifecycle.install[0]?.command].flat()[1]).toBe("setup");
    expect([lifecycle.startup[0]?.command].flat()[1]).toBe("start");
    // A boot must not wait on a server that may be down.
    expect(lifecycle.startup[0]?.background).toBe(true);
    expect(dockerfile).toContain("COPY seshi-sandbox /out/usr/local/bin/seshi-sandbox");
    expect(statSync(join(KIT, "seshi-sandbox")).mode & 0o111).not.toBe(0);
    expect(helper.split("\n")[0]).toBe("#!/bin/sh");
  });

  it("names no SESHI_* variable that seshi would refuse", () => {
    const shape = shapeOf(cliConfigSchema);
    const files = [descriptorText, dockerfile, helper, demo, ...examples.map((e) => e.text)];
    // A build arg reaches the Dockerfile only, never seshi's environment.
    const buildArgs = new Set(Object.values(descriptor.args).map((arg) => arg.buildArg));
    const names = new Set(
      files
        .flatMap((text) => text.match(/\bSESHI_[A-Z0-9_]+/g) ?? [])
        .filter((name) => !buildArgs.has(name)),
    );
    expect(names.size).toBeGreaterThan(0);
    for (const name of names) {
      expect(
        NOT_SETTINGS_ENV.includes(name) || isSettingName(shape, name),
        `${name} is neither a CLI setting nor one seshi passes over`,
      ).toBe(true);
    }
  });

  it("checks the release it downloads and pins its base image", () => {
    expect(dockerfile).toContain("sha256sum -c -");
    for (const from of dockerfile.match(/^FROM .*$/gm) ?? []) {
      if (/^FROM scratch$/.test(from)) continue;
      expect(from).toMatch(/@sha256:[0-9a-f]{64}/);
    }
  });
});

describe("deploy/sandbox/demo.sh", () => {
  it("is an executable sh script that drives the example environment's sandbox", () => {
    expect(demo.split("\n")[0]).toBe("#!/bin/sh");
    expect(statSync(join(SANDBOX, "demo.sh")).mode & 0o111).not.toBe(0);
    const env = Bun.YAML.parse(examples[0]?.text ?? "") as { name: string };
    expect(demo).toContain(`BOX=${env.name}`);
    expect(demo).toContain('ENV_FILE="$KIT_DIR/examples/claude.sbxenv.yaml"');
  });
});

describe("deploy/sandbox/examples", () => {
  it.each(examples)("$name uses the kit beside it and holds no secret", ({ text }) => {
    const env = Bun.YAML.parse(text) as {
      schemaVersion: string;
      kits: { source: string; args?: Record<string, string> }[];
      secrets?: Record<string, Record<string, unknown>>;
      lifecycle?: { preRemove?: { command: string }[] };
    };
    expect(env.schemaVersion).toBe("1");
    expect(env.kits.map((k) => k.source)).toContain("../seshi-sandbox-kit");
    for (const name of Object.keys(env.kits[0]?.args ?? {})) {
      expect(descriptor.args, name).toHaveProperty(name);
    }
    for (const source of Object.values(env.secrets ?? {})) {
      expect(source).not.toHaveProperty("value");
    }
    // Sessions the uploader has not sent go with the sandbox, so removal flushes first.
    expect(env.lifecycle?.preRemove?.map((c) => c.command).join("\n")).toContain(
      "seshi-sandbox flush",
    );
  });
});
