/** The `otlp-genai` format (F4.6): spans that follow the OpenTelemetry GenAI conventions, from
 * any producer, refined by vendor mappers (the Claude Platform integration adds `anthropic.*`).
 * It takes span sets (the OTLP receiver, X4.2) through `spans`, and also reads a whole OTLP/JSON
 * export as one session (`seshi normalize trace.json`, an S3 object), assembled the same way. */

import type {
  FormatAdapter,
  NormalizedRecord,
  ReceivedSpan,
  SpanAdapter,
  SpanPart,
  SpanResource,
} from "@seshi/model";
import { assembleSpanParts } from "./assemble";
import {
  genAiHasContent,
  genAiPart,
  genAiSessionKey,
  type SpanAttributeMapper,
  viewOf,
} from "./genai";
import { readExportRequest } from "./request";

/** The format name OTLP spans are filed under: archive ids derive from it. */
export const OTLP_GENAI = "otlp-genai";

export interface SpanFormatOptions {
  /** The format's name; `otlp-genai` by default. */
  name?: string;
  /** Vendor refinements, applied in order after the conventions. */
  mappers?: readonly SpanAttributeMapper[];
}

/** The span adapter of a GenAI-conventions format with `mappers`. */
export function genAiSpanAdapter(mappers: readonly SpanAttributeMapper[] = []): SpanAdapter {
  return {
    sessionKey: (span, resource) => genAiSessionKey(span, resource, mappers),
    hasContent(span, resource) {
      const view = viewOf(span, resource);
      return genAiHasContent(view) || mappers.some((m) => m.hasContent?.(view) === true);
    },
    claims(span, resource) {
      const view = viewOf(span, resource);
      let merged: ReturnType<NonNullable<SpanAttributeMapper["claims"]>>;
      for (const mapper of mappers) {
        const claims = mapper.claims?.(view);
        if (!claims) continue;
        merged = {
          ...merged,
          ...claims,
          ...(merged?.account_ids || claims.account_ids
            ? { account_ids: { ...merged?.account_ids, ...claims.account_ids } }
            : {}),
        };
      }
      return merged;
    },
    normalize: (span, resource) => genAiPart(span, resource, mappers),
    assemble: (parts, session) => assembleSpanParts(parts, session),
  };
}

/** Normalize every span of a document's groups, skipping spans that cannot be read. */
function partsOf(
  adapter: SpanAdapter,
  groups: readonly { resource: SpanResource; spans: readonly ReceivedSpan[] }[],
): SpanPart[] {
  const parts: SpanPart[] = [];
  for (const group of groups) {
    for (const span of group.spans) {
      try {
        parts.push(adapter.normalize(span, group.resource));
      } catch {
        // A span without a start time cannot be placed; the rest of the session still reads.
      }
    }
  }
  return parts;
}

/** The `otlp-genai` format adapter (or one named otherwise, with other mappers). */
export function otlpGenAiFormat(options: SpanFormatOptions = {}): FormatAdapter {
  const source = options.name ?? OTLP_GENAI;
  const spans = genAiSpanAdapter(options.mappers);
  return {
    source,
    // An export is one JSON document: always whole.
    chunkable: false,
    detect: { document: (head) => head.has("resourceSpans") || head.has("resource_spans") },
    spans,
    normalize(transcript: string): NormalizedRecord[] {
      let value: unknown;
      try {
        value = JSON.parse(transcript);
      } catch {
        throw Object.assign(new Error("an OTLP export must be one JSON document"), {
          code: "invalid_json",
        });
      }
      const { groups } = readExportRequest(value);
      // A log carries records only (the format adapter contract), so the LLM calls the span
      // path keeps are left out here, and with them the records' references to them.
      return spans.assemble(partsOf(spans, groups), { source }).records.map((record) => {
        if (!("llm_call" in record)) return record;
        const { llm_call: _call, ...rest } = record as NormalizedRecord & { llm_call?: string };
        return rest as NormalizedRecord;
      });
    },
  };
}
