/** The Docker kit (deploy/docker/) against the config schema: its .env.example names only
 * settings and boots unedited, its own variables never look like settings (the server refuses
 * an unknown SESHI_* name, and the container reads the same .env), and its defaults stay
 * hardened and pinned. scripts/docker-kit-smoke.sh boots it for real. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { authSettings } from "@seshi/auth";
import { isSettingName, loadConfig, serverConfigSchema, shapeOf } from "@seshi/config";
import { describe, expect, it } from "vitest";

const kit = join(import.meta.dirname, "..", "..", "deploy", "docker");
const read = (name: string) => readFileSync(join(kit, name), "utf8");
const COMPOSE_FILES = ["compose.yaml", "compose.bucket.yaml", "compose.tls.yaml"];

type Service = {
  image?: string;
  build?: unknown;
  read_only?: boolean;
  cap_drop?: string[];
  security_opt?: string[];
  volumes?: string[];
  environment?: Record<string, string>;
};
type Compose = { services: Record<string, Service> };
const parse = (name: string) => Bun.YAML.parse(read(name)) as Compose;

const envLines = read(".env.example").split("\n");
const settings = envLines
  .map((line) => /^(#\s*)?(SESHI_[A-Z0-9_]+)=(\S*)/.exec(line))
  .filter((match) => match !== null);
const kitNames = envLines
  .map((line) => /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
  .filter((name): name is string => name !== undefined && !name.startsWith("SESHI_"));
const setEnv = Object.fromEntries(
  settings.filter((m) => m[1] === undefined).map((m) => [m[2], m[3]]),
);

describe("deploy/docker/.env.example", () => {
  it("names only settings, set or commented out", () => {
    const shape = shapeOf(serverConfigSchema);
    expect(settings.length).toBeGreaterThan(5);
    expect(
      settings.map((m) => m[2]).filter((name) => !isSettingName(shape, name as string)),
    ).toEqual([]);
  });

  it("boots unedited: a file store on the volume, and no placeholder the server refuses", () => {
    const { config } = loadConfig(serverConfigSchema, { env: setEnv });
    expect(config.store.url).toBe("file:///data");
    expect(() => authSettings(config)).not.toThrow();
  });

  it("documents every variable the compose files read, and only those", () => {
    const used = new Set<string>();
    for (const file of COMPOSE_FILES) {
      for (const m of read(file).matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)) used.add(m[1] as string);
    }
    // The kit's names never start with SESHI_: the container would refuse them.
    expect([...used].filter((name) => name.startsWith("SESHI_"))).toEqual([]);
    expect([...used].filter((name) => !kitNames.includes(name))).toEqual([]);
    expect(kitNames.filter((name) => !name.startsWith("COMPOSE_") && !used.has(name))).toEqual([]);
  });

  it("keeps a file:// store on a volume compose.yaml mounts", () => {
    const path = new URL(setEnv.SESHI_STORE__URL as string).pathname;
    const mounts = (parse("compose.yaml").services.seshi?.volumes ?? []).map(
      (v) => v.split(":")[1] as string,
    );
    expect(mounts.some((m) => path === m || path.startsWith(`${m}/`))).toBe(true);
  });
});

describe("deploy/docker compose files", () => {
  it("set only settings in the seshi service's environment", () => {
    const shape = shapeOf(serverConfigSchema);
    for (const file of COMPOSE_FILES) {
      const env = Object.keys(parse(file).services.seshi?.environment ?? {});
      expect(
        env.filter((name) => !isSettingName(shape, name)),
        file,
      ).toEqual([]);
    }
  });

  it("run the published image, pinned to one release, with a hardened default", () => {
    const seshi = parse("compose.yaml").services.seshi as Service;
    expect(seshi.build).toBeUndefined();
    expect(seshi.image).toMatch(
      /^\$\{IMAGE_REPOSITORY:-ghcr\.io\/dosu-ai\/seshi\}:\$\{IMAGE_TAG:-\d+\.\d+\.\d+\}$/,
    );
    expect(seshi.read_only).toBe(true);
    expect(seshi.cap_drop).toContain("ALL");
    expect(seshi.security_opt).toContain("no-new-privileges:true");
  });

  it("publish no seshi port beside Caddy, so plain HTTP cannot bypass it", () => {
    expect(parse("compose.tls.yaml").services.seshi).toEqual({ ports: [] });
    expect(read("compose.tls.yaml")).toContain("ports: !reset []");
  });

  it("pin every third-party image by digest", () => {
    for (const file of COMPOSE_FILES) {
      for (const [name, service] of Object.entries(parse(file).services)) {
        if (name === "seshi" || service.image === undefined) continue;
        expect(service.image, `${file}: ${name}`).toMatch(/:[\w.-]+@sha256:[0-9a-f]{64}$/);
      }
    }
  });
});
