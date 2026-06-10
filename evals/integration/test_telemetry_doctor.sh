#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FLOW_AGENTS_CLI="${FLOW_AGENTS_CLI:-node}"
FLOW_AGENTS_CLI_ARGS=()
if [[ "$FLOW_AGENTS_CLI" == "node" ]]; then
  FLOW_AGENTS_CLI_ARGS=("$ROOT_DIR/build/src/cli.js")
fi
TMPDIR_EVAL="$(mktemp -d /tmp/flow-agents-telemetry-doctor.XXXXXX)"
pass=0
fail=0

cleanup() {
  rm -rf "$TMPDIR_EVAL"
}
trap cleanup EXIT

_pass() { echo "  ✓ $1"; pass=$((pass + 1)); }
_fail() { echo "  ✗ $1"; fail=$((fail + 1)); }

echo "=== Telemetry Doctor Integration Test ==="
echo ""

DEST="$TMPDIR_EVAL/install"
mkdir -p "$DEST/scripts/telemetry"
cp "$ROOT_DIR/scripts/telemetry/telemetry.conf" "$DEST/scripts/telemetry/telemetry.conf"

if $FLOW_AGENTS_CLI "${FLOW_AGENTS_CLI_ARGS[@]}" telemetry-doctor --dest "$DEST" --json --headless >"$TMPDIR_EVAL/local.json"; then
  if jq -e '
    .ok == true and
    .telemetry.configExists == true and
    (.telemetry.activeSinks | index("local-files")) and
    .console.sink == "local-only" and
    .console.reachability.checked == false
  ' "$TMPDIR_EVAL/local.json" >/dev/null; then
    _pass "doctor reports local-only telemetry as JSON"
  else
    _fail "doctor local-only JSON did not match expected shape"
  fi
else
  _fail "doctor failed for local-only telemetry config"
fi

cat >> "$DEST/scripts/telemetry/telemetry.conf" <<'CONF'
console_telemetry_url=http://127.0.0.1:9
console_tenant_id=tenant-a
CONF

if $FLOW_AGENTS_CLI "${FLOW_AGENTS_CLI_ARGS[@]}" telemetry-doctor --dest "$DEST" --json --headless --timeout-ms 250 >"$TMPDIR_EVAL/console.json"; then
  _fail "doctor returned success for unreachable configured Console"
else
  if jq -e '
    .ok == false and
    (.telemetry.activeSinks | index("console")) and
    .console.sink == "console" and
    .console.endpointAllowed == true and
    .console.tenantConfigured == true and
    .console.reachability.checked == true and
    .console.reachability.ok == false
  ' "$TMPDIR_EVAL/console.json" >/dev/null; then
    _pass "doctor reports unreachable configured Console in JSON"
  else
    _fail "doctor unreachable Console JSON did not match expected shape"
  fi
fi

cp "$ROOT_DIR/scripts/telemetry/telemetry.conf" "$DEST/scripts/telemetry/telemetry.conf"
cat >> "$DEST/scripts/telemetry/telemetry.conf" <<'CONF'
console_telemetry_url=http://example.test
CONF

if $FLOW_AGENTS_CLI "${FLOW_AGENTS_CLI_ARGS[@]}" telemetry-doctor --dest "$DEST" --json --headless --timeout-ms 250 >"$TMPDIR_EVAL/unsafe.json"; then
  _fail "doctor returned success for unsafe Console URL"
else
  if jq -e '
    .ok == false and
    .console.sink == "console" and
    .console.endpointAllowed == false and
    .console.reachability.checked == false and
    (.warnings | length > 0)
  ' "$TMPDIR_EVAL/unsafe.json" >/dev/null; then
    _pass "doctor rejects unsafe non-local Console URL before reachability"
  else
    _fail "doctor unsafe Console JSON did not match expected shape"
  fi
fi

cat > "$DEST/scripts/telemetry/telemetry.conf" <<'CONF'
enabled=true
channels=full,analytics
console_telemetry_url=https://bad host
CONF

if $FLOW_AGENTS_CLI "${FLOW_AGENTS_CLI_ARGS[@]}" telemetry-doctor --dest "$DEST" --json --headless >"$TMPDIR_EVAL/malformed.json"; then
  _fail "doctor returned success for malformed HTTPS Console URL"
