#!/usr/bin/env bash
# test_mint_attestation.sh — Integration eval for CI trust anchor Phase 2.
#
# Proves scripts/ci/mint-attestation.js behavior:
#   1. FAIL-OPEN-LOCAL: exits 0 with no OIDC identity; writes the unsigned in-toto
#      statement to trust.attestation.intoto.json; status "unsigned" recorded.
#   2. MOCK-SIGNER-ROUND-TRIP: toDsseEnvelope(statement, mockSigner) +
#      parseDssePayload round-trips to original statement; PAE bytes the mock
#      signer received == buildPaeBytes(payloadType, statementJson); subject
#      digest == sha256 of the attested artifact.
#   3. WITH-RESULTS-FILE: correctly reads CI results file written by trust-reconcile.
#   WORKFLOW-YAML: .github/workflows/trust-reconcile.yml parses; has id-token: write;
#      has mint-attestation step after reconcile; has upload-artifact step.
#
# Deterministic, no model spend, no network, self-cleaning.
# Usage: bash evals/integration/test_mint_attestation.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MINT="$ROOT/scripts/ci/mint-attestation.js"

TMP="$(mktemp -d)"
errors=0

_pass() { echo "  PASS: $1"; }
_fail() { echo "  FAIL: $1"; errors=$((errors + 1)); }

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# TEST 1: FAIL-OPEN-LOCAL
echo ""
echo "=== TEST 1: FAIL-OPEN-LOCAL — no OIDC => unsigned, exit 0 ==="

ATTEST_DIR1="$TMP/attest1"
mkdir -p "$ATTEST_DIR1"
RUNNER_TEMP1="$TMP/runner1"
mkdir -p "$RUNNER_TEMP1"

out1=$(
  env -u ACTIONS_ID_TOKEN_REQUEST_URL \
      -u SIGSTORE_ID_TOKEN \
      -u GITHUB_ACTIONS \
      ATTESTATION_OUT_DIR="$ATTEST_DIR1" \
      RUNNER_TEMP="$RUNNER_TEMP1" \
  node "$MINT" 2>&1
)
exit1=$?

if [[ $exit1 -eq 0 ]]; then
  _pass "FAIL-OPEN-LOCAL: exits 0 (fail-open, no OIDC)"
else
  _fail "FAIL-OPEN-LOCAL: expected exit 0, got $exit1 — output: $out1"
fi

if echo "$out1" | grep -q "status: unsigned"; then
  _pass "FAIL-OPEN-LOCAL: stdout contains 'status: unsigned'"
else
  _fail "FAIL-OPEN-LOCAL: expected 'status: unsigned' in stdout, got: $out1"
fi

if [[ -f "$ATTEST_DIR1/trust.attestation.intoto.json" ]]; then
  _pass "FAIL-OPEN-LOCAL: trust.attestation.intoto.json written"
else
  _fail "FAIL-OPEN-LOCAL: trust.attestation.intoto.json not found in $ATTEST_DIR1"
fi

if [[ ! -f "$ATTEST_DIR1/trust.attestation.sig.json" ]]; then
  _pass "FAIL-OPEN-LOCAL: trust.attestation.sig.json absent (correct for unsigned path)"
else
  _fail "FAIL-OPEN-LOCAL: trust.attestation.sig.json unexpectedly present"
fi

if [[ -f "$ATTEST_DIR1/trust.attestation.status.json" ]]; then
  _pass "FAIL-OPEN-LOCAL: trust.attestation.status.json written"
else
  _fail "FAIL-OPEN-LOCAL: trust.attestation.status.json not found"
fi

# Verify statement + status shape using a script file
VERIFY_SCRIPT1="$TMP/verify1.js"
node - "$ATTEST_DIR1/trust.attestation.intoto.json" \
     "$ATTEST_DIR1/trust.attestation.status.json" << 'NODE'
const fs = require("fs");
const [,, intotoPath, statusPath] = process.argv;
const errors = [];

const stmt = JSON.parse(fs.readFileSync(intotoPath, "utf8"));
if (stmt._type !== "https://in-toto.io/Statement/v1")
  errors.push("_type wrong: " + stmt._type);
if (stmt.predicateType !== "https://kontourai.dev/ci-verify/v1")
  errors.push("predicateType wrong: " + stmt.predicateType);
if (!Array.isArray(stmt.subject) || stmt.subject.length === 0)
  errors.push("subject must be non-empty array");
