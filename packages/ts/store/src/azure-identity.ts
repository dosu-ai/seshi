import { readFile } from "node:fs/promises";
import type { Fetch } from "@seshi/model";

/** Workload identity (AKS, or any federated credential): the pod's projected service account
 * token, exchanged with Microsoft Entra ID for an access token to Azure Storage. AKS sets these
 * variables on a pod whose service account is annotated with a managed identity's client id:
 *
 * - `AZURE_FEDERATED_TOKEN_FILE`: the token file, rotated by the kubelet (read on each exchange)
 * - `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`
 * - `AZURE_AUTHORITY_HOST`: `https://login.microsoftonline.com/` by default
 *
 * `undefined` when they are not all set. */
export function workloadIdentityFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  options: { fetch?: Fetch; now?: () => Date } = {},
): (() => Promise<string>) | undefined {
  const tokenFile = env.AZURE_FEDERATED_TOKEN_FILE;
  const clientId = env.AZURE_CLIENT_ID;
  const tenantId = env.AZURE_TENANT_ID;
  if (!tokenFile || !clientId || !tenantId) return undefined;
  return workloadIdentity({
    tokenFile,
    clientId,
    tenantId,
    ...(env.AZURE_AUTHORITY_HOST ? { authorityHost: env.AZURE_AUTHORITY_HOST } : {}),
    ...options,
  });
}

export interface WorkloadIdentityOptions {
  tokenFile: string;
  clientId: string;
  tenantId: string;
  authorityHost?: string;
  fetch?: Fetch;
  now?: () => Date;
  /** Reads the token file; `readFile` by default. */
  read?: (path: string) => Promise<string>;
  /** Where tokens are kept, by identity; one map for the process by default, so every store
   * and source bucket opened for the same identity shares a token (a source's bucket is opened
   * again on each run). */
  cache?: Map<string, IdentitySlot>;
}

/** Microsoft Entra ID refused to exchange the federated token. Not a Blob service answer, so
 * nothing reads it as one (a refused condition, a missing object). */
export class AzureIdentityError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "AzureIdentityError";
  }
}

/** One identity's token, and the exchange in flight for it. */
export interface IdentitySlot {
  cached?: { token: string; expires: number };
  pending?: Promise<string>;
}

const SHARED_SLOTS = new Map<string, IdentitySlot>();

const STORAGE_SCOPE = "https://storage.azure.com/.default";
/** Renew this long before the access token expires. */
const RENEW_BEFORE_MS = 5 * 60 * 1000;

/** A function that answers an access token for Azure Storage, exchanging the federated token
 * (OAuth 2.0 client credentials with a client assertion) when it has none or the one it has is
 * about to expire. Concurrent callers share one exchange. */
export function workloadIdentity(options: WorkloadIdentityOptions): () => Promise<string> {
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => new Date());
  const read = options.read ?? ((path: string) => readFile(path, "utf8"));
  const authority = (options.authorityHost ?? "https://login.microsoftonline.com/").replace(
    /\/*$/,
    "/",
  );
  const url = `${authority}${encodeURIComponent(options.tenantId)}/oauth2/v2.0/token`;
  const slots = options.cache ?? SHARED_SLOTS;
  const id = [url, options.clientId, options.tokenFile].join("\n");
  let slot = slots.get(id);
  if (!slot) {
    slot = {};
    slots.set(id, slot);
  }
  const held = slot;

  const exchange = async (): Promise<string> => {
    const assertion = (await read(options.tokenFile)).trim();
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: options.clientId,
        scope: STORAGE_SCOPE,
        grant_type: "client_credentials",
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: assertion,
      }).toString(),
    });
    const text = await response.text();
    let body: { access_token?: unknown; expires_in?: unknown; error?: unknown } = {};
    try {
      body = JSON.parse(text);
    } catch {}
    if (!response.ok || typeof body.access_token !== "string") {
      const code = typeof body.error === "string" ? body.error : undefined;
      throw new AzureIdentityError(
        response.status,
        code,
        `workload identity token for client ${options.clientId}: ${response.status}${code ? ` ${code}` : ""}`,
      );
    }
    const seconds = Number(body.expires_in);
    held.cached = {
      token: body.access_token,
      expires: now().getTime() + (Number.isFinite(seconds) ? seconds : 3600) * 1000,
    };
    return held.cached.token;
  };

  return async () => {
    const { cached } = held;
    if (cached && cached.expires - now().getTime() > RENEW_BEFORE_MS) return cached.token;
    held.pending ??= exchange().finally(() => {
      held.pending = undefined;
    });
    return held.pending;
  };
}