else
  if jq -e '
    .ok == false and
    .console.endpointAllowed == false and
    .console.reachability.checked == false and
    .console.endpointUrl == "[malformed-url]"
  ' "$TMPDIR_EVAL/malformed.json" >/dev/null; then
    _pass "doctor emits JSON for malformed HTTPS Console URL"
  else
    _fail "doctor malformed HTTPS JSON did not match expected shape"
  fi
fi

cat > "$DEST/scripts/telemetry/telemetry.conf" <<'CONF'
enabled=true
channels=full,analytics
console_telemetry_url=https://user:pass@console.example.test/path?token=secret&safe=yes
CONF

if $FLOW_AGENTS_CLI "${FLOW_AGENTS_CLI_ARGS[@]}" telemetry-doctor --dest "$DEST" --json --headless >"$TMPDIR_EVAL/redacted.json"; then
  _fail "doctor returned success for credential-bearing Console URL"
else
  if jq -e '
    .ok == false and
    .console.endpointAllowed == false and
    (.console.url | contains("user") | not) and
    (.console.url | contains("pass") | not) and
    (.console.url | contains("secret") | not) and
    (.console.url | contains("token=%5Bredacted%5D"))
  ' "$TMPDIR_EVAL/redacted.json" >/dev/null; then
    _pass "doctor redacts credential-bearing Console URLs"
  else
    _fail "doctor did not redact credential-bearing Console URLs"
  fi
fi

cat > "$DEST/scripts/telemetry/telemetry.conf" <<'CONF'
enabled=true
channels=full
channel.full.endpoint_url=https://user:pass@example.test/path?token=secret&safe=yes
CONF

if $FLOW_AGENTS_CLI "${FLOW_AGENTS_CLI_ARGS[@]}" telemetry-doctor --dest "$DEST" --json --headless >"$TMPDIR_EVAL/channel-redacted.json"; then
  if jq -e '
    .ok == true and
    (.telemetry.channels[0].endpointUrl | contains("user") | not) and
    (.telemetry.channels[0].endpointUrl | contains("pass") | not) and
    (.telemetry.channels[0].endpointUrl | contains("secret") | not) and
    (.telemetry.channels[0].endpointUrl | contains("token=%5Bredacted%5D"))
  ' "$TMPDIR_EVAL/channel-redacted.json" >/dev/null; then
    _pass "doctor redacts channel endpoint URLs"
  else
    _fail "doctor did not redact channel endpoint URLs"
  fi
else
  _fail "doctor failed for channel endpoint redaction case"
fi

cat > "$DEST/scripts/telemetry/telemetry.conf" <<'CONF'
enabled=true
channels=full,analytics
console_telemetry_url=https://console.example.test
CONF

if $FLOW_AGENTS_CLI "${FLOW_AGENTS_CLI_ARGS[@]}" telemetry-doctor --dest "$DEST" --json --headless >"$TMPDIR_EVAL/nonlocal.json"; then
  _fail "doctor returned success for non-local Console without --allow-network"
else
  if jq -e '
    .ok == false and
    .console.endpointAllowed == false and
    .console.reachability.checked == false
  ' "$TMPDIR_EVAL/nonlocal.json" >/dev/null; then
    _pass "doctor blocks non-local Console reachability without opt-in"
  else
    _fail "doctor non-local block JSON did not match expected shape"
  fi
fi

if $FLOW_AGENTS_CLI "${FLOW_AGENTS_CLI_ARGS[@]}" telemetry-doctor --dest "$DEST" --json --headless --allow-network --timeout-ms 50 >"$TMPDIR_EVAL/allow-network.json"; then
  _fail "doctor returned success for unreachable non-local Console with --allow-network"
else
  if jq -e '
    .ok == false and
    .console.endpointAllowed == true and
    .console.reachability.checked == true
  ' "$TMPDIR_EVAL/allow-network.json" >/dev/null; then
    _pass "doctor checks non-local Console only with explicit network opt-in"
  else
    _fail "doctor allow-network JSON did not match expected shape"
  fi
fi

echo ""
echo "Passed: $pass"
echo "Failed: $fail"

[[ "$fail" -eq 0 ]]
