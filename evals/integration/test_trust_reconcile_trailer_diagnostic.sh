#!/usr/bin/env bash
# test_trust_reconcile_trailer_diagnostic.sh — Integration eval for scripts/ci/
# trust-reconcile.js's runtime-session commit-trailer diagnostic (issue #305, ADR 0022 §1).
#
# Proves the diagnostic added in findRuntimeSessionTrailers()/logRuntimeSessionTrailers()
# is audit-only:
#   AC5  trailer-diagnostic-positive: a commit with a Claude-Session: trailer in the
#        resolved range produces the exact line
#        `[trust-reconcile] identified: runtime-session trailer 'Claude-Session' on <ref>`
#        — the trailer KEY only, never the VALUE (session URL) — printed for the range's
#        commit-with-trailer.
#   AC6  trailer-diagnostic-negative: a commit range with no runtime-session trailer
#        produces NO such diagnostic line, and the reconciler's exit code is IDENTICAL
#        to the positive case (same canonical command, same bundle/DECLARED absence,
#        differing only in trailer presence) — the diagnostic never changes the exit path.
#   AC7  trailer-diagnostic-checkout-depth-verified: .github/workflows/trust-reconcile.yml
#        already carries fetch-depth: 0 (no .yml edit needed for #305's depth ask).
#   Base-ref-range vs narrower-fallback: both range-resolution paths
#        (TRUST_RECONCILE_BASE_REF/GITHUB_BASE_REF resolvable vs unresolvable, falling back
#        to just the head commit) are exercised directly against the exported
#        findRuntimeSessionTrailers() helper (unit-style, no reconciler wrapper needed for
#        this sub-case) as well as through the full reconciler CLI (integration-style).
#
# Eval-authoring hazards observed (per plan/goal constraints):
#   - No self-recursive harness invocation: this eval shells out to trust-reconcile.js and
#     to git only; it never invokes evals/run.sh or any other eval-suite entry point.
#   - No legacy/deprecated-path literals: trailer fixture values are synthetic/generic
#     (a https://claude.ai/code/session_test-fixture-only placeholder), never a copy of a
#     real committed session URL or a legacy flat delivery/trust.bundle-style literal.
#
# Deterministic, no model spend, self-cleaning.
# Usage: bash evals/integration/test_trust_reconcile_trailer_diagnostic.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RECONCILE="$ROOT/scripts/ci/trust-reconcile.js"

errors=0
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

echo "=== trust-reconcile.js runtime-session trailer diagnostic — integration eval ==="

# Synthetic-only trailer value — never a real/legacy committed session URL.
TRAILER_VALUE="https://claude.ai/code/session_test-fixture-only"
RECONCILE_CMD="node -e 'process.exit(0)'"

# ─── Fixture: a real scratch git repo with two commits (base, then head) ─────────
build_repo() {
  local repo_dir="$1"
  local with_trailer="$2"  # "true" or "false"
  mkdir -p "$repo_dir"
  git init -q "$repo_dir"
  git -C "$repo_dir" config user.email "eval@local"
  git -C "$repo_dir" config user.name "eval"
  echo "base" > "$repo_dir/f.txt"
  git -C "$repo_dir" add -A
  git -C "$repo_dir" commit -qm "base commit"
  echo "change" >> "$repo_dir/f.txt"
  git -C "$repo_dir" add -A
  if [[ "$with_trailer" == "true" ]]; then
    git -C "$repo_dir" commit -qm "$(printf 'feat: trailer test commit\n\nClaude-Session: %s\n' "$TRAILER_VALUE")"
  else
    git -C "$repo_dir" commit -qm "feat: no-trailer test commit"
  fi
}

POS_REPO="$TMP_DIR/positive-repo"
NEG_REPO="$TMP_DIR/negative-repo"
build_repo "$POS_REPO" "true"
build_repo "$NEG_REPO" "false"

POS_BASE="$(git -C "$POS_REPO" rev-list --max-parents=0 HEAD)"
POS_HEAD="$(git -C "$POS_REPO" rev-parse HEAD)"
NEG_BASE="$(git -C "$NEG_REPO" rev-list --max-parents=0 HEAD)"
NEG_HEAD="$(git -C "$NEG_REPO" rev-parse HEAD)"

