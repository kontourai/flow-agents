/**
 * Deterministic residue scrub (#669 R3) — defense-in-depth layer 1.
 *
 * Applied to every string that leaves the runtime-session parser (turn text and
 * provenance). It is pattern-based and has no model in the loop, so it cannot be
 * talked out of redacting by transcript text that tells a later distiller to
 * "preserve this token verbatim". Layer 2 (a distill prompt rule) is #671's.
 *
 * Replacements:
 *   - provider/API tokens, JWTs, private keys, URL credentials, and
 *     `<secret-ish-name> = <value>` assignments -> `<SECRET>`
 *   - email addresses -> `<EMAIL>`
 *   - absolute home directories (`/Users/<name>`, `/home/<name>`,
 *     `C:\Users\<name>`) -> `~`, keeping the project-relative remainder so
 *     provenance stays useful without naming the account.
 *
 * @module promote/runtime-redaction
 */

// Secret-named keys are recognised by splitting an identifier on `_`/`-` (see
// isSecretName), not by one regex: the nested quantifiers a single regex needs
// backtrack quadratically on long `token_token_...` or `a-a-a-...` runs.
const SECRET_WORDS = new Set([
  "secret", "password", "passwd", "pwd", "passphrase", "credential", "credentials", "token",
  "authorization", "apikey", "accesskey", "privatekey", "connectionstring",
]);
const SECRET_WORD_PAIRS = new Set(["api key", "access key", "private key", "connection string"]);

/** `my_api_token_2`, `Client-Secret`, `PASSWORD`: a key with a secret word between plain segments. */
function isSecretName(identifier) {
  const segments = identifier.toLowerCase().split(/[_-]/);
  if (segments.some((segment) => segment === "")) return false;
  for (let i = 0; i < segments.length; i += 1) {
    if (SECRET_WORDS.has(segments[i]) || (i + 1 < segments.length && SECRET_WORD_PAIRS.has(`${segments[i]} ${segments[i + 1]}`))) {
      return true;
    }
  }
  return false;
}