else {
  const sub = stmt.subject[0];
  if (!sub.name || !sub.digest || !sub.digest.sha256)
    errors.push("subject[0] must have name and digest.sha256");
}
if (!stmt.predicate || !stmt.predicate.commit_sha)
  errors.push("predicate.commit_sha missing");
if (!Array.isArray(stmt.predicate.canonical_commands))
  errors.push("predicate.canonical_commands must be array");
if (typeof stmt.predicate.reconciled !== "boolean")
  errors.push("predicate.reconciled must be boolean");
if (!stmt.predicate.built_at)
  errors.push("predicate.built_at missing");

const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
if (status.status !== "unsigned")
  errors.push("status.status expected 'unsigned', got " + status.status);
if (!status.reason)
  errors.push("status.reason missing");
if (!status.output_path)
  errors.push("status.output_path missing");

if (errors.length > 0) {
  console.error("STATEMENT ERRORS:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("_type=" + stmt._type);
console.log("predicateType=" + stmt.predicateType);
console.log("subject=" + stmt.subject[0].name + " sha256=" + stmt.subject[0].digest.sha256.slice(0,16) + "...");
console.log("status=" + JSON.stringify(status));
NODE
if [[ $? -eq 0 ]]; then
  _pass "FAIL-OPEN-LOCAL: statement and status file have correct shape"
else
  _fail "FAIL-OPEN-LOCAL: statement or status shape incorrect"
fi

# TEST 2: MOCK-SIGNER-ROUND-TRIP
echo ""
echo "=== TEST 2: MOCK-SIGNER-ROUND-TRIP — DSSE/PAE + subject-digest proof ==="

node - "$ATTEST_DIR1/trust.attestation.intoto.json" << 'NODE'
// Exercises DSSE signing with a mock signer:
//   toDsseEnvelope(statement, mockSigner) => envelope
//   parseDssePayload(envelope) => round-trip must equal original statement
//   capturedPaeBytes == buildPaeBytes(payloadType, JSON.stringify(statement))
//   subject digest == sha256(predicate JSON) for synthesized subject

const fs = require("fs");
const crypto = require("crypto");

async function run() {
  const { toDsseEnvelope, parseDssePayload, buildPaeBytes } =
    await import("@kontourai/surface");

  const errors = [];
  const statement = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));

  // Deterministic mock signer capturing PAE bytes.
  let capturedPaeBytes = null;
  const mockSigner = {
    keyid: "test-ci-mint-mock",
    sign: async (paeBytes) => {
      capturedPaeBytes = paeBytes;
      return Buffer.from("mock-ci-mint-sig").toString("base64");
    },
  };

  const envelope = await toDsseEnvelope(statement, mockSigner);

  if (envelope.payloadType !== "application/vnd.in-toto+json")
    errors.push("payloadType wrong: " + envelope.payloadType);
  else
    console.log("payloadType: " + envelope.payloadType);

  let roundTripped;
  try { roundTripped = parseDssePayload(envelope); }
  catch (e) { errors.push("parseDssePayload threw: " + e.message); }
  if (roundTripped) {
    if (roundTripped._type !== statement._type)
      errors.push("round-trip _type: " + roundTripped._type);
    if (roundTripped.predicateType !== statement.predicateType)
      errors.push("round-trip predicateType: " + roundTripped.predicateType);
    if (!Array.isArray(roundTripped.subject) ||
        roundTripped.subject.length !== statement.subject.length)
      errors.push("round-trip subject length mismatch");
    console.log("parseDssePayload round-trip predicateType=" + roundTripped.predicateType);
  }

  const statementJson = JSON.stringify(statement);
  const expectedPae = buildPaeBytes("application/vnd.in-toto+json", statementJson);
  if (capturedPaeBytes === null) {
    errors.push("mock signer was never called");
  } else {
    const match = capturedPaeBytes.length === expectedPae.length &&
      capturedPaeBytes.every((b, i) => b === expectedPae[i]);
    if (!match)
      errors.push("PAE bytes: signer received different bytes than buildPaeBytes");
    else {
      const paeStr = Buffer.from(capturedPaeBytes).toString("utf8").slice(0, 40);
      console.log("PAE bytes match buildPaeBytes: " + paeStr + "...");
    }
  }

  // Subject digest check: for synthesized subject (name=ci-verify-results),
  // digest.sha256 must equal sha256(JSON.stringify(predicate)).
  const sub = statement.subject[0];
  if (sub.name === "ci-verify-results") {
    const predicateJson = JSON.stringify(statement.predicate);
    const expected = crypto.createHash("sha256").update(predicateJson,"utf8").digest("hex");
    if (sub.digest.sha256 !== expected)
      errors.push("subject digest mismatch: got " + sub.digest.sha256 +
        " expected " + expected);
    else
      console.log("subject digest=sha256(predicateJson): " + sub.digest.sha256.slice(0,16) + "...");
  } else {
    if (!/^[0-9a-f]{64}$/.test(sub.digest.sha256))
      errors.push("subject digest not a valid sha256 hex");
    else
      console.log("subject digest (bundle): " + sub.digest.sha256.slice(0,16) + "...");
  }

  if (!Array.isArray(envelope.signatures) || envelope.signatures.length === 0)
    errors.push("envelope.signatures empty");
  else {
    if (envelope.signatures[0].keyid !== "test-ci-mint-mock")
      errors.push("keyid wrong: " + envelope.signatures[0].keyid);
    console.log("mock sig keyid=" + envelope.signatures[0].keyid);
  }

  if (errors.length > 0) {
    console.error("MOCK-SIGNER ERRORS:\n" + errors.join("\n"));
    process.exit(1);
  }
  console.log("MOCK-SIGNER-ROUND-TRIP: all assertions passed");
}
run().catch(e => { console.error("test threw: " + e.message); process.exit(1); });
NODE
if [[ $? -eq 0 ]]; then
  _pass "MOCK-SIGNER-ROUND-TRIP: toDsseEnvelope/parseDssePayload/buildPaeBytes/subject-digest all correct"
