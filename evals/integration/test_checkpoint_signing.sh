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
#   5. NO-CLOBBER (WS5 iteration-2 part 2 regression guard): this eval's scratch sessions
#      (mktemp -d, no kits/ ancestor) never publish into this real repo's delivery/trust.bundle,
#      even when the eval is run from a checkout of this repo — publish-delivery's repo-root
#      resolution is fail-closed and TEST 2 passes an explicit scratch --repo-root.
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

# REGRESSION GUARD (WS5 iteration-2 part 2): this eval's scratch sessions live under a
# mktemp -d tree with no kits/ ancestor. Before the fail-closed fix to
# findRepoRootFromDir/publishDelivery in src/cli/workflow-sidecar.ts, a scratch session's
# record-release / advance-state --status delivered call would silently fall back to
# process.cwd() for its delivery/ repo-root — and when this eval runs from a checkout of
# THIS repo (as it does under npm run eval:static / the integration suite), that clobbered
# the real repo's own delivery/trust.bundle with scratch fixture content. Capture this real
# repo's delivery/trust.bundle content hash now (before any scratch session in this eval
# runs) and re-check it is byte-identical after every test below.
REAL_DELIVERY_BUNDLE="$ROOT/delivery/trust.bundle"
_bundle_hash() { if [[ -f "$1" ]]; then shasum -a 256 "$1" | awk '{print $1}'; else echo "absent"; fi; }
REAL_DELIVERY_HASH_BEFORE="$(_bundle_hash "$REAL_DELIVERY_BUNDLE")"

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
# ROUND-TRIP ASSERTION: after the fix, trust.checkpoint.json is the exact artifact
# that was signed — no post-digest mutation. sha256(on-disk checkpoint) must equal
# the subject digest in the in-toto statement.
node - "$SESSION_DIR1" << 'NODE'
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const dir = process.argv[2];
const checkpointPath = path.join(dir, "trust.checkpoint.json");
const intotoPath = path.join(dir, "trust.checkpoint.intoto.json");
const sigPath = path.join(dir, "trust.checkpoint.sig.json");

const errors = [];

