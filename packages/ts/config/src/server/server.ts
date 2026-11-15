/** `[server]`: how the HTTP server listens and which roles this instance runs (X7.1). */

import * as z from "zod";
import { httpUrl } from "./common";

export const ROLES = ["api", "worker"] as const;

const LISTEN = /^(?:(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]*):)?(\d{1,5})$/;

/** `host:port`, `:port` or `port` as a hostname and a port; `[::1]:7200` for IPv6. An empty
 * host means every interface. `undefined` when it is none of these. */
export function parseListen(listen: string): { hostname: string; port: number } | undefined {
  const match = LISTEN.exec(listen.trim());
  if (!match) return undefined;
  const port = Number(match[2]);
  if (port > 65535) return undefined;
  const host = (match[1] ?? "").replace(/^\[|\]$/g, "");
  return { hostname: host === "" ? "0.0.0.0" : host, port };
}

export const serverSection = z
  .strictObject({
    listen: z
      .string()
      .refine((v) => parseListen(v) !== undefined, "host:port, :port or port (port 0–65535)")
      .default(":7200")
      .describe("Where the HTTP server listens: host:port, :port (every interface) or port."),
    public_url: httpUrl
      .optional()
      .describe(
        "The URL clients reach this server at, behind any proxy (sign-in redirects, links).",
      ),
    roles: z
      .array(z.enum(ROLES))
      .min(1)
      .default(["api", "worker"])
      .describe(
        "What this instance runs (X7.1): api (the HTTP API), worker (pollers, span assembly). Exactly one instance may run the worker.",
      ),
  })
  .prefault({})
  .describe("The HTTP server.");

export type ServerSection = z.output<typeof serverSection>;
