'use strict';
// ---------------------------------------------------------------------------
// read-only-grammar.js — narrow, conservative allowlist for #799.
//
// PROBLEM: config-protection.js's interpreter-write detector (checkInterpreterWriteToProtected)
// blocks any `python3 -c` / `node -e` / `sed -i` / `perl -e` segment that merely contains a
// protected-path token as a LITERAL SUBSTRING -- it has no notion of read vs write. That is
// correctly conservative for genuine writes, but it also blocks provably-read-only one-liners
// (`python3 -c "print(json.load(open('trust.bundle'))['claims'][0])"`), which trains agents to
// evade the hook via runtime path construction instead of reading files honestly (see #799).
//
// FIX SHAPE: a narrow, POSITIVE-match grammar (not a blacklist-only relaxation). A command is
// "provably read-only" only when its ENTIRE shape is one of two recognized read idioms AND it
// contains none of a conservative set of write/escape-hatch indicators. Anything that does not
// cleanly match -- multi-statement bodies, heredocs, unrecognized interpreters, ambiguous
// nested-call parsing -- returns false (BLOCK stays in effect upstream). "When in doubt, block."
//
// SCOPE: this module is consulted ONLY by checkInterpreterWriteToProtected. The redirect/tee and
// cp/mv/install detectors key off an actual write TARGET (the redirect destination, the copy
// destination) which is structurally a write whenever it names a protected path -- they have no
// read-only false-positive class to fix, so they are untouched by this module.
//
// ADR 0018 FROZEN bar-raiser note: this module does not grow WRITE-DETECTION surface (no new
// evasion-catching regexes were added to the existing detectors). It narrows a false-positive
// class in the READ direction only, via a positive allowlist that itself fails closed on any
// ambiguity -- consistent with the file's existing "raise the bar, not a wall" framing.
// ---------------------------------------------------------------------------

/**
 * Grammar A: `python(2|3)? -m json.tool <path...>`, alone or piped from `cat <file> |`.
 * json.tool is a stdlib module that only ever reads its input (file arg or stdin) and prints
 * pretty-formatted JSON to stdout -- there is no flag that turns it into a file-writer.
 */
function isJsonToolInvocation(tokens) {
  return tokens.length >= 3 &&
    /^python[23]?$/.test(tokens[0]) &&
    tokens[1] === '-m' &&
    tokens[2] === 'json.tool';
}

function isJsonToolGrammar(substantive) {
  if (substantive.length === 1) return isJsonToolInvocation(substantive[0].tokens);
  if (substantive.length === 2) {
    const [first, second] = substantive;
    return first.tokens[0] === 'cat' && isJsonToolInvocation(second.tokens);
  }
  return false;
}

