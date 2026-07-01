#!/usr/bin/env bash
# test_codex_hook_resolution.sh - exercises the literal hooks.json command
# strings emitted by build-universal-bundles.ts against the CODEX_HOME
# resolution edge cases that a live Codex session actually hits: CODEX_HOME
# unset/stale, and cwd being an unrelated project rather than this repo.
#
# Coverage gap this closes: test_codex_harness.sh only runs when a `codex`
# binary is on PATH (it skips-as-pass otherwise, and no CI workflow installs
# one), and every other hook eval calls the underlying script directly
# (e.g. `node scripts/hooks/stop-goal-fit.js`), bypassing the bash -lc
# CODEX_HOME resolver in hooks.json entirely. Neither ever caught a resolver
# bug, which is exactly what shipped: every hook exited 1 in real usage
# whenever CODEX_HOME wasn't exported into the hook's process and the
# project cwd didn't happen to vendor scripts/hooks itself.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

errors=0
TMPDIR_EVAL="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_EVAL"' EXIT

_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

echo "=== Codex Hook Resolution ==="
echo ""

if flow_agents_node scripts/build-universal-bundles.js >/dev/null; then
  _pass "bundle build completed"
else
  _fail "bundle build failed"
fi

HOOKS_JSON="$ROOT/dist/codex/.codex/hooks.json"
if [[ -f "$HOOKS_JSON" ]]; then
  _pass "dist/codex/.codex/hooks.json exists"
else
  _fail "dist/codex/.codex/hooks.json missing"
fi

# Pull the exact SessionStart workflow-steering command string Codex would run.
SESSION_START_CMD="$(node -e '
const hooks = require(process.argv[1]).hooks.SessionStart;
const entry = hooks.find(group => group.hooks[0].command.includes("codex-hook-adapter.js"));
process.stdout.write(entry.hooks[0].command);
' "$HOOKS_JSON")"

if [[ "$SESSION_START_CMD" == *"codex-hook-adapter.js"* ]]; then
  _pass "extracted SessionStart hook command"
else
  _fail "could not extract SessionStart hook command"
fi

# An unrelated project: a real git repo that does NOT vendor scripts/hooks,
# which is what every real installation target looks like (this repo is the
# one exception, since it dogfoods itself from its own repo root).
PROJECT="$TMPDIR_EVAL/unrelated-project"
mkdir -p "$PROJECT"
git init -q "$PROJECT"

HOME_WITH_INSTALL="$TMPDIR_EVAL/home-with-install"
mkdir -p "$HOME_WITH_INSTALL"
bash "$ROOT/dist/codex/install.sh" "$HOME_WITH_INSTALL/.codex" >/dev/null

HOME_EMPTY="$TMPDIR_EVAL/home-empty"
mkdir -p "$HOME_EMPTY"

echo ""
echo "--- CODEX_HOME set correctly (baseline) ---"
OUT="$(cd "$PROJECT" && CODEX_HOME="$HOME_WITH_INSTALL/.codex" bash -lc "$SESSION_START_CMD" <<<'{"hook_event_name":"SessionStart"}' 2>"$TMPDIR_EVAL/stderr.baseline")"
STATUS=$?
if [[ $STATUS -eq 0 ]] && [[ "$OUT" == *'"continue":true'* ]]; then
  _pass "hook succeeds when CODEX_HOME is set and correct"
else
  _fail "hook should succeed when CODEX_HOME is set and correct (exit $STATUS): $OUT"
fi

echo ""
echo "--- CODEX_HOME unset, unrelated cwd, install lives under \$HOME/.codex ---"
OUT="$(cd "$PROJECT" && unset CODEX_HOME && HOME="$HOME_WITH_INSTALL" bash -lc "$SESSION_START_CMD" <<<'{"hook_event_name":"SessionStart"}' 2>"$TMPDIR_EVAL/stderr.fallback")"
STATUS=$?
if [[ $STATUS -eq 0 ]] && [[ "$OUT" == *'"continue":true'* ]]; then
  _pass "hook falls back to \$HOME/.codex and succeeds when CODEX_HOME is unset"
else
  _fail "hook should fall back to \$HOME/.codex when CODEX_HOME is unset (exit $STATUS): $OUT"
fi

echo ""
echo "--- CODEX_HOME unset, unrelated cwd, no install anywhere (fail open) ---"
set +e
OUT="$(cd "$PROJECT" && unset CODEX_HOME && HOME="$HOME_EMPTY" bash -lc "$SESSION_START_CMD" <<<'{"hook_event_name":"SessionStart"}' 2>"$TMPDIR_EVAL/stderr.missing")"
STATUS=$?
set -e
if [[ $STATUS -eq 0 ]]; then
  _pass "hook exits 0 (fails open) instead of crashing when the script cannot be found anywhere"
else
  _fail "hook should fail open with exit 0 when unresolvable, got exit $STATUS"
fi

if grep -q "hook script not found" "$TMPDIR_EVAL/stderr.missing"; then
  _pass "hook reports a clear diagnostic instead of a bare module-not-found crash"
else
  _fail "hook did not report a diagnostic when the script was unresolvable"
fi

echo ""
if [[ $errors -gt 0 ]]; then
  echo "FAILED: $errors error(s)"
  exit 1
fi
echo "PASSED"
exit 0
