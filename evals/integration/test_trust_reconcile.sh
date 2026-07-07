#!/usr/bin/env bash
# test_trust_reconcile.sh — Integration eval for the CI trust anchor (Phase 1).
#
# Proves that scripts/ci/trust-reconcile.js correctly:
#   1. DIVERGENCE-CAUGHT:  bundle claims a command passed; CI re-runs it and it FAILS.
#      Exit 1 with "trust divergence" message naming the command.
#   2. MATCHING-PASSES:    bundle claims a command passed; CI re-runs it and it PASSES.
#      Exit 0 (no divergence).
#   3. NO-CHECKPOINT:      no bundle present, no delivery/DECLARED marker; canonical
#      verify passes. Exit 1 — bundle required by default (ADR 0022 §1); the
#      'bundle-required-no-declared-marker' issue fires (no more fail-open on absence).
#   4. LAUNDERING-CAUGHT:  bundle claims "something || true" passed.
#      Exit 1 with laundering message (checked before "CI never ran" check).
#   YAML-VALID:            .github/workflows/trust-reconcile.yml parses as valid YAML.
#
# Also validates the workflow YAML parses (yamllint or python3 yaml or structural check).
#
# Deterministic, no model spend, self-cleaning.
# Usage: bash evals/integration/test_trust_reconcile.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RECONCILE="$ROOT/scripts/ci/trust-reconcile.js"

TMP="$(mktemp -d)"
errors=0

_pass() { echo "  PASS: $1"; }
_fail() { echo "  FAIL: $1"; errors=$((errors + 1)); }

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# ─── Fixture bundle builder ───────────────────────────────────────────────────
# Writes a minimal trust.bundle fixture to a path.
# Usage: write_bundle <path> <label> <passing>
#   <label>   — the execution.label command string in the evidence item
#   <passing> — true or false
write_bundle() {
  local bundle_path="$1"
  local label="$2"
  local passing="$3"

  node - "$bundle_path" "$label" "$passing" << 'NODE'
const fs = require('fs');
const [,, bundlePath, label, passingStr] = process.argv;
const passing = passingStr === 'true';
const bundle = {
  schemaVersion: 5,
  source: "test-fixture",
  claims: [
    {
      id: "c1",
      claimType: "workflow.check.build",
      value: passing ? "pass" : "fail",
      status: passing ? "verified" : "disputed",
      subjectId: "test-slug/build",
      facet: "flow-agents.workflow",
      subjectType: "workflow-check",
      fieldOrBehavior: "build",
      createdAt: "2026-06-27T00:00:00Z",
      updatedAt: "2026-06-27T00:00:00Z",
      impactLevel: "high",
      verificationPolicyId: "policy:workflow.check.build"
    }
  ],
  evidence: [
    {
      id: "ev1",
      claimId: "c1",
      evidenceType: "test_output",
      method: "validation",
      sourceRef: "test-slug/command-log.jsonl",
      excerptOrSummary: "build",
      observedAt: "2026-06-27T00:00:00Z",
      collectedBy: "flow-agents/evidence-capture",
      passing: passing,
      execution: {
        runner: "bash",
        label: label,
        isError: !passing,
        exitCode: passing ? 0 : 1
      }
    }
  ],
  policies: [],
  events: []
};
fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));
NODE
}

