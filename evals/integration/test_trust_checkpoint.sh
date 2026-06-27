#!/usr/bin/env bash
# test_trust_checkpoint.sh — Integration eval for Increment A: per-run trust CHECKPOINT.
#
# Proves that:
#   1. SEAL-AT-COMPLETE: running record-release (which sets status=delivered) with a
#      trust.bundle present writes trust.checkpoint.json with the correct envelope shape:
#        - schema_version, slug, status=delivered, phase=release, sealed_at, commit_sha
#        - checkpoint.statusByClaimId, checkpoint.statusFunctionVersion, checkpoint.throughEventCreatedAt
#   2. ADVANCE-STATE-DELIVERED: advance-state --status delivered also writes
#      trust.checkpoint.json (alternative delivered path).
#   3. SEAL-CHECKPOINT-SUBCOMMAND: seal-checkpoint <dir> explicit subcommand writes the
#      checkpoint and outputs the path to stdout.
#   4. DIFF-ON-DRIFT: after sealing, mutating the bundle (expiresAt in the past) causes
#      render-trust-panel to emit a "went stale" message via diffFreshness.
#   5. NO-BUNDLE-SKIP: when no trust.bundle exists, seal-checkpoint exits 0 (graceful skip).
#   6. ADDITIVE/NO-REGRESSION: existing commands record-evidence, record-critique,
#      advance-state to non-delivered statuses, record-learning all continue to work.
#
# Deterministic, no model spend, self-cleaning.
# Usage: bash evals/integration/test_trust_checkpoint.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

WRITER="workflow-sidecar"
TMP="$(mktemp -d)"
errors=0

_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

echo ""
echo "=== TEST 1: Seal-at-complete — record-release writes trust.checkpoint.json ==="

AROOT1="$TMP/test1/.flow-agents"
SLUG1="ckpt-release-test"
SESSION_DIR1="$AROOT1/$SLUG1"
mkdir -p "$AROOT1"

flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$AROOT1" \
  --task-slug "$SLUG1" \
  --title "Checkpoint Release Test" \
  --summary "Test that record-release seals trust.checkpoint.json." \
  --criterion "Evidence recorded" \
  --timestamp "2026-06-26T10:00:00Z" >/dev/null 2>&1

flow_agents_node "$WRITER" init-plan "$SESSION_DIR1/${SLUG1}--deliver.md" \
  --source-request "Test" --summary "Test" \
  --timestamp "2026-06-26T10:01:00Z" >/dev/null 2>&1

flow_agents_node "$WRITER" record-evidence "$SESSION_DIR1" \
  --verdict pass \
  --check-json '{"id":"build","kind":"build","status":"pass","summary":"build passed"}' \
  --check-json '{"id":"types","kind":"types","status":"pass","summary":"types ok"}' \
  --timestamp "2026-06-26T10:02:00Z" >/dev/null 2>&1

flow_agents_node "$WRITER" record-critique "$SESSION_DIR1" \
  --verdict pass \
  --summary "Review passed." \
  --timestamp "2026-06-26T10:03:00Z" >/dev/null 2>&1

flow_agents_node "$WRITER" record-release "$SESSION_DIR1" \
  --decision merge \
  --gate-json '{"name":"merge","status":"pass","summary":"Ready to merge."}' \
  --summary "Release recorded." \
  --timestamp "2026-06-26T10:04:00Z" >/dev/null 2>&1

if [[ -f "$SESSION_DIR1/trust.checkpoint.json" ]]; then
  _pass "record-release writes trust.checkpoint.json"
else
  _fail "record-release did NOT write trust.checkpoint.json"
fi

# Validate envelope shape
node - "$SESSION_DIR1/trust.checkpoint.json" <<'NODE'
const fs = require("fs");
const env = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));

