'use strict';
/**
 * codex-exit-code.js — codex-only host-banner exit-code extraction (#470).
 *
 * The codex PostToolUse payload carries no structured exit code (no
 * `tool_response.exitCode`/`exit_code`, no `error`, no `stderr`). The only
 * deterministic host signal is a fixed-format banner the codex CLI itself
 * writes into the session rollout's `function_call_output`:
 *
 *   Process exited with code N
 *
 * This is HOST-authored prose (observed on codex-cli 0.142.5), not model
 * narration — regex-matching exactly this banner is a deterministic host
 * signal, distinct from scanning stdout/narration for "error"/"fail" words
 * (which docs/spec/runtime-hook-surface.md §2.5 forbids and this module does
 * not do).
 *
 * SECURITY (iteration 2 / #470 review). The banner lives in the HOST-authored
 * PREAMBLE of a `function_call_output.output` string, BEFORE the model's own
 * stdout, which is appended after a literal `Output:` delimiter:
 *
 *   Process exited with code 1
 *   Original token count: 25
 *   Output:
 *   <arbitrary model-produced stdout, which may itself contain the string
 *    "Process exited with code 0" — this is NOT a host signal and must never
 *    be matched>
 *
 * Both exports are therefore PREAMBLE-ANCHORED: extraction only ever looks
 * BEFORE the first `Output:` delimiter and takes the FIRST banner match there
 * (the host writes it once). The post-delimiter model stdout is never
 * scanned, at any size — this is what makes the extraction fail-safe against
 * a command that deliberately prints a forged banner to stdout.
 *
 * Both exports are pure/fail-open: malformed input, a missing/unreadable file,
 * an oversized/inaccessible rollout, or an ambiguous cross-call correlation
 * all degrade to `null` ("no signal"), never a throw. Callers must treat
 * `null` as "extraction unavailable", not as exit code 0.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// The two forms the `Output:` delimiter can take depending on how far the
// caller has decoded the surrounding JSON:
//   - a JSON.parse'd `output` string carries the delimiter as a REAL newline
//     pair: "...\nOutput:\n...".
//   - a raw (still JSON-escaped) slice of the rollout file — used only by the
//     head-only fallback below, when a line is too large to fully parse —
//     carries it literally escaped: "...\\nOutput:\\n...".
// extractExitCodeFromBanner accepts either input flavor and anchors on
// whichever form is present (real callers only ever hand it one flavor at a
// time; this is not an ambiguity, just support for both call sites).
const ANCHOR_REAL = '\nOutput:\n';
const ANCHOR_ESCAPED = '\\nOutput:\\n';

const BANNER_RE = /Process exited with code (\d+)/;

function splitPreamble(text) {
  const iReal = text.indexOf(ANCHOR_REAL);
  const iEsc = text.indexOf(ANCHOR_ESCAPED);
  let idx = -1;
  if (iReal !== -1 && iEsc !== -1) idx = Math.min(iReal, iEsc);
  else if (iReal !== -1) idx = iReal;
  else if (iEsc !== -1) idx = iEsc;
  // No anchor found at all: fall back to treating the whole text as the
  // preamble (documented residual — the observed codex format always
  // includes the `Output:` delimiter; see docs/spec + plan risk log).
  return idx === -1 ? text : text.slice(0, idx);
}

/**
 * extractExitCodeFromBanner(text) → integer | null
 *
 * Pure regex extraction — no I/O, cannot throw on well-formed string input.
 * PREAMBLE-ANCHORED (#470 iteration 2, CRITICAL finding #1): splits `text` on
 * the FIRST `Output:` delimiter (real or JSON-escaped form) and matches the
 * banner ONLY in the portion before it, returning the FIRST match. The
 * model's stdout after the delimiter is never scanned, so a command that
 * prints a forged `Process exited with code 0` to its own stdout cannot
 * override the real host-reported code in the preamble.
 */
function extractExitCodeFromBanner(text) {
  if (typeof text !== 'string' || !text) return null;
  const preamble = splitPreamble(text);
  const match = BANNER_RE.exec(preamble);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isInteger(n) ? n : null;
}

function normalizeCommandText(value) {
  if (typeof value === 'string') return value.trim() || null;
  if (Array.isArray(value)) {
    const joined = value.map(v => String(v)).join(' ').trim();
    return joined || null;
  }
  return null;
}

