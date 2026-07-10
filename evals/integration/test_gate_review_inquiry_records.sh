#!/usr/bin/env bash
# test_gate_review_inquiry_records.sh — AC1 + AC2 integration tests for gate-review #119.
#
# Verifies that the gate-review subcommand emits canonical InquiryRecords
# (gate-review.inquiries.json) validated against hachure inquiry-record.schema.json.
#
# AC1: a session with a gate event yields ≥1 InquiryRecord.
# AC2: false_block scenario (claim verified + block) and missed_block scenario
#      (expected claim absent) each yield a distinct InquiryRecord with the
#      correct calibration + non-empty advisoryFix.
#
# Seed is deterministic: same inputs → same outputs. Surface is loaded from the
# installed optional dependency (@kontourai/surface).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

TMPDIR_EVAL="$(mktemp -d)"
errors=0

cleanup() { rm -rf "$TMPDIR_EVAL"; }
trap cleanup EXIT

_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

hook_tree_digest() {
  find "$ROOT/scripts/hooks" -type f -print | LC_ALL=C sort | while IFS= read -r file; do
    shasum -a 256 "$file"
  done | shasum -a 256 | awk '{print $1}'
}

HOOKS_BEFORE="$(hook_tree_digest)"

echo "=== Gate Review InquiryRecord Tests (AC1 + AC2) ==="

# ── helpers ──────────────────────────────────────────────────────────────────

# JSON query helper using node (no jq dependency)
jq_node() {
  local file="$1"; local expr="$2"
  node -e "
const d=JSON.parse(require('fs').readFileSync('${file}','utf8'));
const r=(${expr})(d);
if(r===undefined||r===null){process.exit(2);}
if(typeof r==='boolean'||typeof r==='number'||typeof r==='string'){
  process.stdout.write(String(r)+'\n');
}else{
  process.stdout.write(JSON.stringify(r)+'\n');
}"
}

# Write a minimal trust.bundle for testing. Args:
#   $1: dir       session artifact dir (bundle written as trust.bundle)
#   $2: slug      session slug
#   $3: status    claim status (verified|disputed|assumed|stale|unknown)
seed_trust_bundle() {
  local dir="$1" slug="$2" status="$3"
  local ts="2026-06-24T00:00:00Z"
  local claimId="${slug}/unit-tests.flow-agents.workflow.unit tests pass"

  # Build events array: add a "verified" or "disputed" event when status requires it
  local events="[]"
  if [[ "$status" == "verified" ]]; then
    events='[{"id":"evt:'"$claimId"'","claimId":"'"$claimId"'","status":"verified","actor":"gate-review-test","method":"validation","evidenceIds":[],"createdAt":"'"$ts"'","verifiedAt":"'"$ts"'"}]'
  elif [[ "$status" == "disputed" ]]; then
    events='[{"id":"evt:'"$claimId"'","claimId":"'"$claimId"'","status":"disputed","actor":"gate-review-test","method":"validation","evidenceIds":[],"createdAt":"'"$ts"'","verifiedAt":"'"$ts"'"}]'
  fi

  cat > "$dir/trust.bundle" <<JSON
{
  "schemaVersion": 5,
  "source": "gate-review-test;statusFunctionVersion=1",
  "claims": [
    {
      "id": "$claimId",
      "subjectType": "workflow-check",
      "subjectId": "$slug/unit-tests",
      "facet": "flow-agents.workflow",
      "claimType": "workflow.check.test",
      "fieldOrBehavior": "unit tests pass",
      "value": "pass",
      "status": "$status",
      "createdAt": "$ts",
      "updatedAt": "$ts"
    }
  ],
  "evidence": [],
  "events": $events,
  "policies": []
}
JSON
}

# Set the gate block streak file ($1: root, $2: count)
seed_block_streak() {
  local root="$1" count="$2"
  if [[ "$count" -gt 0 ]]; then
    printf '{"count":%d,"hash":"testHash001"}' "$count" > "$root/.goal-fit-block-streak.json"
  else
    rm -f "$root/.goal-fit-block-streak.json"
  fi
}

