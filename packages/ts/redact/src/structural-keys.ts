const RECORD_IDENTITY_KEYS = ["id", "tool_call_id", "role", "timestamp", "source", "name"];

const NATIVE_IDENTITY_KEYS = [
  ...RECORD_IDENTITY_KEYS,
  "uuid",
  "type",
  "tool_use_id",
  "toolCallId",
  "call_id",
  "callID",
  "parentUuid",
  "parent_id",
  "parentId",
  "sessionId",
  "session_id",
  "sessionID",
  "messageID",
  "messageId",
  "requestId",
  "request_id",
];

const RECORD_ENTROPY_EXEMPT_KEYS = ["git_branch"];

const NATIVE_ENTROPY_EXEMPT_KEYS = [...RECORD_ENTROPY_EXEMPT_KEYS, "gitBranch"];

export const RECORD_UNREDACTED_KEYS: ReadonlySet<string> = new Set([
  ...RECORD_IDENTITY_KEYS,
  ...RECORD_ENTROPY_EXEMPT_KEYS,
]);

export const NATIVE_UNREDACTED_KEYS: ReadonlySet<string> = new Set([
  ...NATIVE_IDENTITY_KEYS,
  ...NATIVE_ENTROPY_EXEMPT_KEYS,
]);
