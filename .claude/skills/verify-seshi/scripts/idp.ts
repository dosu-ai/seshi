/** A stand-in IdP for a verify-seshi run: the repository's `IdpServer` (tests/tooling/cli.ts),
 * served as a real process for `control-seshi up --idp`.
 *
 *   bun idp.ts <cert.pem> <key.pem> <info.json>
 *
 * `seshi serve` takes the IdP's keys only from an https `jwks_uri`, so the keys are served a
 * second time over TLS with the run's throwaway self-signed certificate (for 127.0.0.1), and
 * discovery names that URL. `seshi serve` trusts the certificate through NODE_EXTRA_CA_CERTS.
 *
 * It writes `{ issuer, jwks_uri, pid }` to <info.json> once both servers listen, and logs every
 * call to stdout as `<time> <METHOD> <path> [grant=<grant_type>] -> <status> [<error>]`.
 * SIGUSR1 forgets every refresh token it issued, so renewal answers invalid_grant from then on
 * (an IdP that stopped renewing: the person left, or the session was revoked). SIGTERM stops it.
 */

import { renameSync, writeFileSync } from "node:fs";
import { IdpServer } from "../../../../tests/tooling/cli";

const [certPath, keyPath, infoPath] = process.argv.slice(2);
if (!certPath || !keyPath || !infoPath) {
  console.error("usage: bun idp.ts <cert.pem> <key.pem> <info.json>");
  process.exit(2);
}

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

const idp = await IdpServer.start();
const keys = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  tls: { cert: Bun.file(certPath), key: Bun.file(keyPath) },
  fetch(request) {
    const path = new URL(request.url).pathname;
    log(`${request.method} ${path} (https) -> 200`);
    return Response.json(idp.idp.jwks);
  },
});
idp.jwksUri = `https://127.0.0.1:${keys.port}/jwks`;
idp.onCall = async (call, response, request) => {
  let detail = "";
  if (!response.ok && response.headers.get("content-type")?.includes("json")) {
    const { error } = (await response.clone().json()) as { error?: string };
    if (error) detail = ` ${error}`;
  }
  log(
    `${request.method} ${call.path}${call.grant ? ` grant=${call.grant}` : ""} -> ${response.status}${detail}`,
  );
};

process.on("SIGUSR1", () => {
  const n = idp.refreshTokens.size;
  idp.refreshTokens.clear();
  log(`SIGUSR1: forgot ${n} refresh token(s); renewal now answers invalid_grant`);
});
const stop = () => {
  log("stopping");
  keys.stop(true);
  idp.stop();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

// Written whole and renamed into place, so a reader never sees half of it.
writeFileSync(
  `${infoPath}.tmp`,
  `${JSON.stringify({ issuer: idp.url, jwks_uri: idp.jwksUri, pid: process.pid })}\n`,
);
renameSync(`${infoPath}.tmp`, infoPath);
log(`issuer ${idp.url}`);
log(`jwks_uri ${idp.jwksUri}`);