const SECRET_PATTERNS = [
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bnpm_[A-Za-z0-9]{20,}\b/g,
  /\bxox[abeprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bAIza[A-Za-z0-9_-]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];

// scheme://user:password@host -> keep user and host, drop the password.
const URL_CREDENTIAL = /\b([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+(@)/gi;
const BEARER = /\b(bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi;
// YAML block scalar header: `token: |`, `"token": >-`, `- token: |2 # note`.
const BLOCK_SCALAR_HEADER = /^([ \t]*(?:-[ \t]+)?)(["']?)([A-Za-z0-9_-]{1,256})\2[ \t]*:[ \t]*[|>][0-9+-]*[ \t]*(?:#.*)?$/;

/**
 * Replace the body of every secret-named YAML block scalar. The body is the
 * run of blank lines and lines indented deeper than the key; the first line at
 * the key's indent or less (a sibling key) ends it and is kept.
 */
function scrubBlockScalars(text) {
  if (!/[|>]/.test(text)) return text;
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const header = BLOCK_SCALAR_HEADER.exec(lines[i].replace(/\r$/, ""));
    out.push(lines[i]);
    if (!header || !isSecretName(header[3])) continue;
    const keyIndent = header[1].length;
    let last = i;
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j].replace(/\r$/, "");
      if (line.trim() === "") continue;
      if (line.length - line.trimStart().length <= keyIndent) break;
      last = j;
    }
    if (last > i) {
      out.push(`${" ".repeat(keyIndent + 2)}<SECRET>`);
      i = last;
    }
  }
  return out.join("\n");
}
const PLACEHOLDER = "<SECRET>";
const IDENTIFIER = /[A-Za-z0-9_-]+/g;
const WHITESPACE = /\s/;

/** End of the closing `quote` after `from`, skipping backslash-escaped ones; end of line when never closed. */
function closingQuoteEnd(text, quote, from) {
  for (let i = text.indexOf(quote, from); i !== -1; i = text.indexOf(quote, i + 1)) {
    let backslashes = 0;
    while (text[i - 1 - backslashes] === "\\") backslashes += 1;
    if (backslashes % 2 === 0) return i + 1;
  }
  const newline = text.indexOf("\n", from);
  return newline === -1 ? text.length : newline;
}

/**
 * If a secret-named key (`NAME=`, `"name":`, `name :`) ends at `identifierEnd`,
 * return where its value starts and ends; otherwise null.
 */
function assignmentValue(text, identifierEnd) {
  let i = identifierEnd;
  if (text[i] === '"' || text[i] === "'") i += 1;
  while (i < text.length && WHITESPACE.test(text[i])) i += 1;
  if (text[i] !== ":" && text[i] !== "=") return null;
  i += 1;
  while (i < text.length && WHITESPACE.test(text[i])) i += 1;
  const scheme = /^(?:bearer|basic)\s+/i.exec(text.slice(i, i + 12));
  if (scheme) i += scheme[0].length;
  if (text[i] === '"' || text[i] === "'") return { start: i, end: closingQuoteEnd(text, text[i], i + 1) };
  if (text.startsWith(PLACEHOLDER, i)) {
    // Already redacted. Taking only the placeholder keeps a following key from being
    // read as part of this value on a second pass, so the scrub is idempotent.
    return { start: i, end: i + PLACEHOLDER.length };
  }
  let end = i;
  while (end < text.length && !WHITESPACE.test(text[end]) && !`"',;}`.includes(text[end])) end += 1;
  return end - i < 4 ? null : { start: i, end };
}

/**
 * Redact the value of every secret-named assignment (`NAME=value`,
 * `"name": "value"`, `name: value`) in one linear pass. A quoted value ends at
 * its closing quote, but if that span contains further secret-named keys it is
 * extended over each of their values too, until nothing new appears. An
 * unmatched quote therefore cannot pair with a later key's quote and leave that
 * key's value behind, and a quoted secret that mentions another key is redacted
 * whole. The cost is over-redaction of the prose in between.
 */
function scrubAssignments(text) {
  let out = "";
  let copied = 0;
  IDENTIFIER.lastIndex = 0;
  for (let match = IDENTIFIER.exec(text); match !== null; match = IDENTIFIER.exec(text)) {
    if (!isSecretName(match[0])) continue;
    const value = assignmentValue(text, match.index + match[0].length);
    if (value === null) continue;
    let end = value.end;
    // Keys inside the span: scan them, growing the span as their values reach past it.
    IDENTIFIER.lastIndex = value.start + 1;
    for (let inner = IDENTIFIER.exec(text); inner !== null && inner.index < end; inner = IDENTIFIER.exec(text)) {
      if (!isSecretName(inner[0])) continue;
      const nested = assignmentValue(text, inner.index + inner[0].length);
      if (nested !== null && nested.end > end) end = nested.end;
    }
    out += `${text.slice(copied, value.start)}${PLACEHOLDER}`;
    copied = end;
    IDENTIFIER.lastIndex = end;
  }
  return out + text.slice(copied);
}

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const POSIX_HOME = /(^|[^A-Za-z0-9._~-])\/(?:Users|home)\/[^/\s"'`<>]+/g;
const WINDOWS_HOME = /\b[A-Z]:\\Users\\[^\\\s"'`<>]+/gi;

const MAX_RUN = 256;

/**
 * A run of more than MAX_RUN non-whitespace characters is a data blob (base64,
 * minified code, a long dashed rule), not prose, and no credential is that long
 * in a form the other stages could still find. It is replaced whole, so what is
 * inside is redacted by omission, and the regex stages never see a run long
 * enough to make them backtrack quadratically.
 */
function replaceBlobs(text) {
  // `\S+` with a callback: a counted `\S{257,}` overflows the regex stack on a multi-megabyte run.
  return text.length <= MAX_RUN ? text : text.replace(/\S+/g, (run) => (run.length > MAX_RUN ? "<BLOB>" : run));
}

/**
 * Replace every PEM private key block. Linear: once no END marker follows, no
 * later BEGIN can have one either, so the search stops.
 */
const PEM_BEGIN = /-----BEGIN[A-Z ]*PRIVATE KEY-----/g;
const PEM_END = /-----END[A-Z ]*PRIVATE KEY-----/g;
function scrubPrivateKeys(text) {
  if (!text.includes("PRIVATE KEY-----")) return text;
  let out = "";
  let copied = 0;
  PEM_BEGIN.lastIndex = 0;
  for (let begin = PEM_BEGIN.exec(text); begin !== null; begin = PEM_BEGIN.exec(text)) {
    PEM_END.lastIndex = begin.index + begin[0].length;
    const end = PEM_END.exec(text);
    if (end === null) break;
    out += `${text.slice(copied, begin.index)}<SECRET>`;
    copied = end.index + end[0].length;
    PEM_BEGIN.lastIndex = copied;
  }
  return out + text.slice(copied);
}

/**
 * Scrub one string. Pure and deterministic: the same input always yields the
 * same output, and scrubbing is idempotent.
 * @param {unknown} value
 * @returns {string}
 */
export function scrubResidueText(value) {
  let text = replaceBlobs(String(value ?? ""));
  text = scrubPrivateKeys(text);
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "<SECRET>");
  text = text.replace(URL_CREDENTIAL, "$1<SECRET>$2");
  text = scrubBlockScalars(text);
  text = scrubAssignments(text);
  // After assignments: `Bearer <8+ chars>` must not swallow a key name like `Bearer password: "..."`.
  text = text.replace(BEARER, "$1<SECRET>");
  text = text.replace(EMAIL, "<EMAIL>");
  text = text.replace(WINDOWS_HOME, "~");
  text = text.replace(POSIX_HOME, "$1~");
  return text;
}
