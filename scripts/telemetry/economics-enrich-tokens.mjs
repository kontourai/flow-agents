#!/usr/bin/env node
// economics-enrich-tokens.mjs — OPTIONAL token-attribution enrichment for a flow-run-derived
// economics record (#922/#925 phase A, item 2). Given a session transcript path and the phase
// windows a `flow-run-economics.mjs` run already computed (real transition timestamps, never
// guessed), streams the transcript ONCE with constant memory and sums each assistant message's
// real `.message.usage` block into whichever phase window its `timestamp` falls inside.
//
// This is deliberately a SEPARATE, explicit tool: session <-> Flow-run binding is not something
// this script infers — the caller passes --transcript explicitly (never auto-discovered from a
// "most recent" or "current" pointer; see flow-agents#922's boundary: "no cwd/path/time/process
// heuristic joins").
//
// Absence of a signal must never look like a real zero: a missing/unreadable transcript, or a
// phase window with no matching lines, leaves that phase's token fields OUT of the emitted
// `phases[]` entries entirely (the caller keeps its null tokens + tokens_unattributed:true) rather
// than emitting a fabricated 0. Malformed transcript lines are counted and skipped, never fatal.
//
// Usage:
//   node economics-enrich-tokens.mjs --transcript <path> --windows-json <path>
//
// --windows-json points to a JSON file containing either a raw array of
// {phase, start, end} (ISO 8601) window objects, or an object with a `.phase_windows` array of the
// same shape (the direct output shape of flow-run-economics.mjs) — either is accepted so the two
// tools can be piped together without an intermediate reshape.
//
// Prints one JSON object to stdout and always exits 0 (best-effort, matches the rest of the
// economics telemetry pipeline's fail-open philosophy).
'use strict';

import { createReadStream, existsSync, readFileSync, realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

function toMillis(iso) {
  if (typeof iso !== 'string' || !iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function loadWindows(windowsJsonPath) {
  if (!existsSync(windowsJsonPath)) {
    return { ok: false, reason: `no windows JSON at ${windowsJsonPath}` };
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(windowsJsonPath, 'utf8'));
  } catch (err) {
    return { ok: false, reason: `windows JSON is not valid JSON: ${err.message}` };
  }
  const arr = Array.isArray(raw) ? raw : (Array.isArray(raw?.phase_windows) ? raw.phase_windows : null);
  if (!arr) {
    return { ok: false, reason: 'windows JSON must be an array or carry a .phase_windows array' };
  }
  const windows = [];
  for (const w of arr) {
    if (!w || typeof w !== 'object') continue;
    const startMs = toMillis(w.start);
    const endMs = toMillis(w.end);
    if (typeof w.phase !== 'string' || !w.phase || startMs === null || endMs === null || endMs <= startMs) continue;
    windows.push({ phase: w.phase, startMs, endMs });
  }
  return { ok: true, windows };
}

function findWindow(windows, tsMs) {
  // Windows can legitimately overlap at their shared boundary instant; last-matching-start wins,
  // consistent with flow-run-economics.mjs treating a transition instant as the start of the NEXT
  // phase. Linear scan: window counts per run are small (single-digit to low tens of Builder
  // steps), so this stays O(lines) in practice rather than needing an interval tree.
  let match = null;
  for (const w of windows) {
    if (tsMs >= w.startMs && tsMs < w.endMs) match = w;
  }
  return match;
}

// Streams the transcript with readline (constant memory regardless of transcript size). Mirrors
// the transcript shape scripts/telemetry/lib/usage.sh's usage_parse_transcript already reads:
// one JSON object per line, assistant turns carry `.message.usage` (real Anthropic usage block)
// and a top-level `.timestamp` (ISO 8601) recording when that turn was emitted.
async function sliceTranscript(transcriptPath, windows) {
  const byPhase = new Map();
  let linesRead = 0;
  let malformedLinesSkipped = 0;
  let assistantUsageLinesMatched = 0;
  let linesOutsideWindows = 0;

  const rl = createInterface({ input: createReadStream(transcriptPath, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    linesRead += 1;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      malformedLinesSkipped += 1;
      continue;
    }
    if (!obj || typeof obj !== 'object' || obj.type !== 'assistant') continue;
    const usage = obj.message && obj.message.usage;
    if (!usage || typeof usage !== 'object') continue;
    const tsMs = toMillis(obj.timestamp);
    if (tsMs === null) {
      malformedLinesSkipped += 1;
      continue;
    }
    const win = findWindow(windows, tsMs);
    if (!win) {
      linesOutsideWindows += 1;
      continue;
    }
    assistantUsageLinesMatched += 1;
    if (!byPhase.has(win.phase)) {
      byPhase.set(win.phase, {
        input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      });
    }
    const bucket = byPhase.get(win.phase);
    bucket.input_tokens += Number(usage.input_tokens) || 0;
    bucket.output_tokens += Number(usage.output_tokens) || 0;
    bucket.cache_creation_input_tokens += Number(usage.cache_creation_input_tokens) || 0;
    bucket.cache_read_input_tokens += Number(usage.cache_read_input_tokens) || 0;
  }

  const phases = [...byPhase.entries()].map(([phase, tokens]) => ({
    phase,
    input_tokens: tokens.input_tokens,
    output_tokens: tokens.output_tokens,
    cache_creation_input_tokens: tokens.cache_creation_input_tokens,
    cache_read_input_tokens: tokens.cache_read_input_tokens,
    source: 'transcript-slice',
  }));

  return {
    phases, linesRead, malformedLinesSkipped, assistantUsageLinesMatched, linesOutsideWindows,
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--transcript') { out.transcript = argv[i + 1]; i += 1; }
    else if (a === '--windows-json') { out.windowsJson = argv[i + 1]; i += 1; }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.transcript || !args.windowsJson) {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: 'usage: economics-enrich-tokens.mjs --transcript <path> --windows-json <path>' })}\n`);
    process.exitCode = 0;
    return;
  }
  const windowsResult = loadWindows(args.windowsJson);
  if (!windowsResult.ok) {
    process.stdout.write(`${JSON.stringify(windowsResult)}\n`);
    process.exitCode = 0;
    return;
  }
  if (!existsSync(args.transcript)) {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: `transcript not found: ${args.transcript}`, transcript_path: args.transcript })}\n`);
    process.exitCode = 0;
    return;
  }
  let sliced;
  try {
    sliced = await sliceTranscript(args.transcript, windowsResult.windows);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: `transcript unreadable: ${err.message}`, transcript_path: args.transcript })}\n`);
    process.exitCode = 0;
    return;
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    transcript_path: args.transcript,
    phases: sliced.phases,
    lines_read: sliced.linesRead,
    malformed_lines_skipped: sliced.malformedLinesSkipped,
    assistant_usage_lines_matched: sliced.assistantUsageLinesMatched,
    lines_outside_windows: sliced.linesOutsideWindows,
  })}\n`);
  process.exitCode = 0;
}

// See flow-run-economics.mjs for why this realpath-normalizes both sides (symlinked tmp dirs
// like macOS's /tmp -> /private/tmp otherwise break a naive string compare).
const isMain = (() => {
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMain) {
  main();
}

export { loadWindows, sliceTranscript };