// Best-effort parse of a rollout `function_call`'s `arguments` field into a
// normalized command string, used only for the command cross-check
// correlation (Decision B #2). Any shape mismatch degrades to `null`
// (unresolvable pairing), never a throw.
function normalizeCallArguments(argumentsField) {
  let parsed = argumentsField;
  if (typeof argumentsField === 'string') {
    try {
      parsed = JSON.parse(argumentsField);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  // Codex records exec_command arguments under `cmd`; older shell fixtures
  // and some adapters use `command`.
  return normalizeCommandText(parsed.cmd) || normalizeCommandText(parsed.command);
}

const OUTPUT_FIELD_NEEDLE = '"output":"';
const COMMAND_FUNCTION_NAMES = new Set(['exec_command', 'shell']);

/**
 * parseCandidateLine(line, maxLineHeadBytes) → candidate | null
 *
 * Interprets one JSONL rollout line as either a `function_call_output` or a
 * `function_call` response_item, HEAD-ANCHORED (#470 iteration 2, MEDIUM
 * finding #5): a line that fits within `maxLineHeadBytes` is fully
 * `JSON.parse`d (cheap, and correct for the real-newline anchor form); a line
 * that exceeds the head window is NEVER fully parsed (that would mean holding
 * arbitrarily large flooded stdout in memory and risks the preamble/banner —
 * which lives at the line HEAD — being reasoned about incorrectly). Instead
 * only the first `maxLineHeadBytes` raw bytes are inspected: the banner and
 * `Output:` delimiter live within the first few hundred bytes of the `output`
 * field regardless of how much stdout follows, so the raw head slice is
 * sufficient for `extractExitCodeFromBanner` (escaped-anchor form).
 */
function parseCandidateLine(line, maxLineHeadBytes) {
  const byteLen = Buffer.byteLength(line, 'utf8');
  if (byteLen <= maxLineHeadBytes) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return null; // malformed/partial line — skip, keep scanning
    }
    const payload = entry && typeof entry === 'object' ? entry.payload : null;
    if (!payload || typeof payload !== 'object') return null;
    const callId = typeof payload.call_id === 'string' ? payload.call_id : null;
    if (payload.type === 'function_call_output' && typeof payload.output === 'string') {
      return { type: 'function_call_output', callId, output: payload.output };
    }
    if (payload.type === 'function_call') {
      const name = typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : null;
      const command = normalizeCallArguments(payload.arguments);
      const commandCapable = name === null || COMMAND_FUNCTION_NAMES.has(name) || command !== null;
      return {
        type: 'function_call',
        callId,
        commandCapable,
        command,
      };
    }
    return null;
  }

  // Line exceeds the head window: raw, head-only, best-effort extraction.
  // `function_call` entries carry only a short command string in practice and
  // are not expected to exceed the head window; only `function_call_output`
  // (whose stdout can flood) is handled here.
  const head = line.slice(0, maxLineHeadBytes);
  if (head.indexOf('"type":"function_call_output"') === -1) return null;
  const callIdMatch = /"call_id":"([^"]*)"/.exec(head);
  const outputIdx = head.indexOf(OUTPUT_FIELD_NEEDLE);
  if (outputIdx === -1) return null; // output field itself starts beyond the head window
  const rawOutputHead = head.slice(outputIdx + OUTPUT_FIELD_NEEDLE.length);
  return {
    type: 'function_call_output',
    callId: callIdMatch ? callIdMatch[1] : null,
    output: rawOutputHead, // still JSON-escaped; extractExitCodeFromBanner handles both anchor forms
  };
}

// Best-effort containment (#470 iteration 2, LOW finding #8): realpath the
// transcript path and require it to be a regular file; when the codex
// sessions root itself resolves on this host, additionally reject a realpath
// that escapes it (defends against a symlinked transcript_path pointing
// somewhere unexpected). Fail-open: any resolution error propagates to the
// caller's try/catch as "unusable" (null); a non-resolvable sessions root
// (e.g. custom CODEX_HOME, test fixtures) simply skips the containment check.
function resolveContainedRealPath(transcriptPath) {
  const realPath = fs.realpathSync(transcriptPath);
  const stat = fs.statSync(realPath);
  if (!stat.isFile()) return null;
  try {
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const sessionsRoot = path.join(codexHome, 'sessions');
    const realRoot = fs.realpathSync(sessionsRoot);
    const rel = path.relative(realRoot, realPath);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  } catch {
    // Sessions root doesn't exist/resolve on this host — best-effort only.
  }
  return realPath;
}

/**
 * readExitCodeFromRollout(transcriptPath, options) → integer | null
 *
 * options:
 *   - maxScanBytes (default 1MB): bounded backward-scan window from EOF used
 *     to locate candidate `response_item` lines. Beyond this cap, an
 *     unresolvable line start (and thus that candidate) is dropped — never
 *     read further back, and never a crash.
 *   - maxLineHeadBytes (default 64KB): per-line head window; see
 *     `parseCandidateLine`. This is what makes extraction survive a flooded
 *     `output` field (#470 iteration 2, MEDIUM finding #5) — the preamble
 *     banner sits at the line HEAD, so bounding reads to the head can never
 *     have the banner pushed out of the window by TAIL stdout volume.
 *   - callId: correlate to a specific `function_call_output.call_id`.
 *   - command: the claimed command (e.g. `tool_input.command`), used only for
 *     the command cross-check correlation below.
 *
 * Correlation policy (Decision B, #470 iteration 2, HIGH finding #4), in
 * priority order:
 *   1. call_id match wins — authoritative.
 *   2. Absent a call_id match: pair outputs with calls by rollout call_id and
 *      select the only pair whose normalized arguments match `command`. Zero
 *      matches or multiple matches DECLINE (`null`) rather than attribute a
 *      neighboring or repeated command's exit code.
 *   3. If no pairing is resolvable at all and the rollout contains exactly one
 *      output with no function call, use that genuinely unpaired legacy output.
 *
 * Any failure (missing/unreadable/non-regular file, containment violation,
 * malformed JSON lines, no candidate found) yields `null` — never throws.
 */
