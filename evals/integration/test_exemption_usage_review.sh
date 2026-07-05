#!/usr/bin/env bash
# test_exemption_usage_review.sh — Integration eval for the Veritas Governance Kit's
# exemption-usage-review skill (issue #303, ADR 0022 §3).
#
# Proves review-exemptions.mjs correctly:
#   AC1  review-lists-exemptions: parses a delivery/DECLARED fixture and lists every entry
#        with scope, reason, approved_by, and computed age (deterministic via --as-of).
#   AC2  review-flags-stale: against a mixed fresh/stale fixture, flags ONLY the entry
#        outside --stale-days as stale, using exact age math.
#   AC3  review-process-only-no-mutation: running the review does not modify
#        delivery/DECLARED (byte-identical before/after) and does not change
#        scripts/ci/trust-reconcile.js's exit code run against the same fixture tree
#        before/after the review executes.
#   AC9  no-fork: the skill/helper contains no copy of matchesScopeCondition/matchesScope/
#        parseDeclaredMarker function bodies (structural grep, mirrors
#        test_veritas_governance_kit.sh's no-fork assertion pattern).
#   Output shape: --json emits {scope, reason, approved_by, declared_at, age_days, stale}
#        per entry.
#   Exit-0-always-informational: the script's own exit code is 0 regardless of how many
#        entries are flagged stale (staleness is informational, never a script failure).
#
# Deterministic (--as-of pins "now"), no model spend, self-cleaning.
# Usage: bash evals/integration/test_exemption_usage_review.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KIT="$ROOT/kits/veritas-governance"
HELPER="$KIT/skills/exemption-usage-review/review-exemptions.mjs"
SKILL_MD="$KIT/skills/exemption-usage-review/SKILL.md"
FIXTURE="$KIT/fixtures/exemption-review/mixed-fresh-stale.DECLARED.json"
RECONCILE="$ROOT/scripts/ci/trust-reconcile.js"

errors=0
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

echo "=== exemption-usage-review skill — integration eval ==="

# --- Sanity: required files exist ------------------------------------------------
if [[ -f "$HELPER" && -f "$SKILL_MD" && -f "$FIXTURE" ]]; then
  pass "helper, SKILL.md, and fixture all exist"
else
  fail "one or more required files missing (helper=$HELPER skill=$SKILL_MD fixture=$FIXTURE)"
fi

# --- AC1/AC2: listing + staleness math, deterministic via --as-of ----------------
echo "--- AC1/AC2: listing + staleness flagging ---"
AS_OF="2026-07-05T00:00:00Z"
STALE_DAYS=90

json_out="$(node "$HELPER" --declared-path "$FIXTURE" --repo-root "$ROOT" --as-of "$AS_OF" --stale-days "$STALE_DAYS" --json 2>&1)"
json_code=$?

if [[ "$json_code" -eq 0 ]]; then
  pass "review-exemptions.mjs exits 0 on a clean run against the mixed fixture"
else
  fail "review-exemptions.mjs expected exit 0, got $json_code — output: $json_out"
fi

echo "$json_out" > "$TMP_DIR/report.json"

if node -e "
const r = JSON.parse(require('fs').readFileSync('$TMP_DIR/report.json', 'utf8'));
if (!Array.isArray(r.entries) || r.entries.length !== 2) process.exit(1);
"; then
  pass "AC1: exactly 2 entries listed from the mixed-fresh-stale fixture"
else
  fail "AC1: expected exactly 2 entries in the report — output: $json_out"
fi

if node -e "
const r = JSON.parse(require('fs').readFileSync('$TMP_DIR/report.json', 'utf8'));
const [fresh, stale] = r.entries;
const required = ['scope', 'reason', 'approved_by', 'declared_at', 'age_days', 'stale'];
for (const e of r.entries) {
  for (const f of required) {
    if (!(f in e)) process.exit(1);
  }
}
if (fresh.age_days !== 15) process.exit(1);
if (stale.age_days !== 185) process.exit(1);
"; then
  pass "AC1: age_days computed correctly (15 for the fresh entry, 185 for the stale entry) against as-of $AS_OF"
else
  fail "AC1: age_days math did not match expected values — output: $json_out"
fi

if node -e "
const r = JSON.parse(require('fs').readFileSync('$TMP_DIR/report.json', 'utf8'));
const [fresh, stale] = r.entries;
if (fresh.stale !== false) process.exit(1);
if (stale.stale !== true) process.exit(1);
"; then
  pass "AC2: ONLY the entry outside the $STALE_DAYS-day threshold is flagged stale (fresh entry: false, stale entry: true)"
else
  fail "AC2: staleness flagging diverged from expected (fresh=false, stale=true) — output: $json_out"
fi

# --- AC2 negative/flip case: lowering the threshold flips the fresh entry too ----
flip_out="$(node "$HELPER" --declared-path "$FIXTURE" --repo-root "$ROOT" --as-of "$AS_OF" --stale-days 10 --json 2>&1)"
echo "$flip_out" > "$TMP_DIR/flip.json"
if node -e "
const r = JSON.parse(require('fs').readFileSync('$TMP_DIR/flip.json', 'utf8'));
if (r.entries.length !== 2) process.exit(1);
if (!r.entries.every((e) => e.stale === true)) process.exit(1);
"; then
  pass "AC2 threshold-flip: lowering --stale-days to 10 flips BOTH entries to stale (age math is threshold-relative, not hardcoded)"
else
  fail "AC2 threshold-flip: lowering the threshold did not flip both entries stale — output: $flip_out"
