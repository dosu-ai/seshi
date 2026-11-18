/** Content an agent or a plugin adds to a user turn that the member never typed: an OpenCode
 * part with `synthetic: true`, a pi extension's `custom_message`. The model sees it, so seshi
 * keeps it, labelled `synthetic` on its record, unless the integrator that added it asks seshi to
 * leave it out.
 *
 * The ask is `session_capture.omit = true` in the metadata the agent keeps beside the content
 * (an OpenCode part's `metadata`, a pi entry's `details`). It is a public contract once released:
 * docs/formats.md and docs/capture.md name it. It is honoured only on user-side input and
 * injected context, never on what the model wrote or a tool returned, so a model cannot hide its
 * own output and a tool result is never lost. */

/** The key, in an agent's per-item metadata, that holds what an integrator asks of Session
 * Capture. Named after the agent-facing `session-capture` command. */
export const SESSION_CAPTURE_KEY = "session_capture";

/** What a flagged item's text becomes before the library reads it. The library skips an empty
 * user message, so the item needs some text to keep its record; the record's content is then
 * emptied (`RecordLabels.omitted`), so this is never stored either. */
export const OMITTED_TEXT = "[omitted]";

/** Labels for the records one source item (an OpenCode part, a pi entry) normalizes to: what the
 * library has no field for. `omitted` counts the items left out at that record, whose text it
 * no longer holds. */
export interface RecordLabels {
  synthetic?: true;
  omitted?: number;
}

/** A transcript ready for the library, with labels for the records its items normalize to, keyed
 * by the item's id in the source (the library's `stable_source_record_id`: an OpenCode part id,
 * a pi entry id). Produced in one pass, so what is left out and what is labelled are decided in
 * one place. */
export interface Injected {
  transcript: string;
  labels: ReadonlyMap<string, RecordLabels>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether an item's metadata asks seshi to leave the item out: `session_capture.omit` is
 * `true`, and nothing else counts. */
export function omitRequested(metadata: unknown): boolean {
  if (!isObject(metadata)) return false;
  const capture = metadata[SESSION_CAPTURE_KEY];
  return isObject(capture) && capture.omit === true;
}
