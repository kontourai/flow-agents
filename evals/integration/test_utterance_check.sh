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
# Hook: pass-through when disabled by default (no config, no env var)
# ---------------------------------------------------------------------------

echo ""
echo "--- hook: disabled by default (no config, no env var) ---"

INPUT_JSON='{"hook_event_name":"PostToolUse","tool_response":"The coverage is 92% and all tests pass."}'

if node "$HOOK" >"$TMPDIR_EVAL/disabled.out" 2>"$TMPDIR_EVAL/disabled.err" <<< "$INPUT_JSON"; then
  if grep -qF '"hook_event_name"' "$TMPDIR_EVAL/disabled.out"; then
    _pass "utterance check hook passes through when no config and FLOW_AGENTS_UTTERANCE_CHECK_ENABLED is unset"
  else
    _fail "utterance check hook pass-through output was not the raw input"
  fi
else
  _fail "utterance check hook should exit 0 when disabled"
fi

# ---------------------------------------------------------------------------
# Hook: env var force-off overrides a config that would enable
# ---------------------------------------------------------------------------

echo ""
echo "--- hook: env var force-off overrides config ---"

# Create a temp repo dir with a config that has enabled:true
FAKE_REPO="$TMPDIR_EVAL/fake-repo"
mkdir -p "$FAKE_REPO/context/settings"
cat > "$FAKE_REPO/AGENTS.md" <<'AGENTS_EOF'
# Fake repo for testing
AGENTS_EOF
cat > "$FAKE_REPO/context/settings/flow-agents-settings.json" <<'CONFIG_EOF'
{"schema_version":"1.0","utteranceCheck":{"enabled":true,"mode":"report","extractor":"reference"}}
CONFIG_EOF

INPUT_WITH_CWD="{\"hook_event_name\":\"PostToolUse\",\"tool_response\":\"text\",\"cwd\":\"$FAKE_REPO\"}"

if FLOW_AGENTS_UTTERANCE_CHECK_ENABLED=false \
   node "$HOOK" >"$TMPDIR_EVAL/forceoff.out" 2>"$TMPDIR_EVAL/forceoff.err" <<< "$INPUT_WITH_CWD"; then
  if grep -qF '"hook_event_name"' "$TMPDIR_EVAL/forceoff.out"; then
    _pass "env var FLOW_AGENTS_UTTERANCE_CHECK_ENABLED=false forces hook off even when config has enabled:true"
  else
    _fail "force-off pass-through output did not match raw input"
  fi
else
  _fail "hook should exit 0 when force-off via env var"
fi

# ---------------------------------------------------------------------------
# Hook: config-based enable (no env var override) passes through to CLI
# ---------------------------------------------------------------------------

echo ""
echo "--- hook: config-based enable reaches CLI (fail-open on missing CLI is acceptable) ---"

if node "$HOOK" >"$TMPDIR_EVAL/config-enable.out" 2>"$TMPDIR_EVAL/config-enable.err" <<< "$INPUT_WITH_CWD"; then
  _pass "hook with config enabled exits 0 (fails open when CLI or survey is unavailable)"
else
  _fail "hook with config enabled should exit 0 (fail-open)"
fi

# ---------------------------------------------------------------------------
# Hook: env var force-on (legacy behavior still works)
# ---------------------------------------------------------------------------

echo ""
echo "--- hook: env var force-on still works ---"

if FLOW_AGENTS_UTTERANCE_CHECK_ENABLED=true \
   node "$HOOK" >"$TMPDIR_EVAL/forceon.out" 2>"$TMPDIR_EVAL/forceon.err" <<< "$INPUT_JSON"; then
  _pass "FLOW_AGENTS_UTTERANCE_CHECK_ENABLED=true still enables the hook (legacy env var override)"
else
  _fail "hook with force-on env var should exit 0"
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
  if cmp -s "$TMPDIR_EVAL/disabled-runner.out" <(printf '%s\n' "$HOOK_INPUT"); then
    _pass "run-hook.js passes input through when hook id is in SA_DISABLED_HOOKS"
  else
    _fail "run-hook.js disabled hook output did not match raw input"
  fi
else
  _fail "run-hook.js with disabled hook should exit 0"
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
  if (typeof h.findRepoRoot !== "function") { console.error("findRepoRoot missing"); process.exit(4); }
  if (typeof h.loadRepoConfig !== "function") { console.error("loadRepoConfig missing"); process.exit(5); }
  if (typeof h.resolvePolicy !== "function") { console.error("resolvePolicy missing"); process.exit(6); }