else
  _fail "MOCK-SIGNER-ROUND-TRIP: DSSE round-trip or PAE/subject-digest assertion failed"
fi

# TEST 3: WITH-RESULTS-FILE
echo ""
echo "=== TEST 3: WITH-RESULTS-FILE — reads CI results file when present ==="

ATTEST_DIR3="$TMP/attest3"
mkdir -p "$ATTEST_DIR3"
RUNNER_TEMP3="$TMP/runner3"
mkdir -p "$RUNNER_TEMP3"

# Write synthetic results as trust-reconcile.js would write on success.
cat > "$RUNNER_TEMP3/ci-trust-reconcile-results.json" << 'JSON'
{
  "commit_sha": "deadbeef1234567890abcdef",
  "canonical_commands": [
    { "command": "npm run build", "exitCode": 0, "passed": true }
  ],
  "reconciled": false,
  "built_at": "2026-06-27T00:00:00Z"
}
JSON

out3=$(
  env -u ACTIONS_ID_TOKEN_REQUEST_URL \
      -u SIGSTORE_ID_TOKEN \
      -u GITHUB_ACTIONS \
      ATTESTATION_OUT_DIR="$ATTEST_DIR3" \
      RUNNER_TEMP="$RUNNER_TEMP3" \
  node "$MINT" 2>&1
)
exit3=$?

if [[ $exit3 -eq 0 ]]; then
  _pass "WITH-RESULTS-FILE: exits 0"
else
  _fail "WITH-RESULTS-FILE: expected exit 0, got $exit3 — output: $out3"
fi

if echo "$out3" | grep -q "loaded CI results from"; then
  _pass "WITH-RESULTS-FILE: loaded results file (not synthesized)"
else
  _fail "WITH-RESULTS-FILE: expected 'loaded CI results from' in stdout, got: $out3"
fi

node - "$ATTEST_DIR3/trust.attestation.intoto.json" << 'NODE'
const fs = require("fs");
const stmt = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const sha = stmt.predicate && stmt.predicate.commit_sha;
if (sha !== "deadbeef1234567890abcdef") {
  console.error("predicate.commit_sha expected 'deadbeef1234567890abcdef', got " + sha);
  process.exit(1);
}
console.log("predicate.commit_sha from results file: " + sha);
NODE
if [[ $? -eq 0 ]]; then
  _pass "WITH-RESULTS-FILE: predicate.commit_sha correctly read from results file"
else
  _fail "WITH-RESULTS-FILE: predicate.commit_sha mismatch or file missing"
fi

# TEST 4: EXACT RECONCILED SUBJECT
echo ""
echo "=== TEST 4: EXACT RECONCILED SUBJECT — signs the bundle selected by reconcile ==="

