import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { CAPTURE_COMMAND } from "./capture";
import { commandLine, readTextFile, writeFileAtomic } from "./files";

export const SKILL_MARKER =
  "<!-- written by seshi capture install; seshi capture uninstall removes it -->";

/** The skill's folder name before it was `session-capture`. seshi's own skill there is removed
 * by install and by uninstall; anyone else's is left. */
const OLD_SKILL_NAME = "seshi";

/** The `session-capture` skill: turn Session Capture off or on for the session the agent is in,
 * say whether it is captured, or share it with the org (and unshare it). One text for every agent, since Cursor also reads Claude Code's
 * and the shared skill folders: the agent names itself with `--agent`. */
export function captureSkill(command: readonly string[]): string {
  const seshi = commandLine(command);
  const name = CAPTURE_COMMAND;
  return `---
name: ${name}
description: Turn Session Capture off or on for this session, show whether it is being captured, or share it with the team (or unshare it). Use when the user runs /${name} or $${name}, or asks to stop, pause, resume or check session capture or seshi, or to share or unshare this session.
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
- Share (or "share this session"): run \`${seshi} share --session --agent <agent>\`. Every
  member of the team may then read the session, and its subagents'.
- Unshare: run \`${seshi} unshare --session --agent <agent>\`. Only its owner (and admins) may
  read it again.

\`--session\` with no id means this session. seshi knows it in Claude Code (\`SESHI_SESSION_ID\`,
which its SessionStart hook sets) and in Codex (\`CODEX_THREAD_ID\`). Elsewhere it is the one
session of that agent seen in the current folder in the past day, so in a session that has not
finished a turn yet seshi may not know it: say so. When seshi answers that more than one ran
here, show the user the sessions it lists and ask which, then run the command again with
\`--session <id>\`.

In Codex and Cursor, when the user's whole message is \`$${name} off\`, \`$${name} on\` or
\`$${name} status\` (\`/${name} …\` in Cursor), seshi's own hook has already done it before
you see the message, and shown the user the result: do not run off or on. Run
\`${seshi} capture status --session --agent <agent>\`, which only reads, and confirm in one
sentence.

Share and unshare change the session in the session store, so they need the network. Until its
first turn has finished, seshi has not uploaded the session and says so: tell the user to ask
again after this turn. In a sandbox, run them with escalated permissions, saying they change who
may read this session.

Otherwise, off and on write seshi's state folder (\`~/.local/state/seshi\`, outside the
workspace), which a sandbox blocks. In a sandbox, run the command with escalated permissions,
saying it changes Session Capture for this session, and let the user approve it. If that is
refused, tell the user to type \`$${name} off\` or \`$${name} on\` as a message of its own in
Codex (\`/${name} off\` in Cursor), or to run the command in a terminal.

Report the command's output to the user in one or two sentences. Do not run any other seshi
command unless the user asks for it.
`;
}

/** The skill's file in an agent's skills folder (`~/.claude/skills`, `~/.agents/skills`, …). */
export function skillFile(skillsDir: string): string {
  return join(skillsDir, CAPTURE_COMMAND, "SKILL.md");
}

/** Write the skill into `skillsDir` unless someone else's skill is there, and remove seshi's own
 * skill under its old name. */
export function installSkill(
  skillsDir: string,
  command: readonly string[],
): { changed: string[]; notes: string[] } {
  const path = skillFile(skillsDir);
  const existing = readTextFile(path);
  if (existing !== undefined && !existing.includes(SKILL_MARKER)) {
    return { changed: [], notes: [`${path} is someone else's skill, so it was left as it is`] };
  }
  writeFileAtomic(path, captureSkill(command));
  const old = removeOne(join(skillsDir, OLD_SKILL_NAME, "SKILL.md"));
  return { changed: [path], notes: old.map((p) => `removed ${p}, the skill's old name`) };
}

/** Remove the skill's folder from `skillsDir`, under its name and its old one, where the skill
 * there is seshi's. */
export function removeSkill(skillsDir: string): string[] {
  return [skillFile(skillsDir), join(skillsDir, OLD_SKILL_NAME, "SKILL.md")].flatMap(removeOne);
}

/** Remove the folder of the skill at `path` when the skill there is seshi's. */
function removeOne(path: string): string[] {
  if (!isOurSkill(path)) return [];
  rmSync(dirname(path), { recursive: true, force: true });
  return [path];
}

export function isOurSkill(path: string): boolean {
  return readTextFile(path)?.includes(SKILL_MARKER) ?? false;
}
