#!/usr/bin/env bash
# Narrative redaction is value-free and fail-closed: secrets never enter snapshot blobs or diagnostics.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURES="$ROOT/evals/fixtures/narrative-sources"
TMP="$(mktemp -d)"
errors=0
_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

json_assert() { # $1=file $2=JavaScript expression using value
  node - "$1" "$2" <<'NODE'
const fs = require('fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!Function('value', `return Boolean(${process.argv[3]})`)(value)) process.exit(1);
NODE
}

echo "Narrative redaction fail-closed integration"
if npm run build --silent; then _pass "TypeScript build completed"; else _fail "TypeScript build failed"; fi

RAW="$TMP/raw-telemetry"
ARTIFACT_ROOT="$TMP/artifacts"
AC6_CANARY="NARRATIVE_AC6_SECRET_7b31e9" # deliberate test canary, never a real credential
cp -R "$FIXTURES/telemetry" "$RAW"
# Telemetry IDs carry a content pin: sha8 of the exact fixture line.
PIN="$(node -e "const fs=require('fs'),c=require('crypto');const line=fs.readFileSync(process.argv[1],'utf8').split('\n').find(l=>l.trim()&&JSON.parse(l).event_id==='evt-redaction');process.stdout.write(c.createHash('sha256').update(Buffer.from(line)).digest('hex').slice(0,8))" "$RAW/full.jsonl")"
SOURCE_ID="fa1:telemetry:full/session-fixture:evt-redaction/$PIN"

node "$ROOT/build/src/cli.js" narrative-sources snapshot \
  --artifact-root "$ARTIFACT_ROOT" \
  --narrative-id redacted-success \
  --source "$SOURCE_ID" \
  --telemetry-root "$RAW" \
  --redact-fields tool.input \
  >"$TMP/snapshot-success.json" 2>"$TMP/snapshot-success.stderr"
success_exit=$?
SUCCESS_DIR="$ARTIFACT_ROOT/.kontourai/narrative/redacted-success"
SUCCESS_MANIFEST="$SUCCESS_DIR/source-manifest.json"
if [[ "$success_exit" -eq 0 && -f "$SUCCESS_MANIFEST" ]]; then
  _pass "AC6: redacted snapshot completed"
else
  _fail "AC6: redacted snapshot failed (exit=$success_exit): $(<"$TMP/snapshot-success.stderr")"
  echo "narrative redaction fail-closed tests FAILED: $errors issue(s)."
  exit 1
fi

if json_assert "$SUCCESS_MANIFEST" 'value.sources.length === 1 && value.sources[0].status === "snapshotted" && value.sources[0].redactions.includes("tool.input")'; then
  _pass "AC6: manifest records only the redacted field name"
else
  _fail "AC6: redaction field-name metadata missing"
fi

node "$ROOT/build/src/cli.js" narrative-sources resolve \
  --narrative-dir "$SUCCESS_DIR" --source-id "$SOURCE_ID" --out "$TMP/redacted-record.json" \
  >"$TMP/resolve-success.json" 2>"$TMP/resolve-success.stderr"
if [[ "$?" -eq 0 ]] && json_assert "$TMP/redacted-record.json" 'value.tool.input === null && value.tool.output === null'; then
  _pass "AC6: seeded tool.input secret is nulled in resolved bytes"
else
  _fail "AC6: resolved record did not null sensitive tool fields"
fi

if ! grep -R -F -q -- "$AC6_CANARY" "$SUCCESS_DIR" && ! grep -F -q -- "$AC6_CANARY" "$TMP/snapshot-success.stderr" "$TMP/resolve-success.stderr"; then
  _pass "AC6: zero secret hits in narrative directory and captured stderr"
else
  _fail "AC6: secret leaked into snapshot artifacts or diagnostics"
fi

# An invalid policy field is a deterministic integration-level filter failure.
# The source must be recorded unavailable/redacted without writing candidate bytes.
node "$ROOT/build/src/cli.js" narrative-sources snapshot \
  --artifact-root "$ARTIFACT_ROOT" \
  --narrative-id redacted-failure \
  --source "$SOURCE_ID" \
  --telemetry-root "$RAW" \
  --redact-fields __proto__ \
  >"$TMP/snapshot-failure.json" 2>"$TMP/snapshot-failure.stderr"
failure_exit=$?
FAILURE_DIR="$ARTIFACT_ROOT/.kontourai/narrative/redacted-failure"
FAILURE_MANIFEST="$FAILURE_DIR/source-manifest.json"
if [[ "$failure_exit" -eq 0 && -f "$FAILURE_MANIFEST" ]]; then
  _pass "AC6: filter failure still emits an auditable manifest"
else
  _fail "AC6: filter-failure snapshot failed (exit=$failure_exit): $(<"$TMP/snapshot-failure.stderr")"
  echo "narrative redaction fail-closed tests FAILED: $errors issue(s)."
  exit 1
fi

if json_assert "$FAILURE_MANIFEST" 'value.sources.length === 1 && value.sources[0].status === "unavailable" && value.sources[0].unavailable_reason === "redacted" && !Object.hasOwn(value.sources[0], "sha256")'; then
  _pass "AC6: filter failure becomes unavailable/redacted with no blob hash"
else
  _fail "AC6: filter failure did not fail closed"
fi

blob_count=0
if [[ -d "$FAILURE_DIR/sources" ]]; then blob_count="$(find "$FAILURE_DIR/sources" -type f | wc -l | tr -d ' ')"; fi
if [[ "$blob_count" -eq 0 ]]; then _pass "AC6: filter failure writes zero source blobs"; else _fail "AC6: filter failure wrote $blob_count source blob(s)"; fi

if ! grep -R -F -q -- "$AC6_CANARY" "$FAILURE_DIR" && ! grep -F -q -- "$AC6_CANARY" "$TMP/snapshot-failure.stderr"; then
  _pass "AC6: failed-filter artifacts and stderr contain no secret value"
else
  _fail "AC6: failed-filter path leaked the secret value"
fi

if grep -F -q -- '__proto__' "$FAILURE_MANIFEST" || grep -F -q -- '__proto__' "$TMP/snapshot-failure.json" "$TMP/snapshot-failure.stderr"; then
  _pass "AC6: failed-filter diagnostics identify the field name, not its value"
else
  _fail "AC6: failed-filter diagnostic omitted the invalid field name"
fi

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "narrative redaction fail-closed tests passed: 9/9."
  exit 0
fi
echo "narrative redaction fail-closed tests FAILED: $errors issue(s)."
exit 1
