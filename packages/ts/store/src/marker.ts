import { randomUUID } from "node:crypto";
import {
  type BucketMode,
  LAYOUT_SCHEMA,
  LAYOUT_SCHEMA_V1,
  LAYOUT_SCHEMAS,
  type LayoutMarker,
  LEGACY_LAYOUT_SCHEMA,
  TRACE_SCHEMA,
} from "@seshi/model";
import { createJson, readJson, tryDecodeJson, updateJson } from "./json";
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
  /** Write a marker when the prefix has none (true). False: a missing marker is a
   * `NoLayout` error, for serverless laptops, which never claim a bucket by writing to it
   * (F11.11). */
  create?: boolean;
  /** For a new marker: the mode to record, which makes it schema 2. */
  mode?: BucketMode;
  /** Record `org` in a marker that names none (true). False checks only. */
  claimOrg?: boolean;
}

/** The prefix has no marker and the caller may not write one. */
export class NoLayout extends LayoutError {
  constructor(readonly url: string) {
    super(`no seshi bucket at ${url}`);
    this.name = "NoLayout";
  }
}

function check(marker: LayoutMarker): LayoutMarker {
  if (!LAYOUT_SCHEMAS.includes(marker.schema)) {
    throw new LayoutError(
      `${LAYOUT_KEY} is ${JSON.stringify(marker.schema)}; this seshi reads ${LAYOUT_SCHEMAS.join(" and ")} (written by a newer seshi?)`,
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
  const schema = tryDecodeJson<{ schema?: string }>(legacy)?.schema ?? LEGACY_LAYOUT_SCHEMA;
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
    if (options.create === false) throw new NoLayout(store.url);
    const at = now().toISOString();
    const marker: LayoutMarker = {
      schema: options.mode !== undefined ? LAYOUT_SCHEMA : LAYOUT_SCHEMA_V1,
      trace_schema: TRACE_SCHEMA,
      deployment_id: options.deploymentId ?? (options.newDeploymentId ?? randomUUID)(),
      ...(options.org !== undefined ? { org: options.org } : {}),
      created_at: at,
      created_by: options.createdBy,
      ...(options.mode !== undefined
        ? { mode: options.mode, mode_changed_at: at, mode_changed_by: options.createdBy }
        : {}),
    };
    try {
      await createJson(store, LAYOUT_KEY, marker);
      return marker;
    } catch (err) {
      if (!isPreconditionFailed(err) || attempt >= 3) throw err;
    }
  }
}

async function claimOrg(store: Store, org: string): Promise<LayoutMarker> {
  const updated = await updateJson<LayoutMarker>(store, LAYOUT_KEY, (current) => {
    if (current === null) throw new LayoutError(`${LAYOUT_KEY} disappeared`);
    return current.org === undefined ? { ...current, org } : null;
  });
  return check(updated.value as LayoutMarker);
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
  if (options.claimOrg === false) return marker;
  const result = await claimOrg(store, org);
  if (result.org !== org) {
    throw new LayoutError(
      `${store.url} belongs to org ${JSON.stringify(result.org)}, not ${JSON.stringify(org)} (store.org)`,
    );
  }
  return result;
}

/** What `setLayout` changes. `min_version: null` clears it. */
export interface LayoutPatch {
  mode?: BucketMode;
  min_version?: string | null;
}

/** Set schema 2's fields on the prefix's marker, upgrading a schema 1 marker (If-Match, so a
 * concurrent change is read again, not overwritten). Throws `NoLayout` when there is none. */
export async function setLayout(
  store: Store,
  patch: LayoutPatch,
  options: { by: string; now?: () => Date },
): Promise<LayoutMarker> {
  if (patch.min_version !== undefined && patch.min_version !== null) {
    parseVersion(patch.min_version);
  }
  const at = (options.now ?? (() => new Date()))().toISOString();
  const updated = await updateJson<LayoutMarker>(store, LAYOUT_KEY, (current) => {
    if (current === null) throw new NoLayout(store.url);
    const marker = check(current);
    const next: LayoutMarker = { ...marker, schema: LAYOUT_SCHEMA };
    if (patch.mode !== undefined && patch.mode !== marker.mode) {
      next.mode = patch.mode;
      next.mode_changed_at = at;
      next.mode_changed_by = options.by;
    }
    if (patch.min_version === null) delete next.min_version;
    else if (patch.min_version !== undefined) next.min_version = patch.min_version;
    const same = JSON.stringify(next) === JSON.stringify(marker);
    return same ? null : next;
  });
  return check(updated.value as LayoutMarker);
}

/** A `major.minor.patch` version as three numbers; anything after the patch (`-rc.1`, `+sha`)
 * is ignored. */
export function parseVersion(version: string): [number, number, number] {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!match) throw new LayoutError(`not a version: ${JSON.stringify(version)} (use 0.10.0)`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Whether `version` is `min` or newer. */
export function versionAtLeast(version: string, min: string): boolean {
  const a = parseVersion(version);
  const b = parseVersion(min);
  for (let i = 0; i < 3; i++) {
    if ((a[i] as number) !== (b[i] as number)) return (a[i] as number) > (b[i] as number);
  }
  return true;
}
