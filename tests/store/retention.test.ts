/** The store's record retention default is config's `[records]` default (X6.4): 30 days for
 * drops and failures alike. Crosses config and store, so it lives in tests/ (X3.6). */

import { loadConfig, serverConfigSchema } from "@seshi/config";
import { DEFAULT_RECORD_RETENTION_MS } from "@seshi/store";
import { describe, expect, it } from "vitest";

describe("record retention", () => {
  it("defaults to what [records] defaults to", () => {
    const { config } = loadConfig(serverConfigSchema, {
      env: { SESHI_STORE__URL: "file:///tmp/x" },
    });
    expect(config.records.dropped_retention).toBe(DEFAULT_RECORD_RETENTION_MS);
    expect(config.records.failed_retention).toBe(DEFAULT_RECORD_RETENTION_MS);
  });
});
