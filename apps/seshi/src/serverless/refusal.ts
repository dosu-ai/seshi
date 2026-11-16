import { type AccessDenied, accessDeniedIn } from "@seshi/store";
import { EXIT } from "../cli/exit";
import { Refused } from "../cli/failures";

/** The message a request the bucket refused becomes (F11.4): the bucket's permissions are the
 * only roles, so it says which kind of key the request takes. */
export function refusedMessage(denied: AccessDenied, owner?: string): string {
  const { key, operation } = denied;
  const reading = operation === "read" || operation === "list" || operation === "stat";
  const folder = /^owners\/([^/]+)\//.exec(key)?.[1];
  if (folder !== undefined && owner !== undefined && folder !== owner) {
    return reading
      ? `this key can't read owners/${folder}/…: it can read only its own owner's folder`
      : `this key can't change owners/${folder}/…: that takes a key that can write every owner's folder`;
  }
  if (folder !== undefined && folder === owner) {
    return `this key can't ${reading ? "read" : "write"} its own folder owners/${folder}/: check the key's permissions, and that serverless.owner matches the folder it may write`;
  }
  if (!reading && (key.startsWith("config/") || key === "seshi.json")) {
    return `this key can't write ${key}: that takes a key that can write the bucket's shared settings`;
  }
  return `the bucket refused this key: ${operation} ${key || "/"}; check the key's permissions`;
}

/** `Refused` for an `AccessDenied` anywhere in `err`; `err` otherwise. */
export function refusalOf(err: unknown, owner?: string): unknown {
  const denied = accessDeniedIn(err);
  if (!denied) return err;
  return new Refused(EXIT.auth, "access_denied", refusedMessage(denied, owner));
}
