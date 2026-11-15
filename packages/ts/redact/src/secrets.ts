/** Secret redaction over free text: pattern passes for the shapes credentials take, then an
 * entropy pass for what no pattern knows. Biased toward over-redaction; deliberately no disable
 * switch. */

/** Every replacement is `[redacted:<kind>]`, the kind naming what was matched. */
const REDACTION_MARKER = "[redacted:";

type RedactionCounts = Record<string, number>;

/** Every rule id `redactSecrets` can count, in the order its passes run. The built-in pack
 * (`packs/builtin.toml`) lists each of them, so an operator pack can turn one off by id (F2.1). */
export const BUILTIN_SECRET_KINDS: readonly string[] = [
  "private-key",
  "url-credentials",
  "aws-secret",
  "seshi-token",
  "aws-access-key",
  "quoted-secret",
  "bearer-token",
  "jwt",
  "credential",
  "github-token",
  "gitlab-token",
  "stripe-key",
  "user-key",
  "anthropic-key",
  "openai-key",
  "groq-key",
  "xai-key",
  "huggingface-token",
  "npm-token",
  "slack-token",
  "google-api-key",
  "pulumi-token",
  "supabase-token",
  "provider-token",
  "entropy",
];

export interface RedactionResult {
  text: string;
  /** Total replacements across all kinds. */
  count: number;
  /** Replacements per kind, e.g. `{ "github-token": 2, entropy: 1 }`. */
  counts: RedactionCounts;
}

const awsAccessKeyRE = /A(?:KIA|SIA)[0-9A-Z]{16}/g;
// A key name starts a word, or follows an escaped line break: in a JSONL transcript (and in a
// tool call's JSON `args`) every newline inside a string is the two characters `\n`, so an env
// var at the start of a line reads `\nAWS_SECRET_ACCESS_KEY=` and `\b` sees `n` glued to `A`.
const keyStart = String.raw`(?<![A-Za-z0-9_])|(?<=\\[nrt])`;
const awsSecretRE = new RegExp(
  String.raw`(?:${keyStart})(aws[_-]?secret[_-]?access[_-]?key)(\\*['"]?\s*[:=]\s*)(\\*['"]?)([A-Za-z0-9/+=_-]{32,})((?:\\*['"])?)`,
  "gi",
);
// Matches keys embedded in larger identifiers; the `\\*` runs tolerate the escaped-JSON
// quotes (`api_key\":`) that agents paste constantly.
const genericKVRE = new RegExp(
  String.raw`(?:${keyStart})([\w.-]{0,64}?(?:api[_-]?key|secret|token|passwd|password|authorization))(\\*['"]?\s*[:=]\s*)(\\*['"]?)([A-Za-z0-9/+=._-]{16,})((?:\\*['"])?)`,
  "gi",
);
// OAuth session tokens can be shorter than genericKVRE's 16-character floor
// (Supabase refresh tokens are 12), so a key that names an access, refresh, or id token needs
// only 8 (`"refresh_token": "abc123def456"`).
const authTokenKVRE = new RegExp(
  String.raw`(?:${keyStart})([\w.-]{0,64}?(?:access|refresh|id)[_-]?token)(\\*['"]?\s*[:=]\s*)(\\*['"]?)([A-Za-z0-9/+=._-]{8,})((?:\\*['"])?)`,
  "gi",
);
// Credential env vars can end in plain _KEY (GROQ_KEY) or _KEY_ID (R2_ACCESS_KEY_ID, AWS's
// AKIA… when it is not in that shape); case-sensitive on purpose so lowercase `cache_key:`
// never matches.
const envKeyRE = new RegExp(
  String.raw`(?:${keyStart})([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_KEY(?:_ID)?)(\\*['"]?\s*[:=]\s*)(\\*['"]?)([A-Za-z0-9/+=._-]{16,})((?:\\*['"])?)`,
  "g",
);
// The same shape in the languages people actually type in — an English-only
// list left "пароль: …" in the clear.
const genericKVIntlRE =
  /(парол[ьяею]|токен[ауы]?|секрет[ауы]?|ключ[аеиуом]?|contraseña|senha|passwort|密码|密碼|パスワード|비밀번호)(\\*['"]?\s*[:=]\s*)(\\*['"]?)([A-Za-z0-9/+=._-]{16,})((?:\\*['"])?)/gi;
