import type { ServerConfig } from "@seshi/config";
import { type LoadOptions, loadPolicies } from "./policy";
import { ModelReviewer, type ModelReviewerOptions } from "./reviewer";

export interface ReviewerOptions extends LoadOptions, Omit<ModelReviewerOptions, "policies"> {}

export async function reviewerFromConfig(
  config: Pick<ServerConfig, "review">,
  options: ReviewerOptions = {},
): Promise<ModelReviewer | undefined> {
  if (config.review.policies.length === 0) return undefined;
  const { providers, fetch, readFile, ...rest } = options;
  const policies = await loadPolicies(config.review.policies, {
    ...(providers ? { providers } : {}),
    ...(fetch ? { fetch } : {}),
    ...(readFile ? { readFile } : {}),
  });
  return new ModelReviewer({ ...rest, policies });
}