write_scope_bundle() {
  local bundle_path="$1"
  shift

  node - "$bundle_path" "$@" << 'NODE'
const fs = require('fs');
const [,, bundlePath, ...paths] = process.argv;
const entries = paths.map((p) => ({ path: p, blobHash: `sha:${p}` }));
const bundle = {
  schemaVersion: 5,
  source: "test-fixture",
  claims: [
    {
      id: "scope-claim",
      claimType: "workflow.check.scope",
      value: "pass",
      status: "verified",
      subjectId: "test-slug/scope",
      facet: "flow-agents.workflow",
      subjectType: "workflow-check",
      fieldOrBehavior: "scope attestation",
      createdAt: "2026-06-27T00:00:00Z",
      updatedAt: "2026-06-27T00:00:00Z",
      impactLevel: "high",
      verificationPolicyId: "policy:workflow.check.scope:attestation",
      metadata: {
        origin: "check",
        check_kind: "scope",
        scope: { source: "git", base: "fixture-base", head: "fixture-head", entries }
      }
    }
  ],
  evidence: [
    {
      id: "ev-scope",
      claimId: "scope-claim",
      evidenceType: "attestation",
      method: "attestation",
      sourceRef: "test-slug/scope",
      excerptOrSummary: "scope attestation",
      observedAt: "2026-06-27T00:00:00Z",
      collectedBy: "flow-agents/workflow-sidecar",
      passing: true
    }
  ],
  policies: [
    {
      id: "policy:workflow.check.scope:attestation",
      claimType: "workflow.check.scope",
      requiredEvidence: ["attestation"],
      acceptanceCriteria: ["A verified verification event must support a workflow.check.scope claim."],
      reviewAuthority: "system",
      validityRule: { kind: "manual" },
      stalenessTriggers: [],
      conflictRules: [],
      impactLevel: "high"
    }
  ],
  events: [
    {
      id: "evt-scope",
      claimId: "scope-claim",
      status: "verified",
      actor: "flow-agents/workflow-sidecar",
      method: "validation",
      evidenceIds: ["ev-scope"],
      createdAt: "2026-06-27T00:00:00Z",
      verifiedAt: "2026-06-27T00:00:00Z"
    }
  ]
};
fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));
NODE
}

# ─── TEST 1: DIVERGENCE-CAUGHT ────────────────────────────────────────────────
echo ""
echo "=== TEST 1: DIVERGENCE-CAUGHT — claimed pass, CI re-run FAILS ==="

BUNDLE1="$TMP/bundle-diverge.json"
write_bundle "$BUNDLE1" "node -e 'process.exit(1)'" "true"

# canonical command is "node -e 'process.exit(1)'" — it fails
# bundle claims that same command passed → divergence
out1=$(TRUST_RECONCILE_COMMANDS="node -e 'process.exit(1)'" \
  node "$RECONCILE" \
    --bundle "$BUNDLE1" \
    --repo-root "$TMP" 2>&1)
exit1=$?

if [[ $exit1 -ne 0 ]]; then
  _pass "DIVERGENCE-CAUGHT: exits 1 (got $exit1)"
else
  _fail "DIVERGENCE-CAUGHT: expected exit 1, got 0"
fi

if echo "$out1" | grep -q "trust divergence"; then
  _pass "DIVERGENCE-CAUGHT: output contains 'trust divergence'"
else
  _fail "DIVERGENCE-CAUGHT: expected 'trust divergence' in output, got: $out1"
fi

# Verify the divergent command name appears in the message
if echo "$out1" | grep -q "process.exit(1)"; then
  _pass "DIVERGENCE-CAUGHT: output names the divergent command"
else
  _fail "DIVERGENCE-CAUGHT: expected command name in output, got: $out1"
fi

# ─── TEST 2: MATCHING-PASSES ──────────────────────────────────────────────────
echo ""
echo "=== TEST 2: MATCHING-PASSES — claimed pass, CI re-run also PASSES ==="

BUNDLE2="$TMP/bundle-match.json"
write_bundle "$BUNDLE2" "node -e 'process.exit(0)'" "true"

out2=$(TRUST_RECONCILE_COMMANDS="node -e 'process.exit(0)'" \
  node "$RECONCILE" \
    --bundle "$BUNDLE2" \
    --repo-root "$TMP" 2>&1)
exit2=$?

if [[ $exit2 -eq 0 ]]; then
  _pass "MATCHING-PASSES: exits 0"
else
  _fail "MATCHING-PASSES: expected exit 0, got $exit2 — output: $out2"
fi

if echo "$out2" | grep -q "RECONCILED"; then
  _pass "MATCHING-PASSES: output shows RECONCILED"
