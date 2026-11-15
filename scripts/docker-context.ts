/** What the image build (apps/seshi/Dockerfile) can see of the repository: `.dockerignore`
 * leaves out tests, testdata, docs and more, so a source file the binary imports from one of
 * those paths compiles here and fails inside `docker build`. scripts/docker-context.test.ts
 * bundles `apps/seshi/src/main.ts` and checks every workspace file it pulls in against these
 * rules.
 *
 * The rules follow Docker's: patterns are relative to the context root, `*` and `?` stay
 * inside one path segment, `**` crosses any number of them, a pattern that matches a folder
 * leaves out everything under it, `!` puts a path back, and the last matching line wins. */

import { readFileSync } from "node:fs";
import { join } from "node:path";

interface Rule {
  negate: boolean;
  regex: RegExp;
}

function toRegex(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        // `**/` also matches no folder at all.
        if (pattern[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  // A folder pattern leaves out everything below it too.
  return new RegExp(`^${out}(?:/.*)?$`);
}

/** The rules of a `.dockerignore` file's text. */
export function parseDockerignore(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const negate = line.startsWith("!");
    if (negate) line = line.slice(1).trim();
    line = line.replace(/^\/+/, "").replace(/\/+$/, "");
    if (line === "") continue;
    rules.push({ negate, regex: toRegex(line) });
  }
  return rules;
}

/** Whether `path` (relative to the context root, `/`-separated) is left out of the context. */
export function isIgnored(rules: readonly Rule[], path: string): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.regex.test(path)) ignored = !rule.negate;
  }
  return ignored;
}

/** The repository's own `.dockerignore` rules. */
export function repositoryRules(root: string): Rule[] {
  return parseDockerignore(readFileSync(join(root, ".dockerignore"), "utf8"));
}
