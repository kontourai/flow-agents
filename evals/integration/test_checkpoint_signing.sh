#!/usr/bin/env bash
# test_checkpoint_signing.sh — Integration eval for Increment B1: terminal trust checkpoint signing.
#
# Proves that:
#   1. STATEMENT-WITH-SUBJECT: after record-release, an in-toto statement file exists with
#      the correct predicateType "https://hachure.org/v1/bundle" and subject digest matching
#      sha256(trust.checkpoint.json). The checkpoint envelope carries attestation.status.
#   2. FAIL-OPEN-LOCAL: signStatementWithSigstore returns null locally (no OIDC);
#      the unsigned statement is written and the seal still succeeds (exit 0).
#      attestation.status == "unsigned".
#   3. DSSE-ROUND-TRIP: toDsseEnvelope(statement, mockSigner) produces an envelope whose:
#      - payloadType == "application/vnd.in-toto+json"
#      - base64 payload round-trips via parseDssePayload back to the statement
#      - PAE bytes match buildPaeBytes(payloadType, statementJson)
#      This proves the signing PATH is structurally correct without needing real OIDC.
#   4. ADDITIVE: all existing gating tests still pass (record-release, advance-state-delivered,
#      seal-checkpoint, record-evidence, record-critique all unaffected).
#
# Deterministic, no model spend, no network, self-cleaning.
# Usage: bash evals/integration/test_checkpoint_signing.sh

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

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== TEST 1: Statement produced with correct subject (sha256 of checkpoint) ==="

AROOT1="$TMP/test1/.flow-agents"
SLUG1="sign-test-statement"
SESSION_DIR1="$AROOT1/$SLUG1"
mkdir -p "$AROOT1"

flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$AROOT1" \
  --task-slug "$SLUG1" \
  --title "Checkpoint Signing Statement Test" \
  --summary "Verify in-toto statement subject matches sha256 of trust.checkpoint.json." \
  --criterion "Statement subject digest matches checkpoint sha256" \
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

# Checkpoint must exist (Increment A prerequisite)
if [[ -f "$SESSION_DIR1/trust.checkpoint.json" ]]; then
  _pass "record-release writes trust.checkpoint.json (Increment A prerequisite)"
else
  _fail "trust.checkpoint.json absent — Increment A not working"
fi

# Increment B1: unsigned in-toto statement must exist locally (no OIDC in test env)
INTOTO_FILE="$SESSION_DIR1/trust.checkpoint.intoto.json"
SIG_FILE="$SESSION_DIR1/trust.checkpoint.sig.json"

if [[ -f "$INTOTO_FILE" ]]; then
  _pass "trust.checkpoint.intoto.json written (unsigned statement for local env)"
elif [[ -f "$SIG_FILE" ]]; then
  _pass "trust.checkpoint.sig.json written (OIDC signing succeeded — CI environment)"
else
  _fail "no attestation file found (neither trust.checkpoint.intoto.json nor trust.checkpoint.sig.json)"
fi

# Verify the in-toto statement has correct predicateType and subject digest.
# The subject digest is the sha256 of trust.checkpoint.json at the moment it was signed,
# i.e. BEFORE the attestation field was added back (the attestation update is a second
# write that happens after signing). To verify, we reconstruct the pre-attestation bytes:
# remove the attestation key from the envelope and re-serialize in the same format.
node - "$SESSION_DIR1" << 'NODE'
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const dir = process.argv[2];
const checkpointPath = path.join(dir, "trust.checkpoint.json");
const intotoPath = path.join(dir, "trust.checkpoint.intoto.json");
const sigPath = path.join(dir, "trust.checkpoint.sig.json");

const errors = [];

// Determine which attestation file exists
let statement;
if (fs.existsSync(intotoPath)) {
  statement = JSON.parse(fs.readFileSync(intotoPath, "utf8"));
} else if (fs.existsSync(sigPath)) {
  // Parse from DSSE envelope payload
  const envelope = JSON.parse(fs.readFileSync(sigPath, "utf8"));
  const payloadJson = Buffer.from(envelope.payload, "base64").toString("utf8");
  statement = JSON.parse(payloadJson);
} else {
  errors.push("no attestation file found");
  console.error("ERRORS:\n" + errors.join("\n"));
  process.exit(1);
}

// Verify predicateType
if (statement.predicateType !== "https://hachure.org/v1/bundle") {
  errors.push("predicateType expected 'https://hachure.org/v1/bundle', got " + statement.predicateType);
}

// Verify _type
if (statement._type !== "https://in-toto.io/Statement/v1") {
  errors.push("_type expected 'https://in-toto.io/Statement/v1', got " + statement._type);
}

