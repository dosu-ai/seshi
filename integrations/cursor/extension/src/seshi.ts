import { execFile } from "node:child_process";

/** What `seshi statusline --agent cursor --json --folder …` answers. Older seshi answers
 * without `session`. */
export interface StatusJson {
  capturing: boolean;
  level: string;
  reason: string;
  frozen_at?: number;
  problems: string[];
  session?: { session_id: string; by: string; at?: string; state?: string } | null;
  candidates?: { session_id: string; by: string; at?: string }[];
  attention?: "warn" | "error" | null;
  installed?: boolean;
  watch?: string[];
}

export type RunResult =
  | { ok: true; json: unknown }
  | { ok: false; kind: "missing" | "failed"; message: string };

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
}

/** Run seshi with `args` and parse its one JSON document. Never throws. */
export function runSeshi(
  program: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const platform = options.platform ?? process.platform;
  const shell = platform === "win32" && /\.(cmd|bat)$/i.test(program);
  return new Promise((resolve) => {
    execFile(
      program,
      [...args],
      {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        timeout: options.timeoutMs ?? 10_000,
        windowsHide: true,
        shell,
        env: { ...process.env, NO_COLOR: "1" },
      },
      (err, stdout, stderr) => {
        const code = (err as NodeJS.ErrnoException | null)?.code;
        if (code === "ENOENT") {
          resolve({ ok: false, kind: "missing", message: `${program} was not found` });
          return;
        }
        const text = String(stdout).trim() || String(stderr).trim();
        try {
          const json = JSON.parse(text);
          if (err && typeof json === "object" && json && "error" in json) {
            const message = (json as { error?: { message?: string } }).error?.message;
            resolve({ ok: false, kind: "failed", message: message ?? String(err) });
          } else {
            resolve({ ok: true, json });
          }
        } catch {
          resolve({
            ok: false,
            kind: "failed",
            message: String(stderr).trim() || (err ? String(err.message) : "no answer"),
          });
        }
      },
    );
  });
}

export function statusArgs(input: {
  folders: readonly string[];
  focused?: string;
  selected?: readonly string[];
}): string[] {
  return [
    "statusline",
    "--agent",
    "cursor",
    "--json",
    ...input.folders.flatMap((f) => ["--folder", f]),
    ...(input.focused ? ["--session", input.focused] : []),
    ...(input.selected && input.selected.length > 0
      ? ["--selected", input.selected.join(",")]
      : []),
  ];
}
