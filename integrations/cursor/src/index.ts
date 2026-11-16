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
