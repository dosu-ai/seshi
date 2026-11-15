/** Cursor (X3.11): the local agent-transcripts format and how local sessions are captured
 * (`local/`, F9). The Cloud Agents poller (`cloud/`, F7) is deferred. */

import { defineIntegration } from "@seshi/kit";
import { CURSOR_FORMAT } from "./local/adapter";
import { CURSOR_CAPTURE } from "./local/capture";

export { CURSOR_FORMAT } from "./local/adapter";
export { CURSOR_CAPTURE } from "./local/capture";

export const cursor = defineIntegration({
  name: "cursor",
  formats: [CURSOR_FORMAT],
  capture: CURSOR_CAPTURE,
});
