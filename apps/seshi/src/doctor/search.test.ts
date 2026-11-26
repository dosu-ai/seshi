/** `seshi doctor --config`'s search checks and the search job's backlog, over a LanceDB index
 * stubbed to a given state: what an operator sees when the scrub has failed. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, serverConfigSchema } from "@seshi/config";
import { BUILTIN_FORMATS, FormatRegistry } from "@seshi/formats";
import { buildInstance, type Instance, SEARCH_JOB } from "@seshi/instance";
import { type IndexState, type IndexStore, provideLance } from "@seshi/search";
import { FsStore } from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { searchServerChecks } from "./search";

const NOW = new Date("2026-11-14T12:00:00.000Z");

describe("the search checks and backlog, with LanceDB", () => {
  let dir: string;
  let instance: Instance | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seshi-doctor-search-"));
  });
  afterEach(async () => {
    await instance?.close();
    instance = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  async function worker(state: IndexState) {
    provideLance(
      () => async () =>
        ({
          location: () => join(dir, "index"),
          state: async () => state,
          close: async () => {},
        }) as unknown as IndexStore,
    );
    const toml = `[store]\nurl = "file://${join(dir, "bucket")}"\n[search]\nbackend = "lance"\n`;
    const { config } = loadConfig(serverConfigSchema, {
      file: "seshi.toml",
      env: {},
      fs: { readFile: () => toml, mode: () => 0o100600 },
    });
    instance = await buildInstance(config, {
      formats: new FormatRegistry([...BUILTIN_FORMATS]),
      env: {},
      id: "t",
      roles: ["worker"],
    });
    const job = instance.jobs.list().find((j) => j.name === SEARCH_JOB);
    const checks = await searchServerChecks(instance, config, {
      env: {},
      now: NOW,
      probeStore: () => new FsStore(join(dir, "probe")),
    });
    return { checks, backlog: await job?.backlog?.() };
  }

  const live: IndexState = {
    ready_at: "2026-11-14T00:00:00.000Z",
    caught_up_at: "2026-11-14T11:59:00.000Z",
    sessions: 9,
    events: 90,
    generation: "g1",
  };

  it("warns that deleted text is still in the files while the scrub fails", async () => {
    const { checks, backlog } = await worker({
      ...live,
      scrub_failed: {
        at: "2026-11-14T10:00:00.000Z",
        error: "Resources exhausted",
        failures: 2,
        retry_at: "2026-11-14T14:00:00.000Z",
        due_since: "2026-11-14T09:30:00.000Z",
      },
    });
    expect(checks.find((c) => c.id === "search-scrub")).toEqual({
      id: "search-scrub",
      title: "Search scrub",
      status: "warn",
      summary:
        "the scrub failed 2 times in a row, last 2 h ago: text deleted, retracted or redacted since 2026-11-14T09:30:00.000Z is still in the index's files",
      detail: ["Resources exhausted", "the worker tries again at 2026-11-14T14:00:00.000Z"],
      hint: 'seshi search --scrub retries it on the worker\'s next pass; see "Deleted text" in docs/search.md',
    });
    expect(backlog).toMatchObject({ scrub_failures: 2 });
  });

  it("says nothing of the scrub while it works", async () => {
    const { checks, backlog } = await worker(live);
    expect(checks.map((c) => [c.id, c.status])).toEqual([
      ["search", "ok"],
      ["search-write", "ok"],
      ["search-fresh", "ok"],
    ]);
    expect(backlog).toMatchObject({ scrub_failures: 0 });
  });
});