fi

# --- Output-shape: human-readable mode also runs clean ---------------------------
human_out="$(node "$HELPER" --declared-path "$FIXTURE" --repo-root "$ROOT" --as-of "$AS_OF" --stale-days "$STALE_DAYS" 2>&1)"
human_code=$?
if [[ "$human_code" -eq 0 ]] && echo "$human_out" | grep -qF "PROCESS-ONLY: read-only report."; then
  pass "human-readable report mode exits 0 and states the process-only boundary plainly"
else
  fail "human-readable report mode did not exit 0 or did not state the process-only boundary — output: $human_out"
fi

# --- AC3: process-only, no mutation of delivery/DECLARED or trust-reconcile exit code --
echo "--- AC3: no-mutation lock (byte-diff DECLARED + reconciler exit-code identity) ---"
DECLARED_WORK="$TMP_DIR/declared-work"
mkdir -p "$DECLARED_WORK/delivery"
cp "$FIXTURE" "$DECLARED_WORK/delivery/DECLARED"

sha_before="$(shasum -a 256 "$DECLARED_WORK/delivery/DECLARED" | awk '{print $1}')"
RECONCILE_CMD="node -e 'process.exit(0)'"
recon_before_out="$(TRUST_RECONCILE_ACTOR="dependabot[bot]" TRUST_RECONCILE_COMMANDS="$RECONCILE_CMD" \
  node "$RECONCILE" --repo-root "$DECLARED_WORK" 2>&1)"
recon_before_code=$?

# Run the review against the SAME fixture tree's DECLARED file (not the read-only source
# fixture) — this is the file whose byte-identity and reconciler-exit-code-identity we lock.
review_out="$(node "$HELPER" --declared-path "$DECLARED_WORK/delivery/DECLARED" --repo-root "$DECLARED_WORK" --as-of "$AS_OF" --stale-days "$STALE_DAYS" --json 2>&1)"
review_code=$?

sha_after="$(shasum -a 256 "$DECLARED_WORK/delivery/DECLARED" | awk '{print $1}')"
recon_after_out="$(TRUST_RECONCILE_ACTOR="dependabot[bot]" TRUST_RECONCILE_COMMANDS="$RECONCILE_CMD" \
  node "$RECONCILE" --repo-root "$DECLARED_WORK" 2>&1)"
recon_after_code=$?

if [[ "$review_code" -eq 0 ]]; then
  pass "review-exemptions.mjs itself exits 0 (informational only, regardless of stale entries present)"
else
  fail "review-exemptions.mjs expected exit 0, got $review_code — output: $review_out"
fi

if [[ "$sha_before" == "$sha_after" ]]; then
  pass "AC3: delivery/DECLARED bytes are IDENTICAL before/after the review ran (sha256 $sha_before)"
else
  fail "AC3: delivery/DECLARED bytes CHANGED after the review ran (before=$sha_before after=$sha_after) — review mutated a file it must never touch"
fi

if [[ "$recon_before_code" == "$recon_after_code" ]]; then
  pass "AC3: trust-reconcile.js's exit code is IDENTICAL before/after the review ran (both: $recon_before_code)"
else
  fail "AC3: trust-reconcile.js's exit code DIVERGED before ($recon_before_code) vs after ($recon_after_code) the review ran — the audit-vs-enforcement boundary is broken"
fi

# --- AC9: no-fork — helper/SKILL.md contain no copy of the reconciler's scope-matching --
echo "--- AC9: no-fork (structural grep for vendored reconciler logic) ---"
if grep -nE "startsWith\('ref:'\)|startsWith\('commit:'\)|startsWith\('author:'\)|startsWith\('branch-prefix:'\)" "$HELPER" >/dev/null 2>&1; then
  fail "AC9: review-exemptions.mjs contains vendored matchesScopeCondition-style branch logic (no-fork violated)"
else
  pass "AC9: review-exemptions.mjs contains no vendored matchesScopeCondition branch logic"
fi

if grep -nE "^function (matchesScope|matchesScopeCondition|parseDeclaredMarker)\(" "$HELPER" "$SKILL_MD" >/dev/null 2>&1; then
  fail "AC9: a matchesScope/matchesScopeCondition/parseDeclaredMarker function DEFINITION was found in the skill's own files (no-fork violated)"
else
  pass "AC9: no matchesScope/matchesScopeCondition/parseDeclaredMarker function definition exists in the skill's own files (references-only, per SKILL.md's explicit non-reuse note)"
fi

# --- kit.json registration sanity (skill is registered, kit still validates) -----
FLOW_CLI="$ROOT/node_modules/@kontourai/flow/dist/cli.js"
if node "$FLOW_CLI" kit validate "$KIT" >"$TMP_DIR/kitval.out" 2>&1; then
  pass "kit container still validates with the exemption-usage-review skill present"
else
  fail "kit container failed validation with the skill present"; sed -n '1,40p' "$TMP_DIR/kitval.out"
fi
if grep -q '"id": *"veritas-governance\.exemption-usage-review"' "$KIT/kit.json" && grep -q '"path": *"skills/exemption-usage-review/SKILL.md"' "$KIT/kit.json"; then
  pass "exemption-usage-review skill is registered in kit.json skills[]"
else
  fail "exemption-usage-review skill is NOT registered in kit.json skills[]"
fi

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "PASS: exemption-usage-review skill (listing, staleness, no-mutation lock, no-fork)"
  exit 0
else
  echo "FAIL: $errors check(s) failed"
  exit 1
fi
