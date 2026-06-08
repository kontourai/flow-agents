#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/evals/lib/node.sh"
TMP_WORK=""
TMP_LOG=""
TMP_LAST=""
pass=0
fail=0
skip=0

cleanup() {
  [[ -n "$TMP_WORK" ]] && rm -rf "$TMP_WORK"
  [[ -n "$TMP_LOG" ]] && rm -f "$TMP_LOG"
  [[ -n "$TMP_LAST" ]] && rm -f "$TMP_LAST"
}
trap cleanup EXIT

_pass() { echo "  ✓ $1"; pass=$((pass + 1)); }
_fail() { echo "  ✗ $1"; fail=$((fail + 1)); }
_skip() { echo "  ○ $1"; skip=$((skip + 1)); }

echo "=== Harness Acceptance: Codex ==="
echo ""

if ! command -v codex >/dev/null 2>&1; then
  _skip "codex CLI not installed"
  echo ""
  echo "Results: ${pass}/$((pass + fail)) passed, ${fail} failed, ${skip} skipped"
  exit 0
fi

cd "$ROOT_DIR"
flow_agents_node scripts/build-universal-bundles.js >/dev/null

TMP_WORK="$(mktemp -d /tmp/codex-acceptance-work.XXXXXX)"
TMP_LOG="$(mktemp /tmp/codex-acceptance-log.XXXXXX)"
TMP_LAST="$(mktemp /tmp/codex-acceptance-last.XXXXXX)"
bash dist/codex/install.sh "$TMP_WORK" >/dev/null

echo "--- Exec Smoke ---"
if codex exec --skip-git-repo-check -C "$TMP_WORK" --sandbox read-only --json --output-last-message "$TMP_LAST" "After any required startup checks, reply with READY only." >"$TMP_LOG" 2>&1; then
  _pass "codex exec completed successfully"
else
  _fail "codex exec exited non-zero"
fi

if grep -q "Ignoring malformed agent role definition" "$TMP_LOG"; then
  _fail "codex reported malformed exported agent roles"
else
  _pass "codex accepted exported local agent role files"
fi

if grep -q "failed to stat skills path" "$TMP_LOG"; then
  _fail "codex could not stat exported skill paths"
else
  _pass "codex resolved exported skill paths"
fi

if grep -q "READY" "$TMP_LAST"; then
  _pass "codex returned READY in final message"
else
  _fail "codex final message did not contain READY"
fi

echo ""
echo "--- Behavioral Route ---"
TMP_ROUTE_LOG="$(mktemp /tmp/codex-acceptance-route.XXXXXX)"
if node -e 'const fs=require("fs"); const cp=require("child_process"); const [work,log]=process.argv.slice(1); const r=cp.spawnSync("codex",["exec","--skip-git-repo-check","-C",work,"--sandbox","read-only","--json","Before doing anything else, state the exact skill you are activating if any, then explore the codebase and explain what it does."],{encoding:"utf8",timeout:45000}); fs.writeFileSync(log,(r.stdout||"")+(r.stderr||"")); process.exit(r.error?.code==="ETIMEDOUT" ? 0 : (r.status ?? 1));' "$TMP_WORK" "$TMP_ROUTE_LOG"
then
  _pass "codex behavioral route command completed successfully"
else
  _fail "codex behavioral route command exited non-zero"
fi

if grep -Fq 'Activating `$explore`' "$TMP_ROUTE_LOG" || grep -Fq 'Activating skill: `explore`' "$TMP_ROUTE_LOG" || grep -Fq 'Activating skill: explore' "$TMP_ROUTE_LOG"; then
  _pass "codex dev activates explore on repository exploration"
else
  _fail "codex dev did not activate explore on repository exploration"
fi

rm -f "$TMP_ROUTE_LOG"

echo ""
echo "--- deliver Route ---"
TMP_BUILD_LOG="$(mktemp /tmp/codex-acceptance-build.XXXXXX)"
if node -e 'const fs=require("fs"); const cp=require("child_process"); const [work,log]=process.argv.slice(1); const r=cp.spawnSync("codex",["exec","--skip-git-repo-check","-C",work,"--sandbox","read-only","--json","Before doing anything else, state the exact skill you are activating if any, then begin the deliver workflow for '\''Build a CLI tool that converts markdown files to HTML'\'', but stop after deciding the initial skill and first phase."],{encoding:"utf8",timeout:45000}); fs.writeFileSync(log,(r.stdout||"")+(r.stderr||"")); process.exit(r.error?.code==="ETIMEDOUT" ? 0 : (r.status ?? 1));' "$TMP_WORK" "$TMP_BUILD_LOG"
then
  _pass "codex deliver route command completed successfully"
else
  _fail "codex deliver route command exited non-zero"
fi

if grep -Fq 'Activating skill: `$deliver`' "$TMP_BUILD_LOG" || grep -Fq 'Activating skill: `deliver`' "$TMP_BUILD_LOG" || grep -Fq 'Activating skill: deliver' "$TMP_BUILD_LOG"; then
  _pass "codex dev activates deliver for broad build requests"
else
  _fail "codex dev did not activate deliver for broad build requests"
fi

rm -f "$TMP_BUILD_LOG"

echo ""
echo "==========================="
total=$((pass + fail))
echo "Results: ${pass}/${total} passed, ${fail} failed, ${skip} skipped"
[[ "$fail" -gt 0 ]] && exit 1
exit 0
