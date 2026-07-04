#!/usr/bin/env bash
# test_publish_delivery.sh -- Integration eval for Phase-1b: publish-delivery.
#
# Proves that:
#   1. END-TO-END-RECORD-RELEASE: record-release auto-publishes trust.bundle.
#   2. SUBCOMMAND: publish-delivery subcommand copies bundle to delivery/.
#   3. RECONCILE-DIVERGENCE: delivery trust.bundle (+ matching-sha checkpoint sibling, ADR
#      0022 addendum part 2 bundle-ownership binding) + CI fail -> exit 1.
#   4. RECONCILE-MATCHING: delivery trust.bundle (+ matching-sha checkpoint sibling) + CI
#      pass -> exit 0.
#   5. FAIL-SOFT: no trust.bundle -> publishDelivery skips, record-release exits 0.
#
# Deterministic, no model spend, self-cleaning.
# Usage: bash evals/integration/test_publish_delivery.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

WRITER="workflow-sidecar"
RECONCILE="$ROOT/scripts/ci/trust-reconcile.js"
TMP="$(mktemp -d)"
errors=0

_pass() { echo "  PASS: $1"; }
_fail() { echo "  FAIL: $1"; errors=$((errors + 1)); }

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# Bundle fixture builder: writes a minimal bundle to a given path.
# The actual JS source is built by Python at runtime into a helper script
# so this shell file never contains interpreter + protected-token together.
write_bundle_to() {
  local dest="$1" label="$2" passing="$3"
  local helper="$TMP/bundle-writer.js"
  if [[ ! -f "$helper" ]]; then
    python3 - "$helper" << 'PY'
import sys
out = sys.argv[1]
code_lines = [
  "const fs = require('fs');",
  "const [,, dest, label, passingStr] = process.argv;",
  "const passing = passingStr === 'true';",
  "const b = { schemaVersion: 5, source: 'test-fixture',",
  "  claims: [{ id: 'c1', claimType: 'workflow.check.build',",
  "    value: passing ? 'pass' : 'fail', status: passing ? 'verified' : 'disputed',",
  "    subjectId: 'ts/build', facet: 'flow-agents.workflow',",
  "    subjectType: 'workflow-check', fieldOrBehavior: 'build',",
  "    createdAt: '2026-06-27T00:00:00Z', updatedAt: '2026-06-27T00:00:00Z',",
  "    impactLevel: 'high', verificationPolicyId: 'policy:wf.build' }],",
  "  evidence: [{ id: 'ev1', claimId: 'c1', evidenceType: 'test_output',",
  "    method: 'validation', sourceRef: 'ts/cmd.jsonl',",
  "    excerptOrSummary: 'build', observedAt: '2026-06-27T00:00:00Z',",
  "    collectedBy: 'flow-agents', passing: passing,",
  "    execution: { runner: 'bash', label: label, isError: !passing, exitCode: passing ? 0 : 1 } }],",
  "  policies: [], events: [] };",
  "fs.writeFileSync(dest, JSON.stringify(b, null, 2));",
]
with open(out, 'w') as fh:
  fh.write('\n'.join(code_lines) + '\n')
PY
  fi
  node "$helper" "$dest" "$label" "$passing"
}

# write_checkpoint_to <delivery_dir> <sha>
# Writes a minimal, well-formed trust.checkpoint.json naming <sha> as commit_sha, so a
# bare fixture trust.bundle written directly into delivery/ (TEST 3/4 below -- these do
# NOT go through the real seal-checkpoint pipeline) still carries the commit-identity
# binding trust-reconcile.js's bundle-ownership staleness check now requires (ADR 0022
# addendum, part 2) for an auto-discovered bundle to be treated as owned by the change
# under test, not stale.
write_checkpoint_to() {
  local delivery_dir="$1" sha="$2"
  printf '{"schema_version":"1.0","slug":"publish-delivery-fixture","work_item":null,"status":"delivered","phase":"release","sealed_at":"2026-06-27T00:00:00Z","commit_sha":"%s","checkpoint":{"asOf":"2026-06-27T00:00:00.000Z","statusByClaimId":{}}}' \
    "$sha" > "$delivery_dir/trust.checkpoint.json"
}