# Remove the block streak file
clear_block_streak() {
  rm -f "$1/.goal-fit-block-streak.json"
}

# ── AC1: session with a gate event → ≥1 InquiryRecord ───────────────────────
echo ""
echo "--- AC1: gate event → ≥1 InquiryRecord ---"

AC1_ROOT="$TMPDIR_EVAL/ac1/.flow-agents"
AC1_SLUG="ac1-session"
AC1_DIR="$AC1_ROOT/$AC1_SLUG"
mkdir -p "$AC1_DIR"

# Seed: verified claim + blocked (false_block scenario for AC1)
seed_trust_bundle "$AC1_DIR" "$AC1_SLUG" "verified"
seed_block_streak "$AC1_ROOT" 1

if flow_agents_node workflow-sidecar gate-review "$AC1_DIR" \
  >"$TMPDIR_EVAL/ac1.out" 2>"$TMPDIR_EVAL/ac1.err"; then
  _pass "AC1: gate-review exits 0"
else
  _fail "AC1: gate-review failed: $(cat "$TMPDIR_EVAL/ac1.err")"
fi

AC1_INQUIRIES="$AC1_DIR/gate-review.inquiries.json"
if [[ -f "$AC1_INQUIRIES" ]]; then
  _pass "AC1: gate-review.inquiries.json emitted"
else
  _fail "AC1: gate-review.inquiries.json missing"
fi

if [[ -f "$AC1_INQUIRIES" ]]; then
  AC1_COUNT="$(jq_node "$AC1_INQUIRIES" 'd => d.length' 2>/dev/null || echo 0)"
  if [[ "$AC1_COUNT" -ge 1 ]]; then
    _pass "AC1: ≥1 InquiryRecord present (count=$AC1_COUNT)"
  else
    _fail "AC1: expected ≥1 InquiryRecord, got $AC1_COUNT"
  fi

  # Verify each record has required schema fields
  MISSING_FIELDS="$(node -e "
const records=JSON.parse(require('fs').readFileSync('$AC1_INQUIRIES','utf8'));
const required=['id','inquiry','outcome','resolutionPath','inputSnapshot','statusFunctionVersion','resolvedAt'];
const missing=[];
for(const [i,r] of records.entries()){
  for(const f of required){
    if(!(f in r)) missing.push('record['+i+'].'+f);
  }
}
process.stdout.write(missing.join(','));
" 2>/dev/null)"
  if [[ -z "$MISSING_FIELDS" ]]; then
    _pass "AC1: all InquiryRecords have required schema fields"
  else
    _fail "AC1: InquiryRecords missing fields: $MISSING_FIELDS"
  fi

  # Verify each record has non-empty advisoryFix in answer.value
  EMPTY_FIX="$(node -e "
const records=JSON.parse(require('fs').readFileSync('$AC1_INQUIRIES','utf8'));
const bad=records.filter(r=>!r.answer||!r.answer.value||!r.answer.value.advisoryFix);
process.stdout.write(bad.map(r=>r.id).join(','));
" 2>/dev/null)"
  if [[ -z "$EMPTY_FIX" ]]; then
    _pass "AC1: all InquiryRecords have non-empty advisoryFix"
  else
    _fail "AC1: InquiryRecords with empty/missing advisoryFix: $EMPTY_FIX"
  fi
fi

# ── AC2: false_block scenario ─────────────────────────────────────────────────
echo ""
echo "--- AC2a: false_block — verified claim + blocked ---"

AC2FB_ROOT="$TMPDIR_EVAL/ac2fb/.flow-agents"
AC2FB_SLUG="ac2-false-block"
AC2FB_DIR="$AC2FB_ROOT/$AC2FB_SLUG"
mkdir -p "$AC2FB_DIR"