function readExitCodeFromRollout(transcriptPath, options) {
  const opts = options || {};
  const maxScanBytes = Number.isInteger(opts.maxScanBytes) && opts.maxScanBytes > 0
    ? opts.maxScanBytes
    : 1024 * 1024;
  const maxLineHeadBytes = Number.isInteger(opts.maxLineHeadBytes) && opts.maxLineHeadBytes > 0
    ? opts.maxLineHeadBytes
    : 64 * 1024;
  const callId = typeof opts.callId === 'string' && opts.callId ? opts.callId : null;
  const command = normalizeCommandText(opts.command);

  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;

  let text;
  let truncated;
  try {
    const realPath = resolveContainedRealPath(transcriptPath);
    if (realPath === null) return null; // containment violation

    const stat = fs.statSync(realPath);
    const fd = fs.openSync(realPath, 'r');
    try {
      const readLen = Math.min(maxScanBytes, stat.size);
      const start = stat.size - readLen;
      const buf = Buffer.alloc(readLen);
      fs.readSync(fd, buf, 0, readLen, start);
      text = buf.toString('utf8');
      // A read starting after byte 0 means the file is larger than the scan
      // window and the first captured line may be a truncated fragment of a
      // longer line that started before `start` — only then is it dropped.
      truncated = start > 0;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }

  let lines;
  try {
    lines = text.split('\n');
  } catch {
    return null;
  }
  if (truncated && lines.length > 1) lines.shift();

  const outputsByRequestedCallId = [];
  let newestOutputEntry = null;
  const outputEntries = [];
  const commandByCallId = new Map();
  const seenFunctionCallIds = new Set();
  const ambiguousCallIds = new Set();
  let functionCallCount = 0;
  let sawUnclassifiableLine = false;
  let sawUnresolvableFunctionCall = false;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    const candidate = parseCandidateLine(line, maxLineHeadBytes);
    if (!candidate) {
      if (Buffer.byteLength(line, 'utf8') > maxLineHeadBytes) {
        sawUnclassifiableLine = true;
      } else {
        try {
          JSON.parse(line); // valid non-candidate events do not poison correlation
        } catch {
          sawUnclassifiableLine = true;
        }
      }
      continue; // malformed/partial/unrecognized line — skip, keep scanning
    }

    if (candidate.type === 'function_call_output') {
      outputEntries.push(candidate); // scan order is newest to oldest
      if (newestOutputEntry === null) newestOutputEntry = candidate; // first seen scanning backward = newest
      if (callId && candidate.callId === callId) {
        outputsByRequestedCallId.push(candidate);
      }
    } else if (candidate.type === 'function_call') {
      functionCallCount += 1;
      if (candidate.callId) {
        if (seenFunctionCallIds.has(candidate.callId)) ambiguousCallIds.add(candidate.callId);
        else seenFunctionCallIds.add(candidate.callId);
      }
      if (candidate.commandCapable && candidate.callId && candidate.command !== null) {
        if (!commandByCallId.has(candidate.callId)) commandByCallId.set(candidate.callId, candidate.command);
      } else if (candidate.commandCapable) {
        sawUnresolvableFunctionCall = true;
      }
    }
  }

  let chosenOutput = null;
  if ((callId || command) && sawUnclassifiableLine) return null;
  if (callId) {
    if (outputsByRequestedCallId.length === 1 && !ambiguousCallIds.has(callId)) {
      chosenOutput = outputsByRequestedCallId[0].output;
    } else {
      return null; // explicit call ID is unresolved, reused, or has duplicate outputs
    }
  } else if (newestOutputEntry) {
    if (command) {
      if (sawUnresolvableFunctionCall) return null;
      const matchingCallIds = [...commandByCallId.entries()]
        .filter(([, candidateCommand]) => candidateCommand === command)
        .map(([candidateCallId]) => candidateCallId);
      const matches = outputEntries.filter((entry) => commandByCallId.get(entry.callId) === command);
      if (matchingCallIds.length === 1
        && !ambiguousCallIds.has(matchingCallIds[0])
        && matches.length === 1) {
        chosenOutput = matches[0].output;
      } else if (matchingCallIds.length > 0 || matches.length > 0 || commandByCallId.size > 0) {
        return null; // no unique command correlation
      } else if (!truncated && outputEntries.length === 1 && functionCallCount === 0) {
        chosenOutput = newestOutputEntry.output; // genuinely unpaired legacy fallback
      } else {
        return null; // multi-call or partially paired tail
      }
    } else if (!truncated && outputEntries.length === 1 && functionCallCount === 0) {
      chosenOutput = newestOutputEntry.output; // genuinely unpaired legacy fallback
    } else {
      return null; // no correlation signal for a paired or multi-call tail
    }
  }

  if (chosenOutput === null) return null;
  return extractExitCodeFromBanner(chosenOutput);
}

module.exports = { extractExitCodeFromBanner, readExitCodeFromRollout };
