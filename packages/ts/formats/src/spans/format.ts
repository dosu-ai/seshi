import type {
  FormatAdapter,
  NormalizedTranscript,
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

export const OTLP_GENAI = "otlp-genai";

export interface SpanFormatOptions {
  name?: string;
  mappers?: readonly SpanAttributeMapper[];
}

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

function partsOf(
  adapter: SpanAdapter,
  groups: readonly { resource: SpanResource; spans: readonly ReceivedSpan[] }[],
): SpanPart[] {
  const parts: SpanPart[] = [];
  for (const group of groups) {
    for (const span of group.spans) {
      try {
        parts.push(adapter.normalize(span, group.resource));
      } catch {}
    }
  }
  return parts;
}

export function otlpGenAiFormat(options: SpanFormatOptions = {}): FormatAdapter {
  const source = options.name ?? OTLP_GENAI;
  const spans = genAiSpanAdapter(options.mappers);
  return {
    source,
    chunkable: false,
    detect: { document: (head) => head.has("resourceSpans") || head.has("resource_spans") },
    spans,
    normalize(transcript: string): NormalizedTranscript {
      let value: unknown;
      try {
        value = JSON.parse(transcript);
      } catch {
        throw Object.assign(new Error("an OTLP export must be one JSON document"), {
          code: "invalid_json",
        });
      }
      const { groups } = readExportRequest(value);
      const { records, llm_calls } = spans.assemble(partsOf(spans, groups), { source });
      return llm_calls.length > 0 ? { records, llm_calls } : { records };
    },
  };
}
