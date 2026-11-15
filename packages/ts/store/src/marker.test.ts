import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsStore } from "./fs";
import { decodeJson, encodeJson } from "./json";
import { LAYOUT_KEY, LEGACY_LAYOUT_KEY } from "./layout";
import { ensureLayout, LayoutError, readLayout } from "./marker";
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

  it("refuses a sessiondb prefix, which holds sessionstorage/layout/1", async () => {
    await store.put(
      LEGACY_LAYOUT_KEY,
      encodeJson({
        schema: "sessionstorage/layout/1",
        created_at: "x",
        created_by: "y",
        format: "letta",
      }),
    );
    await expect(ensureLayout(store, { createdBy: "t" })).rejects.toThrow(
      /holds a sessiondb store \(sessionstorage.json, sessionstorage\/layout\/1\).*no migration \(X1.5\)/,
    );
    await expect(readLayout(store)).rejects.toBeInstanceOf(LayoutError);
    expect(await getBytes(store, LAYOUT_KEY)).toBeNull();
  });

  it("refuses a marker this version cannot read", async () => {
    await store.put(
      LAYOUT_KEY,
      encodeJson({ schema: "seshi/layout/2", trace_schema: "seshi/trace/2" }),
    );
    await expect(readLayout(store)).rejects.toThrow(/this seshi reads seshi\/layout\/1/);
    await store.put(
      LAYOUT_KEY,
      encodeJson({ schema: "seshi/layout/1", trace_schema: "seshi/trace/2", deployment_id: "d" }),
    );
    await expect(readLayout(store)).rejects.toThrow(/this seshi writes seshi\/trace\/1/);
  });

  it("reads nothing from a new prefix", async () => {
    expect(await readLayout(store)).toBeNull();
  });
});
