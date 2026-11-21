import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsStore } from "./fs";
import { decodeJson, encodeJson } from "./json";
import { LAYOUT_KEY } from "./layout";
import {
  ensureLayout,
  LayoutError,
  NoLayout,
  readLayout,
  setLayout,
  versionAtLeast,
} from "./marker";
import { getBytes } from "./store";

let dir: string;
let store: FsStore;
const now = () => new Date("2026-11-14T09:00:00.000Z");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-marker-"));
  store = new FsStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ensureLayout", () => {
  it("writes the seshi marker once, recording the trace format, deployment and org", async () => {
    const marker = await ensureLayout(store, {
      createdBy: "seshi/test",
      deploymentId: "prod-eu",
      org: "acme",
      now,
    });
    expect(marker).toEqual({
      schema: "seshi/layout/1",
      trace_schema: "seshi/trace/1",
      deployment_id: "prod-eu",
      org: "acme",
      created_at: "2026-11-14T09:00:00.000Z",
      created_by: "seshi/test",
    });
    expect(decodeJson((await getBytes(store, LAYOUT_KEY)) as Uint8Array)).toEqual(marker);
    // A later writer keeps it.
    const again = await ensureLayout(store, { createdBy: "seshi/other", deploymentId: "prod-eu" });
    expect(again).toEqual(marker);
  });

  it("generates a deployment id for a new prefix when the config names none, and accepts it after", async () => {
    const marker = await ensureLayout(store, {
      createdBy: "seshi/test",
      newDeploymentId: () => "generated-1",
    });
    expect(marker.deployment_id).toBe("generated-1");
    expect(marker.org).toBeUndefined();
    expect((await ensureLayout(store, { createdBy: "x" })).deployment_id).toBe("generated-1");
  });

  it("refuses another deployment's or another org's prefix", async () => {
    await ensureLayout(store, { createdBy: "t", deploymentId: "prod", org: "acme" });
    await expect(ensureLayout(store, { createdBy: "t", deploymentId: "staging" })).rejects.toThrow(
      /belongs to deployment "prod", not "staging"/,
    );
    await expect(ensureLayout(store, { createdBy: "t", org: "globex" })).rejects.toBeInstanceOf(
      LayoutError,
    );
    await expect(ensureLayout(store, { createdBy: "t", org: "globex" })).rejects.toThrow(
      /belongs to org "acme", not "globex" \(store.org\)/,
    );
  });

  it("records the org the first time a config names one, then holds it", async () => {
    await ensureLayout(store, { createdBy: "t", deploymentId: "prod" });
    const claimed = await ensureLayout(store, { createdBy: "t", org: "acme" });
    expect(claimed.org).toBe("acme");
    expect((await readLayout(store))?.org).toBe("acme");
    await expect(ensureLayout(store, { createdBy: "t", org: "globex" })).rejects.toThrow(/org/);
  });

  it("converges when two writers create the marker at once", async () => {
    const markers = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        ensureLayout(store, { createdBy: `w${i}`, newDeploymentId: () => `id-${i}` }),
      ),
    );
    const ids = new Set(markers.map((m) => m.deployment_id));
    expect(ids.size).toBe(1);
    expect((await readLayout(store))?.deployment_id).toBe([...ids][0]);
  });

  it("refuses a marker this version cannot read", async () => {
    await store.put(
      LAYOUT_KEY,
      encodeJson({ schema: "seshi/layout/3", trace_schema: "seshi/trace/2" }),
    );
    await expect(readLayout(store)).rejects.toThrow(
      /this seshi reads seshi\/layout\/1 and seshi\/layout\/2/,
    );
    await store.put(
      LAYOUT_KEY,
      encodeJson({ schema: "seshi/layout/1", trace_schema: "seshi/trace/2", deployment_id: "d" }),
    );
    await expect(readLayout(store)).rejects.toThrow(/this seshi writes seshi\/trace\/1/);
  });
});

describe("layout schema 2 (F11.7)", () => {
  it("writes schema 1 for a new prefix, and schema 2 when a mode is given", async () => {
    expect((await ensureLayout(store, { createdBy: "seshi/1" })).schema).toBe("seshi/layout/1");
    const other = new FsStore(mkdtempSync(join(tmpdir(), "marker2-")));
    const marker = await ensureLayout(other, {
      createdBy: "seshi/1",
      mode: "serverless",
      now: () => new Date("2026-11-16T00:00:00Z"),
    });
    expect(marker).toMatchObject({
      schema: "seshi/layout/2",
      mode: "serverless",
      mode_changed_at: "2026-11-16T00:00:00.000Z",
      mode_changed_by: "seshi/1",
    });
    expect(await readLayout(other)).toEqual(marker);
  });

  it("refuses to create a marker when the caller may not (NoLayout)", async () => {
    await expect(ensureLayout(store, { createdBy: "t", create: false })).rejects.toBeInstanceOf(
      NoLayout,
    );
    expect(await getBytes(store, LAYOUT_KEY)).toBeNull();
  });

  it("upgrades schema 1 to 2 when a field is set, and clears min_version", async () => {
    const first = await ensureLayout(store, { createdBy: "seshi/1", deploymentId: "d" });
    const set = await setLayout(
      store,
      { mode: "serverless", min_version: "0.10.0" },
      { by: "seshi/2", now: () => new Date("2026-11-16T00:00:00Z") },
    );
    expect(set).toEqual({
      ...first,
      schema: "seshi/layout/2",
      mode: "serverless",
      min_version: "0.10.0",
      mode_changed_at: "2026-11-16T00:00:00.000Z",
      mode_changed_by: "seshi/2",
    });
    const cleared = await setLayout(store, { min_version: null }, { by: "seshi/2" });
    expect(cleared.min_version).toBeUndefined();
    expect(cleared.mode).toBe("serverless");
    const same = await setLayout(store, { mode: "serverless" }, { by: "seshi/3" });
    expect(same.mode_changed_by).toBe("seshi/2");
  });

  it("refuses setLayout without a marker, and a version that is not one", async () => {
    await expect(setLayout(store, { mode: "server" }, { by: "t" })).rejects.toBeInstanceOf(
      NoLayout,
    );
    await ensureLayout(store, { createdBy: "t" });
    await expect(setLayout(store, { min_version: "ten" }, { by: "t" })).rejects.toThrow(
      /not a version/,
    );
  });

  it("compares versions by number", () => {
    expect(versionAtLeast("0.10.0", "0.9.9")).toBe(true);
    expect(versionAtLeast("0.9.0", "0.10.0")).toBe(false);
    expect(versionAtLeast("1.0.0-rc.1", "1.0.0")).toBe(true);
    expect(versionAtLeast("1.2.3", "1.2.3")).toBe(true);
  });
});
