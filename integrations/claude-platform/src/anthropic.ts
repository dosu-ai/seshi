/** The `anthropic.*` span attributes of the Claude Platform's OpenTelemetry export (F4): what a
 * Claude Console destination sends for Messages API requests and Managed Agents sessions, and
 * what the Anthropic SDK sends from an application. The GenAI conventions (`gen_ai.*`) carry
 * most of it and `@seshi/formats` reads those; this mapper adds what only Anthropic names:
 *
 * - the session key: `anthropic.session.id`, which groups a Managed Agents session's spans
 *   across traces and threads (F4.3);
 * - a tool span's result, `anthropic.tool_result.content` (content blocks as JSON), and its
 *   name from the span name (`anthropic.tool_use bash`, `anthropic.mcp_tool_use …`,
 *   `anthropic.custom_tool_use …`);
 * - an outcome evaluation's explanation, as an observation;
 * - a request's stop reason (`anthropic.message.stop_reason`), request id, thinking and
 *   service-tier parameters, and cache writes by tier when the GenAI total is missing;
 * - the end of a session: archiving or deleting it (`anthropic.sessions.archive`,
 *   `anthropic.sessions.delete`) is a final span (F4.4);
 * - identity the data asserts (X5.5): the organization, the workspace and the application's
 *   end-user id, recorded as account ids and never trusted for ownership.
 *
 * Shapes follow Anthropic's span reference (platform.claude.com, "OpenTelemetry span
 * reference", beta: names and attributes can change). */

import {
  argsOf,
  jsonAttribute,
  type SpanAttributeMapper,
  type SpanView,
  textOf,
} from "@seshi/formats";
import type { Claims, LlmCall, SpanPart } from "@seshi/model";

/** The prefixes of Anthropic's tool span names; the tool's name follows a space. */
const TOOL_SPANS = ["anthropic.tool_use", "anthropic.mcp_tool_use", "anthropic.custom_tool_use"];

/** Spans that end a session. */
const FINAL_SPANS = new Set(["anthropic.sessions.archive", "anthropic.sessions.delete"]);

function toolNameOf(spanName: string): string | undefined {
  for (const prefix of TOOL_SPANS) {
    if (spanName === prefix || spanName.startsWith(`${prefix} `)) {
      const name = spanName.slice(prefix.length).trim();
      return name === "" ? prefix.replace(/^anthropic\./, "") : name;
    }
  }
  return undefined;
}

function refineCall(call: LlmCall, view: SpanView): LlmCall {
  const attrs = view.attributes;
  const out: LlmCall = { ...call };
  const stop = attrs.first("anthropic.message.stop_reason");
  if (stop) out.stop_reason = stop;
  if (!out.request_id) {
    const request = attrs.first("anthropic.request.id");
    if (request) out.request_id = request;
  }
  if (out.usage && out.usage.cache_creation_input_tokens === undefined) {
    const five = attrs.count("anthropic.usage.cache_creation.ephemeral_5m_input_tokens");
    const hour = attrs.count("anthropic.usage.cache_creation.ephemeral_1h_input_tokens");
    if (five !== undefined || hour !== undefined) {
      out.usage = { ...out.usage, cache_creation_input_tokens: (five ?? 0) + (hour ?? 0) };
    }
  }
  const parameters = { ...out.parameters };
  const thinking = attrs.string("anthropic.thinking.type");
  if (thinking) parameters.thinking = thinking;
  const budget = attrs.count("anthropic.thinking.budget_tokens");
  if (budget !== undefined) parameters.thinking_budget_tokens = budget;
  const tier = attrs.string("anthropic.request.service_tier");
  if (tier) parameters.service_tier = tier;
  const served = attrs.string("anthropic.response.service_tier");
  if (served) parameters.served_tier = served;
  if (Object.keys(parameters).length > 0) out.parameters = parameters;
  return out;
}

export const anthropicAttributes: SpanAttributeMapper = {
  name: "anthropic",

  sessionKey: (view) => view.attributes.string("anthropic.session.id"),

  hasContent: (view) =>
    view.attributes.has("anthropic.tool_result.content") ||
    view.attributes.has("anthropic.session.outcome_evaluation.explanation"),

  claims(view): Claims | undefined {
    const ids: Record<string, string> = {};
    const org = view.attributes.string("anthropic.organization.id");
    if (org) ids["anthropic-org"] = org;
    const workspace = view.attributes.string("anthropic.workspace.id");
    if (workspace) ids["anthropic-workspace"] = workspace;
    const user = view.attributes.string("user.id");
    if (user) ids["anthropic-user"] = user;
    return Object.keys(ids).length > 0 ? { account_ids: ids } : undefined;
  },

  refine(part: SpanPart, view: SpanView): SpanPart {
    const attrs = view.attributes;
    const out: SpanPart = { ...part };
    const toolName = toolNameOf(view.span.name);
    if (toolName !== undefined) {
      out.operation ??= "execute_tool";
      const tool = { ...(out.tool ?? { name: attrs.string("gen_ai.tool.name") ?? toolName }) };
      if (!tool.call_id) {
        const id = attrs.string("gen_ai.tool.call.id");
        if (id) tool.call_id = id;
      }
      if (tool.args === undefined && attrs.has("gen_ai.tool.call.arguments")) {
        tool.args = argsOf(jsonAttribute(attrs.get("gen_ai.tool.call.arguments")));
      }
      if (attrs.has("anthropic.tool_result.content")) {
        tool.result = textOf(jsonAttribute(attrs.get("anthropic.tool_result.content")));
      }
      if (view.span.status?.code === 2 || attrs.has("error.type")) tool.ok = false;
      out.tool = tool;
    }
    const explanation = attrs.string("anthropic.session.outcome_evaluation.explanation");
    if (explanation) {
      const result = attrs.string("anthropic.session.outcome_evaluation.result");
      out.output = [
        ...(out.output ?? []),
        {
          role: "observation",
          content: result ? `Outcome evaluation (${result}): ${explanation}` : explanation,
          timestamp: out.ended_at ?? out.started_at,
        },
      ];
    }
    if (out.llm_call) out.llm_call = refineCall(out.llm_call, view);
    if (FINAL_SPANS.has(view.span.name) && view.span.status?.code !== 2) out.final = true;
    return out;
  },
};
