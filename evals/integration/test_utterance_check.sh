#!/usr/bin/env bash
# test_utterance_check.sh — Survey utterance check hook and CLI adapter coverage
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

TMPDIR_EVAL="$(mktemp -d)"
errors=0

cleanup() {
  rm -rf "$TMPDIR_EVAL"
}
trap cleanup EXIT

_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

echo "=== Utterance Check Hook and CLI Adapter ==="

HOOK="$ROOT/scripts/hooks/utterance-check.js"
RUN_HOOK="$ROOT/scripts/hooks/run-hook.js"

# ---------------------------------------------------------------------------
# Hook: pass-through when disabled (default)
# ---------------------------------------------------------------------------

echo ""
echo "--- hook: disabled by default ---"

INPUT_JSON='{"hook_event_name":"PostToolUse","tool_response":"The coverage is 92% and all tests pass."}'

if node "$HOOK" >"$TMPDIR_EVAL/disabled.out" 2>"$TMPDIR_EVAL/disabled.err" <<< "$INPUT_JSON"; then
  if grep -qF '"hook_event_name"' "$TMPDIR_EVAL/disabled.out"; then
    _pass "utterance check hook passes through when FLOW_AGENTS_UTTERANCE_CHECK_ENABLED is unset"
  else
    _fail "utterance check hook pass-through output was not the raw input"
  fi
else
  _fail "utterance check hook should exit 0 when disabled"
fi

# ---------------------------------------------------------------------------
# Hook: pass-through with empty input
# ---------------------------------------------------------------------------

echo ""
echo "--- hook: empty input ---"

if FLOW_AGENTS_UTTERANCE_CHECK_ENABLED=true node "$HOOK" >"$TMPDIR_EVAL/empty.out" 2>"$TMPDIR_EVAL/empty.err" <<< '{}'; then
  _pass "utterance check hook passes through when no utterance text is present"
else
  _fail "utterance check hook should exit 0 on empty input"
fi

# ---------------------------------------------------------------------------
# Hook: pass-through when CLI is not built yet
# ---------------------------------------------------------------------------

echo ""
echo "--- hook: missing CLI gracefully fails open ---"

if FLOW_AGENTS_UTTERANCE_CHECK_ENABLED=true \
   node "$HOOK" >"$TMPDIR_EVAL/nocli.out" 2>"$TMPDIR_EVAL/nocli.err" <<JSON
{"hook_event_name":"PostToolUse","tool_response":"Some agent text."}
JSON
then
  # Either built CLI path worked, or hook failed open (exit 0)
  _pass "utterance check hook fails open when CLI or survey is not available"
else
  _fail "utterance check hook should not block when CLI is unavailable"
fi

# ---------------------------------------------------------------------------
# Hook: respects SA_DISABLED_HOOKS through run-hook.js
# ---------------------------------------------------------------------------

echo ""
echo "--- hook: run-hook.js respects SA_DISABLED_HOOKS ---"

HOOK_INPUT='{"hook_event_name":"PostToolUse","tool_response":"text"}'

if SA_DISABLED_HOOKS=post:utterance-check \
   node "$RUN_HOOK" post:utterance-check utterance-check.js standard,strict \
   >"$TMPDIR_EVAL/disabled-runner.out" 2>"$TMPDIR_EVAL/disabled-runner.err" <<< "$HOOK_INPUT"
