/** Cursor (X3.11): the local agent-transcripts format (`local/`). The Cloud Agents poller
 * (`cloud/`, F7) is deferred. */

import { defineIntegration } from "@seshi/kit";
import { CURSOR_FORMAT } from "./local/adapter";

export { CURSOR_FORMAT } from "./local/adapter";

export const cursor = defineIntegration({
  name: "cursor",
  formats: [CURSOR_FORMAT],
});
