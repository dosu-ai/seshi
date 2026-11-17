import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { commandLine, readTextFile, writeFileAtomic } from "./files";

export const SKILL_MARKER =
  "<!-- written by seshi capture install; seshi capture uninstall removes it -->";

/** The `seshi` skill: turn Session Capture off or on for the session the agent is in, or say
 * whether it is captured. One text for every agent, since Cursor also reads Claude Code's and the
 * shared skill folders: the agent names itself with `--agent`. */
export function captureSkill(command: readonly string[]): string {
  const seshi = commandLine(command);
  return `---
name: seshi
description: Turn Session Capture off or on for this session, or show whether it is being captured. Use when the user runs /seshi or $seshi, or asks to stop, pause, resume or check session capture or seshi.
---
${SKILL_MARKER}

# Session Capture

seshi uploads this session to the team's session store as it happens. The user controls it.
In each command, \`<agent>\` is the agent you are: \`claude-code\` in Claude Code, \`codex\` in
Codex, \`cursor\` in Cursor.

- Off: run \`${seshi} capture off --session --agent <agent>\`. Nothing more of this session is
  uploaded, and what was already uploaded is retracted from the session store.
- On: run \`${seshi} capture on --session --agent <agent>\`. The session is uploaded again from
  its start.
- Status, or no word after the command: run \`${seshi} capture status --session --agent <agent>\`
  and tell the user what it says.

\`--session\` with no id means this session. seshi knows it in Claude Code (\`SESHI_SESSION_ID\`,
which its SessionStart hook sets) and in Codex (\`CODEX_THREAD_ID\`). Elsewhere it is the one
session of that agent seen in the current folder in the past day, so in a session that has not
finished a turn yet seshi may not know it: say so. When seshi answers that more than one ran
here, show the user the sessions it lists and ask which, then run the command again with
\`--session <id>\`.

In Codex, when the user's whole message is \`$seshi off\`, \`$seshi on\` or \`$seshi status\`,
seshi's own hook has already done it before you see the message, and shown the user the
result: do not run off or on. Run \`${seshi} capture status --session --agent codex\`, which only
reads, and confirm in one sentence.

Otherwise, off and on write seshi's state folder (\`~/.local/state/seshi\`, outside the
workspace), which a sandbox blocks. In a sandbox, run the command with escalated permissions,
saying it changes Session Capture for this session, and let the user approve it. If that is
refused, tell the user to type \`$seshi off\` or \`$seshi on\` as a message of its own in Codex,
or to run the command in a terminal.

Report the command's output to the user in one or two sentences. Do not run any other seshi
command unless the user asks for it.
`;
}

/** Write the skill at `path` unless someone else's skill is there. */
export function installSkill(
  path: string,
  command: readonly string[],
): { changed: string[]; notes: string[] } {
  const existing = readTextFile(path);
  if (existing !== undefined && !existing.includes(SKILL_MARKER)) {
    return { changed: [], notes: [`${path} is someone else's skill, so it was left as it is`] };
  }
  writeFileAtomic(path, captureSkill(command));
  return { changed: [path], notes: [] };
}

/** Remove the skill's folder at `path` when the skill there is seshi's. */
export function removeSkill(path: string): string[] {
  if (!readTextFile(path)?.includes(SKILL_MARKER)) return [];
  rmSync(dirname(path), { recursive: true, force: true });
  return [path];
}

export function isOurSkill(path: string): boolean {
  return readTextFile(path)?.includes(SKILL_MARKER) ?? false;
}
