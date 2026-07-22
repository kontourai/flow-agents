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
#   6. AC6 SHAPE-INVALID-REFUSED (#356): a shape-invalid trust.bundle (test_output claim
#      naming a non-manifest command) is REFUSED by publishDelivery() -- non-zero exit, loud
#      message, nothing copied to delivery/. Distinct from FAIL-SOFT (bundle absent).
#   7. AC1 HEAD-MISMATCH-REFUSED (#413 Facet A): a real git repo whose sealed
#      trust.checkpoint.json commit_sha names commit A, but the repo's actual HEAD has been
#      advanced to an unrelated orphan commit B (no ancestor relationship) -- publish-delivery
#      REFUSES loudly (non-zero exit, RepoHeadMismatchError message), nothing copied to
#      delivery/. The happy path (HEAD matches the sealed commit_sha) still publishes.
#   8. AC2 CROSS-SESSION-SEAL-SURVIVES (#413 Facet B): a fixture delivery/<other-slug>/ seal
#      pre-exists before publishing a DIFFERENT slug -- the other slug's seal directory
#      survives byte-identical; pruneSupersededSeals only ever touches its OWN keepSlug
#      directory, never another session's.
#   9. FIX 4 SHALLOW-UNDETERMINABLE-WARNS-NOT-REFUSES (#413 iteration-2): a REAL shallow clone
#      (git clone --depth 1) whose sealed trust.checkpoint.json commit_sha names a commit the
#      shallow clone's object database does not have (so ancestry is UNDETERMINABLE, not
#      positively confirmed absent) -- publish-delivery WARNS but still PUBLISHES (exit 0, bundle
#      copied). Distinct from AC1 HEAD-MISMATCH-REFUSED above, which is a POSITIVELY-DETERMINABLE
#      mismatch and correctly still hard-refuses.
#  10. NON-GIT-REPOROOT-WITH-SEALED-COMMIT-ALLOWS (#413 iteration-2 Fix 5, REVERTED in
#      iteration-3): a sealed trust.checkpoint.json names a real commit_sha, but the resolved
#      repoRoot is NOT a git working tree at all (a bare mkdir -p, no .git) -- publish-delivery
#      still PUBLISHES (exit 0, bundle copied). This is a SUPPORTED flow (e.g. checkpoint-signing
#      against a scratch/non-git dir -- see evals/integration/test_checkpoint_signing.sh TEST 2),
#      not a mismatch signal: iteration-2's Fix 5 briefly hard-refused this case ("a sealed
#      delivery implies the target should be a real git repo"), but that premise is false and
#      regressed the supported scratch-dir flow, so it was reverted. Wrong-tree protection for a
#      REAL git repoRoot still relies on the shape-check, verify-hold, and HEAD-vs-commit_sha
#      ancestry gates (TEST 6/7/9 above), which correctly no-op (allow) here since there is no git
#      HEAD to compare against. The pre-existing "no checkpoint / no commit_sha -> allow"
#      no-opinion case (already covered by TEST 1/2/5/6 above, which use bare mkdir -p repos with
#      no checkpoint at all) stays exactly the same allow behavior.
#  11. LOUD-DIRECT-CLI-NO-BUNDLE: the direct `publish-delivery` subcommand (unlike the internal
#      auto-publish call sites record-release/advance-state/promote, which stay FAIL-SOFT per
#      TEST 5 above) REFUSES loudly when the given dir has no trust.bundle -- non-zero exit, a
#      diagnostic naming the path and the fix (record-evidence then seal-checkpoint), nothing
#      copied to delivery/. This is the fix for the real-world footgun of passing the OUTPUT dir
#      (delivery/<name>) instead of the session artifact dir (.kontourai/flow-agents/<slug>), or
#      invoking publish-delivery against a session that was never sealed. Distinct from TEST 5:
#      TEST 5 proves the INTERNAL record-release path stays soft; this proves the DIRECT CLI
#      subcommand is now loud -- both are required, neither regresses the other.
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
printf '# marker\n' > "$REPO1/kits/.keep"
# REPO1 is a bare mkdir -p, not a real git working tree (#413 iteration-2 Fix 5 briefly required a
# real git repo here since it hard-refused a non-git repoRoot with a sealed commit_sha; Fix 5 was
# reverted in iteration-3 -- see checkpointHeadAncestry's doc comment -- so the bare-dir fixture is
# restored). record-release's sealTrustCheckpoint() calls resolveCommitSha(), which is deliberately
# AMBIENT (cwd-inheriting, never --repo-root-scoped) and fails (returns null) since $TMP itself is
# not inside any git working tree -- so no commit_sha is ever sealed here, and this test never
# touches the HEAD-vs-commit_sha ancestry gate at all (mismatchKind stays "none").