else
  _fail "MATCHING-PASSES: expected 'RECONCILED' in output, got: $out2"
fi

# ─── TEST 2b: SCOPE-MATCHING-PASSES ──────────────────────────────────────────
echo ""
echo "=== TEST 2b: SCOPE-MATCHING-PASSES — actual changed files are declared ==="

SCOPE_REPO="$TMP/scope-repo"
mkdir -p "$SCOPE_REPO"
(
  cd "$SCOPE_REPO" \
    && git init -q \
    && git config user.email "flow-agents@example.test" \
    && git config user.name "Flow Agents Test" \
    && printf 'base\n' > declared.txt \
    && git add declared.txt \
    && git commit -q -m "base" \
    && git branch base \
    && printf 'changed\n' > declared.txt \
    && git add declared.txt \
    && git commit -q -m "change declared"
)

BUNDLE2B="$TMP/bundle-scope-match.json"
write_scope_bundle "$BUNDLE2B" "declared.txt"
out2b=$(TRUST_RECONCILE_COMMANDS="node -e 'process.exit(0)'" TRUST_RECONCILE_BASE_REF="base" \
  node "$RECONCILE" \
    --bundle "$BUNDLE2B" \
    --repo-root "$SCOPE_REPO" 2>&1)
exit2b=$?

if [[ $exit2b -eq 0 ]]; then
  _pass "SCOPE-MATCHING-PASSES: exits 0"
else
  _fail "SCOPE-MATCHING-PASSES: expected exit 0, got $exit2b — output: $out2b"
fi

if echo "$out2b" | grep -q "RECONCILED scope"; then
  _pass "SCOPE-MATCHING-PASSES: output shows scope reconciliation"
else
  _fail "SCOPE-MATCHING-PASSES: expected scope reconciliation output, got: $out2b"
fi

# ─── TEST 2c: SCOPE-DIVERGENCE-CAUGHT ────────────────────────────────────────
echo ""
echo "=== TEST 2c: SCOPE-DIVERGENCE-CAUGHT — actual changed file is undeclared ==="

BUNDLE2C="$TMP/bundle-scope-diverge.json"
write_scope_bundle "$BUNDLE2C" "other.txt"
out2c=$(TRUST_RECONCILE_COMMANDS="node -e 'process.exit(0)'" TRUST_RECONCILE_BASE_REF="base" \
  node "$RECONCILE" \
    --bundle "$BUNDLE2C" \
    --repo-root "$SCOPE_REPO" 2>&1)
exit2c=$?

if [[ $exit2c -ne 0 ]]; then
  _pass "SCOPE-DIVERGENCE-CAUGHT: exits 1 (got $exit2c)"
else
  _fail "SCOPE-DIVERGENCE-CAUGHT: expected exit 1, got 0"
fi

if echo "$out2c" | grep -q "actual changed file 'declared.txt' was not declared"; then
  _pass "SCOPE-DIVERGENCE-CAUGHT: output names the undeclared actual file"
else
  _fail "SCOPE-DIVERGENCE-CAUGHT: expected undeclared file diagnostic, got: $out2c"
fi

# ─── TEST 2d: SCOPE-OVERDECLARED-CAUGHT ──────────────────────────────────────
echo ""
echo "=== TEST 2d: SCOPE-OVERDECLARED-CAUGHT — declared file is not actually changed ==="

BUNDLE2D="$TMP/bundle-scope-overdeclared.json"
write_scope_bundle "$BUNDLE2D" "declared.txt" "extra.txt"
out2d=$(TRUST_RECONCILE_COMMANDS="node -e 'process.exit(0)'" TRUST_RECONCILE_BASE_REF="base" \
  node "$RECONCILE" \
    --bundle "$BUNDLE2D" \
    --repo-root "$SCOPE_REPO" 2>&1)
exit2d=$?

if [[ $exit2d -ne 0 ]]; then
  _pass "SCOPE-OVERDECLARED-CAUGHT: exits 1 (got $exit2d)"
