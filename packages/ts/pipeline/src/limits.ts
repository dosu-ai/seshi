/** Size caps on what one upload may become. Past them the session is refused with a 422, which
 * is final: the same bytes cannot succeed on a retry. Config's `[limits]` (F1) sets them; these
 * are the defaults, today's values. The names match the config's. */

export interface Limits {
  /** Records in one trace. */
  max_records: number;
  /** JSON bytes of the records array. */
  max_records_bytes: number;
  /** Gzipped bytes of one raw part (one upload). */
  max_upload_bytes: number;
}

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  max_records: 50_000,
  max_records_bytes: 32 * 1024 * 1024,
  max_upload_bytes: 64 * 1024 * 1024,
});
