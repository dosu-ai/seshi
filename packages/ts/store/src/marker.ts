import { randomUUID } from "node:crypto";
import { LAYOUT_SCHEMA, type LayoutMarker, LEGACY_LAYOUT_SCHEMA, TRACE_SCHEMA } from "@seshi/model";
import { createJson, decodeJson, readJson, updateJson } from "./json";
import { LAYOUT_KEY, LEGACY_LAYOUT_KEY } from "./layout";
import { getBytes, isPreconditionFailed, type Store, StoreError } from "./store";

export class LayoutError extends StoreError {
  constructor(message: string) {
    super(message);
    this.name = "LayoutError";
  }
}

export interface LayoutOptions {
  createdBy: string;
  /** Config's `store.deployment_id`: the marker must name it, or one is recorded when the
   * prefix is new. Without it a new prefix gets a generated id, and any id is accepted. */
  deploymentId?: string;
  /** Config's `store.org`: the marker must name it. A marker without an org records it the
   * first time a config names one. */
  org?: string;
  now?: () => Date;
  newDeploymentId?: () => string;
}

function check(marker: LayoutMarker): LayoutMarker {
  if (marker.schema !== LAYOUT_SCHEMA) {
    throw new LayoutError(
      `${LAYOUT_KEY} is ${JSON.stringify(marker.schema)}; this seshi reads ${LAYOUT_SCHEMA} (written by a newer seshi?)`,
    );
  }
  if (marker.trace_schema !== TRACE_SCHEMA) {
    throw new LayoutError(
      `traces under this prefix are ${JSON.stringify(marker.trace_schema)}; this seshi writes ${TRACE_SCHEMA}`,
    );
  }
  return marker;
}

async function refuseLegacy(store: Store): Promise<void> {
  const legacy = await getBytes(store, LEGACY_LAYOUT_KEY);
  if (legacy === null) return;
  let schema = LEGACY_LAYOUT_SCHEMA as string;
  try {
    schema = decodeJson<{ schema?: string }>(legacy).schema ?? schema;
  } catch {}
  throw new LayoutError(
    `${store.url} holds a sessiondb store (${LEGACY_LAYOUT_KEY}, ${schema}): its traces are letta or otlp objects beside raw transcripts, which seshi does not read, and there is no migration (X1.5). Point store.url at a new prefix.`,
  );
}

/** The prefix's marker, checked; null when it has none. Refuses a sessiondb prefix. */
export async function readLayout(store: Store): Promise<LayoutMarker | null> {
  const found = await readJson<LayoutMarker>(store, LAYOUT_KEY);
  if (found) return check(found.value);
  await refuseLegacy(store);
  return null;
}

/** The prefix's marker, written if there is none, checked against the deployment and org the
 * config names. Throws `LayoutError` when the prefix is another deployment's or org's, holds
 * sessiondb's layout, or holds a marker this version cannot read. */
export async function ensureLayout(store: Store, options: LayoutOptions): Promise<LayoutMarker> {
  const now = options.now ?? (() => new Date());
  for (let attempt = 0; ; attempt++) {
    const existing = await readLayout(store);
    if (existing) return agree(store, existing, options);
    const marker: LayoutMarker = {
      schema: LAYOUT_SCHEMA,
      trace_schema: TRACE_SCHEMA,
      deployment_id: options.deploymentId ?? (options.newDeploymentId ?? randomUUID)(),
      ...(options.org !== undefined ? { org: options.org } : {}),
      created_at: now().toISOString(),
      created_by: options.createdBy,
    };
    try {
      await createJson(store, LAYOUT_KEY, marker);
      return marker;
    } catch (err) {
      if (!isPreconditionFailed(err) || attempt >= 3) throw err;
    }
  }
}

async function agree(
  store: Store,
  marker: LayoutMarker,
  options: LayoutOptions,
): Promise<LayoutMarker> {
  if (options.deploymentId !== undefined && marker.deployment_id !== options.deploymentId) {
    throw new LayoutError(
      `${store.url} belongs to deployment ${JSON.stringify(marker.deployment_id)}, not ${JSON.stringify(options.deploymentId)} (store.deployment_id)`,
    );
  }
  const org = options.org;
  if (org === undefined) return marker;
  if (marker.org !== undefined) {
    if (marker.org !== org) {
      throw new LayoutError(
        `${store.url} belongs to org ${JSON.stringify(marker.org)}, not ${JSON.stringify(org)} (store.org)`,
      );
    }
    return marker;
  }
  const updated = await updateJson<LayoutMarker>(store, LAYOUT_KEY, (current) => {
    if (current === null) throw new LayoutError(`${LAYOUT_KEY} disappeared`);
    return current.org === undefined ? { ...current, org } : null;
  });
  const result = check(updated.value as LayoutMarker);
  if (result.org !== org) {
    throw new LayoutError(
      `${store.url} belongs to org ${JSON.stringify(result.org)}, not ${JSON.stringify(org)} (store.org)`,
    );
  }
  return result;
}