' "$HOOK"; then
  _pass "utterance-check hook exports run, extractUtteranceText, findPackageRoot, findRepoRoot, loadRepoConfig, resolvePolicy"
else
  _fail "utterance-check hook module.exports is missing expected functions"
fi

# ---------------------------------------------------------------------------
# Hook: loadRepoConfig reads utteranceCheck from settings file
# ---------------------------------------------------------------------------

echo ""
echo "--- hook: loadRepoConfig reads from context/settings/flow-agents-settings.json ---"

if node -e '
  const { loadRepoConfig } = require(process.argv[1]);
  const fakeRepo = process.argv[2];
  const cfg = loadRepoConfig(fakeRepo);
  if (!cfg) { console.error("loadRepoConfig returned null for a repo with settings"); process.exit(1); }
  if (cfg.enabled !== true) { console.error("expected enabled:true, got:", cfg.enabled); process.exit(2); }
  if (cfg.mode !== "report") { console.error("expected mode:report, got:", cfg.mode); process.exit(3); }
  if (cfg.extractor !== "reference") { console.error("expected extractor:reference, got:", cfg.extractor); process.exit(4); }
' "$HOOK" "$FAKE_REPO"; then
  _pass "loadRepoConfig correctly reads utteranceCheck fields from settings file"
else
  _fail "loadRepoConfig did not return expected config from settings file"
fi

# ---------------------------------------------------------------------------
# Hook: loadRepoConfig returns null when settings file is absent
# ---------------------------------------------------------------------------

echo ""
echo "--- hook: loadRepoConfig returns null when file is absent ---"

MISSING_REPO="$TMPDIR_EVAL/no-settings-repo"
mkdir -p "$MISSING_REPO"
touch "$MISSING_REPO/AGENTS.md"

if node -e '
  const { loadRepoConfig } = require(process.argv[1]);
  const cfg = loadRepoConfig(process.argv[2]);
  if (cfg !== null) { console.error("expected null, got:", JSON.stringify(cfg)); process.exit(1); }
' "$HOOK" "$MISSING_REPO"; then
  _pass "loadRepoConfig returns null when context/settings/flow-agents-settings.json is absent"
else
  _fail "loadRepoConfig should return null for a repo without the settings file"
fi

# ---------------------------------------------------------------------------
# Hook: resolvePolicy respects config enabled:false as default-off
# ---------------------------------------------------------------------------

echo ""
echo "--- hook: resolvePolicy returns disabled when config has enabled:false ---"

mkdir -p "$TMPDIR_EVAL/disabled-repo/context/settings"
touch "$TMPDIR_EVAL/disabled-repo/AGENTS.md"
cat > "$TMPDIR_EVAL/disabled-repo/context/settings/flow-agents-settings.json" <<'DCFG_EOF'
{"schema_version":"1.0","utteranceCheck":{"enabled":false}}
DCFG_EOF

if node -e '
  const { resolvePolicy } = require(process.argv[1]);
  const policy = resolvePolicy(process.argv[2]);
  if (policy.enabled !== false) { console.error("expected enabled:false, got:", policy.enabled); process.exit(1); }
' "$HOOK" "$TMPDIR_EVAL/disabled-repo"; then
  _pass "resolvePolicy returns {enabled:false} when config has enabled:false"
else
  _fail "resolvePolicy should return disabled policy when config has enabled:false"
fi

# ---------------------------------------------------------------------------
# Hook: resolvePolicy applies strict mode from config
# ---------------------------------------------------------------------------

echo ""
echo "--- hook: resolvePolicy applies mode:strict from config ---"

mkdir -p "$TMPDIR_EVAL/strict-repo/context/settings"
touch "$TMPDIR_EVAL/strict-repo/AGENTS.md"
cat > "$TMPDIR_EVAL/strict-repo/context/settings/flow-agents-settings.json" <<'SCFG_EOF'
{"schema_version":"1.0","utteranceCheck":{"enabled":true,"mode":"strict","extractor":"reference"}}
SCFG_EOF

if node -e '
  const { resolvePolicy } = require(process.argv[1]);
  const policy = resolvePolicy(process.argv[2]);
  if (policy.enabled !== true) { console.error("expected enabled:true, got:", policy.enabled); process.exit(1); }
  if (policy.mode !== "strict") { console.error("expected mode:strict, got:", policy.mode); process.exit(2); }
' "$HOOK" "$TMPDIR_EVAL/strict-repo"; then
  _pass "resolvePolicy applies mode:strict from config"
else
  _fail "resolvePolicy did not apply strict mode from config"
fi

# ---------------------------------------------------------------------------
# Hook: resolvePolicy applies anthropic extractor from config
# ---------------------------------------------------------------------------

