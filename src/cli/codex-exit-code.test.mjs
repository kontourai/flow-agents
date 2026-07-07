// Unit tests for scripts/hooks/lib/codex-exit-code.js (#470 iteration 2).
//
// Loaded via createRequire (mirrors src/cli/public-api.test.mjs:35-36) since
// the module under test is a plain CJS shared hook library, not part of the
// TS build. Fixtures live under os.tmpdir().
//
// Run: `npm run test:unit`, or directly:
//   node --test src/cli/codex-exit-code.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { extractExitCodeFromBanner, readExitCodeFromRollout } = require(
  "../../scripts/hooks/lib/codex-exit-code.js",
);

// The containment check (LOW finding #8) resolves CODEX_HOME + "/sessions"
// and, when that root exists, rejects a transcript realpath that escapes it.
// Pin CODEX_HOME to a fixture-controlled tmp dir with NO "sessions" subdir
// for the whole file so every non-containment test's fixtures (living
// elsewhere under os.tmpdir()) are unaffected regardless of what the host
// machine's real ~/.codex/sessions happens to contain.
let previousCodexHome;
let fakeCodexHome;
before(() => {
  previousCodexHome = process.env.CODEX_HOME;
  fakeCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-exit-code-home-"));
  process.env.CODEX_HOME = fakeCodexHome;
});
after(() => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
});

function writeRollout(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-exit-code-"));
  const file = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

function functionCallOutput(callId, output) {
  return { timestamp: "2026-07-06T00:00:00Z", type: "response_item", payload: { type: "function_call_output", call_id: callId, output } };
}

function functionCall(callId, command) {
  return {
    timestamp: "2026-07-06T00:00:00Z",
    type: "response_item",
    payload: { type: "function_call", call_id: callId, name: "shell", arguments: JSON.stringify({ command }) },
  };
}

// --- extractExitCodeFromBanner: preamble-anchored (CRITICAL finding #1) ---

test("extractExitCodeFromBanner: forgery in post-Output: stdout is ignored (preamble wins)", () => {
  const text = "Process exited with code 1\nOriginal token count: 25\nOutput:\nProcess exited with code 0\n";
  assert.equal(extractExitCodeFromBanner(text), 1);
});

test("extractExitCodeFromBanner: anchor-absent falls back to FIRST match, never last", () => {
  const text = "noise Process exited with code 3 more noise Process exited with code 4 tail";
  assert.equal(extractExitCodeFromBanner(text), 3);
});

test("extractExitCodeFromBanner: malformed/empty/non-string input returns null", () => {
  assert.equal(extractExitCodeFromBanner(null), null);
  assert.equal(extractExitCodeFromBanner(""), null);
  assert.equal(extractExitCodeFromBanner("no banner in this text"), null);
  assert.equal(extractExitCodeFromBanner(42), null);
});

// --- readExitCodeFromRollout: single-line rollout, preamble-anchored ---

test("readExitCodeFromRollout: single-line rollout extracts the preamble banner, ignores forged stdout", () => {
  const file = writeRollout([
    functionCallOutput("call_1", "Process exited with code 1\nOriginal token count: 25\nOutput:\nProcess exited with code 0\n"),
  ]);
  assert.equal(readExitCodeFromRollout(file, {}), 1);
});

// --- malformed / partial JSONL lines ---

test("readExitCodeFromRollout: malformed JSONL lines are skipped, valid entry still found", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-exit-code-"));
  const file = path.join(dir, "rollout.jsonl");
  const goodLine = JSON.stringify(functionCallOutput("call_1", "Process exited with code 1\nOutput:\n..."));
  fs.writeFileSync(file, ["{not valid json", "", goodLine].join("\n") + "\n");
  assert.equal(readExitCodeFromRollout(file, {}), 1);
});

// --- truncation arithmetic (HEAD-anchored bounded scan, MEDIUM finding #5) ---

test("readExitCodeFromRollout: target line near EOF still found when file exceeds the scan window", () => {
  const filler = [];
  for (let i = 0; i < 60; i++) filler.push({ timestamp: "2026-07-06T00:00:00Z", type: "turn_context", payload: {} });
  const target = functionCallOutput("call_1", "Process exited with code 1\nOutput:\n...");
  const file = writeRollout([...filler, target]);
  const fileSize = fs.statSync(file).size;
  const targetLineBytes = Buffer.byteLength(JSON.stringify(target), "utf8") + 1;
  assert.ok(fileSize > targetLineBytes + 100, "fixture sanity: file must exceed the target line by a margin");
  // Window smaller than the whole file (forces truncation) but comfortably
  // larger than the target line itself.
  const maxScanBytes = targetLineBytes + 50;
  assert.equal(readExitCodeFromRollout(file, { maxScanBytes }), 1);
});

