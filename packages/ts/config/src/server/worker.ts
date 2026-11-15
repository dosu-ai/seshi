/** `[worker]`: the worker role's jobs (X7). */

import * as z from "zod";
import { duration } from "../units";

export const workerSection = z
  .strictObject({
    heartbeat_interval: duration()
      .prefault("1m")
      .describe("How often the worker writes worker/heartbeat.json (X7.5)."),
  })
  .prefault({})
  .describe("Background jobs (X7).");

export type WorkerSection = z.output<typeof workerSection>;
