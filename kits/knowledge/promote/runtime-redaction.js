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

const SECRET_NAME =
  "(?:[a-z][a-z0-9]*[_-])*(?:secret|password|passwd|pwd|passphrase|credentials?|token|api[_-]?key|authorization|access[_-]?key|private[_-]?key|client[_-]?secret|connection[_-]?string|sas[_-]?token)(?:[_-][a-z0-9]+)*";

const SECRET_PATTERNS = [
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
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
// Authorization: Bearer <token>
const BEARER = /\b(bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi;
// NAME=value, "name": "value", name: value — for secret-ish names.
const ASSIGNMENT = new RegExp(
  `(["']?\\b${SECRET_NAME}["']?\\s*[:=]\\s*(?:(?:bearer|basic)\\s+)?)(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s"',;}]{4,})`,
  "gi",
);
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const POSIX_HOME = /(^|[^A-Za-z0-9._~-])\/(?:Users|home)\/[^/\s"'`<>]+/g;
const WINDOWS_HOME = /\b[A-Z]:\\Users\\[^\\\s"'`<>]+/gi;

/**
 * Scrub one string. Pure and deterministic: the same input always yields the
 * same output, and scrubbing is idempotent.
 * @param {unknown} value
 * @returns {string}
 */
export function scrubResidueText(value) {
  let text = String(value ?? "");
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "<SECRET>");
  text = text.replace(URL_CREDENTIAL, "$1<SECRET>$2");
  text = text.replace(BEARER, "$1<SECRET>");
  text = text.replace(ASSIGNMENT, "$1<SECRET>");
  text = text.replace(EMAIL, "<EMAIL>");
  text = text.replace(WINDOWS_HOME, "~");
  text = text.replace(POSIX_HOME, "$1~");
  return text;
}
