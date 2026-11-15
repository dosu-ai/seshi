/** Which keys under an S3 source's prefix are sessions, and what a key says about its session
 * (F6.1): the `include` globs pick keys, and the optional `path` template reads the session id,
 * its format, its work and identity claims from the key. Claims never decide the owner, which is
 * always the source's service account (X5.4); they are recorded in metadata (X5.5). */

/** What a key's template match names. */
export interface KeyFields {
  session?: string;
  format?: string;
  project?: string;
  branch?: string;
  email?: string;
  name?: string;
  username?: string;
  git_email?: string;
  git_name?: string;
}

const PLACEHOLDERS: ReadonlySet<string> = new Set<keyof KeyFields>([
  "session",
  "format",
  "project",
  "branch",
  "email",
  "name",
  "username",
  "git_email",
  "git_name",
]);

function literal(text: string): string {
  return text.replace(/[.+^$()|[\]\\]/g, "\\$&");
}

/** A `path` template as a matcher: `{placeholder}` matches one path segment's worth (no `/`),
 * `*` the rest of a segment, `**` any number of segments, `?` one character; everything else is
 * literal. The whole key under the prefix must match. */
export class PathTemplate {
  private readonly pattern: RegExp;

  constructor(readonly template: string) {
    let source = "";
    let i = 0;
    while (i < template.length) {
      const ch = template[i] as string;
      if (ch === "{") {
        const end = template.indexOf("}", i);
        if (end < 0) throw new Error(`path template ${template}: an unmatched {`);
        const name = template.slice(i + 1, end);
        if (!PLACEHOLDERS.has(name)) {
          throw new Error(`path template ${template}: unknown placeholder {${name}}`);
        }
        if (source.includes(`(?<${name}>`)) {
          throw new Error(`path template ${template}: {${name}} appears twice`);
        }
        source += `(?<${name}>[^/]+?)`;
        i = end + 1;
      } else if (ch === "*" && template[i + 1] === "*") {
        // `**/` is any number of whole segments (none included); a trailing `**` is anything.
        if (template[i + 2] === "/") {
          source += "(?:[^/]*/)*";
          i += 3;
        } else {
          source += ".*";
          i += 2;
        }
      } else if (ch === "*") {
        source += "[^/]*";
        i++;
      } else if (ch === "?") {
        source += "[^/]";
        i++;
      } else if (ch === "}") {
        throw new Error(`path template ${template}: an unmatched }`);
      } else {
        source += literal(ch);
        i++;
      }
    }
    this.pattern = new RegExp(`^${source}$`);
  }

  /** What `key` (relative to the prefix) names, or null when it does not match. */
  match(key: string): KeyFields | null {
    const found = this.pattern.exec(key);
    if (!found) return null;
    const fields: KeyFields = {};
    for (const [name, value] of Object.entries(found.groups ?? {})) {
      if (value !== undefined && value !== "") fields[name as keyof KeyFields] = value;
    }
    return fields;
  }
}

/** The `include` globs (Bun's glob syntax), matched against the key under the prefix. Every
 * key is included when there are none. */
export class KeyFilter {
  private readonly globs: Bun.Glob[];

  constructor(include: readonly string[]) {
    this.globs = include.map((pattern) => new Bun.Glob(pattern));
  }

  includes(key: string): boolean {
    return this.globs.length === 0 || this.globs.some((glob) => glob.match(key));
  }
}

/** The user metadata (`x-amz-meta-seshi-*`) a writer can set on an object to say what it is,
 * which wins over the key's template: the same fields, with `-` for `_`. */
export function metadataFields(metadata: Readonly<Record<string, string>>): KeyFields {
  const fields: KeyFields = {};
  for (const name of PLACEHOLDERS) {
    const value = metadata[`seshi-${name.replace(/_/g, "-")}`]?.trim();
    if (value) fields[name as keyof KeyFields] = value;
  }
  return fields;
}