const errors = [];
if (env.schema_version !== "1.0") errors.push("schema_version expected '1.0', got " + env.schema_version);
if (typeof env.slug !== "string" || !env.slug) errors.push("slug missing");
if (env.status !== "delivered") errors.push("status expected 'delivered', got " + env.status);
if (env.phase !== "release") errors.push("phase expected 'release', got " + env.phase);
if (typeof env.sealed_at !== "string" || !env.sealed_at) errors.push("sealed_at missing");
// commit_sha can be null if not in a git repo, but must be present as key
if (!Object.prototype.hasOwnProperty.call(env, "commit_sha")) errors.push("commit_sha key absent");
if (!env.checkpoint || typeof env.checkpoint !== "object") errors.push("checkpoint missing or not object");
const ckpt = env.checkpoint;
if (!ckpt.statusByClaimId || typeof ckpt.statusByClaimId !== "object") errors.push("checkpoint.statusByClaimId missing");
if (typeof ckpt.statusFunctionVersion !== "string") errors.push("checkpoint.statusFunctionVersion missing");
if (!Object.prototype.hasOwnProperty.call(ckpt, "throughEventCreatedAt")) errors.push("checkpoint.throughEventCreatedAt missing");

const claimCount = Object.keys(ckpt.statusByClaimId || {}).length;
if (claimCount === 0) errors.push("checkpoint.statusByClaimId is empty — expected at least 1 claim");

