/** Helpers every polling connector needs: its config's secrets and API URL, the identity its
 * envelopes carry, and a sleep its run's signal can cut short. */

import type { Envelope } from "@seshi/model";

/** A secret config field's text: a plain string, or a `secret()` value revealed. Throws when it
 * is missing or empty, naming the source type and field. */
export function secretValue(value: unknown, sourceType: string, field: string): string {
  const text =
    typeof value === "string"
      ? value
      : typeof value === "object" && value !== null && "reveal" in value
        ? (value as { reveal(): string }).reveal()
        : undefined;
  if (typeof text !== "string" || text === "") {
    throw new Error(`the ${sourceType} source needs ${field}`);
  }
  return text;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** An `api_url` override, checked: https, or http to localhost only, since `credentials` (what
 * the requests carry, such as "the keys") would otherwise travel in clear. Undefined when unset. */
export function apiUrlOverride(
  raw: unknown,
  sourceType: string,
  credentials: string,
): string | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`the ${sourceType} source's api_url is not a URL`);
  }
  if (url.protocol === "http:" && !LOOPBACK.has(url.hostname)) {
    throw new Error(
      `the ${sourceType} source's api_url must be https (plain http would send ${credentials} in clear); http is allowed for localhost only`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`the ${sourceType} source's api_url must be https`);
  }
  return raw;
}

/** Who a poller's envelopes come from and belong to: its source's service account,
 * `svc:<id>` (X5.4). */
export function serviceEnvelopeIdentity(
  sourceId: string,
): Pick<Envelope, "caller" | "owner" | "owner_basis"> {
  const owner = `svc:${sourceId}`;
  return { caller: { kind: "service", principal: owner }, owner, owner_basis: "service" };
}

/** Wait `ms`, or reject with the signal's reason as soon as it aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
