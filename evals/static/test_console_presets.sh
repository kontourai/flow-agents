#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

pass() {
  echo "PASS: $1"
}

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

assert_hosted_preset() {
  local preset_file="$1"
  local label="$2"
  local default_url override_url

  default_url="$(
    unset FLOW_AGENTS_KONTOUR_CLOUD_CONSOLE_URL
    # shellcheck source=/dev/null
    source "$preset_file"
    flow_agents_kontour_hosted_console_url
  )"
  [[ "$default_url" == "https://console.kontourai.io" ]] || fail "$label default hosted URL is $default_url"
  pass "$label default hosted URL uses console.kontourai.io"

  override_url="$(
    export FLOW_AGENTS_KONTOUR_CLOUD_CONSOLE_URL="https://console.override.test"
    # shellcheck source=/dev/null
    source "$preset_file"
    flow_agents_kontour_hosted_console_url
  )"
  [[ "$override_url" == "https://console.override.test" ]] || fail "$label hosted URL override is $override_url"
  pass "$label hosted URL override is preserved"
}

echo "=== Console Preset Contract Checks ==="

assert_hosted_preset "$ROOT_DIR/scripts/telemetry/console-presets.sh" "source preset"
assert_hosted_preset "$ROOT_DIR/context/scripts/telemetry/console-presets.sh" "context preset"

if rg -F -q "https://console.kontourai.com" \
  "$ROOT_DIR/scripts/telemetry/console-presets.sh" \
  "$ROOT_DIR/context/scripts/telemetry/console-presets.sh"; then
  fail "preset scripts still reference console.kontourai.com"
fi
pass "preset scripts do not reference console.kontourai.com"