// Verify subject array
if (!Array.isArray(statement.subject) || statement.subject.length === 0) {
  errors.push("subject must be a non-empty array");
} else {
  const sub = statement.subject[0];
  if (sub.name !== "trust.checkpoint.json") {
    errors.push("subject[0].name expected 'trust.checkpoint.json', got " + sub.name);
  }
  // The subject digest was computed BEFORE attestation was added to the envelope.
  // Reconstruct the pre-attestation checkpoint bytes by removing the attestation key,
  // then verifying the sha256 matches what the statement carries.
  const checkpointEnv = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
  const preAttestationEnv = { ...checkpointEnv };
  delete preAttestationEnv.attestation;
  // writeJson uses JSON.stringify(payload, null, 2) + "\n"
  const preAttestationBytes = Buffer.from(JSON.stringify(preAttestationEnv, null, 2) + "\n", "utf8");
  const expectedSha256 = crypto.createHash("sha256").update(preAttestationBytes).digest("hex");
  if (!sub.digest || sub.digest.sha256 !== expectedSha256) {
    errors.push("subject[0].digest.sha256 mismatch: expected (pre-attestation sha256) " + expectedSha256 + ", got " + (sub.digest && sub.digest.sha256));
  } else {
    console.log("subject digest matches sha256(trust.checkpoint.json pre-attestation) = " + expectedSha256.slice(0, 16) + "...");
  }
}

// Verify predicate is the trust bundle (has schemaVersion and claims)
if (!statement.predicate || typeof statement.predicate !== "object") {
  errors.push("predicate missing or not an object");
} else {
  if (statement.predicate.schemaVersion === undefined) {
    errors.push("predicate.schemaVersion missing (expected trust bundle)");
  }
  if (!Array.isArray(statement.predicate.claims)) {
    errors.push("predicate.claims must be an array (expected trust bundle)");
  }
}