# Seed: verified claim + blocked → false_block
seed_trust_bundle "$AC2FB_DIR" "$AC2FB_SLUG" "verified"
seed_block_streak "$AC2FB_ROOT" 2

if flow_agents_node workflow-sidecar gate-review "$AC2FB_DIR" \
  >"$TMPDIR_EVAL/ac2fb.out" 2>"$TMPDIR_EVAL/ac2fb.err"; then
  _pass "AC2a: gate-review exits 0"
else
  _fail "AC2a: gate-review failed: $(cat "$TMPDIR_EVAL/ac2fb.err")"
fi

AC2FB_INQUIRIES="$AC2FB_DIR/gate-review.inquiries.json"
if [[ -f "$AC2FB_INQUIRIES" ]]; then
  # outcome must be "matched" (claim exists in bundle)
  OUTCOME="$(jq_node "$AC2FB_INQUIRIES" 'd => d[0].outcome' 2>/dev/null || echo "")"
  if [[ "$OUTCOME" == "matched" ]]; then
    _pass "AC2a: false_block InquiryRecord has outcome=matched"
  else
    _fail "AC2a: expected outcome=matched, got '$OUTCOME'"
  fi

  # calibration must be false_block
  CALIBRATION="$(jq_node "$AC2FB_INQUIRIES" 'd => d[0].answer.value.calibration' 2>/dev/null || echo "")"
  if [[ "$CALIBRATION" == "false_block" ]]; then
    _pass "AC2a: false_block calibration correct"
  else
    _fail "AC2a: expected calibration=false_block, got '$CALIBRATION'"
  fi

  # advisoryFix must be non-empty
  ADVISORY="$(jq_node "$AC2FB_INQUIRIES" 'd => d[0].answer.value.advisoryFix' 2>/dev/null || echo "")"
  if [[ -n "$ADVISORY" ]] && [[ "$ADVISORY" != "null" ]]; then
    _pass "AC2a: false_block has non-empty advisoryFix"
  else
    _fail "AC2a: false_block advisoryFix is empty"
  fi

  # schema validation via hachure (validates against inquiry-record.schema.json)
  SCHEMA_RESULT="$(node -e "
try {
  const { validateInquiryRecord } = require('$ROOT/build/src/cli/workflow-sidecar.js');
  const records = JSON.parse(require('fs').readFileSync('$AC2FB_INQUIRIES','utf8'));
  let allValid = true;
  const errors = [];
  for (const r of records) {
    const result = validateInquiryRecord(r);
    if (result.available && !result.valid) {
      allValid = false;
      errors.push(...result.errors);
    }
  }
  const available = records.length > 0 ? validateInquiryRecord(records[0]).available : false;
  process.stdout.write(JSON.stringify({ available, allValid, errors }));
} catch(e) { process.stdout.write(JSON.stringify({ available: false, allValid: true, errors: [String(e)] })); }
" 2>/dev/null)"
  SCHEMA_AVAILABLE="$(node -e "process.stdout.write(JSON.parse('${SCHEMA_RESULT}').available ? 'true' : 'false')" 2>/dev/null || echo "false")"
  SCHEMA_ALL_VALID="$(node -e "process.stdout.write(JSON.parse('${SCHEMA_RESULT}').allValid ? 'true' : 'false')" 2>/dev/null || echo "true")"
  if [[ "$SCHEMA_AVAILABLE" == "true" ]]; then
    if [[ "$SCHEMA_ALL_VALID" == "true" ]]; then
      _pass "AC2a: false_block InquiryRecords validate against hachure inquiry-record.schema.json (available=true, valid=true)"
    else
      SCHEMA_ERRORS="$(node -e "process.stdout.write(JSON.parse('${SCHEMA_RESULT}').errors.slice(0,3).join('; '))" 2>/dev/null || echo "?")"
      _fail "AC2a: InquiryRecord schema validation failed: $SCHEMA_ERRORS"
    fi
  else
    _pass "AC2a: hachure not available — schema validation skipped (fail-open)"
  fi
fi