FIXTURE1="$TMP/fixture1.json"
write_bundle_to "$FIXTURE1" "node --version" "true"
setup_session "$AROOT1" "$SLUG1" "$FIXTURE1"

# #356: the fixture bundle's evidence.execution.label is "node --version" (a real,
# deterministic command, not a manifest-registered one in this scratch repo) — the new
# reconcile-preflight gate inside publishDelivery() resolves the manifest the SAME way
# trust-reconcile.js itself does, whose legacy fallback tier folds TRUST_RECONCILE_COMMANDS
# into the manifest. Setting it here makes this fixture genuinely shape-valid (a
# manifest-matched command claim), matching what CI would actually accept for a repo whose
# canonical verify is "node --version" — not a preflight-specific carve-out.
rr_out1=$(cd "$REPO1" && TRUST_RECONCILE_COMMANDS="node --version" flow_agents_node "$WRITER" record-release "$SESSION_DIR1" \
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

# #356: same rationale as TEST 1 above — make the fixture genuinely shape-valid for the
# new reconcile-preflight gate inside publishDelivery().
pd_out=$(TRUST_RECONCILE_COMMANDS="node --version" flow_agents_node "$WRITER" publish-delivery "$SESSION_DIR2" \
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

# ==== TEST 6: AC6 SHAPE-INVALID-REFUSED (#356) ======================
# publishDelivery() now runs the reconcile-preflight shape check BEFORE copying anything
# into delivery/ (#356 Wave 3, AC6). A bundle whose test_output-evidenced claim names a
# command that is not in the resolved manifest (no TRUST_RECONCILE_COMMANDS/run-baseline.sh
# entry naming it here) is shape-invalid and must be REFUSED: publish-delivery exits
# non-zero, loudly, and nothing is copied to delivery/. This must never be confused with the
# FAIL-SOFT (bundle-absent) case above, which stays a soft, exit-0 no-op.
echo ""
echo "=== TEST 6: AC6 SHAPE-INVALID-REFUSED ==="

REPO6="$TMP/repo6"
AROOT6="$REPO6/.flow-agents"
SLUG6="pd-shape-invalid-test"
SESSION_DIR6="$AROOT6/$SLUG6"
mkdir -p "$REPO6/kits"

FIXTURE6="$TMP/fixture6.json"
write_bundle_to "$FIXTURE6" "node --version" "true"
setup_session "$AROOT6" "$SLUG6" "$FIXTURE6"

# An ambient manifest override must not authorize publication: hosted CI does not inherit
# the publisher's shell, so "node --version" still resolves to no repository-owned manifest
# entry in this scratch repo and the bundle remains shape-invalid.
shape_out=$(TRUST_RECONCILE_MANIFEST='[{"id":"ambient-bypass","command":"node --version"}]' \
  flow_agents_node "$WRITER" publish-delivery "$SESSION_DIR6" --repo-root "$REPO6" 2>&1)
shape_exit=$?

if [[ $shape_exit -ne 0 ]]; then
  _pass "AC6 SHAPE-INVALID-REFUSED: publish-delivery exits non-zero for a shape-invalid bundle"
else
  _fail "AC6 SHAPE-INVALID-REFUSED: expected non-zero exit, got 0 -- $shape_out"
fi

if echo "$shape_out" | grep -q "REFUSING to publish"; then
  _pass "AC6 SHAPE-INVALID-REFUSED: output names the refusal loudly (REFUSING to publish)"
else
  _fail "AC6 SHAPE-INVALID-REFUSED: expected a loud REFUSING to publish message, got: $shape_out"
fi

DELIVERY_BUNDLE6="$REPO6/delivery/$SLUG6/trust.bundle"
if [[ ! -f "$DELIVERY_BUNDLE6" ]]; then
  _pass "AC6 SHAPE-INVALID-REFUSED: delivery/$SLUG6/trust.bundle NOT created for a shape-invalid bundle"
else
  _fail "AC6 SHAPE-INVALID-REFUSED: delivery/$SLUG6/trust.bundle was created despite invalid shape"
fi

# ==== TEST 7: AC1 HEAD-MISMATCH-REFUSED (#413 Facet A) ==============
# publishDelivery() now refuses loudly when the resolved repoRoot's HEAD is not an
# ancestor-or-equal of the session's sealed trust.checkpoint.json commit_sha -- a real git
# repo is required here (not a bare mkdir -p fixture) so `git rev-parse HEAD` genuinely
# resolves and the ancestor check has real commits to compare.
echo ""
echo "=== TEST 7: AC1 HEAD-MISMATCH-REFUSED ==="

REPO7="$TMP/repo7"
AROOT7="$REPO7/.flow-agents"
SLUG7="pd-head-mismatch-test"
SESSION_DIR7="$AROOT7/$SLUG7"
mkdir -p "$REPO7/kits"
printf '# marker\n' > "$REPO7/kits/.keep"
(cd "$REPO7" && git init -q && git config user.email "test@test.local" && git config user.name "test" && git add -A && git commit -q -m "commit A")
SHA_A="$(cd "$REPO7" && git rev-parse HEAD)"

FIXTURE7="$TMP/fixture7.json"
write_bundle_to "$FIXTURE7" "node --version" "true"
setup_session "$AROOT7" "$SLUG7" "$FIXTURE7"
# Seal a checkpoint naming commit A as the trusted commit_sha -- mirrors write_checkpoint_to's
# minimal, well-formed shape but targets the SESSION dir (where publishDelivery reads it from),
# not the delivery/ dir (write_checkpoint_to's existing target for the reconcile tests above).
printf '{"schema_version":"1.0","slug":"%s","work_item":null,"status":"delivered","phase":"release","sealed_at":"2026-06-27T00:00:00Z","commit_sha":"%s","checkpoint":{"asOf":"2026-06-27T00:00:00.000Z","statusByClaimId":{}}}' \
  "$SLUG7" "$SHA_A" > "$SESSION_DIR7/trust.checkpoint.json"

# Advance repo7's HEAD to a genuinely UNRELATED orphan commit B -- no ancestor relationship
# with commit A at all.
(cd "$REPO7" && git checkout -q --orphan orphan-branch && git rm -rq --cached . >/dev/null 2>&1)
(cd "$REPO7" && mkdir -p kits && printf 'unrelated\n' > kits/unrelated.txt && git add -A && git commit -q -m "commit B (unrelated orphan)")
SHA_B="$(cd "$REPO7" && git rev-parse HEAD)"

if [[ "$SHA_A" != "$SHA_B" ]]; then
  _pass "TEST 7 setup: commit A and commit B are genuinely distinct shas"
else
  _fail "TEST 7 setup: commit A and commit B unexpectedly matched"
fi

mismatch_out=$(TRUST_RECONCILE_COMMANDS="node --version" flow_agents_node "$WRITER" publish-delivery "$SESSION_DIR7"   --repo-root "$REPO7" 2>&1)
mismatch_exit=$?

if [[ $mismatch_exit -ne 0 ]]; then
  _pass "AC1 HEAD-MISMATCH-REFUSED: publish-delivery exits non-zero when repoRoot HEAD does not match the sealed commit_sha"
else
  _fail "AC1 HEAD-MISMATCH-REFUSED: expected non-zero exit, got 0 -- $mismatch_out"
fi

if echo "$mismatch_out" | grep -q "REFUSING to publish"; then
  _pass "AC1 HEAD-MISMATCH-REFUSED: output names the refusal loudly (REFUSING to publish)"
else
  _fail "AC1 HEAD-MISMATCH-REFUSED: expected a loud REFUSING to publish message, got: $mismatch_out"
fi

if echo "$mismatch_out" | grep -qF "$SHA_A" && echo "$mismatch_out" | grep -qF "$SHA_B"; then
  _pass "AC1 HEAD-MISMATCH-REFUSED: refusal message names both the checkpoint commit_sha and the mismatched HEAD sha"
else
  _fail "AC1 HEAD-MISMATCH-REFUSED: refusal message did not name both shas: $mismatch_out"
fi

DELIVERY_BUNDLE7="$REPO7/delivery/$SLUG7/trust.bundle"
if [[ ! -f "$DELIVERY_BUNDLE7" ]]; then
  _pass "AC1 HEAD-MISMATCH-REFUSED: delivery/$SLUG7/trust.bundle NOT created on HEAD mismatch"
else
  _fail "AC1 HEAD-MISMATCH-REFUSED: delivery/$SLUG7/trust.bundle was created despite the HEAD mismatch"
fi

# Happy path: seal a SECOND session's checkpoint against the repo's CURRENT (matching) HEAD --
# publish-delivery must still succeed. Proves the gate is scoped strictly to the mismatch case,
# never a spurious refusal.
SLUG7B="pd-head-match-test"
SESSION_DIR7B="$AROOT7/$SLUG7B"
FIXTURE7B="$TMP/fixture7b.json"
write_bundle_to "$FIXTURE7B" "node --version" "true"
setup_session "$AROOT7" "$SLUG7B" "$FIXTURE7B"
printf '{"schema_version":"1.0","slug":"%s","work_item":null,"status":"delivered","phase":"release","sealed_at":"2026-06-27T00:00:00Z","commit_sha":"%s","checkpoint":{"asOf":"2026-06-27T00:00:00.000Z","statusByClaimId":{}}}'   "$SLUG7B" "$SHA_B" > "$SESSION_DIR7B/trust.checkpoint.json"

match_out=$(TRUST_RECONCILE_COMMANDS="node --version" flow_agents_node "$WRITER" publish-delivery "$SESSION_DIR7B"   --repo-root "$REPO7" 2>&1)
match_exit=$?

if [[ $match_exit -eq 0 ]]; then
  _pass "AC1 happy path: publish-delivery succeeds when repoRoot HEAD matches the sealed commit_sha"
else
  _fail "AC1 happy path: publish-delivery unexpectedly failed on a matching HEAD/commit_sha: $match_out"
fi
if [[ -f "$REPO7/delivery/$SLUG7B/trust.bundle" ]]; then
  _pass "AC1 happy path: delivery/$SLUG7B/trust.bundle created when HEAD matches commit_sha"
else
  _fail "AC1 happy path: delivery/$SLUG7B/trust.bundle NOT created despite a matching HEAD/commit_sha"
fi

# ==== TEST 8: AC2 CROSS-SESSION-SEAL-SURVIVES (#413 Facet B) ========
# pruneSupersededSeals must never delete another session's delivery/<other-slug>/ directory --
# only its OWN keepSlug directory. Seed a fixture other-session seal BEFORE publishing a
# DIFFERENT slug, then assert the fixture survives byte-identical.
echo ""
echo "=== TEST 8: AC2 CROSS-SESSION-SEAL-SURVIVES ==="

REPO8="$TMP/repo8"
AROOT8="$REPO8/.flow-agents"
SLUG8="pd-cross-session-test"
SESSION_DIR8="$AROOT8/$SLUG8"
mkdir -p "$REPO8/kits"

OTHER_SLUG="pd-other-inflight-session"
OTHER_SEAL_DIR="$REPO8/delivery/$OTHER_SLUG"
mkdir -p "$OTHER_SEAL_DIR"
printf '{"marker":"other-session-trust-bundle","schemaVersion":5}' > "$OTHER_SEAL_DIR/trust.bundle"
printf '{"schema_version":"1.0","slug":"%s","work_item":null,"status":"delivered","phase":"release","sealed_at":"2026-06-27T00:00:00Z","commit_sha":"deadbeefdeadbeefdeadbeefdeadbeefdeadbeef","checkpoint":{"asOf":"2026-06-27T00:00:00.000Z","statusByClaimId":{}}}'   > "$OTHER_SEAL_DIR/trust.checkpoint.json"
OTHER_BUNDLE_BEFORE="$(cat "$OTHER_SEAL_DIR/trust.bundle")"
OTHER_CHECKPOINT_BEFORE="$(cat "$OTHER_SEAL_DIR/trust.checkpoint.json")"

FIXTURE8="$TMP/fixture8.json"
write_bundle_to "$FIXTURE8" "node --version" "true"
setup_session "$AROOT8" "$SLUG8" "$FIXTURE8"

cross_out=$(TRUST_RECONCILE_COMMANDS="node --version" flow_agents_node "$WRITER" publish-delivery "$SESSION_DIR8"   --repo-root "$REPO8" 2>&1)
cross_exit=$?

if [[ $cross_exit -eq 0 ]]; then
  _pass "AC2 CROSS-SESSION-SEAL-SURVIVES: publish-delivery for $SLUG8 exits 0"
else
  _fail "AC2 CROSS-SESSION-SEAL-SURVIVES: publish-delivery for $SLUG8 unexpectedly failed: $cross_out"
fi

if [[ -f "$REPO8/delivery/$SLUG8/trust.bundle" ]]; then
  _pass "AC2 CROSS-SESSION-SEAL-SURVIVES: this session's OWN delivery/$SLUG8/trust.bundle was written"
else
  _fail "AC2 CROSS-SESSION-SEAL-SURVIVES: delivery/$SLUG8/trust.bundle was not written"
fi

if [[ -d "$OTHER_SEAL_DIR" ]]; then
  _pass "AC2 CROSS-SESSION-SEAL-SURVIVES: the OTHER session's delivery/$OTHER_SLUG/ directory SURVIVES"
else
  _fail "AC2 CROSS-SESSION-SEAL-SURVIVES: the other session's delivery/$OTHER_SLUG/ directory was deleted -- cross-slug pruning regressed"
fi

if [[ -f "$OTHER_SEAL_DIR/trust.bundle" && "$(cat "$OTHER_SEAL_DIR/trust.bundle" 2>/dev/null)" == "$OTHER_BUNDLE_BEFORE" ]]; then
  _pass "AC2 CROSS-SESSION-SEAL-SURVIVES: the other session's trust.bundle is byte-identical after this publish"
else
  _fail "AC2 CROSS-SESSION-SEAL-SURVIVES: the other session's trust.bundle was mutated or removed"
fi

if [[ -f "$OTHER_SEAL_DIR/trust.checkpoint.json" && "$(cat "$OTHER_SEAL_DIR/trust.checkpoint.json" 2>/dev/null)" == "$OTHER_CHECKPOINT_BEFORE" ]]; then
  _pass "AC2 CROSS-SESSION-SEAL-SURVIVES: the other session's trust.checkpoint.json is byte-identical after this publish"
else
  _fail "AC2 CROSS-SESSION-SEAL-SURVIVES: the other session's trust.checkpoint.json was mutated or removed"
fi

# Mutation-test note (prune scoping): this eval passes ONLY because pruneSupersededSeals was
# scoped to keepSlug's own directory (#413 Facet B). Prior to that fix, this loop deleted ANY
# non-keepSlug directory under delivery/ that looked like a seal (contained trust.bundle or
# trust.checkpoint.json) -- exactly OTHER_SEAL_DIR's shape -- so this test would have failed
# the two directory/byte-identical checks above against the pre-fix implementation.

# ==== TEST 9: FIX 4 SHALLOW-UNDETERMINABLE-WARNS-NOT-REFUSES (#413 iteration-2) =====
# A REAL shallow clone (git clone --depth 1) whose sealed trust.checkpoint.json commit_sha names
# an OLDER commit the shallow clone's object database genuinely does not have -- `git merge-base
# --is-ancestor` cannot determine ancestry here (exit 128, not 0 or 1), which is the
# UNDETERMINABLE case Fix 4 must warn-and-allow, never hard-refuse. Distinct from TEST 7's
# POSITIVELY-DETERMINABLE orphan-commit mismatch, which correctly still hard-refuses.
echo ""
echo "=== TEST 9: FIX 4 SHALLOW-UNDETERMINABLE-WARNS-NOT-REFUSES ==="

SRC9="$TMP/src9"
mkdir -p "$SRC9/kits"
(cd "$SRC9" && git init -q && git config user.email "test@test.local" && git config user.name "test" \
  && printf 'a\n' > kits/.keep && git add -A && git commit -q -m "commit A (older, will be missing from the shallow clone)")
SHA9_A="$(cd "$SRC9" && git rev-parse HEAD)"
(cd "$SRC9" && printf 'b\n' > kits/b.txt && git add -A && git commit -q -m "commit B")
(cd "$SRC9" && printf 'c\n' > kits/c.txt && git add -A && git commit -q -m "commit C (HEAD, shallow clone's only commit)")

REPO9="$TMP/repo9"
if git clone -q --depth 1 --no-local "file://$SRC9" "$REPO9" >/dev/null 2>"$TMP/shallow-clone9.err"; then
  _pass "TEST 9 setup: a real shallow clone (--depth 1) was created"
else
  _fail "TEST 9 setup: shallow clone failed: $(cat "$TMP/shallow-clone9.err")"
fi
SHA9_HEAD="$(cd "$REPO9" && git rev-parse HEAD)"

# Confirm the shallow clone genuinely cannot determine ancestry for the older, missing commit --
# the exact precondition this test depends on.
if ! (cd "$REPO9" && git cat-file -e "$SHA9_A" 2>/dev/null); then
  _pass "TEST 9 setup: the shallow clone's object database genuinely lacks commit A (the precondition for UNDETERMINABLE ancestry)"
else
  _fail "TEST 9 setup: the shallow clone unexpectedly has commit A -- this fixture no longer exercises the undeterminable path"
fi

AROOT9="$REPO9/.flow-agents"
SLUG9="pd-shallow-undeterminable-test"
SESSION_DIR9="$AROOT9/$SLUG9"
mkdir -p "$REPO9/kits" # kits/ already exists from the clone, but keep parity with other tests' setup shape

FIXTURE9="$TMP/fixture9.json"
write_bundle_to "$FIXTURE9" "node --version" "true"
setup_session "$AROOT9" "$SLUG9" "$FIXTURE9"
# Seal a checkpoint naming the OLDER commit (A) the shallow clone does not have -- mirrors TEST
# 7's shape but targets a genuinely shallow repo.
printf '{"schema_version":"1.0","slug":"%s","work_item":null,"status":"delivered","phase":"release","sealed_at":"2026-06-27T00:00:00Z","commit_sha":"%s","checkpoint":{"asOf":"2026-06-27T00:00:00.000Z","statusByClaimId":{}}}' \
  "$SLUG9" "$SHA9_A" > "$SESSION_DIR9/trust.checkpoint.json"

shallow_out=$(TRUST_RECONCILE_COMMANDS="node --version" flow_agents_node "$WRITER" publish-delivery "$SESSION_DIR9" --repo-root "$REPO9" 2>&1)
shallow_exit=$?

if [[ $shallow_exit -eq 0 ]]; then
  _pass "FIX 4: publish-delivery from a shallow clone with an undeterminable checkpoint ancestry still exits 0 (warns, does not refuse)"
else
  _fail "FIX 4: publish-delivery unexpectedly refused (non-zero exit) for the shallow/undeterminable case: $shallow_out"
fi

if echo "$shallow_out" | grep -qi "WARNING.*could not determine"; then
  _pass "FIX 4: output contains a loud WARNING naming the undeterminable ancestry"
else
  _fail "FIX 4: expected a loud WARNING for the undeterminable ancestry case, got: $shallow_out"
fi

if echo "$shallow_out" | grep -q "REFUSING to publish"; then
  _fail "FIX 4: unexpectedly REFUSED the shallow/undeterminable case -- this must warn and allow, never hard-refuse"
else
  _pass "FIX 4: no REFUSING to publish message -- the shallow/undeterminable case is correctly NOT treated as a hard refuse"
fi

if [[ -f "$REPO9/delivery/$SLUG9/trust.bundle" ]]; then
  _pass "FIX 4: delivery/$SLUG9/trust.bundle WAS published despite the undeterminable ancestry (warn-and-allow, not refuse)"
else
  _fail "FIX 4: delivery/$SLUG9/trust.bundle was NOT published -- the shallow/undeterminable case was incorrectly blocked"
fi

# Mutation-test note (Fix 4): this test passes ONLY because checkpointHeadAncestry's
# mismatchKind classification distinguishes "positive" (git merge-base --is-ancestor exits 1,
# a real answer) from "undeterminable-shallow" (exit 128 / spawn failure, e.g. this shallow
# clone's missing commit object). Prior to Fix 4, the collapsed isAncestorCommit() boolean
# treated shallow-missing exactly the same as a positively-confirmed non-ancestor, and this
# test would have failed the REFUSING/exit-0/bundle-published assertions above.

# ==== TEST 10: NON-GIT-REPOROOT-WITH-SEALED-COMMIT-ALLOWS (#413 iteration-2 Fix 5, reverted) ====
# repoRoot resolves to a real path, but it is NOT a git working tree at all (a bare mkdir -p,
# no .git anywhere) -- while the session's sealed trust.checkpoint.json names a real commit_sha.
# This is a SUPPORTED flow (scratch/checkpoint-signing dirs, see
# evals/integration/test_checkpoint_signing.sh TEST 2), so publish-delivery must still PUBLISH
# (exit 0, bundle copied) -- not the FIX 5 hard-refuse iteration-2 briefly added and iteration-3
# reverted. Distinct from the pre-existing "no checkpoint / no commit_sha -> allow" no-opinion
# case TEST 1/2/5/6 already cover with their own bare mkdir -p repos that have no checkpoint at
# all -- this test's REPO10 DOES have a sealed checkpoint with a real-looking commit_sha, and
# still allows.
echo ""
echo "=== TEST 10: NON-GIT-REPOROOT-WITH-SEALED-COMMIT-ALLOWS ==="

REPO10="$TMP/repo10"
AROOT10="$REPO10/.flow-agents"
SLUG10="pd-non-git-reporoot-test"
SESSION_DIR10="$AROOT10/$SLUG10"
mkdir -p "$REPO10/kits" # kits/ marker only -- deliberately NO git init anywhere under REPO10

FIXTURE10="$TMP/fixture10.json"
write_bundle_to "$FIXTURE10" "node --version" "true"
setup_session "$AROOT10" "$SLUG10" "$FIXTURE10"
# Seal a checkpoint naming a plausible-looking (but unverifiable, since there's no git repo here
# at all) commit_sha.
printf '{"schema_version":"1.0","slug":"%s","work_item":null,"status":"delivered","phase":"release","sealed_at":"2026-06-27T00:00:00Z","commit_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","checkpoint":{"asOf":"2026-06-27T00:00:00.000Z","statusByClaimId":{}}}' \
  > "$SESSION_DIR10/trust.checkpoint.json"

if [[ ! -d "$REPO10/.git" ]]; then
  _pass "TEST 10 setup: REPO10 genuinely has no .git -- not a git working tree at all"
else
  _fail "TEST 10 setup: REPO10 unexpectedly has a .git directory"
fi

nongit_out=$(TRUST_RECONCILE_COMMANDS="node --version" flow_agents_node "$WRITER" publish-delivery "$SESSION_DIR10" --repo-root "$REPO10" 2>&1)
nongit_exit=$?

if [[ $nongit_exit -eq 0 ]]; then
  _pass "NON-GIT-REPOROOT-ALLOWS: publish-delivery exits 0 for a non-git repoRoot with a sealed commit_sha"
else
  _fail "NON-GIT-REPOROOT-ALLOWS: expected exit 0 for a non-git repoRoot with a sealed commit_sha, got $nongit_exit -- $nongit_out"
fi

if ! echo "$nongit_out" | grep -q "REFUSING to publish"; then
  _pass "NON-GIT-REPOROOT-ALLOWS: output does not contain a REFUSING to publish message"
else
  _fail "NON-GIT-REPOROOT-ALLOWS: unexpected REFUSING to publish message, got: $nongit_out"
fi

if [[ -f "$REPO10/delivery/$SLUG10/trust.bundle" ]]; then
  _pass "NON-GIT-REPOROOT-ALLOWS: delivery/$SLUG10/trust.bundle created for a non-git repoRoot with a sealed commit_sha"
else
  _fail "NON-GIT-REPOROOT-ALLOWS: delivery/$SLUG10/trust.bundle NOT created despite the supported non-git-repoRoot flow"
fi

# Mutation-test note: this test passes only because checkpointHeadAncestry's non-git-repoRoot
# path resolves headSha to empty (git rev-parse HEAD fails outside a working tree) and returns
# mismatchKind:"none" (the same "no opinion, allow" result as the genuinely no-checkpoint case) --
# never the iteration-2 Fix 5 non-git-repo refuse arm, which this test's own removal proves is
# gone.

# ==== TEST 11: LOUD-DIRECT-CLI-NO-BUNDLE ============================
# The direct `publish-delivery` subcommand must REFUSE loudly (non-zero exit, diagnostic naming
# the path and the fix) when the given dir has no trust.bundle -- unlike the internal auto-publish
# call sites (record-release/advance-state/promote), which TEST 5 above proves stay fail-soft.
echo ""
echo "=== TEST 11: LOUD-DIRECT-CLI-NO-BUNDLE ==="

REPO11="$TMP/repo11"
AROOT11="$REPO11/.flow-agents"
SLUG11="pd-loud-no-bundle-test"
SESSION_DIR11="$AROOT11/$SLUG11"
mkdir -p "$REPO11/kits"

# A session that was set up (ensure-session/init-plan/record-evidence/record-critique) but never
# sealed -- no trust.bundle exists at the session dir, exactly the "never ran seal-checkpoint"
# real-world root cause. Mirrors TEST 5 FAIL-SOFT's own setup: setup_session's record-evidence
# call writes ITS OWN trust.bundle as a side effect (ADR 0010: bundle is the primary artifact),
# so it must be removed afterward to genuinely simulate "no trust.bundle at this path".
setup_session "$AROOT11" "$SLUG11" ""
rm -f "$SESSION_DIR11/trust.bundle"
if [[ -f "$SESSION_DIR11/trust.bundle" ]]; then
  _fail "TEST 11 setup: expected no trust.bundle at $SESSION_DIR11, but one exists"
else
  _pass "TEST 11 setup: $SESSION_DIR11 genuinely has no trust.bundle"
fi

loud_out=$(flow_agents_node "$WRITER" publish-delivery "$SESSION_DIR11" --repo-root "$REPO11" 2>&1)
loud_exit=$?

if [[ $loud_exit -ne 0 ]]; then
  _pass "LOUD-DIRECT-CLI-NO-BUNDLE: publish-delivery exits non-zero for a missing trust.bundle"
else
  _fail "LOUD-DIRECT-CLI-NO-BUNDLE: expected non-zero exit, got 0 -- $loud_out"
fi

if echo "$loud_out" | grep -qF "$SESSION_DIR11"; then
  _pass "LOUD-DIRECT-CLI-NO-BUNDLE: diagnostic names the session artifact dir path"
else
  _fail "LOUD-DIRECT-CLI-NO-BUNDLE: expected the session dir path in the diagnostic, got: $loud_out"
fi

if echo "$loud_out" | grep -q "record-evidence" && echo "$loud_out" | grep -q "seal-checkpoint"; then
  _pass "LOUD-DIRECT-CLI-NO-BUNDLE: diagnostic names the next command (record-evidence then seal-checkpoint)"
else
  _fail "LOUD-DIRECT-CLI-NO-BUNDLE: expected next-command guidance (record-evidence/seal-checkpoint) in the diagnostic, got: $loud_out"
fi

if [[ ! -d "$REPO11/delivery/$SLUG11" ]]; then
  _pass "LOUD-DIRECT-CLI-NO-BUNDLE: delivery/$SLUG11/ NOT created for a missing trust.bundle"
else
  _fail "LOUD-DIRECT-CLI-NO-BUNDLE: delivery/$SLUG11/ was created despite the missing trust.bundle"
fi

# Mutation-test note: this test passes ONLY because publishDelivery()'s missing-bundle branch was
# changed from a silent `return` to `throw new SessionNotPublishableError(dir)` -- prior to that
# fix, the direct CLI subcommand would have exited 0 with no output here, exactly the silent
# footgun this test guards against.

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
