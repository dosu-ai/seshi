import {
  canonicalJson,
  type NormalizedRecord,
  prefixSha256,
  type ShippedPrefix,
} from "@seshi/model";

export { canonicalJson, prefixSha256, type ShippedPrefix };

interface Continuation {
  from_record: number;
  prefix_sha256: string;
}

export interface ShipPlan {
  records: NormalizedRecord[];
  /** Set when `records` is the meta record plus a tail. */
  continuation?: Continuation;
  /** The records past what already shipped (all of them for a full ship), meta excluded. */
  fresh: NormalizedRecord[];
}

/** The prefix a fork or clone copied from the session it was made from: its meta record and the
 * leading records the parent's normalized records hold too (past the parent's own meta record).
 * That history is the parent's to ship; undefined when nothing is shared or the parent could not
 * be read. */
export function copiedPrefix(
  records: readonly NormalizedRecord[],
  parentRecords: readonly NormalizedRecord[] | null,
): ShippedPrefix | undefined {
  if (!parentRecords) return undefined;
  const skipMeta = (list: readonly NormalizedRecord[]) => (list[0]?.role === "meta" ? 1 : 0);
  const start = skipMeta(records);
  const parentStart = skipMeta(parentRecords);
  let shared = 0;
  while (
    start + shared < records.length &&
    parentStart + shared < parentRecords.length &&
    canonicalJson(records[start + shared]) === canonicalJson(parentRecords[parentStart + shared])
  ) {
    shared += 1;
  }
  if (shared === 0) return undefined;
  return { records: start + shared, prefix_sha256: prefixSha256(records, start + shared) };
}

export function planShipment(
  records: NormalizedRecord[],
  shipped: ShippedPrefix | undefined,
): ShipPlan {
  const continues =
    shipped !== undefined &&
    shipped.records > 0 &&
    shipped.records <= records.length &&
    prefixSha256(records, shipped.records) === shipped.prefix_sha256;
  if (!continues) return { records, fresh: records };
  const tail = records.slice(shipped.records);
  const meta = records[0]?.role === "meta" ? [records[0]] : [];
  return {
    records: [...meta, ...tail],
    continuation: { from_record: shipped.records, prefix_sha256: shipped.prefix_sha256 },
    fresh: tail,
  };
}