# ── AC2: missed_block scenario ────────────────────────────────────────────────
echo ""
echo "--- AC2b: missed_block — absent criterion ---"

AC2MB_ROOT="$TMPDIR_EVAL/ac2mb/.flow-agents"
AC2MB_SLUG="ac2-missed-block"
AC2MB_DIR="$AC2MB_ROOT/$AC2MB_SLUG"
mkdir -p "$AC2MB_DIR"

# Seed: empty bundle (no claims) + no block + expected criterion absent → missed_block
cat > "$AC2MB_DIR/trust.bundle" <<JSON
{
  "schemaVersion": 5,
  "source": "gate-review-test;statusFunctionVersion=1",
  "claims": [],
  "evidence": [],
  "events": [],
  "policies": []
}
JSON

# Seed acceptance.json with an expected criterion
cat > "$AC2MB_DIR/acceptance.json" <<JSON
{
  "schema_version": "1.0",
  "task_slug": "$AC2MB_SLUG",
  "criteria": [
    { "id": "ac-1", "description": "Unit tests pass", "status": "pending" }
  ]
}
JSON

# No block streak — gate did NOT fire
clear_block_streak "$AC2MB_ROOT"

if flow_agents_node workflow-sidecar gate-review "$AC2MB_DIR" \
  >"$TMPDIR_EVAL/ac2mb.out" 2>"$TMPDIR_EVAL/ac2mb.err"; then
  _pass "AC2b: gate-review exits 0"
else
  _fail "AC2b: gate-review failed: $(cat "$TMPDIR_EVAL/ac2mb.err")"
fi

AC2MB_INQUIRIES="$AC2MB_DIR/gate-review.inquiries.json"
if [[ -f "$AC2MB_INQUIRIES" ]]; then
  # The absent criterion should yield outcome="unsupported"
  OUTCOME_MB="$(jq_node "$AC2MB_INQUIRIES" 'd => d[0].outcome' 2>/dev/null || echo "")"
  if [[ "$OUTCOME_MB" == "unsupported" ]]; then
    _pass "AC2b: missed_block absent criterion yields outcome=unsupported"
  else
    _fail "AC2b: expected outcome=unsupported for absent criterion, got '$OUTCOME_MB'"
  fi

  # calibration must be missed_block
  CALIBRATION_MB="$(jq_node "$AC2MB_INQUIRIES" 'd => d[0].answer.value.calibration' 2>/dev/null || echo "")"
  if [[ "$CALIBRATION_MB" == "missed_block" ]]; then
    _pass "AC2b: missed_block calibration correct"
  else
    _fail "AC2b: expected calibration=missed_block for absent criterion, got '$CALIBRATION_MB'"
  fi

  # advisoryFix must be non-empty
  ADVISORY_MB="$(jq_node "$AC2MB_INQUIRIES" 'd => d[0].answer.value.advisoryFix' 2>/dev/null || echo "")"
  if [[ -n "$ADVISORY_MB" ]] && [[ "$ADVISORY_MB" != "null" ]]; then
    _pass "AC2b: missed_block has non-empty advisoryFix"
  else
    _fail "AC2b: missed_block advisoryFix is empty"
  fi

  # schema validation
  SCHEMA_RESULT_MB="$(node -e "
