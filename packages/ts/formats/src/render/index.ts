import type { RenderedTraces, RenderFormat, Trace } from "@seshi/model";
import { toAtif } from "./atif";
import { toLetta } from "./letta";
import { toOtlp } from "./otlp";

export { toAtif } from "./atif";
export { lettaRecord, lettaRecords, toLetta } from "./letta";
export { fromOtlp, isOtlpTrace, otlpMeta, otlpResource, toOtlp } from "./otlp";

export function renderTrace<F extends RenderFormat>(trace: Trace, format: F): RenderedTraces[F] {
  const rendered: { [K in RenderFormat]: () => RenderedTraces[K] } = {
    seshi: () => trace,
    letta: () => toLetta(trace),
    otlp: () => toOtlp(trace),
    atif: () => toAtif(trace),
  };
  return rendered[format]();
}