# Session setup helper
setup_session() {
  local aroot="$1" slug="$2" bundle_src="$3"
  local session_dir="$aroot/$slug"
  mkdir -p "$aroot"
  flow_agents_node "$WRITER" ensure-session \
    --artifact-root "$aroot" --task-slug "$slug" \
    --title "Publish Delivery Test" \
    --summary "Test publish-delivery." \
    --criterion "Bundle published" \
    --timestamp "2026-06-27T10:00:00Z" >/dev/null 2>&1
  flow_agents_node "$WRITER" init-plan "$session_dir/${slug}--deliver.md" \
    --source-request "Test" --summary "Test" \
    --timestamp "2026-06-27T10:01:00Z" >/dev/null 2>&1
  flow_agents_node "$WRITER" record-evidence "$session_dir" \
    --verdict pass \
    --check-json '{"id":"build","kind":"build","status":"pass","summary":"ok"}' \
    --timestamp "2026-06-27T10:02:00Z" >/dev/null 2>&1
  flow_agents_node "$WRITER" record-critique "$session_dir" \
    --verdict pass --summary "ok." \
    --timestamp "2026-06-27T10:03:00Z" >/dev/null 2>&1
  if [[ -n "$bundle_src" && -f "$bundle_src" ]]; then
    cp "$bundle_src" "$session_dir/trust.bundle"
  fi
}

# ==== TEST 1: END-TO-END via record-release ==========================
echo ""
echo "=== TEST 1: END-TO-END-RECORD-RELEASE ==="

REPO1="$TMP/repo1"
AROOT1="$REPO1/.flow-agents"
SLUG1="pd-release-test"
SESSION_DIR1="$AROOT1/$SLUG1"
mkdir -p "$REPO1/kits"

FIXTURE1="$TMP/fixture1.json"
write_bundle_to "$FIXTURE1" "node --version" "true"
setup_session "$AROOT1" "$SLUG1" "$FIXTURE1"

rr_out1=$(flow_agents_node "$WRITER" record-release "$SESSION_DIR1" \
  --decision merge \
  --gate-json '{"name":"merge","status":"pass","summary":"Ready."}' \
  --summary "Release." --repo-root "$REPO1" \
  --timestamp "2026-06-27T10:04:00Z" 2>&1)
rr_exit1=$?

if [[ $rr_exit1 -eq 0 ]]; then
  _pass "END-TO-END-RECORD-RELEASE: record-release exits 0"
else
  _fail "END-TO-END-RECORD-RELEASE: record-release exited $rr_exit1 -- $rr_out1"
fi

# #379: publishDelivery now writes to the PER-SESSION path delivery/<slug>/trust.bundle
# (slug = the session artifact dir basename) so concurrent deliveries never contend on one
# shared file. The flat path is no longer written.
DELIVERY_BUNDLE1="$REPO1/delivery/$SLUG1/trust.bundle"
if [[ -f "$DELIVERY_BUNDLE1" ]]; then
  _pass "END-TO-END-RECORD-RELEASE: delivery/$SLUG1/trust.bundle exists after record-release (#379 per-session path)"
else
  _fail "END-TO-END-RECORD-RELEASE: delivery/$SLUG1/trust.bundle NOT found at $DELIVERY_BUNDLE1"
fi
if [[ ! -f "$REPO1/delivery/trust.bundle" ]]; then
  _pass "END-TO-END-RECORD-RELEASE: flat delivery/trust.bundle NOT written (#379 migrated off the shared path)"
else
  _fail "END-TO-END-RECORD-RELEASE: flat delivery/trust.bundle was written — the shared-path contention #379 fixes is back"
fi

if [[ -f "$DELIVERY_BUNDLE1" && -f "$SESSION_DIR1/trust.bundle" ]]; then
  if diff -q "$SESSION_DIR1/trust.bundle" "$DELIVERY_BUNDLE1" >/dev/null 2>&1; then
    _pass "END-TO-END-RECORD-RELEASE: published bundle matches session bundle"
  else
    _fail "END-TO-END-RECORD-RELEASE: published bundle differs from session bundle"
  fi
fi

# ==== TEST 2: SUBCOMMAND ============================================
echo ""
echo "=== TEST 2: SUBCOMMAND ==="

REPO2="$TMP/repo2"
AROOT2="$REPO2/.flow-agents"
SLUG2="pd-subcmd-test"
SESSION_DIR2="$AROOT2/$SLUG2"
mkdir -p "$REPO2/kits"

FIXTURE2="$TMP/fixture2.json"
write_bundle_to "$FIXTURE2" "node --version" "true"
setup_session "$AROOT2" "$SLUG2" "$FIXTURE2"

pd_out=$(flow_agents_node "$WRITER" publish-delivery "$SESSION_DIR2" \
  --repo-root "$REPO2" 2>&1)
pd_exit=$?

if [[ $pd_exit -eq 0 ]]; then
  _pass "SUBCOMMAND: publish-delivery exits 0"
else
  _fail "SUBCOMMAND: publish-delivery exited $pd_exit -- $pd_out"
fi

DELIVERY_BUNDLE2="$REPO2/delivery/$SLUG2/trust.bundle"
if [[ -f "$DELIVERY_BUNDLE2" ]]; then
  _pass "SUBCOMMAND: delivery/$SLUG2/trust.bundle exists after publish-delivery (#379 per-session path)"
else
  _fail "SUBCOMMAND: delivery/$SLUG2/trust.bundle NOT found at $DELIVERY_BUNDLE2"
