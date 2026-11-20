import type { CaptureHost } from "@seshi/kit";
import { expandTilde } from "@seshi/kit";
import { keepableLabels, type Labels } from "@seshi/model/labels";
import { tryRealpath } from "./files";
import { folderMatch, type Place } from "./rules";

/** A label's value as configured: fixed, or read from the environment at resolution. */
export type LabelSource = string | { env: string };

/** The CLI config's labels, as the hook needs them (`rules.json` caches them): `[labels]`, and
 * `[[labels.paths]]` with each folder `~`-expanded and its real path beside it. */
export interface LabelRules {
  labels: Record<string, LabelSource>;
  paths: { path: string; real?: string; labels: Record<string, LabelSource> }[];
}

export const NO_LABEL_RULES: LabelRules = { labels: {}, paths: [] };

/** `[labels]` of a loaded CLI config as rules: `~` expanded, symbolic links resolved as
 * `[[capture.paths]]` resolves them. */
export function labelRules(
  config: { paths: ({ path: string } & Record<string, unknown>)[] } & Record<string, unknown>,
  home: string,
): LabelRules {
  const sources = (table: Record<string, unknown>, reserved: string) => {
    const out: Record<string, LabelSource> = {};
    for (const [key, value] of Object.entries(table)) {
      if (key !== reserved) out[key] = value as LabelSource;
    }
    return out;
  };
  return {
    labels: sources(config, "paths"),
    paths: config.paths.map((entry) => {
      const path = expandTilde(entry.path, home);
      const real = tryRealpath(path);
      return {
        path,
        ...(real !== undefined && real !== path ? { real } : {}),
        labels: sources(entry, "path"),
      };
    }),
  };
}

export interface ResolvedLabels {
  labels: Labels;
  /** Labels left out, and why: out of the limits, or not a string in the repo's config. */
  problems: string[];
}

/** The labels of a session in `place`, resolved now with `env` (the agent's, in a hook). Per
 * key, highest first: the `[[labels.paths]]` entries `place` is in, longest folder first; then
 * `[labels]`; then the repo's `.seshi/config.toml`. An `env` reference whose variable is unset or
 * empty counts as absent, so the next one down gives the key. Labels out of the limits (a fixed
 * empty value too) are dropped and said, never an error; past the cap, the lowest precedence
 * go first. */
export function resolveLabels(
  rules: LabelRules | undefined,
  place: Place,
  env: CaptureHost["env"],
  platform: NodeJS.Platform,
): ResolvedLabels {
  const layers: Record<string, LabelSource>[] = [];
  if (rules) {
    const matched = rules.paths
      .map((entry) => ({ entry, length: folderMatch(place, entry, platform) }))
      .filter(
        (m): m is { entry: LabelRules["paths"][number]; length: number } => m.length !== undefined,
      )
      .sort((a, b) => b.length - a.length);
    for (const { entry } of matched) layers.push(entry.labels);
    layers.push(rules.labels);
  }
  const repo = place.repo?.config;
  if (repo?.labels) layers.push(repo.labels);

  // Highest precedence first, so the label cap keeps those (`keepableLabels`).
  const resolved: Record<string, string> = {};
  const empty: string[] = [];
  for (const layer of layers) {
    for (const [key, source] of Object.entries(layer)) {
      if (key in resolved) continue;
      if (source === "") {
        // A fixed empty value is a config error (`seshi config check`): left out, said.
        empty.push(`label '${key}' must not be empty`);
        continue;
      }
      const value = typeof source === "string" ? source : env[source.env];
      if (value === undefined || value === "") continue;
      resolved[key] = value;
    }
  }
  const { labels, dropped } = keepableLabels(resolved);
  return { labels, problems: [...(repo?.labelProblems ?? []), ...empty, ...dropped] };
}
