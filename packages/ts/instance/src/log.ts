import type { ConnectorLogger } from "@seshi/kit";

export type Logger = ConnectorLogger;

export const quietLogger: Logger = { info() {}, warn() {}, error() {} };

export function lineLogger(out: (line: string) => void, err: (line: string) => void): Logger {
  return {
    info: (line) => out(`seshi: ${line}`),
    warn: (line) => err(`seshi: warning: ${line}`),
    error: (line) => err(`seshi: error: ${line}`),
  };
}