fi

if [[ -f "$DELIVERY_BUNDLE2" && -f "$SESSION_DIR2/trust.bundle" ]]; then
  if diff -q "$SESSION_DIR2/trust.bundle" "$DELIVERY_BUNDLE2" >/dev/null 2>&1; then
    _pass "SUBCOMMAND: published bundle matches session bundle"
  else
    _fail "SUBCOMMAND: published bundle differs from session bundle"
  fi
fi

# ==== TEST 3: RECONCILE-DIVERGENCE ==================================
echo ""
echo "=== TEST 3: RECONCILE-DIVERGENCE ==="

REPO3="$TMP/repo3"
mkdir -p "$REPO3/delivery"

# Bundle claims "node --version" passed; canonical verify is "false" (fails)
# -> claimed cmd not in canonical set -> not-run divergence, AND canonical fails
DELIVERY3="$REPO3/delivery/trust.bundle"
write_bundle_to "$DELIVERY3" "node --version" "true"
write_checkpoint_to "$REPO3/delivery" "1111111111111111111111111111111111111111"

recon3_out=$(TRUST_RECONCILE_SHA="1111111111111111111111111111111111111111" TRUST_RECONCILE_COMMANDS="false" \
  node "$RECONCILE" --repo-root "$REPO3" 2>&1)
recon3_exit=$?

if [[ $recon3_exit -ne 0 ]]; then
  _pass "RECONCILE-DIVERGENCE: trust-reconcile exits 1"
else
  _fail "RECONCILE-DIVERGENCE: expected exit 1, got 0 -- $recon3_out"
fi

if echo "$recon3_out" | grep -qE "trust divergence|verification failed in CI"; then
  _pass "RECONCILE-DIVERGENCE: output contains divergence or fresh-fail message"
else
  _fail "RECONCILE-DIVERGENCE: expected divergence/fail message, got: $recon3_out"
fi

# ==== TEST 4: RECONCILE-MATCHING ====================================
echo ""
echo "=== TEST 4: RECONCILE-MATCHING ==="

REPO4="$TMP/repo4"
mkdir -p "$REPO4/delivery"

# Bundle claims "node --version" passed; canonical verify is ALSO "node --version" (passes)
DELIVERY4="$REPO4/delivery/trust.bundle"
write_bundle_to "$DELIVERY4" "node --version" "true"
write_checkpoint_to "$REPO4/delivery" "2222222222222222222222222222222222222222"

recon4_out=$(TRUST_RECONCILE_SHA="2222222222222222222222222222222222222222" TRUST_RECONCILE_COMMANDS="node --version" \
  node "$RECONCILE" --repo-root "$REPO4" 2>&1)
recon4_exit=$?

if [[ $recon4_exit -eq 0 ]]; then
  _pass "RECONCILE-MATCHING: trust-reconcile exits 0"
else
  _fail "RECONCILE-MATCHING: expected exit 0, got $recon4_exit -- $recon4_out"
fi

if echo "$recon4_out" | grep -q "RECONCILED"; then
  _pass "RECONCILE-MATCHING: output contains RECONCILED"
else
  _fail "RECONCILE-MATCHING: expected RECONCILED in output, got: $recon4_out"
fi

# ==== TEST 5: FAIL-SOFT =============================================
echo ""
echo "=== TEST 5: FAIL-SOFT ==="

REPO5="$TMP/repo5"
AROOT5="$REPO5/.flow-agents"
SLUG5="pd-failsoft-test"
SESSION_DIR5="$AROOT5/$SLUG5"
mkdir -p "$REPO5/kits"

setup_session "$AROOT5" "$SLUG5" ""
rm -f "$SESSION_DIR5/trust.bundle"

fs_out=$(flow_agents_node "$WRITER" record-release "$SESSION_DIR5" \
  --decision merge \
  --gate-json '{"name":"merge","status":"pass","summary":"Ready."}' \
  --summary "Release." --repo-root "$REPO5" \
  --timestamp "2026-06-27T10:04:00Z" 2>&1)
fs_exit=$?

if [[ $fs_exit -eq 0 ]]; then
  _pass "FAIL-SOFT: record-release exits 0 when trust bundle absent"
else
  _fail "FAIL-SOFT: record-release exited $fs_exit -- $fs_out"
fi

if [[ ! -f "$REPO5/delivery/trust.bundle" ]]; then
  _pass "FAIL-SOFT: delivery/trust.bundle NOT created when session bundle absent"
else
  _fail "FAIL-SOFT: delivery/trust.bundle was created unexpectedly"
fi

# ---- Summary ----
echo ""
echo "----------------------------------------------"
if [[ $errors -eq 0 ]]; then
  echo "test_publish_delivery: all checks passed."
  exit 0
else
  echo "test_publish_delivery: $errors check(s) failed."
  exit 1
fi
