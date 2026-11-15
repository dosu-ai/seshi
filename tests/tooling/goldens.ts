/** The part of a `Trace` the goldens pin: everything `parseTrace` derives from the
 * records, and the LLM calls they name when the transcript records them. Shared by `tooling/write-goldens.ts`, which writes it, and `goldens.test.ts`, which
 * checks it. */

import type { Trace } from "@seshi/model";

export type Expected =
  | { rejected: true; error: string }
  | ({ rejected: false } & Pick<
      Trace,
      "content_hash" | "source" | "started_at" | "ended_at" | "metadata" | "events" | "llm_calls"
    >);

export function expectedOf(trace: Trace): Expected & { rejected: false } {
  const { content_hash, source, started_at, ended_at, metadata, events, llm_calls } = trace;
  return {
    rejected: false,
    content_hash,
    source,
    started_at,
    ended_at,
    metadata,
    events,
    ...(llm_calls ? { llm_calls } : {}),
  };
}

/** The LLM calls a golden's records name, kept beside them as `<name>.llm_calls.json` for a
 * transcript that records them. */
export const llmCallsFile = (name: string) => `${name}.llm_calls.json`;