// Write indicators (Grammar B bodies): presence of ANY of these disqualifies the body from the
// read-only fast pass, regardless of what else the body does. Matches the spec list verbatim:
// json.dump, .write(/.write_text(/.write_bytes(/.writelines(, os.remove/unlink/rename/replace,
// shutil., truncate, and the Node fs write/remove/rename family.
const WRITE_INDICATOR_RES = [
  /json\.dump\s*\(/,
  /\.write\s*\(/,
  /\.write_text\s*\(/,
  /\.write_bytes\s*\(/,
  /\.writelines\s*\(/,
  /\bos\.remove\s*\(/,
  /\bos\.unlink\s*\(/,
  /\bos\.rename\s*\(/,
  /\bos\.replace\s*\(/,
  /\bshutil\./,
  /\.truncate\s*\(/,
  // Node fs write/remove/rename family. Matched on METHOD NAME with a preceding dot, NOT a
  // literal `fs.` prefix: `-e` one-liners commonly inline the require as
  // `require('fs').writeFileSync(...)`, which does not contain the contiguous substring
  // "fs.writeFileSync(" (the interposed `').` breaks it). Broader matching here only makes
  // disqualification MORE aggressive (fewer false allows), which is the safe direction.
  /\.writeFileSync\s*\(/,
  /\.writeFile\s*\(/,
  /\.appendFileSync\s*\(/,
  /\.appendFile\s*\(/,
  /\.rmSync\s*\(/,
  /\.renameSync\s*\(/,
  /\.unlinkSync\s*\(/,
  /\.unlink\s*\(/,
  /\.rm\s*\(/,
  /\.rename\s*\(/,
];

// Escape-hatch indicators: constructs that can build a write (or arbitrary behavior) out of
// text that would otherwise dodge WRITE_INDICATOR_RES's literal matching (dynamic attribute
// access, code-from-string, shelling out). Presence of any of these disqualifies the body --
// a "provably" read-only grammar must not tolerate provably-can't-tell constructs.
const ESCAPE_HATCH_RES = [
  /\beval\s*\(/,
  /\bexec\s*\(/,
  /\bcompile\s*\(/,
  /__import__\s*\(/,
  /\bgetattr\s*\(/,
  /\bsetattr\s*\(/,
  /\bsubprocess\b/,
  /\bos\.system\s*\(/,
  /\bos\.popen\s*\(/,
  /\bimportlib\b/,
  /\bglobals\s*\(/,
  /\blocals\s*\(/,
  /\bFunction\s*\(/,
  /\bchild_process\b/,
];

// Read constructs: at least one must be present -- confirms the body is actually reading a
// file (not just lacking write indicators, which would also be true of a no-op or a body doing
// something else entirely that this grammar has no business fast-passing). readFileSync is
// matched on the method name alone (no `fs.` prefix requirement) for the same reason the write
// indicators above are: `require('fs').readFileSync(...)` does not contain "fs.readFileSync("
// as a contiguous substring.
const READ_CONSTRUCT_RES = [/\bopen\s*\(/, /json\.load\s*\(/, /\.readFileSync\s*\(/];

// Output constructs: the body must surface something, matching the spec's "open+print" shape.
const OUTPUT_RES = [/\bprint\s*\(/, /console\.log\s*\(/];

/**
 * splitTopLevelArgs(text) -- split a `(...)` call's argument text on top-level commas, honoring
 * quotes and nested (), [], {} depth so `open(os.path.join(a,b), 'w')` splits into exactly
 * ["os.path.join(a,b)", "'w'"] rather than mis-splitting inside the nested join(...) call.
 */
function splitTopLevelArgs(text) {
  const args = [];
  let cur = '';
  let quote = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      cur += c;
      if (c === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; cur += c; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; cur += c; continue; }
    if (c === ',' && depth === 0) { args.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim().length > 0 || args.length > 0) args.push(cur);
  return args.map((a) => a.trim());
}

/**
 * findOpenCallArgs(body) -- balanced-paren scan for every `open(...)` call in body, returning
 * each call's raw argument text. Handles nested calls in the arguments (e.g.
 * `open(os.path.join(a,b), 'w')`) by tracking paren depth rather than a single-level regex,
 * which would silently fail to match (and so silently fail to see the write-mode argument) on
 * any nested-paren argument. A call whose parens never balance (malformed/truncated body) is
 * reported `ambiguous: true` so the caller can fail closed instead of ignoring it.
 */
function findOpenCallArgs(body) {
  const results = [];
  const re = /\bopen\s*\(/g;
  let m;
  while ((m = re.exec(body))) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    for (; i < body.length; i++) {
      const c = body[i];
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) { results.push({ ambiguous: true, args: '' }); continue; }
    results.push({ ambiguous: false, args: body.slice(start, i) });
  }
  return results;
}

/**
 * hasNonReadOpenCall(body) -- true when any `open(...)` call in body is anything other than a
 * single-argument call (default mode 'r') or an explicit `'r'`/`'rb'` second argument. Fails
 * closed (returns true, i.e. "treat as a write") on any call whose parens do not balance.
 */
function hasNonReadOpenCall(body) {
  for (const call of findOpenCallArgs(body)) {
    if (call.ambiguous) return true;
    const args = splitTopLevelArgs(call.args);
    if (args.length <= 1) continue; // single positional arg -- default mode 'r'
    const modeArg = args[1].trim().replace(/^mode\s*=\s*/, '');
    if (!/^["'](r|rb)["']$/.test(modeArg)) return true;
  }
  return false;
}

/**
 * hasEscapeHatch(body) -- true when body contains a dynamic/code-from-string/shell-escape
 * construct, OR a `require(...)` call that is not the canonical `require('fs')`/`require("fs")`
 * form. A read-only one-liner has no legitimate need for any of these.
 */
function hasEscapeHatch(body) {
  if (ESCAPE_HATCH_RES.some((re) => re.test(body))) return true;
  const requireRe = /\brequire\s*\(([^()]*)\)/g;
  let m;
  while ((m = requireRe.exec(body))) {
    if (!/^\s*["']fs["']\s*$/.test(m[1])) return true;
  }
  return false;
}

/**
 * Grammar B: a single `python(2|3)? -c "<body>"` or `node (-e|--eval) "<body>"` invocation
 * whose body has no write indicator, no escape hatch, at least one read construct, and at
 * least one output construct (matches the spec's "open/json.load/readFileSync + print/
 * console.log" shape).
 */
function isReadOnlyInterpreterBody(tokens) {
  let body = null;
  if (tokens.length === 3 && /^python[23]?$/.test(tokens[0]) && tokens[1] === '-c') {
    body = tokens[2];
  } else if (tokens.length === 3 && tokens[0] === 'node' && (tokens[1] === '-e' || tokens[1] === '--eval')) {
    body = tokens[2];
  } else {
    return false; // multi-arg or unrecognized invocation shape -- fail closed
  }

  if (WRITE_INDICATOR_RES.some((re) => re.test(body))) return false;
  if (hasEscapeHatch(body)) return false;
  if (hasNonReadOpenCall(body)) return false;
  if (!READ_CONSTRUCT_RES.some((re) => re.test(body))) return false;
  if (!OUTPUT_RES.some((re) => re.test(body))) return false;
  return true;
}

/**
 * isProvablyReadOnlyCommand(command, { tokenize, splitSegments }) -- true only when the WHOLE
 * command matches Grammar A or Grammar B (optionally prefixed by a harmless `cd <dir>` segment)
 * and contains no real shell redirect (`>`, `>>`) or `tee`/`sponge` token anywhere. Callers pass
 * their own tokenize/splitSegments (dependency injection) to avoid a circular require with
 * config-protection.js, which defines and exports both.
 *
 * Default is false (BLOCK stays in effect upstream) for anything that does not cleanly match --
 * unparseable commands, heredocs, multi-segment compounds beyond the `cd` / `cat | json.tool`
 * shapes, etc.
 */
function isProvablyReadOnlyCommand(command, deps) {
  if (typeof command !== 'string' || !command) return false;
  const tok = deps && deps.tokenize;
  const seg = deps && deps.splitSegments;
  if (typeof tok !== 'function' || typeof seg !== 'function') return false;

  const segments = seg(command);
  if (segments.length === 0) return false;

  // Disqualify on ANY real (tokenized) shell redirect or tee/sponge invocation anywhere in the
  // command. Conservative and intentionally broader than "only redirects TO a protected
  // token": output redirection is compound behavior this narrow grammar does not reason about.
  const tokenizedSegments = segments.map((s) => ({ raw: s, tokens: tok(s) }));
  for (const { tokens } of tokenizedSegments) {
    for (const t of tokens) {
      if (t === '>' || t === '>>' || t === 'tee' || t === 'sponge') return false;
    }
  }

  // Harmless `cd <dir>` prefix segments are allowed; everything else must be the substantive
  // read-only invocation.
  const substantive = tokenizedSegments.filter(({ tokens }) => !(tokens.length >= 1 && tokens[0] === 'cd'));
  if (substantive.length === 0) return false;

  if (isJsonToolGrammar(substantive)) return true;
  if (substantive.length === 1 && isReadOnlyInterpreterBody(substantive[0].tokens)) return true;

  return false;
}

module.exports = { isProvablyReadOnlyCommand };
