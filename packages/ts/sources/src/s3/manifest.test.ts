import { describe, expect, it } from "vitest";
import { emptyManifest, readManifest, rewindManifest } from "./manifest";

function logger() {
  const warnings: string[] = [];
  return { warnings, log: { info() {}, warn: (m: string) => warnings.push(m), error() {} } };
}

describe("the S3 manifest (F6.2)", () => {
  it("starts empty before the first run", () => {
    const { log, warnings } = logger();
    expect(readManifest(null, log)).toEqual(emptyManifest());
    expect(warnings).toEqual([]);
  });

  it("reads its own cursor and drops entries it cannot use", () => {
    const { log } = logger();
    const manifest = readManifest(
      {
        v: 1,
        after: "p/b",
        watch_from: "p/a",
        hold: "",
        listed_at: "2026-11-14T00:00:00.000Z",
        objects: {
          "p/a": { etag: "e1", size: 10, offset: 10, tail: "t", format: "x", session: "a" },
          "p/bad": { etag: "e2", size: "10", offset: 0 },
          "p/neg": { etag: "e3", size: 1, offset: -1 },
        },
        stray: true,
      },
      log,
    );
    expect(manifest).toEqual({
      v: 1,
      after: "p/b",
      watch_from: "p/a",
      hold: "",
      listed_at: "2026-11-14T00:00:00.000Z",
      objects: {
        "p/a": { etag: "e1", size: 10, offset: 10, tail: "t", format: "x", session: "a" },
      },
    });
  });

  it("starts over, with a warning, from a cursor it does not know", () => {
    const { log, warnings } = logger();
    expect(readManifest({ v: 99, objects: {} }, log)).toEqual(emptyManifest());
    expect(readManifest({ window: "2026" }, log)).toEqual(emptyManifest());
    expect(warnings).toHaveLength(2);
  });

  it("rewinds by forgetting objects changed since then, keeping deleted sessions", () => {
    const since = new Date("2026-11-10T00:00:00.000Z");
    const rewound = rewindManifest(
      {
        v: 1,
        after: "k",
        watch_from: "b",
        listed_at: "2026-11-14T00:00:00.000Z",
        objects: {
          old: { etag: "1", size: 1, offset: 1, modified: "2026-11-01T00:00:00.000Z" },
          new: { etag: "2", size: 1, offset: 1, modified: "2026-11-12T00:00:00.000Z" },
          edge: { etag: "3", size: 1, offset: 1, modified: since.toISOString() },
          unknown: { etag: "4", size: 1, offset: 1 },
          gone: {
            etag: "5",
            size: 1,
            offset: 1,
            modified: "2026-11-12T00:00:00.000Z",
            failed: "redacted",
          },
        },
      },
      since,
    );
    expect(Object.keys(rewound.objects).sort()).toEqual(["gone", "old"]);
    expect(rewound.after).toBeUndefined();
    expect(rewound.watch_from).toBeUndefined();
    expect(rewound.listed_at).toBe("2026-11-14T00:00:00.000Z");
    // A new reading: whole objects read again carry new idempotency keys (X4.9).
    expect(rewound.epoch).toBe(1);
    expect(rewindManifest({ ...rewound, epoch: 41 }, since).epoch).toBe(42);
    expect(readManifest({ v: 1, objects: {}, epoch: 7 }, logger().log).epoch).toBe(7);
  });
});