then
  if cmp -s "$TMPDIR_EVAL/disabled-runner.out" <(printf '%s
' "$HOOK_INPUT"); then
    _pass "run-hook.js passes input through when hook id is in SA_DISABLED_HOOKS"
  else
    _fail "run-hook.js disabled hook output did not match raw input"
  fi
else
  _fail "run-hook.js with disabled hook should exit 0"
fi

# ---------------------------------------------------------------------------
# CLI: build and test --not-configured
# ---------------------------------------------------------------------------

echo ""
echo "--- cli: not-configured output ---"

# Build the TypeScript source if needed
if [[ ! -f "$ROOT/build/src/cli.js" ]]; then
  echo "  (building TypeScript source...)"
  if ! (cd "$ROOT" && npm run build --silent 2>"$TMPDIR_EVAL/build.err"); then
    _fail "TypeScript build failed: $(cat "$TMPDIR_EVAL/build.err" | head -5)"
    errors=$((errors + 1))
    echo ""
    echo "Utterance check integration tests failed: $errors issue(s)."
    exit 1
  fi
fi

if node "$ROOT/build/src/cli.js" utterance-check check --not-configured \
   >"$TMPDIR_EVAL/not-configured.out" 2>"$TMPDIR_EVAL/not-configured.err"
then
  if node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    if (r.status !== "not_configured") process.exit(1);
    if (!Array.isArray(r.statements)) process.exit(2);
    if (typeof r.summary !== "string") process.exit(3);
  ' "$TMPDIR_EVAL/not-configured.out"; then
    _pass "CLI outputs not_configured JSON when --not-configured is set"
  else
    _fail "CLI not-configured output did not match expected shape"
  fi
else
  _fail "CLI should exit 0 with --not-configured"
fi

# ---------------------------------------------------------------------------
# CLI: --help exits 0 and prints usage
# ---------------------------------------------------------------------------

echo ""
echo "--- cli: help output ---"

if node "$ROOT/build/src/cli.js" utterance-check --help \
   >"$TMPDIR_EVAL/help.out" 2>"$TMPDIR_EVAL/help.err"; then
  if grep -q 'utterance-check check' "$TMPDIR_EVAL/help.err"; then
    _pass "CLI --help prints usage"
  else
    _fail "CLI --help did not print expected usage text"
  fi
else
  _fail "CLI --help should exit 0"
fi

# ---------------------------------------------------------------------------
# CLI: missing --utterance exits non-zero
# ---------------------------------------------------------------------------

echo ""
echo "--- cli: missing utterance flag ---"

if node "$ROOT/build/src/cli.js" utterance-check check \
   >"$TMPDIR_EVAL/no-utterance.out" 2>"$TMPDIR_EVAL/no-utterance.err"
then
  _fail "CLI check without --utterance should exit non-zero"
else
  _pass "CLI check without --utterance exits non-zero (usage error)"
fi

# ---------------------------------------------------------------------------
# CLI: survey not installed → not_configured output, exits 1
# ---------------------------------------------------------------------------

echo ""
echo "--- cli: @kontourai/survey not installed ---"

# Run with a NODE_PATH that does not include any survey package, so the
# dynamic import fails. node's module resolution will not find @kontourai/survey
# from this test since it is not installed in flow-agents/node_modules.
if node "$ROOT/build/src/cli.js" utterance-check check \
   --utterance "The test coverage is 92%." \
   >"$TMPDIR_EVAL/no-survey.out" 2>"$TMPDIR_EVAL/no-survey.err"
then
  # survey might be installed; check for not_configured or ok status
  status_val=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).status)' \
    "$TMPDIR_EVAL/no-survey.out" 2>/dev/null || echo "parse-error")
  if [[ "$status_val" == "ok" || "$status_val" == "not_configured" ]]; then
    _pass "CLI utterance check produces valid report (status: $status_val)"
  else
    _fail "CLI utterance check output had unexpected status: $status_val"
  fi
else
  exit_code=$?
  # Exit 1 means not_configured (survey not installed) — expected in CI
  if [[ "$exit_code" -eq 1 ]]; then
    if node -e '
      const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      if (r.status !== "not_configured") process.exit(1);
    ' "$TMPDIR_EVAL/no-survey.out" 2>/dev/null; then
      _pass "CLI outputs not_configured when @kontourai/survey is not installed"
    else
      _fail "CLI exit 1 but output was not not_configured JSON"
    fi
  else
    _fail "CLI should exit 0 or 1, got exit code: $exit_code"
  fi
fi

# ---------------------------------------------------------------------------
# CLI: utterance check registers as a valid flow-agents command
# ---------------------------------------------------------------------------

echo ""
echo "--- cli: command registration ---"

if node "$ROOT/build/src/cli.js" commands 2>/dev/null | grep -q 'utterance-check'; then
  _pass "utterance-check is registered as a flow-agents CLI command"
else
  _fail "utterance-check is not registered in flow-agents CLI commands"
fi

# ---------------------------------------------------------------------------
# Hook: module.exports shape
# ---------------------------------------------------------------------------

echo ""
echo "--- hook: module.exports contract ---"

if node -e '
  const h = require(process.argv[1]);
  if (typeof h.run !== "function") { console.error("run missing"); process.exit(1); }
  if (typeof h.extractUtteranceText !== "function") { console.error("extractUtteranceText missing"); process.exit(2); }
  if (typeof h.findPackageRoot !== "function") { console.error("findPackageRoot missing"); process.exit(3); }
' "$HOOK"; then
  _pass "utterance-check hook exports run, extractUtteranceText, findPackageRoot"
else
  _fail "utterance-check hook module.exports is missing expected functions"
fi

# ---------------------------------------------------------------------------
# Hook: extractUtteranceText extracts from PostToolUse and Stop events
# ---------------------------------------------------------------------------

echo ""
echo "--- hook: extractUtteranceText ---"

if node -e '
  const { extractUtteranceText } = require(process.argv[1]);
  const postToolUse = { hook_event_name: "PostToolUse", tool_response: "The answer is 42." };
  const text = extractUtteranceText(postToolUse);
  if (text !== "The answer is 42.") { console.error("PostToolUse extract failed:", text); process.exit(1); }
  const stopWithContent = { hook_event_name: "Stop", content: [{ type: "text", text: "Done!" }] };
  const text2 = extractUtteranceText(stopWithContent);
  if (text2 !== "Done!") { console.error("Stop content extract failed:", text2); process.exit(2); }
  const emptyEvent = { hook_event_name: "PostToolUse" };
  const text3 = extractUtteranceText(emptyEvent);
  if (text3 !== null) { console.error("Empty event should return null, got:", text3); process.exit(3); }
' "$HOOK"; then
  _pass "extractUtteranceText handles PostToolUse, Stop content, and empty events"
else
  _fail "extractUtteranceText behavior was unexpected"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "Utterance check integration tests passed."
  exit 0
fi

echo "Utterance check integration tests failed: $errors issue(s)."
exit 1
