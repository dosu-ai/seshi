import { type FormatAdapter, type NormalizedRecord, validateRecords } from "@seshi/model";

export const TRAJECTORY = "trajectory" as const;

class TrajectoryInputError extends Error {
  readonly code = "invalid_input";
  constructor(message: string) {
    super(message);
    this.name = "TrajectoryInputError";
  }
}

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

export const TRAJECTORY_FORMAT: FormatAdapter = {
  source: TRAJECTORY,
  chunkable: true,
  detect: {
    record: (row) => !("type" in row) && !("message" in row) && isTrajectoryRecord(row),
  },
  normalize: (transcript, chunk) => trajectoryRecords(transcript, { partial: chunk !== undefined }),
};
