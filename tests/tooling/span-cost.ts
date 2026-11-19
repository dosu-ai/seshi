/** The cost of a long span session (09's "Cost at scale", 22's measurement):
 * `bun run tests/tooling/span-cost.ts [calls] [message bytes]`.
 *
 * One OTLP session of `calls` chat calls (400 by default), each sent as its own batch the way an
 * exporter sends them: a call's input repeats the whole conversation so far (each message about
 * `message bytes`, 2 KB by default) plus a new user message, and its output is one assistant
 * message. The script stores every span through the pipeline into a folder store, then runs one
 * assembler pass, and prints:
 *
 * - the bytes under the session's `spans/` (span records and, once history is stored once, the
 *   messages they point at) and how many objects;
 * - the bytes of the published trace's records (what the session is);
 * - the peak JS heap above the heap before the pass, sampled every 2 ms and at the publish (the
 *   assembler's working set: what it read and what it built).
 *
 * Run with `--expose-gc`-like behaviour through `Bun.gc(true)` before the pass, so the baseline
 * is the heap after storing. Numbers vary a little between runs; the order of magnitude is what
 * counts. Nothing calls an external service. */

import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_FORMATS, FormatRegistry, otlpGenAiFormat } from "@seshi/formats";
import { ENVELOPE_SCHEMA, type Envelope } from "@seshi/model";
import { assemblePending, MemoryHealthCounters, Pipeline, SpanStore } from "@seshi/pipeline";
import { archiveId, FsStore, keys } from "@seshi/store";

const CALLS = Number(process.argv[2] ?? 400);
const MESSAGE_BYTES = Number(process.argv[3] ?? 2048);
const OWNER = "svc:console";
const SESSION = "sesn_cost";

const WORDS =
  "the of and to in is that for it as was with be by on not he this are or his from at which but have an they you were her she there been one all we their has would when if so no will more can out up into other".split(
    " ",
  );
// mulberry32: a fixed sequence, so every run stores the same text.
let seed = 7;
const random = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
let said = 0;
/** About `n` bytes of words, numbered so no two messages are the same. */
function text(n: number): string {
  const out: string[] = [];
  let length = 0;
  while (length < n) {
    const word = WORDS[Math.floor(random() * WORDS.length)] as string;
    out.push(word);
    length += word.length + 1;
  }
  return `${said++}: ${out.join(" ")}`;
}

const ns = (sec: number) =>
  (BigInt(Date.parse("2026-11-01T10:00:00Z") + sec * 1000) * 1_000_000n).toString();
const attr = (key: string, value: string) => ({ key, value: { stringValue: value } });

function sizeOf(dir: string): { bytes: number; objects: number } {
  let bytes = 0;
  let objects = 0;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) {
      const inner = sizeOf(path);
      bytes += inner.bytes;
      objects += inner.objects;
    } else {
      bytes += statSync(path).size;
      objects++;
    }
  }
  return { bytes, objects };
}

const dir = mkdtempSync(join(tmpdir(), "seshi-span-cost-"));
try {
  const store = new FsStore(dir);
  let clock = new Date("2026-11-01T10:00:00Z");
  const now = () => clock;
  const formats = new FormatRegistry([...BUILTIN_FORMATS, otlpGenAiFormat()]);
  const pipeline = new Pipeline({
    store,
    formats,
    now,
    assembler: new SpanStore({ store, now }),
    health: new MemoryHealthCounters(),
    filter: { enabled: false, min_chars: 0, require_user: false, require_reply: false },
    limits: { max_records: 1_000_000, max_records_bytes: 1 << 30, max_upload_bytes: 1 << 30 },
  });

  const history: { role: string; parts: { type: string; content: string }[] }[] = [];
  const started = performance.now();
  for (let i = 0; i < CALLS; i++) {
    history.push({ role: "user", parts: [{ type: "text", content: text(MESSAGE_BYTES) }] });
    const reply = { role: "assistant", parts: [{ type: "text", content: text(MESSAGE_BYTES) }] };
    const span = {
      traceId: "ab".repeat(16),
      spanId: (i + 1).toString(16).padStart(16, "0"),
      name: "chat claude",
      startTimeUnixNano: ns(i * 10),
      endTimeUnixNano: ns(i * 10 + 5),
      attributes: [
        attr("gen_ai.operation.name", "chat"),
        attr("gen_ai.conversation.id", "conv"),
        attr("gen_ai.request.model", "claude"),
        attr("gen_ai.input.messages", JSON.stringify(history)),
        attr("gen_ai.output.messages", JSON.stringify([reply])),
        { key: "gen_ai.usage.input_tokens", value: { intValue: 10 } },
      ],
    };
    history.push(reply);
    const envelope: Envelope = {
      schema: ENVELOPE_SCHEMA,
      source: "otlp",
      source_id: "console",
      format: "otlp-genai",
      session_key: SESSION,
      payload: { kind: "spans", spans: [span] as unknown as Record<string, unknown>[] },
      caller: { kind: "service", principal: OWNER, credential_id: "tok1" },
      owner: OWNER,
      owner_basis: "service",
      idempotency_key: `batch-${i}`,
      received_at: clock.toISOString(),
    };
    const outcome = await pipeline.submit(envelope);
    if (outcome.status !== "accepted") throw new Error(`call ${i}: ${JSON.stringify(outcome)}`);
  }
  const stored = performance.now() - started;

  const archive = archiveId(OWNER, "otlp-genai", SESSION);
  const spans = sizeOf(join(dir, keys.spans(OWNER, archive)));

  clock = new Date(clock.getTime() + 60 * 60_000);
  Bun.gc(true);
  const base = process.memoryUsage().heapUsed;
  let peak = base;
  const sample = () => {
    peak = Math.max(peak, process.memoryUsage().heapUsed);
  };
  const timer = setInterval(sample, 2);
  let recordsBytes = 0;
  let traceHash = "";
  const assembleStart = performance.now();
  const report = await assemblePending({
    store,
    formats,
    publish: async (session) => {
      sample();
      const json = JSON.stringify({ records: session.records, llm_calls: session.llm_calls });
      recordsBytes = JSON.stringify(session.records).length;
      traceHash = createHash("sha256").update(json).digest("hex").slice(0, 16);
      return pipeline.publishAssembled(session);
    },
    quietMs: () => 10 * 60_000,
    now,
  });
  sample();
  clearInterval(timer);
  const assembled = performance.now() - assembleStart;
  if (report.published !== 1) throw new Error(`not published: ${JSON.stringify(report)}`);

  const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
  console.log(
    JSON.stringify(
      {
        calls: CALLS,
        message_bytes: MESSAGE_BYTES,
        span_objects: spans.objects,
        span_bytes: mb(spans.bytes),
        trace_records_bytes: mb(recordsBytes),
        trace_sha256: traceHash,
        peak_heap_above_base: mb(peak - base),
        store_ms: Math.round(stored),
        assemble_ms: Math.round(assembled),
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