# A THIRD repo where the range-distinguishing case actually differs from POS_REPO/NEG_REPO:
# the trailer lives on a MIDDLE commit (between base and a later, trailer-free head commit)
# -- reachable ONLY via the ranged `git log <base>..<head>` walk, never via the narrower
# head-commit-only fallback. This is the genuine base-ref-range-vs-fallback distinguisher;
# POS_REPO/NEG_REPO above (trailer-or-not on the head commit itself) would pass under
# EITHER code path and do not by themselves prove the ranged branch is exercised.
RANGE_REPO="$TMP_DIR/range-only-repo"
mkdir -p "$RANGE_REPO"
git init -q "$RANGE_REPO"
git -C "$RANGE_REPO" config user.email "eval@local"
git -C "$RANGE_REPO" config user.name "eval"
echo "base" > "$RANGE_REPO/f.txt"
git -C "$RANGE_REPO" add -A
git -C "$RANGE_REPO" commit -qm "base commit"
RANGE_BASE="$(git -C "$RANGE_REPO" rev-parse HEAD)"
echo "middle" >> "$RANGE_REPO/f.txt"
git -C "$RANGE_REPO" add -A
git -C "$RANGE_REPO" commit -qm "$(printf 'feat: middle commit carries the trailer

Claude-Session: %s
' "$TRAILER_VALUE")"
echo "head" >> "$RANGE_REPO/f.txt"
git -C "$RANGE_REPO" add -A
git -C "$RANGE_REPO" commit -qm "feat: head commit itself has no trailer"
RANGE_HEAD="$(git -C "$RANGE_REPO" rev-parse HEAD)"

# --- AC5: positive case — exact diagnostic line, key only, no value leak --------
echo "--- AC5: positive — Claude-Session trailer present ---"
pos_out="$(TRUST_RECONCILE_BASE_REF="$POS_BASE" TRUST_RECONCILE_SHA="$POS_HEAD" TRUST_RECONCILE_REF="test-branch" \
  TRUST_RECONCILE_COMMANDS="$RECONCILE_CMD" node "$RECONCILE" --repo-root "$POS_REPO" 2>&1)"
pos_code=$?

if echo "$pos_out" | grep -qF "[trust-reconcile] identified: runtime-session trailer 'Claude-Session' on test-branch"; then
  pass "AC5: exact diagnostic line printed for the Claude-Session trailer"
else
  fail "AC5: expected diagnostic line not found — output: $pos_out"
fi

if echo "$pos_out" | grep -qF "$TRAILER_VALUE"; then
  fail "AC5: trailer VALUE ($TRAILER_VALUE) leaked into stdout — diagnostic must log the KEY only"
else
  pass "AC5: trailer VALUE does not appear anywhere in stdout (key-only logging, per ADR 0022 §1's exact quoted format)"
fi

# --- AC6: negative case — no trailer, no line, same canonical command/DECLARED state --
echo "--- AC6: negative — no runtime-session trailer present ---"
neg_out="$(TRUST_RECONCILE_BASE_REF="$NEG_BASE" TRUST_RECONCILE_SHA="$NEG_HEAD" TRUST_RECONCILE_REF="test-branch" \
  TRUST_RECONCILE_COMMANDS="$RECONCILE_CMD" node "$RECONCILE" --repo-root "$NEG_REPO" 2>&1)"
neg_code=$?

if echo "$neg_out" | grep -q "identified: runtime-session trailer"; then
  fail "AC6: an 'identified: runtime-session trailer' line was printed with no trailer present"
else
  pass "AC6: no 'identified: runtime-session trailer' line printed (no trailer present)"
fi

if [[ "$pos_code" == "$neg_code" ]]; then
  pass "AC6: reconciler exit code is IDENTICAL between the trailer-present and no-trailer cases (both: $pos_code) — diagnostic never changes the exit path"
else
  fail "AC6: reconciler exit code DIVERGED between trailer-present ($pos_code) and no-trailer ($neg_code) cases — the diagnostic must never affect the exit path"
fi

# --- Base-ref-range vs narrower-fallback, exercised directly on the exported helper --
# RANGE_REPO's trailer lives on a MIDDLE commit, absent from the head commit itself — this
# genuinely distinguishes the two code paths (see RANGE_REPO fixture comment above).
echo "--- base-ref-range vs narrower-fallback (direct helper exercise, genuinely distinguishing fixture) ---"
range_result="$(TRUST_RECONCILE_BASE_REF="$RANGE_BASE" node -e "
const { findRuntimeSessionTrailers } = require('$RECONCILE');
const found = findRuntimeSessionTrailers('$RANGE_REPO', { sha: '$RANGE_HEAD', ref: 'test-branch' });
console.log(JSON.stringify(found));
" 2>&1)"
if echo "$range_result" | grep -q '"trailerName":"Claude-Session"'; then
  pass "base-ref-range path: findRuntimeSessionTrailers finds a trailer on a MIDDLE commit (base..head range) that is absent from the head commit itself, when TRUST_RECONCILE_BASE_REF resolves"
else
  fail "base-ref-range path: findRuntimeSessionTrailers did not find the middle-commit trailer via the ranged walk — output: $range_result"
fi