// A credential shown the way a console shows it: the label on one line, the value alone on
// the next ("Secret Access Key\n93b6…"), no assignment anywhere. The value is one token on its
// own line, so prose under a heading ("API key\nThe key lives in …") never matches; hex is
// allowed, since that is what access keys are and nothing else here would catch them.
// The separator after the label is `[ \t]*(?::[ \t]*)?`, not `[ \t]*:?[ \t]*`: with the colon
// optional, two runs of blanks side by side split a long run every possible way before failing,
// quadratic in it (a label and 240k tabs took 54 s). Both match the same text.
const labeledLineRE =
  /((?:^|\n|\\n)[ \t]*(?:secret[ _-]?access[ _-]?key|access[ _-]?key[ _-]?id|secret[ _-]?key|api[ _-]?key|token[ _-]?value|access[ _-]?token|client[ _-]?secret|password|secret|token)[ \t]*(?::[ \t]*)?(?:\n|\\n)+[ \t]*)([A-Za-z0-9/+=._-]{16,})(?=[ \t]*(?:\n|\\n|$|["']))/gi;
const bearerRE = /\b(Bearer|Basic)(\s+)([A-Za-z0-9._~+/=-]{16,})/gi;
// A secret named in prose and quoted rather than assigned; the required quotes make it
// safe to be this loose, since an unquoted mention matches nothing.
const quotedSecretRE =
  /\b(password|passwd|pwd|secret|token|api[_-]?key)(\s+(?:is\s+|was\s+|for\s+)?)(\\*["'`])([^"'`\n]{6,80})(\\*["'`])/gi;
const pemPrivateRE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY[A-Z0-9 ]*-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY[A-Z0-9 ]*-----/g;
// Provider prefixes. sk- allows internal hyphens/underscores so hyphenated
// formats (sk-ant-…, sk-proj-…) are covered. `sk_user_` is a per-user key shape whose tail is
// `secrets.token_urlsafe` output, so it spans '-' and '_'.
// seshi's own opaque tokens (X5.9): `seshi_<20 hex>_<43 base64url>`. The secret can end in `-`,
// so the end is "no token character next", not `\b`.
const seshiTokenRE = /(?<![A-Za-z0-9_-])seshi_[0-9a-f]{20}_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;
// An `sk-` key is `sk-`, then `[A-Za-z0-9_-]*[A-Za-z0-9]{20,}\b`: as written, that rescans the
// rest of the token run from every way of splitting it, quadratic on `sk-` and a long run that
// does not end in 20 alphanumerics (and again from every `sk-` inside one). So the expression
// only finds where an `sk-` starts (the last alternative, not subject to the closing `\b`), and
// `skKeyEnd` finds where the key ends, the same end the pattern gives, in one pass per run.
const providerRE =
  /\b(?:(gh[opsur]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|sk_user_[A-Za-z0-9_-]{8,}|gsk_[A-Za-z0-9]{20,}|xai-[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{30,}|xox[bpcs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|pul-[0-9a-f]{40}|sbp_[0-9a-f]{40})\b|sk-)/g;
// The second alternative drops the leading \b, which would miss a JWT glued to a
// word character: the `n` of an escaped `\n` in JSON-in-a-string, or URL-encoding's `%3D`.
// Without the boundary it requires the payload to open with `eyJ` too (both segments are JSON
// objects), so an identifier like `keyJsonSchema.properties.name` stays. The lookbehind allows
// at most 8 glued characters: an unbounded start would rescan a long run of base64url from
// every `eyJ` inside it, which is quadratic.
const jwtRE =
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b|(?<=(?:^|[^A-Za-z0-9_-])[A-Za-z0-9_-]{1,8})eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g;
// A URL with credentials is what `\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\s/@:]*):([^\s]+)@([^\s]+)`
// matches; `replaceConnUrls` finds exactly those matches without the expression. The password
// is greedy, so one containing '@' (user:p@ss@host) splits on the last '@' and is redacted
// whole. As an expression that rescanned the rest of a run without whitespace from every `://`
// in it (`a://:b` repeated, or a minified bundle full of URLs), which is quadratic.

// Cheap substring hints checked first, keeping the regexes off the vast majority
// of messages, which contain no credentials at all.
// Labels the labeled-line rule can start from; checked as substrings before the regex runs.
const labelHints = ["key", "secret", "token", "password"];
const kvHints = [
  "key",
  "secret",
  "token",
  "passw",
  "authorization",
  "пароль",
  "парол",
  "токен",
  "секрет",
  "ключ",
  "contraseña",
  "senha",
  "mot de passe",
  "passwort",
  "密码",
  "密碼",
  "パスワード",
  "비밀번호",
];

const providerHints = [
  "ghp_",
  "gho_",
  "ghs_",
  "ghu_",
  "ghr_",
  "github_pat_",
  "glpat-",
  "sk_",
  "rk_",
  "sk-",
  "gsk_",
  "xai-",
  "hf_",
  "npm_",
  "xox",
  "AIza",
  "pul-",
  "sbp_",
];

function isWordChar(code: number): boolean {
  return (
    (code >= 97 && code <= 122) || // a-z
    (code >= 65 && code <= 90) || // A-Z
    (code >= 48 && code <= 57) || // 0-9
    code === 95 || // _
    code === 45 || // -
    code === 46 // .
  );
}

function isSpaceChar(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";
}

/** Reports whether any key-ish word is followed by an assignment; genericKVRE cannot match
 * otherwise, so skipping on a negative cannot change what is redacted. */
function kvAssignmentNearby(lower: string): boolean {
  for (const hint of kvHints) {
    let at = 0;
    for (;;) {
      const i = lower.indexOf(hint, at);
      if (i < 0) break;
      if (assignmentFollows(lower, i + hint.length)) return true;
      at = i + 1;
    }
  }
  return false;
}

/** Skips what genericKVRE allows between name and value, looking for the required ':' or '=';
 * chars >= 0x80 continue a non-ASCII word so "парол" reaches the ':' behind "пароля". */
function assignmentFollows(s: string, start: number): boolean {
  let i = start;
  while (i < s.length && (isWordChar(s.charCodeAt(i)) || s.charCodeAt(i) >= 0x80)) i++;
  while (i < s.length && (isSpaceChar(s[i]) || s[i] === "'" || s[i] === '"' || s[i] === "\\")) i++;
  return i < s.length && (s[i] === ":" || s[i] === "=");
}

function containsAny(s: string, hints: readonly string[]): boolean {
  return hints.some((h) => s.includes(h));
}

function add(counts: RedactionCounts, kind: string, n: number): void {
  if (n > 0) counts[kind] = (counts[kind] ?? 0) + n;
}

function replaceWhole(s: string, re: RegExp, kind: string, counts: RedactionCounts): string {
  let n = 0;
  const out = s.replace(re, () => {
    n += 1;
    return `${REDACTION_MARKER}${kind}]`;
  });
  add(counts, kind, n);
  return out;
}

function replaceSubmatch(
  s: string,
  re: RegExp,
  kind: string,
  counts: RedactionCounts,
  repl: (groups: string[]) => string,
): string {
  let n = 0;
  const out = s.replace(re, (...args) => {
    // args = [match, ...captures, offset, whole string]
    const groups = args.slice(0, -2) as string[];
    const next = repl(groups);
    // A match whose secret is already a marker (`user:[redacted:url-credentials]@host`) comes
    // out as it went in: nothing was redacted, so nothing is counted, and redacting redacted
    // text counts nothing (backfill and a whole upload's prefix rely on it).
    if (next !== groups[0]) n += 1;
    return next;
  });
  add(counts, kind, n);
  return out;
}

/** Emit the closing quote only when an opening quote was captured. */
function closingQuote(open: string, close: string): string {
  return open === "" ? "" : close;
}

const isAlnum = (code: number) =>
  (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || (code >= 48 && code <= 57);
const isTokenChar = (code: number) => isAlnum(code) || code === 95 || code === 45; // _ -
/** What `\b` counts as a word character (no `u` flag): `[A-Za-z0-9_]`. */
const isRegexWord = (code: number) => isAlnum(code) || code === 95;

/** For an `sk-` at `at`: where its run of `[A-Za-z0-9_-]` ends, and where the key ends, or -1
 * when it has none. The key ends where `sk-[A-Za-z0-9_-]*[A-Za-z0-9]{20,}\b` would end it: at
 * the last end of a `-`-separated part of the run, after the `sk-`, whose last 20 characters
 * are alphanumeric. Any later `sk-` in the same run (one just after a `-`) ends at the same
 * place, or has no key when that place is not past its own `sk-`. */
function skKeyEnd(s: string, at: number): { runEnd: number; keyEnd: number } {
  let keyEnd = -1;
  let alnum = 0;
  let i = at + 3;
  for (; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (!isTokenChar(code)) break;
    if (code === 45) {
      if (alnum >= 20) keyEnd = i;
      alnum = 0;
    } else {
      alnum = isAlnum(code) ? alnum + 1 : 0;
    }
  }
  if (alnum >= 20) keyEnd = i;
  return { runEnd: i, keyEnd };
}

function replaceProvider(s: string, counts: RedactionCounts, off: Off): string {
  let out = "";
  let last = 0;
  // The `sk-` key end of the token run being read, kept while the run lasts.
  let run = { runEnd: -1, keyEnd: -1 };
  const re = new RegExp(providerRE.source, "g");
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const at = m.index;
    let end = at + m[0].length;
    if (m[1] === undefined) {
      if (at >= run.runEnd) run = skKeyEnd(s, at);
      if (run.keyEnd <= at + 3) {
        // No key here; the pattern moves on to the next position, as it would.
        re.lastIndex = at + 1;
        continue;
      }
      end = run.keyEnd;
      re.lastIndex = end;
    }
    const kind = providerKind(s.slice(at, end));
    if (off?.has(kind)) continue;
    add(counts, kind, 1);
    out += `${s.slice(last, at)}${REDACTION_MARKER}${kind}]`;
    last = end;
  }
  return last === 0 ? s : out + s.slice(last);
}

const isSchemeChar = (code: number) => isAlnum(code) || code === 43 || code === 46 || code === 45; // + . -
const isLetter = (code: number) => (code >= 97 && code <= 122) || (code >= 65 && code <= 90);
/** What `\s` matches. */
const isRegexSpace = (code: number) =>
  (code >= 9 && code <= 13) ||
  code === 32 ||
  code === 0xa0 ||
  code === 0x1680 ||
  (code >= 0x2000 && code <= 0x200a) ||
  code === 0x2028 ||
  code === 0x2029 ||
  code === 0x202f ||
  code === 0x205f ||
  code === 0x3000 ||
  code === 0xfeff;

/** Every URL with credentials in `s` (see `url-credentials` above) with its password replaced,
 * the matches `\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\s/@:]*):([^\s]+)@([^\s]+)` finds, found in
 * time linear in `s`: each scan below covers a stretch no other `://` scans again. */
function replaceConnUrls(s: string, counts: RedactionCounts): string {
  let out = "";
  let last = 0;
  let n = 0;
  // The run without whitespace being read: where it ends, and its last '@' with a character
  // after it (-1 when none).
  let runEnd = -1;
  let lastAt = -1;
  let from = 0;
  for (let c = s.indexOf("://", from); c >= 0; c = s.indexOf("://", from)) {
    from = c + 3;
    // The scheme: the leftmost letter at a word boundary in the scheme characters before `://`.
    let b = c;
    while (b > last && isSchemeChar(s.charCodeAt(b - 1))) b--;
    let start = -1;
    for (let i = b; i < c; i++) {
      if (isLetter(s.charCodeAt(i)) && (i === 0 || !isRegexWord(s.charCodeAt(i - 1)))) {
        start = i;
        break;
      }
    }
    if (start < 0) continue;
    // The user, up to the ':' that must follow it.
    let user = c + 3;
    for (; user < s.length; user++) {
      const code = s.charCodeAt(user);
      if (code === 47 || code === 64 || code === 58 || isRegexSpace(code)) break; // / @ :
    }
    if (s.charCodeAt(user) !== 58) continue;
    const pass = user + 1;
    if (pass >= runEnd) {
      let at = -1;
      let before = -1;
      let i = pass;
      for (; i < s.length && !isRegexSpace(s.charCodeAt(i)); i++) {
        if (s.charCodeAt(i) === 64) {
          before = at;
          at = i;
        }
      }
      runEnd = i;
      // A trailing '@' has no host after it; the one before it, if any, is the split.
      lastAt = at === runEnd - 1 ? before : at;
    }
    // The password is at least one character.
    if (lastAt < pass + 1) continue;
    const whole = s.slice(start, runEnd);
    const next = `${s.slice(start, user)}:[redacted:url-credentials]@${s.slice(lastAt + 1, runEnd)}`;
    if (next !== whole) n += 1;
    out += s.slice(last, start) + next;
    last = runEnd;
    from = runEnd;
  }
  add(counts, "url-credentials", n);
  return last === 0 ? s : out + s.slice(last);
}

/** Which provider's token `v` (a provider-pattern match) is: the rule id it counts under. */
function providerKind(v: string): string {
  if (/^(gh[opsur]_|github_pat_)/.test(v)) return "github-token";
  if (/^(?:sk|rk)_(?:live|test)_/.test(v)) return "stripe-key";
  if (v.startsWith("sk_user_")) return "user-key";
  if (v.startsWith("sk-ant-")) return "anthropic-key";
  if (v.startsWith("sk-")) return "openai-key";
  if (v.startsWith("gsk_")) return "groq-key";
  if (v.startsWith("xai-")) return "xai-key";
  if (v.startsWith("hf_")) return "huggingface-token";
  if (v.startsWith("glpat-")) return "gitlab-token";
  if (v.startsWith("npm_")) return "npm-token";
  if (/^xox[bpcs]-/.test(v)) return "slack-token";
  if (v.startsWith("AIza")) return "google-api-key";
  if (v.startsWith("pul-")) return "pulumi-token";
  if (v.startsWith("sbp_")) return "supabase-token";
  return "provider-token";
}

/** Rule ids turned off; none when absent. */
type Off = ReadonlySet<string> | undefined;

/** `text` with every built-in secret pattern applied, except the rules in `off` (an operator
 * pack turned them off by id, F2.1). */
export function redactSecrets(text: string, off?: ReadonlySet<string>): RedactionResult {
  const counts: RedactionCounts = {};
  if (text === "") return { text, count: 0, counts };
  let s = text;
  const lower = s.toLowerCase();
  const on = (kind: string) => !off?.has(kind);

  if (on("private-key") && s.includes("-----BEGIN")) {
    s = replaceWhole(s, pemPrivateRE, "private-key", counts);
  }
  if (on("url-credentials") && s.includes("://")) {
    s = replaceConnUrls(s, counts);
  }
  if (on("aws-secret") && lower.includes("aws")) {
    s = replaceSubmatch(
      s,
      awsSecretRE,
      "aws-secret",
      counts,
      (m) => `${m[1]}${m[2]}${m[3]}[redacted:aws-secret]${closingQuote(m[3], m[5])}`,
    );
  }
  if (on("seshi-token") && s.includes("seshi_")) {
    s = replaceWhole(s, seshiTokenRE, "seshi-token", counts);
  }
  if (on("aws-access-key") && (s.includes("AKIA") || s.includes("ASIA"))) {
    s = replaceWhole(s, awsAccessKeyRE, "aws-access-key", counts);
  }
  if (
    on("quoted-secret") &&
    (lower.includes("password") ||
      lower.includes("passwd") ||
      lower.includes("pwd") ||
      lower.includes("secret") ||
      lower.includes("token") ||
      lower.includes("api key") ||
      lower.includes("api_key") ||
      lower.includes("apikey"))
  ) {
    s = replaceSubmatch(
      s,
      quotedSecretRE,
      "quoted-secret",
      counts,
      (m) => `${m[1]}${m[2]}${m[3]}[redacted:quoted-secret]${m[5]}`,
    );
  }
  if (on("bearer-token") && (lower.includes("bearer") || lower.includes("basic "))) {
    s = replaceSubmatch(
      s,
      bearerRE,
      "bearer-token",
      counts,
      (m) => `${m[1]}${m[2]}[redacted:bearer-token]`,
    );
  }
  if (on("jwt") && s.includes("eyJ")) {
    s = replaceWhole(s, jwtRE, "jwt", counts);
  }
  if (on("credential") && containsAny(lower, labelHints)) {
    s = replaceSubmatch(
      s,
      labeledLineRE,
      "credential",
      counts,
      (m) => `${m[1]}[redacted:credential]`,
    );
  }
  if (on("credential") && kvAssignmentNearby(lower)) {
    const kvRepl = (m: string[]) =>
      `${m[1]}${m[2]}${m[3]}[redacted:credential]${closingQuote(m[3], m[5])}`;
    s = replaceSubmatch(s, genericKVRE, "credential", counts, kvRepl);
    s = replaceSubmatch(s, authTokenKVRE, "credential", counts, kvRepl);
    s = replaceSubmatch(s, envKeyRE, "credential", counts, kvRepl);
    s = replaceSubmatch(s, genericKVIntlRE, "credential", counts, kvRepl);
  }
  if (containsAny(s, providerHints)) {
    s = replaceProvider(s, counts, off);
  }
  if (on("entropy")) s = redactEntropy(s, counts);

  let count = 0;
  for (const n of Object.values(counts)) count += n;
  return { text: s, count, counts };
}

// Entropy pass: catches bare high-entropy strings no pattern knows, but only in a secret-shaped
// context (the value side of an assignment, or alone on its own line) to avoid identifier noise.

const entropyMinBits = 4.5;
const entropyMinAssign = 20;
const entropyMinStandalone = 28;

/** Stop words rejecting assignment keys that are ordinary prose ("moved to: <blob>"); only the
 * English list can ever match ASCII keys. */
const stopWords = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "before",
  "but",
  "by",
  "dealt",
  "did",
  "do",
  "does",
  "for",
  "from",
  "have",
  "how",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "we",
  "what",
  "when",
  "where",
  "which",
  "who",
  "with",
]);

function shannonBits(s: string): number {
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  const n = s.length;
  for (const c of freq.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

function charClasses(s: string): number {
  let lower = false;
  let upper = false;
  let digit = false;
  let other = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 97 && c <= 122) lower = true;
    else if (c >= 65 && c <= 90) upper = true;
    else if (c >= 48 && c <= 57) digit = true;
    else other = true;
  }
  return [lower, upper, digit, other].filter(Boolean).length;
}

function isHexish(s: string): boolean {
  return /^[0-9a-fA-F-]+$/.test(s);
}

/** A filesystem path is not a blob: rooted, multiple separators, no credential punctuation. */
function looksLikePath(tok: string): boolean {
  if (
    !tok.startsWith("/") &&
    !tok.startsWith("~/") &&
    !tok.startsWith("./") &&
    !tok.startsWith("../")
  ) {
    return false;
  }
  if ((tok.match(/\//g) ?? []).length < 2) return false;
  // '=' is base64 padding and the assignment a secret arrives in; ':' is a
  // scheme or a key. Either one means this is not a bare path.
  return !tok.includes("=") && !tok.includes(":");
}

function entropyCandidate(tok: string): boolean {
  if (tok.length > 256 || isHexish(tok) || charClasses(tok) < 3) return false;
  // Lowercase-only path segments sneak into the charset via '/' and '-';
  // real secrets with slashes (base64) mix cases.
  if (tok.includes("/") && tok.toLowerCase() === tok) return false;
  if (looksLikePath(tok)) return false;
  return shannonBits(tok) >= entropyMinBits;
}

/** Reports whether s[start] begins the value side of an assignment; a key that is an English
 * stop word ("moved to: <blob>") does not count. */
function assignmentValue(s: string, start: number): boolean {
  let i = start - 1;
  while (i >= 0 && (s[i] === '"' || s[i] === "'" || s[i] === " " || s[i] === "\t")) i--;
  if (i < 0 || (s[i] !== "=" && s[i] !== ":")) return false;
  i--;
  while (i >= 0 && (s[i] === '"' || s[i] === "'" || s[i] === " " || s[i] === "\t")) i--;
  const end = i + 1;
  while (i >= 0 && isWordChar(s.charCodeAt(i))) i--;
  const key = s.slice(i + 1, end);
  // A pure-digit key is the Telegram bot-token shape (12345678:AA…) — keep
  // it. Otherwise require a real word: two-letter keys are log noise.
  if (/^[0-9]+$/.test(key)) return key.length >= 6;
  if (key.length < 3) return false;
  return !stopWords.has(key.toLowerCase());
}

/** Reports whether the token is the only content on its line, the shape of a pasted credential. */
function standaloneLine(s: string, start: number, end: number): boolean {
  for (let i = start - 1; i >= 0 && s[i] !== "\n"; i--) {
    if (s[i] !== " " && s[i] !== "\t" && s[i] !== "\r") return false;
  }
  for (let j = end; j < s.length && s[j] !== "\n"; j++) {
    if (s[j] !== " " && s[j] !== "\t" && s[j] !== "\r") return false;
  }
  return true;
}

function isEntropyChar(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 43 || // +
    code === 47 || // /
    code === 95 || // _
    code === 45 // -
  );
}

/** Finds runs of 20+ chars from [A-Za-z0-9+/_-], plus up to two trailing '=' of base64 padding. */
function entropySpans(s: string): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < s.length; ) {
    if (!isEntropyChar(s.charCodeAt(i))) {
      i++;
      continue;
    }
    const run = i;
    while (i < s.length && isEntropyChar(s.charCodeAt(i))) i++;
    if (i - run < entropyMinAssign) continue;
    let end = i;
    for (let pad = 0; pad < 2 && end < s.length && s[end] === "="; pad++) end++;
    out.push([run, end]);
    i = end;
  }
  return out;
}

function redactEntropy(s: string, counts: RedactionCounts): string {
  if (s.length < entropyMinAssign) return s;
  const spans = entropySpans(s);
  if (spans.length === 0) return s;
  let out = "";
  let last = 0;
  for (const [start, end] of spans) {
    const tok = s.slice(start, end);
    /* v8 ignore start -- spans hold only [A-Za-z0-9+/_-=], so a marker can never appear */
    if (tok.includes(REDACTION_MARKER)) continue;
    /* v8 ignore stop */
    const hit =
      (tok.length >= entropyMinAssign && assignmentValue(s, start) && entropyCandidate(tok)) ||
      (tok.length >= entropyMinStandalone &&
        standaloneLine(s, start, end) &&
        entropyCandidate(tok));
    if (!hit) continue;
    out += `${s.slice(last, start)}[redacted:entropy]`;
    last = end;
    add(counts, "entropy", 1);
  }
  if (last === 0) return s;
  return out + s.slice(last);
}