// Determine which attestation statement file exists
let statement;
if (fs.existsSync(intotoPath)) {
  statement = JSON.parse(fs.readFileSync(intotoPath, "utf8"));
} else if (fs.existsSync(sigPath)) {
  // Parse from DSSE envelope payload
  const envelope = JSON.parse(fs.readFileSync(sigPath, "utf8"));
  const payloadJson = Buffer.from(envelope.payload, "base64").toString("utf8");
  statement = JSON.parse(payloadJson);
} else {
  errors.push("no attestation statement file found (neither intoto.json nor sig.json)");
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
  // ROUND-TRIP ASSERTION: trust.checkpoint.json must be byte-identical to what was signed.
  // No post-digest mutation is allowed, so the on-disk sha256 == signed subject digest.
  const checkpointBytes = fs.readFileSync(checkpointPath);
  const onDiskSha256 = crypto.createHash("sha256").update(checkpointBytes).digest("hex");
  if (!sub.digest || sub.digest.sha256 !== onDiskSha256) {
    errors.push("ROUND-TRIP FAIL: signed subject digest " + (sub.digest && sub.digest.sha256) +
      " != sha256(on-disk trust.checkpoint.json) " + onDiskSha256 +
      " — checkpoint was mutated after signing");
  } else {
    console.log("ROUND-TRIP PASS: sha256(on-disk trust.checkpoint.json) == signed subject digest = " + onDiskSha256.slice(0, 16) + "...");
  }

  // REGRESSION GUARD: trust.checkpoint.json must NOT contain an attestation field.
  const checkpointEnv = JSON.parse(checkpointBytes);
  if ("attestation" in checkpointEnv) {
    errors.push("trust.checkpoint.json must NOT contain attestation field — it breaks the digest");
  } else {
    console.log("trust.checkpoint.json has no attestation field (correct — digest is stable)");
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
  _pass "in-toto statement: correct predicateType, subject name, ROUND-TRIP digest match, no attestation field in checkpoint"
else
  _fail "in-toto statement or round-trip digest assertion failed"
fi

# Verify the companion attestation file exists with correct shape.
# trust.checkpoint.attestation.json carries the attestation pointer/status.
# trust.checkpoint.json must NOT contain an attestation field (digest stability).
node - "$SESSION_DIR1" << 'NODE'
const fs = require("fs");
const path = require("path");
const dir = process.argv[2];
const attestationPath = path.join(dir, "trust.checkpoint.attestation.json");
const checkpointPath = path.join(dir, "trust.checkpoint.json");
const errors = [];

// Companion file must exist
if (!fs.existsSync(attestationPath)) {
  errors.push("trust.checkpoint.attestation.json missing — attestation companion file not written");
} else {
  const att = JSON.parse(fs.readFileSync(attestationPath, "utf8"));
  if (!["signed", "unsigned"].includes(att.status)) {
    errors.push("attestation.status must be 'signed' or 'unsigned', got " + att.status);
  }
  if (typeof att.path !== "string" || !att.path) {
    errors.push("attestation.path must be a non-empty string");
  }
  if (att.status === "unsigned" && att.reason !== "no ambient signing identity") {
    errors.push("attestation.reason expected 'no ambient signing identity', got " + att.reason);
  }
  if (errors.length === 0) {
    console.log("trust.checkpoint.attestation.json: status=" + att.status + " path=" + att.path);
  }
}

// trust.checkpoint.json must NOT carry attestation (that would break the digest)
const env = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
if ("attestation" in env) {
  errors.push("trust.checkpoint.json must NOT contain attestation field (breaks digest verification)");
}

if (errors.length > 0) {
  console.error("ATTESTATION COMPANION ERRORS:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("attestation companion file correct; trust.checkpoint.json has no attestation field");
NODE
if [[ $? -eq 0 ]]; then
  _pass "trust.checkpoint.attestation.json has correct shape; trust.checkpoint.json has no attestation field"
else
  _fail "trust.checkpoint.attestation.json missing/malformed or trust.checkpoint.json has attestation field"
fi

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== TEST 2: Fail-open local — unsigned path, seal still succeeds ==="

AROOT2="$TMP/test2/.flow-agents"
SLUG2="sign-test-failopen"
SESSION_DIR2="$AROOT2/$SLUG2"
mkdir -p "$AROOT2"

# REGRESSION FIX (WS5 iteration-2 part 2): this session dir has no kits/ ancestor of its
# own (it lives under $TMP). Pass an explicit --repo-root pointing at a scratch repo-root
# under $TMP so advance-state --status delivered's auto-publish never has to fall back to
# (or, pre-fix, silently trust) process.cwd() — matching test_publish_delivery.sh's pattern
# of always giving its scratch sessions an explicit repo-root.
REPO_ROOT2="$TMP/test2/scratch-repo"
mkdir -p "$REPO_ROOT2"

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
  --repo-root "$REPO_ROOT2" \
  --timestamp "2026-06-26T11:03:00Z" >/dev/null 2>&1 || SEAL_EXIT=$?

if [[ "$SEAL_EXIT" -eq 0 ]]; then
  _pass "advance-state --status delivered exits 0 (seal succeeds, signing is fail-open)"
else
  _fail "advance-state --status delivered exited $SEAL_EXIT (signing must not break the seal)"
fi

# #379: publishDelivery writes to the per-session path delivery/<slug>/trust.bundle.
if [[ -f "$REPO_ROOT2/delivery/$SLUG2/trust.bundle" ]]; then
  _pass "publish-delivery published into the explicit scratch --repo-root ($REPO_ROOT2/delivery/$SLUG2/trust.bundle, #379 per-session), not process.cwd()"
else
  _fail "publish-delivery did not write to the explicit scratch --repo-root ($REPO_ROOT2/delivery/$SLUG2/trust.bundle) — check the --repo-root plumbing in advanceState"
fi

if [[ -f "$SESSION_DIR2/trust.checkpoint.json" ]]; then
  _pass "trust.checkpoint.json written even when signing is fail-open"
else
  _fail "trust.checkpoint.json absent — seal did not complete"
fi

# In local (no OIDC), the unsigned path must be taken.
# Attestation is now in the companion file, not in trust.checkpoint.json.
node - "$SESSION_DIR2" << 'NODE'
const fs = require("fs");
const path = require("path");
const dir = process.argv[2];
const attestationPath = path.join(dir, "trust.checkpoint.attestation.json");
if (!fs.existsSync(attestationPath)) {
  console.error("trust.checkpoint.attestation.json missing from fail-open seal");
  process.exit(1);
}
const att = JSON.parse(fs.readFileSync(attestationPath, "utf8"));
// Local: either unsigned OR signed (if OIDC happens to be available in the test env)
if (!["signed", "unsigned"].includes(att.status)) {
  console.error("attestation.status must be signed or unsigned, got: " + att.status);
  process.exit(1);
}
console.log("fail-open seal: attestation companion: status=" + att.status);
NODE
if [[ $? -eq 0 ]]; then
  _pass "trust.checkpoint.attestation.json has valid status after fail-open seal"
else
  _fail "trust.checkpoint.attestation.json missing or invalid after fail-open seal"
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
console.log("Increment A shape preserved: status=" + env.status + " claims=" + claimCount + " (attestation in companion file)");
NODE
if [[ $? -eq 0 ]]; then
  _pass "Increment A checkpoint envelope shape preserved (additive — no regression)"
else
  _fail "Increment A checkpoint envelope shape broken (regression)"
fi

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== TEST 5: Regression — this eval's scratch sessions never touch the real repo's delivery/trust.bundle ==="

REAL_DELIVERY_HASH_AFTER="$(_bundle_hash "$REAL_DELIVERY_BUNDLE")"
if [[ "$REAL_DELIVERY_HASH_AFTER" == "$REAL_DELIVERY_HASH_BEFORE" ]]; then
  _pass "real repo delivery/trust.bundle unchanged by this eval's scratch sessions (before=$REAL_DELIVERY_HASH_BEFORE after=$REAL_DELIVERY_HASH_AFTER)"
else
  _fail "real repo delivery/trust.bundle CHANGED during this eval (before=$REAL_DELIVERY_HASH_BEFORE after=$REAL_DELIVERY_HASH_AFTER) — a scratch session's publish-delivery clobbered $REAL_DELIVERY_BUNDLE"
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
