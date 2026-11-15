/** A transcript that is already Letta trajectory-v1: one record per line, as `validateRecords`
 * accepts them. Nothing to normalize, so the records pass through as they are, checked; a chunk's
 * records lose any meta record, as a Letta chunk's do. Redaction is the caller's, as for every
 * other source. */

import { type FormatAdapter, type NormalizedRecord, validateRecords } from "@seshi/model";

/** The `agent` these sessions are filed under. */
export const TRAJECTORY = "trajectory" as const;

/** Thrown for a line that is not JSON or a record that is not trajectory-v1. */
class TrajectoryInputError extends Error {
  readonly code = "invalid_input";
  constructor(message: string) {
    super(message);
    this.name = "TrajectoryInputError";
  }
}

/** The records of a trajectory-v1 JSONL transcript, or of a chunk of one (`partial`). */
export function trajectoryRecords(
  transcript: string,
  options: { partial: boolean },
): NormalizedRecord[] {
  const rows: unknown[] = [];
  transcript.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    try {
      rows.push(JSON.parse(line));
    } catch {
      throw new TrajectoryInputError(`line ${index + 1} is not JSON`);
    }
  });
  let records: NormalizedRecord[];
  try {
    records = validateRecords(rows);
  } catch (err) {
    throw new TrajectoryInputError(err instanceof Error ? err.message : String(err));
  }
  return options.partial ? records.filter((record) => record.role !== "meta") : records;
}

function isTrajectoryRecord(row: Record<string, unknown>): boolean {
  try {
    validateRecords([row]);
    return true;
  } catch {
    return false;
  }
}

/** Records already in trajectory-v1, one per line: built in, since every integration's output
 * is this format. */
export const TRAJECTORY_FORMAT: FormatAdapter = {
  source: TRAJECTORY,
  chunkable: true,
  // A trajectory-v1 record: `role` and flat fields, nothing a native log wraps it in.
  detect: {
    record: (row) => !("type" in row) && !("message" in row) && isTrajectoryRecord(row),
  },
  normalize: (transcript, chunk) => trajectoryRecords(transcript, { partial: chunk !== undefined }),
};
