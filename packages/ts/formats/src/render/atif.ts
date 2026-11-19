import type {
  AtifDocument,
  AtifStep,
  LlmCall,
  Trace,
  TraceMetaRecord,
  TraceRecord,
} from "@seshi/model";

function argumentsOf(args: string): unknown {
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

function metricsOf(call: LlmCall | undefined): AtifStep["metrics"] | undefined {
  const usage = call?.usage;
  if (!usage) return undefined;
  const input =
    usage.input_tokens === undefined
      ? undefined
      : usage.input_tokens +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0);
  const metrics: NonNullable<AtifStep["metrics"]> = {};
  if (input !== undefined) metrics.prompt_tokens = input;
  if (usage.output_tokens !== undefined) metrics.completion_tokens = usage.output_tokens;
  if (usage.cache_read_input_tokens !== undefined) {
    metrics.cached_tokens = usage.cache_read_input_tokens;
  }
  return Object.keys(metrics).length > 0 ? metrics : undefined;
}

export function toAtif(trace: Trace): AtifDocument {
  const records = trace.records;
  const meta = records[0]?.role === "meta" ? (records[0] as TraceMetaRecord) : undefined;
  const calls = new Map((trace.llm_calls ?? []).map((call) => [call.id, call]));
  const counted = new Set<string>();
  const steps: AtifStep[] = [];
  let open: AtifStep | undefined;
  let reasoning: { text: string[]; timestamp: string } | undefined;

  const push = (step: Omit<AtifStep, "step_id">): AtifStep => {
    const full = { step_id: steps.length + 1, ...step } as AtifStep;
    steps.push(full);
    open = full.source === "user" ? undefined : full;
    return full;
  };
  const agentStep = (timestamp: string, message: string, record?: TraceRecord): AtifStep => {
    const step: Omit<AtifStep, "step_id"> = { timestamp, source: "agent", message };
    if (reasoning) step.reasoning_content = reasoning.text.join("\n\n");
    reasoning = undefined;
    const callId = record && "llm_call" in record ? record.llm_call : undefined;
    const call = callId === undefined ? undefined : calls.get(callId);
    if (call?.model) step.model_name = call.model;
    if (callId !== undefined && !counted.has(callId)) {
      counted.add(callId);
      const metrics = metricsOf(call);
      if (metrics) step.metrics = metrics;
    }
    return push(step);
  };
  const flushReasoning = () => {
    if (reasoning) agentStep(reasoning.timestamp, "");
  };
  const observe = (
    timestamp: string,
    result: { source_call_id?: string; content: string; extra?: Record<string, unknown> },
  ) => {
    const step = open ?? agentStep(timestamp, "");
    step.observation ??= { results: [] };
    step.observation.results.push(result);
  };

  for (const record of records) {
    switch (record.role) {
      case "meta":
        break;
      case "user":
      case "system":
        flushReasoning();
        push({ timestamp: record.timestamp, source: record.role, message: record.content });
        break;
      case "reasoning":
        reasoning ??= { text: [], timestamp: record.timestamp };
        reasoning.text.push(record.content);
        break;
      case "assistant": {
        const step = agentStep(record.timestamp, record.content ?? "", record);
        if (record.tool_calls && record.tool_calls.length > 0) {
          step.tool_calls = record.tool_calls.map((call) => ({
            tool_call_id: call.id,
            function_name: call.name,
            arguments: argumentsOf(call.args),
          }));
        }
        break;
      }
      case "tool":
        flushReasoning();
        observe(record.timestamp, {
          source_call_id: record.tool_call_id,
          content: record.content,
          ...(record.ok !== undefined ? { extra: { is_error: !record.ok } } : {}),
        });
        break;
      case "observation":
        flushReasoning();
        observe(record.timestamp, { content: record.content });
        break;
    }
  }
  flushReasoning();

  const totals = { prompt: 0, completion: 0, cached: 0, any: false };
  for (const step of steps) {
    if (!step.metrics) continue;
    totals.any = true;
    totals.prompt += step.metrics.prompt_tokens ?? 0;
    totals.completion += step.metrics.completion_tokens ?? 0;
    totals.cached += step.metrics.cached_tokens ?? 0;
  }
  const model = trace.metadata.model ?? meta?.model;
  const document: AtifDocument = {
    schema_version: "ATIF-v1.7",
    ...(trace.session_id !== null ? { session_id: trace.session_id } : {}),
    agent: {
      name: trace.source,
      version: meta?.agent_version ?? "unknown",
      ...(model ? { model_name: model } : {}),
    },
    steps,
    final_metrics: {
      ...(totals.any
        ? {
            total_prompt_tokens: totals.prompt,
            total_completion_tokens: totals.completion,
            total_cached_tokens: totals.cached,
          }
        : {}),
      total_steps: steps.length,
    },
    extra: {
      seshi: {
        content_hash: trace.content_hash,
        agent: trace.agent,
        ...(trace.project !== undefined ? { project: trace.project } : {}),
        ...(trace.branch !== undefined ? { branch: trace.branch } : {}),
      },
    },
  };
  return document;
}