try {
  const { validateInquiryRecord } = require('$ROOT/build/src/cli/workflow-sidecar.js');
  const records = JSON.parse(require('fs').readFileSync('$AC2MB_INQUIRIES','utf8'));
  let allValid = true;
  const errors = [];
  for (const r of records) {
    const result = validateInquiryRecord(r);
    if (result.available && !result.valid) {
      allValid = false;
      errors.push(...result.errors);
    }
  }
  const available = records.length > 0 ? validateInquiryRecord(records[0]).available : false;
  process.stdout.write(JSON.stringify({ available, allValid, errors }));
} catch(e) { process.stdout.write(JSON.stringify({ available: false, allValid: true, errors: [String(e)] })); }
" 2>/dev/null)"
  SCHEMA_AVAILABLE_MB="$(node -e "process.stdout.write(JSON.parse('${SCHEMA_RESULT_MB}').available ? 'true' : 'false')" 2>/dev/null || echo "false")"
  SCHEMA_ALL_VALID_MB="$(node -e "process.stdout.write(JSON.parse('${SCHEMA_RESULT_MB}').allValid ? 'true' : 'false')" 2>/dev/null || echo "true")"
  if [[ "$SCHEMA_AVAILABLE_MB" == "true" ]]; then
    if [[ "$SCHEMA_ALL_VALID_MB" == "true" ]]; then
      _pass "AC2b: missed_block InquiryRecords validate against hachure inquiry-record.schema.json (available=true, valid=true)"
    else
      SCHEMA_ERRORS_MB="$(node -e "process.stdout.write(JSON.parse('${SCHEMA_RESULT_MB}').errors.slice(0,3).join('; '))" 2>/dev/null || echo "?")"
      _fail "AC2b: InquiryRecord schema validation failed: $SCHEMA_ERRORS_MB"
    fi
  else
    _pass "AC2b: hachure not available — schema validation skipped (fail-open)"
  fi

  # Verify the absent criterion is the inquiry target
  TARGET_FIELD="$(jq_node "$AC2MB_INQUIRIES" 'd => d[0].inquiry.target && d[0].inquiry.target.fieldOrBehavior' 2>/dev/null || echo "")"
  if [[ -n "$TARGET_FIELD" ]] && [[ "$TARGET_FIELD" != "null" ]]; then
    _pass "AC2b: absent criterion inquiry has canonical target"
  else
    _fail "AC2b: absent criterion inquiry missing canonical target"
  fi
fi

# ── AC2: correct scenario (gate blocked + disputed claim) ─────────────────────
echo ""
echo "--- AC2c: correct — disputed claim + blocked ---"

AC2COR_ROOT="$TMPDIR_EVAL/ac2cor/.flow-agents"
AC2COR_SLUG="ac2-correct"
AC2COR_DIR="$AC2COR_ROOT/$AC2COR_SLUG"
mkdir -p "$AC2COR_DIR"

# Seed: disputed claim + blocked → correct
seed_trust_bundle "$AC2COR_DIR" "$AC2COR_SLUG" "disputed"
seed_block_streak "$AC2COR_ROOT" 1

if flow_agents_node workflow-sidecar gate-review "$AC2COR_DIR" \
  >"$TMPDIR_EVAL/ac2cor.out" 2>"$TMPDIR_EVAL/ac2cor.err"; then
  _pass "AC2c: gate-review exits 0"
else
  _fail "AC2c: gate-review failed: $(cat "$TMPDIR_EVAL/ac2cor.err")"
fi

AC2COR_INQUIRIES="$AC2COR_DIR/gate-review.inquiries.json"
if [[ -f "$AC2COR_INQUIRIES" ]]; then
  CALIBRATION_COR="$(jq_node "$AC2COR_INQUIRIES" 'd => d[0].answer.value.calibration' 2>/dev/null || echo "")"
  if [[ "$CALIBRATION_COR" == "correct" ]]; then
    _pass "AC2c: correct calibration (disputed+blocked)"
  else
    _fail "AC2c: expected calibration=correct for disputed+blocked, got '$CALIBRATION_COR'"
  fi
fi

# ── AC3: no hooks changed ─────────────────────────────────────────────────────
echo ""
echo "--- AC3: hooks unchanged ---"
if [[ "$(hook_tree_digest)" != "$HOOKS_BEFORE" ]]; then
  _fail "AC3: scripts/hooks/ was modified (gate-review must not touch hooks)"
else
  _pass "AC3: scripts/hooks/ unchanged"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "────────────────────────────────────────────────────────────"
echo "gate-review InquiryRecord tests: $errors error(s)"
[ "$errors" -eq 0 ] && echo "PASS" || echo "FAIL"
exit "$errors"