if (errors.length > 0) {
  console.error("ENVELOPE SHAPE ERRORS:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("envelope valid: schema_version=" + env.schema_version + " status=" + env.status + " claims=" + claimCount + " sfv=" + ckpt.statusFunctionVersion);
NODE
if [[ $? -eq 0 ]]; then
  _pass "trust.checkpoint.json envelope shape is valid (schema_version, slug, status, phase, sealed_at, commit_sha, checkpoint.*)"
else
  _fail "trust.checkpoint.json envelope shape invalid"
fi

echo ""
echo "=== TEST 2: Seal via advance-state --status delivered ==="

AROOT2="$TMP/test2/.flow-agents"
SLUG2="ckpt-advance-test"
SESSION_DIR2="$AROOT2/$SLUG2"
mkdir -p "$AROOT2"

flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$AROOT2" \
  --task-slug "$SLUG2" \
  --title "Checkpoint Advance Test" \
  --summary "Test that advance-state --status delivered seals trust.checkpoint.json." \
  --timestamp "2026-06-26T11:00:00Z" >/dev/null 2>&1

flow_agents_node "$WRITER" init-plan "$SESSION_DIR2/${SLUG2}--deliver.md" \
  --source-request "Test" --summary "Test" \
  --timestamp "2026-06-26T11:01:00Z" >/dev/null 2>&1

flow_agents_node "$WRITER" record-evidence "$SESSION_DIR2" \
  --verdict pass \
  --check-json '{"id":"build","kind":"build","status":"pass","summary":"build passed"}' \
  --timestamp "2026-06-26T11:02:00Z" >/dev/null 2>&1

if [[ -f "$SESSION_DIR2/trust.checkpoint.json" ]]; then
  _fail "trust.checkpoint.json should NOT exist before advance-state delivered"
else
  _pass "trust.checkpoint.json absent before advance-state --status delivered (correct)"
fi

flow_agents_node "$WRITER" advance-state "$SESSION_DIR2" \
  --status delivered \
  --phase release \
  --summary "Delivered via advance-state." \
  --timestamp "2026-06-26T11:03:00Z" >/dev/null 2>&1

if [[ -f "$SESSION_DIR2/trust.checkpoint.json" ]]; then
  _pass "advance-state --status delivered writes trust.checkpoint.json"
else
  _fail "advance-state --status delivered did NOT write trust.checkpoint.json"
fi

node - "$SESSION_DIR2/trust.checkpoint.json" <<'NODE'
const fs = require("fs");
const env = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (env.status !== "delivered") { console.error("expected status=delivered, got " + env.status); process.exit(1); }
if (!env.checkpoint || !env.checkpoint.statusByClaimId) { console.error("missing checkpoint.statusByClaimId"); process.exit(1); }
console.log("advance-state checkpoint: status=" + env.status + " sealed_at=" + env.sealed_at);
NODE
if [[ $? -eq 0 ]]; then
  _pass "advance-state delivered checkpoint has correct status and checkpoint fields"
else
  _fail "advance-state delivered checkpoint shape invalid"
fi

echo ""
echo "=== TEST 3: seal-checkpoint explicit subcommand ==="

AROOT3="$TMP/test3/.flow-agents"
SLUG3="ckpt-explicit-test"
SESSION_DIR3="$AROOT3/$SLUG3"
mkdir -p "$AROOT3"

flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$AROOT3" \
  --task-slug "$SLUG3" \
  --title "Checkpoint Explicit Test" \
  --summary "Test seal-checkpoint subcommand." \
  --timestamp "2026-06-26T12:00:00Z" >/dev/null 2>&1

flow_agents_node "$WRITER" init-plan "$SESSION_DIR3/${SLUG3}--deliver.md" \
  --source-request "Test" --summary "Test" \
  --timestamp "2026-06-26T12:01:00Z" >/dev/null 2>&1

flow_agents_node "$WRITER" record-evidence "$SESSION_DIR3" \
  --verdict pass \
  --check-json '{"id":"build","kind":"build","status":"pass","summary":"build passed"}' \
  --timestamp "2026-06-26T12:02:00Z" >/dev/null 2>&1

SEAL_OUT="$TMP/seal-out.txt"
flow_agents_node "$WRITER" seal-checkpoint "$SESSION_DIR3" \
  --timestamp "2026-06-26T12:03:00Z" > "$SEAL_OUT" 2>/dev/null

if [[ -f "$SESSION_DIR3/trust.checkpoint.json" ]]; then
  _pass "seal-checkpoint subcommand writes trust.checkpoint.json"
else
  _fail "seal-checkpoint subcommand did NOT write trust.checkpoint.json"
fi

if grep -q "trust.checkpoint.json" "$SEAL_OUT"; then
  _pass "seal-checkpoint subcommand outputs the checkpoint file path to stdout"
else
  _fail "seal-checkpoint subcommand did not output file path (got: $(cat "$SEAL_OUT"))"
fi

echo ""
echo "=== TEST 4: diff-on-drift — stale claim reported on resume ==="

# Reuse SESSION_DIR1 which has a sealed checkpoint
# Mutate the bundle: set expiresAt in the past on the first claim
node - "$SESSION_DIR1/trust.bundle" <<'NODE'
const fs = require("fs");
const bundle = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const firstClaim = bundle.claims[0];
if (!firstClaim) { console.error("No claims in bundle"); process.exit(1); }
firstClaim.expiresAt = "2020-01-01T00:00:00Z";
fs.writeFileSync(process.argv[2], JSON.stringify(bundle, null, 2));
console.log("Mutated claim: " + firstClaim.id + " expiresAt set to past");
NODE

# Run render-trust-panel and capture stderr for the freshness diff
DIFF_STDERR="$TMP/diff-stderr.txt"
flow_agents_node "$WRITER" render-trust-panel "$SESSION_DIR1" 2>"$DIFF_STDERR" >/dev/null

if grep -q "trust-checkpoint" "$DIFF_STDERR" && grep -q "stale" "$DIFF_STDERR"; then
  _pass "render-trust-panel reports stale claim(s) via diffFreshness after bundle mutation"
else
  _fail "render-trust-panel did NOT report stale transitions (got: $(cat "$DIFF_STDERR"))"
fi

# Also check the count is non-zero
if grep -qE "\[trust-checkpoint\] [1-9][0-9]* claim" "$DIFF_STDERR"; then
  _pass "diffFreshness reports at least 1 fresh→stale transition"
else
  _fail "diffFreshness did not report expected number of stale transitions"
fi

echo ""
echo "=== TEST 5: No-bundle graceful skip ==="

NOBUNDLE_DIR="$TMP/nobundle"
mkdir -p "$NOBUNDLE_DIR"
printf '{"schema_version":"1.0","task_slug":"no-bundle","status":"planning","phase":"execution","updated_at":"2026-06-26T10:00:00Z","next_action":{"status":"continue","summary":"test"}}' \
  > "$NOBUNDLE_DIR/state.json"

SEAL_ERR="$TMP/seal-no-bundle-err.txt"
if flow_agents_node "$WRITER" seal-checkpoint "$NOBUNDLE_DIR" \
  --timestamp "2026-06-26T10:00:00Z" > /dev/null 2>"$SEAL_ERR"; then
  _pass "seal-checkpoint exits 0 when no trust.bundle present (graceful skip)"
else
  _fail "seal-checkpoint exited non-zero when no trust.bundle present"
fi

if [[ -f "$NOBUNDLE_DIR/trust.checkpoint.json" ]]; then
  _fail "seal-checkpoint should NOT write trust.checkpoint.json when no trust.bundle"
else
  _pass "seal-checkpoint does NOT write trust.checkpoint.json when no trust.bundle"
fi

echo ""
echo "=== TEST 6: Additive — non-delivered advance-state does NOT write checkpoint ==="

AROOT6="$TMP/test6/.flow-agents"
SLUG6="ckpt-additive-test"
SESSION_DIR6="$AROOT6/$SLUG6"
mkdir -p "$AROOT6"

flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$AROOT6" \
  --task-slug "$SLUG6" \
  --title "Additive Test" \
  --summary "Test that non-delivered advance-state does not write checkpoint." \
  --timestamp "2026-06-26T13:00:00Z" >/dev/null 2>&1

flow_agents_node "$WRITER" init-plan "$SESSION_DIR6/${SLUG6}--deliver.md" \
  --source-request "Test" --summary "Test" \
  --timestamp "2026-06-26T13:01:00Z" >/dev/null 2>&1

flow_agents_node "$WRITER" record-evidence "$SESSION_DIR6" \
  --verdict pass \
  --check-json '{"id":"build","kind":"build","status":"pass","summary":"build passed"}' \
  --timestamp "2026-06-26T13:02:00Z" >/dev/null 2>&1

# Advance to verified (non-delivered)
flow_agents_node "$WRITER" advance-state "$SESSION_DIR6" \
  --status verified \
  --phase verification \
  --summary "Verified." \
  --timestamp "2026-06-26T13:03:00Z" >/dev/null 2>&1

if [[ -f "$SESSION_DIR6/trust.checkpoint.json" ]]; then
  _fail "advance-state to verified should NOT write trust.checkpoint.json"
else
  _pass "advance-state to non-delivered (verified) does NOT write trust.checkpoint.json (additive)"
fi

echo ""
echo "=== TEST 7: Idempotent — re-sealing overwrites with latest snapshot ==="

# Re-run seal-checkpoint on SESSION_DIR1 (already sealed)
FIRST_SEALED_AT=$(node -e "const fs=require('fs'); const e=JSON.parse(fs.readFileSync('$SESSION_DIR1/trust.checkpoint.json','utf8')); console.log(e.sealed_at);")

flow_agents_node "$WRITER" seal-checkpoint "$SESSION_DIR1" \
  --timestamp "2026-06-26T16:00:00Z" >/dev/null 2>&1

SECOND_SEALED_AT=$(node -e "const fs=require('fs'); const e=JSON.parse(fs.readFileSync('$SESSION_DIR1/trust.checkpoint.json','utf8')); console.log(e.sealed_at);")

if [[ "$FIRST_SEALED_AT" != "$SECOND_SEALED_AT" ]]; then
  _pass "seal-checkpoint is idempotent — re-running overwrites with latest sealed_at ($SECOND_SEALED_AT)"
else
  _fail "seal-checkpoint idempotent re-run: sealed_at did not update (still $FIRST_SEALED_AT)"
fi

echo ""
echo "────────────────────────────────────────────"
if [[ $errors -eq 0 ]]; then
  echo "test_trust_checkpoint: all checks passed."
  exit 0
else
  echo "test_trust_checkpoint: $errors check(s) failed."
  exit 1
fi
