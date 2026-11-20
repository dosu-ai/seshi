import type { FormatAdapter } from "@seshi/kit";
import { CURSOR_CLOUD_API, isRunLine, normalizeCursorCloud } from "./format";

export * from "./api";
export * from "./connector";
export * from "./format";

/** `cursor-cloud-api` logs (F7): one line per run, each line normalizing on its own. */
export const CURSOR_CLOUD_FORMAT: FormatAdapter = {
  source: CURSOR_CLOUD_API,
  chunkable: true,
  version: "1",
  detect: { record: isRunLine },
  normalize: (transcript, chunk) =>
    normalizeCursorCloud(transcript, { partial: chunk !== undefined }),
};
