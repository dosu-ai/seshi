/** OpenCode sessions rebuilt from its database as OpenCode 1.x's `opencode export` prints them
 * (`{info, messages: [{info, parts}]}`): the one shape seshi keeps and uploads for OpenCode,
 * whether the plugin handed it over or seshi read it, and whichever OpenCode wrote it.
 *
 * - 1.x (`session`, `message`, `part`): exactly as OpenCode 1.18's export builds it, the session
 *   row as `Session.Info`, then its messages by creation time and id, each with its parts by id.
 * - 2.x (`session_v2`, `session_message`, and from 2.2.2 `session_part`): each message row becomes
 *   one 1.x message. Assistant content (text, reasoning, tool calls with their results) becomes
 *   1.x parts, from `session_part` rows by ordinal, then any still inline in the row; its usage
 *   goes on the message and a `step-finish` part. A user-run shell command becomes a `shell` tool
 *   call, a finished compaction its summary. Markers (`idle`, the `*-switched` rows) and
 *   unfinished compactions are left out. Ids of parts seshi makes up are `<message id>:<n>`. */

import type { Database } from "bun:sqlite";
import type { CaptureHost } from "@seshi/kit";

export type Row = Record<string, unknown>;

export const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const json = (value: unknown): unknown =>
  typeof value === "string" ? JSON.parse(value) : undefined;