ATTEST_DIR4="$TMP/attest4"
RUNNER_TEMP4="$TMP/runner4"
REPO4="$TMP/repo4"
mkdir -p "$ATTEST_DIR4" "$RUNNER_TEMP4" "$REPO4/delivery/new-session" "$REPO4/delivery"
node - "$REPO4" "$RUNNER_TEMP4" << 'NODE'
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const [repo, runner] = process.argv.slice(2);
fs.writeFileSync(path.join(repo, 'delivery/trust.bundle'), 'older-flat');
const selected = 'delivery/new-session/trust.bundle';
const bytes = Buffer.from('newer-selected-session');
fs.writeFileSync(path.join(repo, selected), bytes);
fs.writeFileSync(path.join(runner, 'ci-trust-reconcile-results.json'), JSON.stringify({
  commit_sha: 'feedface',
  canonical_commands: [{ command: 'npm test', exitCode: 0, passed: true }],
  reconciled: true,
  reconciled_bundle: { path: selected, sha256: crypto.createHash('sha256').update(bytes).digest('hex') },
  built_at: '2026-07-21T00:00:00Z',
}));
NODE

out4=$(env -u ACTIONS_ID_TOKEN_REQUEST_URL -u SIGSTORE_ID_TOKEN -u GITHUB_ACTIONS \
  GITHUB_WORKSPACE="$REPO4" ATTESTATION_OUT_DIR="$ATTEST_DIR4" RUNNER_TEMP="$RUNNER_TEMP4" \
  node "$MINT" 2>&1)
if [[ $? -eq 0 ]] && echo "$out4" | grep -q 'subject: delivery/new-session/trust.bundle'; then
  _pass "EXACT-SUBJECT: minting uses the reconciler-selected per-session bundle"
else
  _fail "EXACT-SUBJECT: expected selected per-session subject, got: $out4"
fi

node - "$ATTEST_DIR4/trust.attestation.intoto.json" << 'NODE'
const fs = require('fs');
const statement = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (statement.subject[0].name !== 'delivery/new-session/trust.bundle') process.exit(1);
NODE
if [[ $? -eq 0 ]]; then
  _pass "EXACT-SUBJECT: statement excludes the older inherited flat bundle"
else
  _fail "EXACT-SUBJECT: statement subject does not match reconciled bundle"
fi

# WORKFLOW-YAML structural validation
echo ""
echo "=== WORKFLOW-YAML: trust-reconcile.yml structure ==="

WORKFLOW_FILE="$ROOT/.github/workflows/trust-reconcile.yml"

if [[ ! -f "$WORKFLOW_FILE" ]]; then
  _fail "WORKFLOW-YAML: workflow file not found at $WORKFLOW_FILE"
else
  yaml_valid=0

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
      _pass "WORKFLOW-YAML: parses (python3 yaml)"
      yaml_valid=1
    else
      _fail "WORKFLOW-YAML: failed python3 yaml parse"
      yaml_valid=1
    fi
  fi

  if [[ $yaml_valid -eq 0 ]] && command -v yamllint >/dev/null 2>&1; then
    if yamllint -d relaxed "$WORKFLOW_FILE" >/dev/null 2>&1; then
      _pass "WORKFLOW-YAML: parses (yamllint)"; yaml_valid=1
    else
      _fail "WORKFLOW-YAML: failed yamllint"; yaml_valid=1
    fi
  fi

  if grep -q "id-token: write" "$WORKFLOW_FILE"; then
    _pass "WORKFLOW-YAML: has 'id-token: write'"
  else
    _fail "WORKFLOW-YAML: 'id-token: write' not found"
  fi

  if grep -q "mint-attestation.js" "$WORKFLOW_FILE"; then
    _pass "WORKFLOW-YAML: has mint-attestation.js step"
  else
    _fail "WORKFLOW-YAML: mint-attestation.js step not found"
  fi

  if grep -q "upload-artifact" "$WORKFLOW_FILE"; then
    _pass "WORKFLOW-YAML: has upload-artifact step"
  else
    _fail "WORKFLOW-YAML: upload-artifact step not found"
  fi

  reconcile_line=$(grep -n "trust-reconcile.js" "$WORKFLOW_FILE" | head -1 | cut -d: -f1)
  mint_line=$(grep -n "mint-attestation.js" "$WORKFLOW_FILE" | head -1 | cut -d: -f1)
  if [[ -n "$reconcile_line" && -n "$mint_line" && "$mint_line" -gt "$reconcile_line" ]]; then
    _pass "WORKFLOW-YAML: mint-attestation comes after trust-reconcile step"
  else
    _fail "WORKFLOW-YAML: mint-attestation must appear after trust-reconcile"
  fi
fi

# Summary
echo ""
echo "────────────────────────────────────────────"
if [[ $errors -eq 0 ]]; then
  echo "test_mint_attestation: all checks passed."
  exit 0
else
  echo "test_mint_attestation: $errors check(s) failed."
  exit 1
fi
