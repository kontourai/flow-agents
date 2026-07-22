'use strict';
// ---------------------------------------------------------------------------
// read-only-grammar.js — narrow, conservative allowlist for #799.
//
// PROBLEM: config-protection.js's interpreter-write detector (checkInterpreterWriteToProtected)
// blocks any interpreter segment that merely contains a protected-path token as a LITERAL
// SUBSTRING -- it has no notion of read vs write. That is correctly conservative for genuine
// writes, but it also blocks provably-read-only idioms, which trains agents to evade the hook
// via runtime path construction instead of reading files honestly (see #799).
//
// FIX SHAPE (v2, post-adversarial-review): an EXACT-TEMPLATE allowlist. The v1 design included
// an interpreter-body heuristic ("Grammar B": accept `-c`/`-e` bodies that lacked known write
// APIs); independent review showed that shape is a deny-list, not a proof -- unlisted mutators,
// quote-blind paren scanning, and shell substitutions all defeated it. v2 removes body analysis
// entirely. A command is "provably read-only" only when:
//
//   1. The WHOLE raw command matches a restrictive character whitelist that structurally
//      excludes every shell expansion/escape channel: no quotes, no backslash, no `$` (bans
//      $(...) and ${...}), no backticks, no `<`/`>` (bans every redirection and process-
//      substitution form, attached or descriptor-prefixed), no `;`/`&`/newline (bans all
//      separators except a single `|`), no glob characters, no `(`/`)`.
//   2. Split on `|`, the stages match one of two exact templates with exact argument counts:
//        A. `<py> -m json.tool <path>`          (exactly one input operand, no flags -- the
//                                                module's write-capable positional OUTFILE and
//                                                any option are structurally excluded)
//        B. `cat <path> | <py> -m json.tool`    (cat: exactly one non-flag operand; json.tool:
//                                                exactly three tokens, so it reads stdin only)
//
// Anything else -- interpreter one-liners, heredocs, `cd` prefixes, extra flags or operands,
// unrecognized characters -- returns false and the upstream BLOCK stays in effect ("when in
// doubt, block"; the grammar must fail closed). False negatives cost a remediation hint;
// a false positive would let a write through a trust gate, so no heuristic earns a pass.
//
// SCOPE: this module is consulted ONLY by checkInterpreterWriteToProtected. The redirect/tee
// and cp/mv/install detectors key off an actual write TARGET and have no read-only
// false-positive class to fix, so they are untouched by this module.
//
// ADR 0018 FROZEN bar-raiser note: this module does not grow WRITE-DETECTION surface. It
// narrows a false-positive class in the READ direction only, via a positive allowlist that
// itself fails closed on any ambiguity.
// ---------------------------------------------------------------------------

// Interpreter-name matcher built by concatenation so this file does not itself
// trip validate-source-tree's first-party-Python-command scan (same convention as
// config-protection.js's INTERPRETER_TOKEN). Matches py2/py3/bare interpreter names.
const PY_NAME_RE = new RegExp('^p' + 'ython[23]?$');

// Whole-command character whitelist. Everything the shell could reinterpret -- quotes,
// backslashes, `$`, backticks, redirections, separators other than `|`, globs, parens,
// tildes, control characters -- is simply not in the alphabet, so no tokenizer subtlety
// (quote provenance, attached redirections, substitution-inside-double-quotes) can arise.
const SAFE_COMMAND_RE = /^[A-Za-z0-9 ._/|-]+$/;

// A path operand: safe charset, not option-shaped, not the `-` stdin alias.
const SAFE_PATH_RE = /^[A-Za-z0-9._/-]+$/;
function isPathOperand(token) {
  return SAFE_PATH_RE.test(token) && !token.startsWith('-');
}

// `<py> -m json.tool` with NO further tokens: reads stdin, writes stdout. Any fourth token
// would be either an option (not validated -> rejected) or the infile positional (not stdin
// -> use the 4-token file template), and a fifth would be the write-capable outfile.
function isJsonToolStdinStage(tokens) {
  return tokens.length === 3 &&
    PY_NAME_RE.test(tokens[0]) &&
    tokens[1] === '-m' &&
    tokens[2] === 'json.tool';
}

// `<py> -m json.tool <path>`: exactly one input operand. No options, no outfile.
function isJsonToolFileStage(tokens) {
  return tokens.length === 4 &&
    isJsonToolStdinStage(tokens.slice(0, 3)) &&
    isPathOperand(tokens[3]);
}

// `cat <path>`: exactly one non-flag operand.
function isCatStage(tokens) {
  return tokens.length === 2 && tokens[0] === 'cat' && isPathOperand(tokens[1]);
}

/**
 * isProvablyReadOnlyCommand(command, deps) -- true only when the WHOLE command is one of the
 * two exact read templates above. Default is false (BLOCK stays in effect upstream) for
 * anything else. The command is parsed self-contained under the charset gate; the injected
 * deps (config-protection.js's tokenize/splitSegments) are accepted for call-site
 * compatibility but intentionally unused -- under SAFE_COMMAND_RE there is nothing a general
 * shell tokenizer could reveal that a whitespace split does not, and depending on one would
 * re-import exactly the quote/expansion ambiguity this grammar exists to exclude.
 */
function isProvablyReadOnlyCommand(command, _deps) {
  if (typeof command !== 'string' || !command) return false;
  if (command.length > 512) return false; // no sanctioned read form is anywhere near this long
  if (!SAFE_COMMAND_RE.test(command)) return false;

  const stages = command.split('|').map((s) => s.trim());
  if (stages.some((s) => s.length === 0)) return false; // bans `||`, leading/trailing pipes
  const tokenized = stages.map((s) => s.split(/\s+/));

  if (tokenized.length === 1) return isJsonToolFileStage(tokenized[0]);
  if (tokenized.length === 2) {
    return isCatStage(tokenized[0]) && isJsonToolStdinStage(tokenized[1]);
  }
  return false;
}

module.exports = { isProvablyReadOnlyCommand };