const nullable = <T>(value: T | null | undefined): T | undefined => value ?? undefined;
const record = (value: unknown): Row =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Row) : {};
const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** A stored directory as OpenCode gives it back: with backslashes on Windows. */
export function directoryOf(row: Row, host: CaptureHost): string {
  const stored = text(row.directory) ?? "";
  if (host.platform !== "win32" || !(/^[A-Za-z]:\//.test(stored) || stored.startsWith("//"))) {
    return stored;
  }
  return stored.replaceAll("/", "\\");
}

/** The session row (`session` or `session_v2`, which share these columns) as 1.x's
 * `Session.Info` (its `fromRow`); fields it leaves undefined are dropped when the export is
 * written as JSON. */
function sessionInfo(row: Row, host: CaptureHost): Row {
  const counted =
    row.summary_additions != null || row.summary_deletions != null || row.summary_files != null;
  const revert = json(row.revert) as Row | undefined;
  const model = json(row.model) as Row | undefined;
  const permission = json(row.permission);
  // Keys in the order OpenCode's server writes `Session.Info` (its schema's), which is what the
  // plugin hands over: a session unchanged since then is rebuilt byte for byte.
  return {
    id: row.id,
    slug: row.slug,
    projectID: row.project_id,
    workspaceID: nullable(row.workspace_id),
    directory: directoryOf(row, host),
    path: nullable(row.path),
    parentID: nullable(row.parent_id),
    summary: counted
      ? {
          additions: row.summary_additions ?? 0,
          deletions: row.summary_deletions ?? 0,
          files: row.summary_files ?? 0,
          diffs: json(row.summary_diffs),
        }
      : undefined,
    cost: row.cost,
    tokens:
      row.tokens_input === undefined
        ? undefined
        : {
            input: row.tokens_input,
            output: row.tokens_output,
            reasoning: row.tokens_reasoning,
            cache: { read: row.tokens_cache_read, write: row.tokens_cache_write },
          },
    share: row.share_url ? { url: row.share_url } : undefined,
    title: nullable(row.title),
    agent: nullable(row.agent),
    model: model
      ? { id: model.id, providerID: model.providerID, variant: model.variant }
      : undefined,
    version: row.version,
    metadata: json(row.metadata),
    time: {
      created: row.time_created,
      updated: row.time_updated,
      compacting: nullable(row.time_compacting),
      archived: nullable(row.time_archived),
    },
    permission: Array.isArray(permission) ? permission : undefined,
    revert: revert?.messageID
      ? {
          messageID: revert.messageID,
          partID: revert.partID || undefined,
          snapshot: revert.snapshot,
          diff: revert.diff,
        }
      : undefined,
  };
}

/** A 1.x session, from OpenCode 1.x's tables. */
export function exportV1(db: Database, id: string, host: CaptureHost): string {
  const row = db.query<Row, [string]>("SELECT * FROM session WHERE id = ?").get(id);
  if (!row) throw new Error(`OpenCode session ${id} is no longer in its database`);
  const messages = db
    .query<Row, [string]>(
      "SELECT id, session_id, data FROM message WHERE session_id = ? ORDER BY time_created, id",
    )
    .all(id);
  const parts = new Map<string, Row[]>();
  const partRows = db
    .query<Row, [string]>(
      "SELECT id, message_id, session_id, data FROM part WHERE session_id = ? ORDER BY message_id, id",
    )
    .all(id);
  for (const part of partRows) {
    const list = parts.get(part.message_id as string) ?? [];
    list.push({
      id: part.id,
      sessionID: part.session_id,
      messageID: part.message_id,
      ...(json(part.data) as Row),
    });
    parts.set(part.message_id as string, list);
  }
  return JSON.stringify({
    info: sessionInfo(row, host),
    messages: messages.map((m) => ({
      info: { id: m.id, sessionID: m.session_id, ...(json(m.data) as Row) },
      parts: parts.get(m.id as string) ?? [],
    })),
  });
}

/** A 2.x session, from OpenCode 2.x's tables, in 1.x's shape. */
export function exportV2(db: Database, id: string, host: CaptureHost, partTable: boolean): string {
  const row = db.query<Row, [string]>("SELECT * FROM session_v2 WHERE id = ?").get(id);
  if (!row) throw new Error(`OpenCode session ${id} is no longer in its database`);
  const rows = db
    .query<Row, [string]>(
      "SELECT id, type, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq",
    )
    .all(id);
  const content = new Map<string, unknown[]>();
  if (partTable) {
    const partRows = db
      .query<Row, [string]>(
        "SELECT message_id, data FROM session_part WHERE session_id = ? ORDER BY message_id, ordinal",
      )
      .all(id);
    for (const part of partRows) {
      const list = content.get(part.message_id as string) ?? [];
      list.push(json(part.data));
      content.set(part.message_id as string, list);
    }
  }
  return JSON.stringify({
    info: sessionInfo(row, host),
    messages: rows.flatMap((r) => messageV2(r, id, content.get(r.id as string) ?? [])),
  });
}

function messageV2(row: Row, sessionID: string, partRows: unknown[]): Row[] {
  const id = row.id as string;
  const data = record(json(row.data));
  const time = record(data.time);
  const created = number(time.created) ?? number(row.time_created);
  const parts: Row[] = [];
  const add = (part: Row) =>
    parts.push({ ...part, id: `${id}:${parts.length}`, sessionID, messageID: id });
  const user = (extra: Row = {}) => ({ role: "user", id, sessionID, time: { created }, ...extra });
  switch (row.type) {
    case "user": {
      if (text(data.text)) add({ type: "text", text: data.text });
      for (const file of Array.isArray(data.files) ? data.files : []) {
        const f = record(file);
        add({
          type: "file",
          mime: f.mime ?? f.mediaType,
          filename: f.name,
          url: text(f.uri) ?? text(f.url) ?? "",
        });
      }
      for (const agent of Array.isArray(data.agents) ? data.agents : []) {
        const a = record(agent);
        add({ type: "agent", name: a.name ?? a.id });
      }
      return [{ info: user(data.agent ? { agent: data.agent } : {}), parts }];
    }
    case "synthetic":
    case "system":
    case "skill":
      if (!text(data.text)) return [];
      add({ type: "text", text: data.text, synthetic: true });
      return [{ info: user(), parts }];
    case "assistant": {
      const items = [...partRows, ...(Array.isArray(data.content) ? data.content : [])];
      for (const item of items) {
        const part = contentV2(record(item));
        if (part) add(part);
      }
      const tokens = data.tokens;
      if (tokens !== undefined || data.cost !== undefined) {
        add({ type: "step-finish", reason: data.finish, cost: data.cost, tokens });
      }
      const model = record(data.model);
      return [
        {
          info: {
            role: "assistant",
            id,
            sessionID,
            modelID: model.id,
            providerID: model.providerID,
            agent: data.agent,
            cost: data.cost,
            tokens,
            finish: data.finish,
            error: data.error,
            time: { created, completed: number(time.completed) },
          },
          parts,
        },
      ];
    }
    case "shell": {
      const exit = number(data.exit);
      const output = record(data.output);
      const status = data.status === "running" ? "running" : exit === 0 ? "completed" : "error";
      const out = text(output.output) ?? text(data.output) ?? "";
      add({
        type: "tool",
        callID: data.shellID,
        tool: "shell",
        state: {
          status,
          input: { command: data.command },
          ...(status === "error" ? { error: `exit ${exit ?? data.status}`, output: out } : {}),
          ...(status === "completed" ? { output: out } : {}),
          time: { start: created, end: number(time.completed) },
        },
      });
      return [{ info: { role: "assistant", id, sessionID, time: { created } }, parts }];
    }
    case "compaction":
      if (data.status !== "completed" || !text(data.summary)) return [];
      add({ type: "text", text: data.summary });
      return [
        {
          info: { role: "assistant", id, sessionID, summary: true, time: { created } },
          parts,
        },
      ];
    default:
      return [];
  }
}

/** One piece of 2.x assistant content as a 1.x part; undefined for a kind seshi does not know. */
function contentV2(item: Row): Row | undefined {
  const time = record(item.time);
  switch (item.type) {
    case "text":
      return { type: "text", text: item.text };
    case "reasoning":
      return {
        type: "reasoning",
        text: item.text,
        ...(item.time ? { time: { start: time.created, end: time.completed } } : {}),
      };
    case "tool": {
      const state = record(item.state);
      const status =
        state.status === "completed" ? "completed" : state.status === "error" ? "error" : "running";
      let input = state.input;
      if (typeof input === "string") {
        try {
          input = JSON.parse(input);
        } catch {
          input = { raw: input };
        }
      }
      const output = Array.isArray(state.content)
        ? state.content
            .map(record)
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n")
        : undefined;
      const error = record(state.error);
      return {
        type: "tool",
        callID: item.id,
        tool: item.name,
        state: {
          status,
          input: input ?? {},
          ...(status === "completed" ? { output: output ?? "" } : {}),
          ...(status === "error"
            ? {
                error: text(error.message) ?? text(state.error) ?? "error",
                ...(output ? { output } : {}),
              }
            : {}),
          time: { start: time.ran ?? time.created, end: time.completed },
        },
      };
    }
    default:
      return undefined;
  }
}