# Narrower fallback: no base ref env var set at all (helper's own internal base-ref
# resolution reads process.env directly, so unset both env vars for this call) — against
# the SAME range-only repo, this must NOT find the middle-commit trailer (it is invisible
# to a head-commit-only scan), proving the fallback is genuinely narrower, not just an
# equivalent restatement of the ranged path.
fallback_result="$(env -u TRUST_RECONCILE_BASE_REF -u GITHUB_BASE_REF node -e "
const { findRuntimeSessionTrailers } = require('$RECONCILE');
const found = findRuntimeSessionTrailers('$RANGE_REPO', { sha: '$RANGE_HEAD', ref: 'test-branch' });
console.log(JSON.stringify(found));
" 2>&1)"
if [[ "$fallback_result" == "[]" ]]; then
  pass "narrower-fallback path: findRuntimeSessionTrailers does NOT find the middle-commit-only trailer when no base ref is resolvable (head-commit-only scan is genuinely narrower)"
else
  fail "narrower-fallback path: expected an empty array (middle-commit trailer invisible to head-only scan), got: $fallback_result"
fi

# Narrower fallback, positive: against POS_REPO (trailer ON the head commit itself), the
# no-base-ref fallback still finds it — proving the fallback is not simply "always empty".
fallback_pos_result="$(env -u TRUST_RECONCILE_BASE_REF -u GITHUB_BASE_REF node -e "
const { findRuntimeSessionTrailers } = require('$RECONCILE');
const found = findRuntimeSessionTrailers('$POS_REPO', { sha: '$POS_HEAD', ref: 'test-branch' });
console.log(JSON.stringify(found));
" 2>&1)"
if echo "$fallback_pos_result" | grep -q '"trailerName":"Claude-Session"'; then
  pass "narrower-fallback path: still finds a trailer that IS on the head commit itself (fallback scans the head commit, not nothing)"
else
  fail "narrower-fallback path: did not find the head-commit trailer with no base ref set — output: $fallback_pos_result"
fi

# Narrower-fallback negative: no base ref, no trailer on the head commit itself (NEG_REPO).
fallback_neg_result="$(env -u TRUST_RECONCILE_BASE_REF -u GITHUB_BASE_REF node -e "
const { findRuntimeSessionTrailers } = require('$RECONCILE');
const found = findRuntimeSessionTrailers('$NEG_REPO', { sha: '$NEG_HEAD', ref: 'test-branch' });
console.log(JSON.stringify(found));
" 2>&1)"
if [[ "$fallback_neg_result" == "[]" ]]; then
  pass "narrower-fallback path: findRuntimeSessionTrailers returns an empty array when the head commit itself has no trailer and no base ref is resolvable"
else
  fail "narrower-fallback path: expected an empty array, got: $fallback_neg_result"
fi

# --- No-crash: unresolvable sha degrades to empty array, never throws -----------
degrade_result="$(node -e "
const { findRuntimeSessionTrailers } = require('$RECONCILE');
const found = findRuntimeSessionTrailers('$POS_REPO', { sha: '', ref: 'test-branch' });
console.log(JSON.stringify(found));
" 2>&1)"
if [[ "$degrade_result" == "[]" ]]; then
  pass "empty sha degrades to an empty array (never throws, never crashes the caller)"
else
  fail "empty sha did not degrade cleanly — got: $degrade_result"
fi

# --- AC7: checkout-depth already verified (no .yml edit needed) -----------------
echo "--- AC7: .github/workflows/trust-reconcile.yml already carries fetch-depth: 0 ---"
WORKFLOW_FILE="$ROOT/.github/workflows/trust-reconcile.yml"
if grep -n "fetch-depth: 0" "$WORKFLOW_FILE" >/dev/null 2>&1; then
  pass "AC7: fetch-depth: 0 already present in trust-reconcile.yml (Addendum part 3) — no .yml change needed for #305's depth ask"
else
  fail "AC7: fetch-depth: 0 not found in trust-reconcile.yml — expected it to already be present"
fi

if command -v python3 >/dev/null 2>&1 && python3 -c "import yaml" 2>/dev/null; then
  if python3 - "$WORKFLOW_FILE" << 'PY' 2>/dev/null
import sys, yaml
try:
    yaml.safe_load(open(sys.argv[1]).read())
    sys.exit(0)
except yaml.YAMLError:
    sys.exit(1)
PY
  then
    pass "AC7: trust-reconcile.yml parses as valid YAML (python3 yaml)"
  else
    fail "AC7: trust-reconcile.yml failed python3 yaml parse"
  fi
else
  grep -q "^name:" "$WORKFLOW_FILE" && grep -q "trust-reconcile" "$WORKFLOW_FILE" && \
    pass "AC7: trust-reconcile.yml has expected structural fields (yaml parser unavailable, structural fallback)" || \
    fail "AC7: trust-reconcile.yml missing expected structural fields"
fi

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "PASS: trust-reconcile.js runtime-session trailer diagnostic (audit-only, key-only, exit-code-identical)"
  exit 0
else
  echo "FAIL: $errors check(s) failed"
  exit 1
fi