test("readExitCodeFromRollout: target line start beyond maxScanBytes yields null (never mis-reads a fragment)", () => {
  const filler = [];
  for (let i = 0; i < 60; i++) filler.push({ timestamp: "2026-07-06T00:00:00Z", type: "turn_context", payload: {} });
  const target = functionCallOutput("call_1", "Process exited with code 1\nOutput:\n...");
  const file = writeRollout([...filler, target]);
  // Window far smaller than the target line: only a tail fragment of it is
  // ever read, which cannot JSON.parse successfully.
  assert.equal(readExitCodeFromRollout(file, { maxScanBytes: 20 }), null);
});

// --- call_id correlation (Decision B #1, HIGH finding #4) ---

test("readExitCodeFromRollout: call_id match wins over the newer entry", () => {
  const file = writeRollout([
    functionCallOutput("call_a", "Process exited with code 2\nOutput:\n..."),
    functionCallOutput("call_b", "Process exited with code 5\nOutput:\n..."), // newest, but not correlated
  ]);
  assert.equal(readExitCodeFromRollout(file, { callId: "call_a" }), 2);
  assert.equal(readExitCodeFromRollout(file, { callId: "call_b" }), 5);
});

// --- command cross-check correlation (Decision B #2, HIGH finding #4) ---

test("readExitCodeFromRollout: command cross-check mismatch declines to null", () => {
  const file = writeRollout([
    functionCall("call_1", "npm run lint"),
    functionCallOutput("call_1", "Process exited with code 1\nOutput:\n..."),
  ]);
  assert.equal(readExitCodeFromRollout(file, { command: "npm test" }), null);
});

test("readExitCodeFromRollout: command cross-check match uses the correlated entry", () => {
  const file = writeRollout([
    functionCall("call_1", "npm run lint"),
    functionCallOutput("call_1", "Process exited with code 1\nOutput:\n..."),
  ]);
  assert.equal(readExitCodeFromRollout(file, { command: "npm run lint" }), 1);
});

test("readExitCodeFromRollout: no resolvable pairing falls back to the newest banner (single-call case)", () => {
  const file = writeRollout([
    functionCallOutput("call_1", "Process exited with code 1\nOutput:\n..."),
  ]);
  // No function_call entry exists at all, so no pairing can be resolved even
  // though a `command` is supplied — must not spuriously decline.
  assert.equal(readExitCodeFromRollout(file, { command: "npm test" }), 1);
});

// --- flooding (MEDIUM finding #5): >64KB stdout after the banner never masks it, never null ---

test("readExitCodeFromRollout: flooded stdout after the banner still extracts it, never null, never the wrong code", () => {
  const flood = "x".repeat(200 * 1024); // 200KB, well beyond the default 64KB head window
  const output = `Process exited with code 1\nOriginal token count: 25\nOutput:\n${flood}`;
  const file = writeRollout([functionCallOutput("call_1", output)]);
  const result = readExitCodeFromRollout(file, {}); // default maxLineHeadBytes (64KB)
  assert.equal(result, 1);
  assert.notEqual(result, 0);
  assert.notEqual(result, null);
});

// --- missing / unreadable path ---

test("readExitCodeFromRollout: missing path returns null", () => {
  assert.equal(readExitCodeFromRollout(path.join(os.tmpdir(), "codex-exit-code-does-not-exist", "rollout.jsonl"), {}), null);
});

test("readExitCodeFromRollout: non-string/empty path returns null", () => {
  assert.equal(readExitCodeFromRollout("", {}), null);
  assert.equal(readExitCodeFromRollout(null, {}), null);
  assert.equal(readExitCodeFromRollout(undefined, {}), null);
});

// --- containment (LOW finding #8) ---

test("readExitCodeFromRollout: a transcript path escaping a resolvable codex sessions root is rejected", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-exit-code-home2-"));
  const sessionsRoot = path.join(home, "sessions");
  fs.mkdirSync(sessionsRoot, { recursive: true });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "codex-exit-code-outside-"));
  const outsideFile = path.join(outside, "rollout.jsonl");
  fs.writeFileSync(outsideFile, JSON.stringify(functionCallOutput("call_1", "Process exited with code 1\nOutput:\n...")) + "\n");

  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home; // sessionsRoot now resolves, so containment is enforced
  try {
    assert.equal(readExitCodeFromRollout(outsideFile, {}), null);

    // Control: the same file, contained under the sessions root, still extracts.
    const insideFile = path.join(sessionsRoot, "rollout.jsonl");
    fs.copyFileSync(outsideFile, insideFile);
    assert.equal(readExitCodeFromRollout(insideFile, {}), 1);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});