else
  _fail "SCOPE-OVERDECLARED-CAUGHT: expected exit 1, got 0"
fi

if echo "$out2d" | grep -q "declared scope file 'extra.txt' is not present"; then
  _pass "SCOPE-OVERDECLARED-CAUGHT: output names the over-declared file"
else
  _fail "SCOPE-OVERDECLARED-CAUGHT: expected over-declared file diagnostic, got: $out2d"
fi

# ─── TEST 2e: SCOPE-EMPTY-CAUGHT ──────────────────────────────────────────────
echo ""
echo "=== TEST 2e: SCOPE-EMPTY-CAUGHT — empty declared scope does not bypass actual diff ==="

BUNDLE2E="$TMP/bundle-scope-empty.json"
write_scope_bundle "$BUNDLE2E"
out2e=$(TRUST_RECONCILE_COMMANDS="node -e 'process.exit(0)'" TRUST_RECONCILE_BASE_REF="base" \
  node "$RECONCILE" \
    --bundle "$BUNDLE2E" \
    --repo-root "$SCOPE_REPO" 2>&1)
exit2e=$?

if [[ $exit2e -ne 0 ]]; then
  _pass "SCOPE-EMPTY-CAUGHT: exits 1 (got $exit2e)"
else
  _fail "SCOPE-EMPTY-CAUGHT: expected exit 1, got 0"
fi

if echo "$out2e" | grep -q "actual changed file 'declared.txt' was not declared"; then
  _pass "SCOPE-EMPTY-CAUGHT: output names actual file omitted by empty scope"
else
  _fail "SCOPE-EMPTY-CAUGHT: expected omitted actual file diagnostic, got: $out2e"
fi

# ─── TEST 3: NO-CHECKPOINT ────────────────────────────────────────────────────
echo ""
echo "=== TEST 3: NO-CHECKPOINT — no bundle present, fresh verify only ==="

out3=$(TRUST_RECONCILE_COMMANDS="node -e 'process.exit(0)'" \
  node "$RECONCILE" \
    --repo-root "$TMP" 2>&1)
exit3=$?

if [[ $exit3 -ne 0 ]]; then
  _pass "NO-CHECKPOINT: exits 1 (bundle required by default, no bundle, no marker) — got $exit3"
else
  _fail "NO-CHECKPOINT: expected exit 1 (bundle-required by default, ADR 0022 §1), got 0 — output: $out3"
fi

if echo "$out3" | grep -q "bundle-required-no-declared-marker"; then
  _pass "NO-CHECKPOINT: output contains 'bundle-required-no-declared-marker'"
else
  _fail "NO-CHECKPOINT: expected 'bundle-required-no-declared-marker' in output, got: $out3"
fi

# Also verify: no-bundle + failing fresh verify still exits 1
out3b=$(TRUST_RECONCILE_COMMANDS="node -e 'process.exit(1)'" \
  node "$RECONCILE" \
    --repo-root "$TMP" 2>&1)
exit3b=$?

if [[ $exit3b -ne 0 ]]; then
  _pass "NO-CHECKPOINT: exits 1 when fresh verify fails (no bundle)"
else
  _fail "NO-CHECKPOINT: expected exit 1 when fresh verify fails, got 0 — output: $out3b"
fi

if echo "$out3b" | grep -q "verification failed in CI"; then
  _pass "NO-CHECKPOINT: 'verification failed in CI' message when fresh verify fails"
else
  _fail "NO-CHECKPOINT: expected 'verification failed in CI' message, got: $out3b"
fi

# ─── TEST 4: LAUNDERING-CAUGHT ────────────────────────────────────────────────
echo ""
echo "=== TEST 4: LAUNDERING-CAUGHT — claimed pass for a laundered command ==="

# Bundle claims 'npm run build || true' passed.
# Canonical verify is a passing command (unrelated).
# Laundering check fires first — before "CI never ran" check.
BUNDLE4="$TMP/bundle-launder.json"
write_bundle "$BUNDLE4" "npm run build || true" "true"

