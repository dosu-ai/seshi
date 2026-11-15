/** `[review]`: model review policies (F3). Off until a policy names a provider and its key
 * (F3.5). Shapes here are typed but loose; the model review branch refines them. */

import * as z from "zod";
import { secret } from "../secret";
import { httpUrl } from "./common";

export const PROVIDERS = ["anthropic", "bedrock", "vertex", "openai-compatible"] as const;

const modelStep = z.strictObject({
  provider: z.enum(PROVIDERS).describe("Who runs the model; review sends envelopes there (F3.5)."),
  model: z.string().min(1).describe("The model name at that provider."),
  prompt: z.string().min(1).optional().describe("The prompt, inline."),
  prompt_file: z.string().min(1).optional().describe("The prompt, from a file."),
  api_key: secret().optional().describe("The provider key."),
  base_url: httpUrl
    .optional()
    .describe("The provider's endpoint (openai-compatible, a local model)."),
});

const category = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1),
  examples: z.array(z.string()).default([]),
});

const onePrompt = (step: { prompt?: string; prompt_file?: string }) =>
  !(step.prompt !== undefined && step.prompt_file !== undefined);

export const reviewPolicy = z
  .strictObject({
    id: z.string().min(1).describe("The policy's name."),
    sources: z
      .array(z.string().min(1))
      .default([])
      .describe("Source ids it applies to; all when empty."),
    agents: z
      .array(z.string().min(1))
      .default([])
      .describe("Agents it applies to; all when empty."),
    repos: z
      .array(z.string().min(1))
      .default([])
      .describe("Repositories it applies to; all when empty."),
    on_failure: z
      .enum(["drop", "skip"])
      .default("drop")
      .describe(
        "After the last retry: drop the envelope, or store it with regex redaction only (F3.4).",
      ),
    retries: z.int().nonnegative().default(3).describe("Retries of a failed model call (F3.4)."),
    decision: modelStep
      .refine(onePrompt, "prompt or prompt_file, not both")
      .describe("The decision model: allow, redact or drop (F3.1)."),
    redactor: modelStep
      .extend({ categories: z.array(category).default([]) })
      .refine(onePrompt, "prompt or prompt_file, not both")
      .optional()
      .describe("The redactor LLM, called only for redact (F3.1)."),
  })
  .describe("A review policy (F3.3).");

export const reviewSection = z
  .strictObject({
    policies: z
      .array(reviewPolicy)
      .default([])
      .describe("Review policies; none means no model review."),
  })
  .prefault({})
  .describe("Model review (F3).");

export type ReviewSection = z.output<typeof reviewSection>;
export type ReviewPolicy = z.output<typeof reviewPolicy>;
