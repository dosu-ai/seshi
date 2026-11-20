/** Labels: small key/value strings attached to a session from config (the CLI's `[labels]`, a
 * repo's `.seshi/config.toml`, a server source's `labels`), stored on its metadata and
 * searchable. seshi gives them no meaning. A leaf module with no imports, so the config loader
 * and the hook can use it without loading the rest of the model. */

export type Labels = Record<string, string>;

/** A label's key: lowercase letters, digits, `.`, `_` and `-`, starting with a letter or digit,
 * up to 64 characters (`dosu.project`, `team`). */
export const LABEL_KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const MAX_LABEL_VALUE_LENGTH = 512;
export const MAX_LABELS = 32;

/** Why a label cannot be kept, or undefined when it can. */
export function labelProblem(key: string, value: unknown): string | undefined {
  if (!LABEL_KEY.test(key)) {
    return `label key '${printable(key)}' must be lowercase letters, digits, '.', '_' or '-', starting with a letter or digit, up to 64 characters`;
  }
  if (typeof value !== "string") return `label '${key}' must be a string`;
  if (value === "") return `label '${key}' must not be empty`;
  if (value.length > MAX_LABEL_VALUE_LENGTH) {
    return `label '${key}' is ${value.length} characters long; at most ${MAX_LABEL_VALUE_LENGTH} are allowed`;
  }
  return undefined;
}

/** Every problem with a set of labels: each label's own, and too many of them. */
export function labelsProblems(labels: unknown): string[] {
  if (typeof labels !== "object" || labels === null || Array.isArray(labels)) {
    return ["labels must be an object of strings"];
  }
  const problems: string[] = [];
  const entries = Object.entries(labels);
  for (const [key, value] of entries) {
    const problem = labelProblem(key, value);
    if (problem) problems.push(problem);
  }
  if (entries.length > MAX_LABELS) {
    problems.push(`${entries.length} labels; at most ${MAX_LABELS} are allowed`);
  }
  return problems;
}

/** The labels that can be kept, and why the others cannot: each label checked on its own, then
 * the first `MAX_LABELS` kept (by key, so the same config always keeps the same ones). */
export function keepableLabels(labels: Readonly<Record<string, unknown>>): {
  labels: Labels;
  dropped: string[];
} {
  const kept: Labels = {};
  const dropped: string[] = [];
  for (const key of Object.keys(labels).sort()) {
    const value = labels[key];
    const problem = labelProblem(key, value);
    if (problem) {
      dropped.push(problem);
      continue;
    }
    if (Object.keys(kept).length >= MAX_LABELS) {
      dropped.push(`label '${key}' is past the ${MAX_LABELS} allowed`);
      continue;
    }
    kept[key] = value as string;
  }
  return { labels: kept, dropped };
}

function printable(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: replacing control characters
  const clean = text.replace(/[\x00-\x1f\x7f-\x9f]/g, "�");
  return clean.length > 80 ? `${clean.slice(0, 80)}…` : clean;
}
