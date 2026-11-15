/** Where an instance's log lines go. `seshi serve` prints them; tests and one-shot commands
 * collect or drop them. The same shape as a connector's logger (`@seshi/kit`). */

import type { ConnectorLogger } from "@seshi/kit";

export type Logger = ConnectorLogger;

/** Drops every line. */
export const quietLogger: Logger = { info() {}, warn() {}, error() {} };

/** Lines to `out` and `err`, prefixed `seshi:` (warnings and errors say so). */
export function lineLogger(out: (line: string) => void, err: (line: string) => void): Logger {
  return {
    info: (line) => out(`seshi: ${line}`),
    warn: (line) => err(`seshi: warning: ${line}`),
    error: (line) => err(`seshi: error: ${line}`),
  };
}