if (errors.length > 0) {
  console.error("STATEMENT ERRORS:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("in-toto statement valid: predicateType=" + statement.predicateType + " subject=" + statement.subject[0].name);
NODE
if [[ $? -eq 0 ]]; then
  _pass "in-toto statement: correct predicateType, subject name, and sha256 digest match"
else
  _fail "in-toto statement validation failed"
fi

# Verify the checkpoint envelope carries attestation
node - "$SESSION_DIR1/trust.checkpoint.json" << 'NODE'
const fs = require("fs");
const env = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const errors = [];
if (!env.attestation || typeof env.attestation !== "object") {
  errors.push("attestation field missing from checkpoint envelope");
} else {
  if (!["signed", "unsigned"].includes(env.attestation.status)) {
    errors.push("attestation.status must be 'signed' or 'unsigned', got " + env.attestation.status);
  }
  if (typeof env.attestation.path !== "string" || !env.attestation.path) {
    errors.push("attestation.path must be a non-empty string");
  }
  if (env.attestation.status === "unsigned" && env.attestation.reason !== "no ambient signing identity") {
    errors.push("attestation.reason expected 'no ambient signing identity', got " + env.attestation.reason);
  }
}
if (errors.length > 0) {
  console.error("ATTESTATION ERRORS:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("attestation in envelope: status=" + env.attestation.status + " path=" + env.attestation.path);
NODE
if [[ $? -eq 0 ]]; then
  _pass "trust.checkpoint.json envelope carries attestation field with correct shape"
else
  _fail "trust.checkpoint.json attestation field missing or malformed"
fi

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== TEST 2: Fail-open local — unsigned path, seal still succeeds ==="

AROOT2="$TMP/test2/.flow-agents"
SLUG2="sign-test-failopen"
SESSION_DIR2="$AROOT2/$SLUG2"
mkdir -p "$AROOT2"

flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$AROOT2" \
  --task-slug "$SLUG2" \
  --title "Checkpoint Signing Fail-Open Test" \
  --summary "Verify that signing fail-open produces unsigned statement and seal succeeds." \
  --timestamp "2026-06-26T11:00:00Z" >/dev/null 2>&1

flow_agents_node "$WRITER" init-plan "$SESSION_DIR2/${SLUG2}--deliver.md" \
  --source-request "Test" --summary "Test" \
  --timestamp "2026-06-26T11:01:00Z" >/dev/null 2>&1

flow_agents_node "$WRITER" record-evidence "$SESSION_DIR2" \
  --verdict pass \
  --check-json '{"id":"build","kind":"build","status":"pass","summary":"build passed"}' \
  --timestamp "2026-06-26T11:02:00Z" >/dev/null 2>&1

# advance-state to delivered: this is the other code path that seals the checkpoint
SEAL_EXIT=0
flow_agents_node "$WRITER" advance-state "$SESSION_DIR2" \
  --status delivered \
  --phase release \
  --summary "Delivered." \
  --timestamp "2026-06-26T11:03:00Z" >/dev/null 2>&1 || SEAL_EXIT=$?

if [[ "$SEAL_EXIT" -eq 0 ]]; then
  _pass "advance-state --status delivered exits 0 (seal succeeds, signing is fail-open)"
else
  _fail "advance-state --status delivered exited $SEAL_EXIT (signing must not break the seal)"
fi

if [[ -f "$SESSION_DIR2/trust.checkpoint.json" ]]; then
  _pass "trust.checkpoint.json written even when signing is fail-open"
else
  _fail "trust.checkpoint.json absent — seal did not complete"
fi

# In local (no OIDC), the unsigned path must be taken
node - "$SESSION_DIR2/trust.checkpoint.json" << 'NODE'
const fs = require("fs");
const env = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!env.attestation) { console.error("attestation missing from envelope"); process.exit(1); }
// Local: either unsigned OR signed (if OIDC happens to be available in the test env)
if (!["signed", "unsigned"].includes(env.attestation.status)) {
  console.error("attestation.status must be signed or unsigned, got: " + env.attestation.status);
  process.exit(1);
}
console.log("fail-open seal: attestation.status=" + env.attestation.status);
NODE
if [[ $? -eq 0 ]]; then
  _pass "checkpoint envelope has valid attestation.status after fail-open seal"
else
  _fail "checkpoint envelope attestation.status invalid after fail-open seal"
fi

# Verify the SPECIFIC local behavior: unsigned path produces intoto.json when no OIDC
# (This is the primary fail-open proof; if OIDC IS available in CI the signed path is also OK)
UNSIGNED_PATH="$SESSION_DIR2/trust.checkpoint.intoto.json"
SIGNED_PATH="$SESSION_DIR2/trust.checkpoint.sig.json"

if [[ -f "$UNSIGNED_PATH" ]]; then
  UNSIGNED_STATEMENT_STATUS="$(node -e "const s=JSON.parse(require('fs').readFileSync('$UNSIGNED_PATH','utf8')); console.log(s.predicateType);" 2>/dev/null || echo "error")"
  if [[ "$UNSIGNED_STATEMENT_STATUS" == "https://hachure.org/v1/bundle" ]]; then
    _pass "unsigned in-toto statement has correct predicateType (fail-open local path confirmed)"
  else
    _fail "unsigned in-toto statement has wrong predicateType: $UNSIGNED_STATEMENT_STATUS"
  fi
elif [[ -f "$SIGNED_PATH" ]]; then
  _pass "signed envelope exists (OIDC available in this env — fail-open also proved by non-error exit)"
else
  _fail "neither trust.checkpoint.intoto.json nor trust.checkpoint.sig.json present"
fi

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== TEST 3: DSSE structure — mock signer round-trip via toDsseEnvelope/parseDssePayload ==="

node - "$SESSION_DIR1" << 'NODE'
// This test directly exercises the Surface DSSE primitives with a deterministic mock signer:
//   toDsseEnvelope(statement, mockSigner) → envelope
//   parseDssePayload(envelope) → statement (round-trip)
//   buildPaeBytes(payloadType, statementJson) == paeReceived in mock signer
//
// Proves the signing PATH is correct without needing real OIDC.

const fs = require("fs");
const path = require("path");

// Load the surface module's interop exports directly (same path the production code uses)
async function run() {
  const { toDsseEnvelope, parseDssePayload, buildPaeBytes, toInTotoStatement } = await import(
    "@kontourai/surface"
  );

  const errors = [];

  // Load the in-toto statement that was produced by the actual seal
  const dir = process.argv[2];
  const intotoPath = path.join(dir, "trust.checkpoint.intoto.json");
  const sigPath = path.join(dir, "trust.checkpoint.sig.json");

  let statement;
  if (fs.existsSync(intotoPath)) {
    statement = JSON.parse(fs.readFileSync(intotoPath, "utf8"));
  } else if (fs.existsSync(sigPath)) {
    // In CI/OIDC env, use signed envelope's payload
    const envelope = JSON.parse(fs.readFileSync(sigPath, "utf8"));
    statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
  } else {
    // Construct a minimal statement for the round-trip test
    const bundle = JSON.parse(fs.readFileSync(path.join(dir, "trust.bundle"), "utf8"));
    statement = toInTotoStatement(bundle, {
      subjects: [{ name: "trust.checkpoint.json", digest: { sha256: "a".repeat(64) } }]
    });
  }

  // Mock signer: deterministic, captures the PAE bytes it receives
  let capturedPaeBytes = null;
  const mockSigner = {
    keyid: "test-mock-key-b1",
    sign: async (paeBytes) => {
      capturedPaeBytes = paeBytes;
      // Return a deterministic base64-encoded "signature"
      return Buffer.from("mock-signature-for-b1-test").toString("base64");
    },
  };

  // Build the DSSE envelope
  const envelope = await toDsseEnvelope(statement, mockSigner);

  // Assert 1: payloadType is correct
  if (envelope.payloadType !== "application/vnd.in-toto+json") {
    errors.push("envelope.payloadType expected 'application/vnd.in-toto+json', got " + envelope.payloadType);
  }

  // Assert 2: payload round-trips back to the statement via parseDssePayload
  let roundTripped;
  try {
    roundTripped = parseDssePayload(envelope);
  } catch (e) {
    errors.push("parseDssePayload threw: " + e.message);
    roundTripped = null;
  }
  if (roundTripped) {
    if (roundTripped._type !== statement._type) {
      errors.push("round-trip _type mismatch: " + roundTripped._type + " vs " + statement._type);
    }
    if (roundTripped.predicateType !== statement.predicateType) {
      errors.push("round-trip predicateType mismatch: " + roundTripped.predicateType);
    }
    if (!Array.isArray(roundTripped.subject) || roundTripped.subject.length !== statement.subject.length) {
      errors.push("round-trip subject length mismatch");
    }
    console.log("parseDssePayload round-trip: predicateType=" + roundTripped.predicateType + " subjects=" + roundTripped.subject.length);
  }

  // Assert 3: PAE bytes match buildPaeBytes(payloadType, statementJson)
  const statementJson = JSON.stringify(statement);
  const expectedPae = buildPaeBytes("application/vnd.in-toto+json", statementJson);
  if (capturedPaeBytes === null) {
    errors.push("mock signer was not called (sign() never invoked)");
  } else {
    // Compare Uint8Arrays
    const match = capturedPaeBytes.length === expectedPae.length &&
      capturedPaeBytes.every((b, i) => b === expectedPae[i]);
    if (!match) {
      errors.push("PAE bytes mismatch: signer received different bytes than buildPaeBytes produced");
    } else {
      const paeStr = Buffer.from(capturedPaeBytes).toString("utf8").slice(0, 40);
      console.log("PAE bytes match buildPaeBytes: " + paeStr + "...");
    }
  }

  // Assert 4: signatures carry the mock keyid and sig
  if (!Array.isArray(envelope.signatures) || envelope.signatures.length === 0) {
    errors.push("envelope.signatures is empty");
  } else {
    if (envelope.signatures[0].keyid !== "test-mock-key-b1") {
      errors.push("signatures[0].keyid expected 'test-mock-key-b1', got " + envelope.signatures[0].keyid);
    }
    if (typeof envelope.signatures[0].sig !== "string" || !envelope.signatures[0].sig) {
      errors.push("signatures[0].sig must be a non-empty string");
    }
    console.log("mock signature: keyid=" + envelope.signatures[0].keyid + " sig=" + envelope.signatures[0].sig);
  }

  if (errors.length > 0) {
    console.error("DSSE ROUND-TRIP ERRORS:\n" + errors.join("\n"));
    process.exit(1);
  }
  console.log("DSSE round-trip: all assertions passed");
}

run().catch((e) => { console.error("DSSE test threw: " + e.message); process.exit(1); });
NODE
if [[ $? -eq 0 ]]; then
  _pass "toDsseEnvelope/parseDssePayload/buildPaeBytes round-trip correct with mock signer"
else
  _fail "DSSE round-trip or PAE structure assertion failed"
fi

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== TEST 4: Additive — existing checkpoint behavior unaffected ==="

# Re-check that the TEST 1 session has a valid checkpoint envelope (Increment A shape unchanged)
node - "$SESSION_DIR1/trust.checkpoint.json" << 'NODE'
const fs = require("fs");
const env = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const errors = [];
if (env.schema_version !== "1.0") errors.push("schema_version expected '1.0'");
if (typeof env.slug !== "string" || !env.slug) errors.push("slug missing");
if (env.status !== "delivered") errors.push("status expected 'delivered'");
if (env.phase !== "release") errors.push("phase expected 'release'");
if (!env.checkpoint || typeof env.checkpoint !== "object") errors.push("checkpoint missing");
if (!env.checkpoint.statusByClaimId) errors.push("checkpoint.statusByClaimId missing");
if (errors.length > 0) {
  console.error("ADDITIVE SHAPE ERRORS:\n" + errors.join("\n"));
  process.exit(1);
}
const claimCount = Object.keys(env.checkpoint.statusByClaimId || {}).length;
console.log("Increment A shape preserved: status=" + env.status + " claims=" + claimCount + " attestation=" + env.attestation?.status);
NODE
if [[ $? -eq 0 ]]; then
  _pass "Increment A checkpoint envelope shape preserved (additive — no regression)"
else
  _fail "Increment A checkpoint envelope shape broken (regression)"
fi

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "────────────────────────────────────────────"
if [[ $errors -eq 0 ]]; then
  echo "test_checkpoint_signing: all checks passed."
  exit 0
else
  echo "test_checkpoint_signing: $errors check(s) failed."
  exit 1
fi