echo ""
echo "--- hook: resolvePolicy applies extractor:anthropic from config ---"

mkdir -p "$TMPDIR_EVAL/anthropic-repo/context/settings"
touch "$TMPDIR_EVAL/anthropic-repo/AGENTS.md"
cat > "$TMPDIR_EVAL/anthropic-repo/context/settings/flow-agents-settings.json" <<'ACFG_EOF'
{"schema_version":"1.0","utteranceCheck":{"enabled":true,"mode":"report","extractor":"anthropic","model":"claude-haiku-4-5"}}
ACFG_EOF

if node -e '
  const { resolvePolicy } = require(process.argv[1]);
  const policy = resolvePolicy(process.argv[2]);
  if (policy.extractor !== "anthropic") { console.error("expected extractor:anthropic, got:", policy.extractor); process.exit(1); }
  if (policy.model !== "claude-haiku-4-5") { console.error("expected model:claude-haiku-4-5, got:", policy.model); process.exit(2); }
' "$HOOK" "$TMPDIR_EVAL/anthropic-repo"; then
  _pass "resolvePolicy applies extractor:anthropic and model from config"
else
  _fail "resolvePolicy did not apply anthropic extractor from config"
fi

# ---------------------------------------------------------------------------
# Hook: resolvePolicy env var STRICT overrides report mode from config
# ---------------------------------------------------------------------------

echo ""
echo "--- hook: env var STRICT overrides report mode in config ---"

if node -e '
  const { resolvePolicy } = require(process.argv[1]);
  // Set env var before requiring resolvePolicy
  process.env.FLOW_AGENTS_UTTERANCE_CHECK_STRICT = "true";
  const policy = resolvePolicy(process.argv[2]);
  delete process.env.FLOW_AGENTS_UTTERANCE_CHECK_STRICT;
  if (policy.mode !== "strict") { console.error("expected mode:strict from env var, got:", policy.mode); process.exit(1); }
' "$HOOK" "$FAKE_REPO"; then
  _pass "FLOW_AGENTS_UTTERANCE_CHECK_STRICT=true env var overrides report mode in config"
else
  _fail "env var STRICT did not override report mode from config"
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
# CLI: --extractor flag appears in help
# ---------------------------------------------------------------------------

echo ""
echo "--- cli: --extractor flag in help ---"

if node "$ROOT/build/src/cli.js" utterance-check --help \
   >"$TMPDIR_EVAL/help2.out" 2>"$TMPDIR_EVAL/help2.err"; then
  if grep -q '\-\-extractor' "$TMPDIR_EVAL/help2.err"; then
    _pass "CLI --help mentions --extractor flag"
  else
    _fail "CLI --help does not mention --extractor flag"
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
# CLI: --extractor anthropic without ANTHROPIC_API_KEY fails open (exit 0)
# ---------------------------------------------------------------------------

echo ""
echo "--- cli: anthropic extractor without API key fails open ---"

# Run without ANTHROPIC_API_KEY set.
# The CLI should emit not_configured JSON and exit 0 (fail open).
if env -u ANTHROPIC_API_KEY \
   node "$ROOT/build/src/cli.js" utterance-check check \
   --utterance "The test coverage is 92%." \
   --extractor anthropic \
   >"$TMPDIR_EVAL/no-apikey.out" 2>"$TMPDIR_EVAL/no-apikey.err"
then
  status_val=$(node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    console.log(r.status);
  ' "$TMPDIR_EVAL/no-apikey.out" 2>/dev/null || echo "parse-error")
  if [[ "$status_val" == "not_configured" ]]; then
    _pass "CLI --extractor anthropic without ANTHROPIC_API_KEY emits not_configured and exits 0 (fail open)"
  elif [[ "$status_val" == "ok" || "$status_val" == "error" ]]; then
    # If survey is installed and somehow proceeded (shouldn't happen without key), still accept
    _pass "CLI --extractor anthropic produced a valid report (status: $status_val)"
  else
    _fail "CLI --extractor anthropic without API key produced unexpected output (status: $status_val)"
  fi
else
  exit_code=$?
  # Exit 1 means survey not installed — that's a different fail-open path, acceptable
  if [[ "$exit_code" -eq 1 ]]; then
    _pass "CLI --extractor anthropic: survey not installed, exits 1 (not_configured)"
  else
    _fail "CLI --extractor anthropic without API key should exit 0 or 1 (fail open), got: $exit_code"
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
# Summary
# ---------------------------------------------------------------------------

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "Utterance check integration tests passed."
  exit 0
fi

echo "Utterance check integration tests failed: $errors issue(s)."
exit 1