out4=$(TRUST_RECONCILE_COMMANDS="node -e 'process.exit(0)'" \
  node "$RECONCILE" \
    --bundle "$BUNDLE4" \
    --repo-root "$TMP" 2>&1)
exit4=$?

if [[ $exit4 -ne 0 ]]; then
  _pass "LAUNDERING-CAUGHT: exits 1"
else
  _fail "LAUNDERING-CAUGHT: expected exit 1, got 0 — output: $out4"
fi

if echo "$out4" | grep -q "laundering"; then
  _pass "LAUNDERING-CAUGHT: output contains 'laundering'"
else
  _fail "LAUNDERING-CAUGHT: expected 'laundering' in output, got: $out4"
fi

if echo "$out4" | grep -q "trust divergence"; then
  _pass "LAUNDERING-CAUGHT: output contains 'trust divergence'"
else
  _fail "LAUNDERING-CAUGHT: expected 'trust divergence' in output, got: $out4"
fi

# ─── YAML-VALID ───────────────────────────────────────────────────────────────
echo ""
echo "=== YAML-VALID: .github/workflows/trust-reconcile.yml parses ==="

WORKFLOW_FILE="$ROOT/.github/workflows/trust-reconcile.yml"

if [[ ! -f "$WORKFLOW_FILE" ]]; then
  _fail "YAML-VALID: workflow file not found at $WORKFLOW_FILE"
else
  yaml_valid=0

  # Try python3 yaml first (standard on macOS and Ubuntu)
  if command -v python3 >/dev/null 2>&1 && python3 -c "import yaml" 2>/dev/null; then
    if python3 - "$WORKFLOW_FILE" << 'PY' 2>/dev/null
import sys, yaml
try:
    yaml.safe_load(open(sys.argv[1]).read())
    sys.exit(0)
except yaml.YAMLError as e:
    print("YAML error: " + str(e))
    sys.exit(1)
PY
    then
      _pass "YAML-VALID: trust-reconcile.yml parses (python3 yaml)"
      yaml_valid=1
    else
      _fail "YAML-VALID: trust-reconcile.yml failed python3 yaml parse"
      yaml_valid=1  # tested, failed
    fi
  fi

  # Fall back to yamllint if available and python3 not tried
  if [[ $yaml_valid -eq 0 ]] && command -v yamllint >/dev/null 2>&1; then
    if yamllint -d relaxed "$WORKFLOW_FILE" >/dev/null 2>&1; then
      _pass "YAML-VALID: trust-reconcile.yml parses (yamllint)"
      yaml_valid=1
    else
      _fail "YAML-VALID: trust-reconcile.yml failed yamllint"
      yaml_valid=1
    fi
  fi

  # Structural fallback: check key fields with grep
  if [[ $yaml_valid -eq 0 ]]; then
    structural_ok=1
    grep -q "^name:" "$WORKFLOW_FILE" || structural_ok=0
    grep -q "trust-reconcile" "$WORKFLOW_FILE" || structural_ok=0
    grep -q "ubuntu-latest" "$WORKFLOW_FILE" || structural_ok=0
    grep -q "node-version" "$WORKFLOW_FILE" || structural_ok=0
    grep -q "npm ci" "$WORKFLOW_FILE" || structural_ok=0
    grep -q "trust-reconcile.js" "$WORKFLOW_FILE" || structural_ok=0
    if [[ $structural_ok -eq 1 ]]; then
      _pass "YAML-VALID: trust-reconcile.yml has expected structure (yaml parser not available)"
    else
      _fail "YAML-VALID: trust-reconcile.yml missing expected structural fields"
    fi
  fi
fi

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "────────────────────────────────────────────"
if [[ $errors -eq 0 ]]; then
  echo "test_trust_reconcile: all checks passed."
  exit 0
else
  echo "test_trust_reconcile: $errors check(s) failed."
  exit 1
fi
