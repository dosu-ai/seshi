import { defineIntegration } from "@seshi/kit";
import { CURSOR_CLOUD_CONNECTOR, CURSOR_CLOUD_FORMAT } from "./cloud";
import { CURSOR_FORMAT } from "./local/adapter";
import { CURSOR_CAPTURE } from "./local/capture";

export * from "./cloud";
export { CURSOR_FORMAT } from "./local/adapter";
export { CURSOR_CAPTURE } from "./local/capture";

export const cursor = defineIntegration({
  name: "cursor",
  formats: [CURSOR_FORMAT, CURSOR_CLOUD_FORMAT],
  connectors: [CURSOR_CLOUD_CONNECTOR],
  capture: CURSOR_CAPTURE,
});
