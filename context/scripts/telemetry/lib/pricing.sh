#!/usr/bin/env bash
# pricing.sh — single-source pricing registry loader.
#
# Resolves the versioned pricing registry (pricing.json) from, in priority:
#   1. explicit local file   TELEMETRY_PRICING_FILE / FLOW_AGENTS_PRICING_FILE
#   2. remote URL (cached)   TELEMETRY_PRICING_URL  / FLOW_AGENTS_PRICING_URL
#   3. bundled snapshot      <telemetry>/pricing.json
# This is the one source every runtime + the console read from — local for
# air-gapped use, remote for a single live registry shared across machines.

PRICING_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Echo the raw registry JSON. Returns non-zero if nothing resolvable.
pricing_registry() {
  local f="${TELEMETRY_PRICING_FILE:-${FLOW_AGENTS_PRICING_FILE:-}}"
  if [[ -n "$f" && -f "$f" ]]; then cat "$f"; return 0; fi

  local url="${TELEMETRY_PRICING_URL:-${FLOW_AGENTS_PRICING_URL:-}}"
  if [[ -n "$url" ]] && command -v curl >/dev/null 2>&1; then
    local cache="${TMPDIR:-/tmp}/flow-agents-pricing-cache.json"
    local ttl="${TELEMETRY_PRICING_TTL_SEC:-3600}"
    if [[ -f "$cache" ]]; then
      local mtime now age
      mtime=$(stat -f %m "$cache" 2>/dev/null || stat -c %Y "$cache" 2>/dev/null || echo 0)
      now=$(date +%s)
      age=$(( now - mtime ))
      if [[ "$age" -lt "$ttl" ]]; then cat "$cache"; return 0; fi
    fi
    if curl -fsS --max-time 5 "$url" -o "${cache}.tmp" 2>/dev/null && [[ -s "${cache}.tmp" ]]; then
      mv "${cache}.tmp" "$cache"
      cat "$cache"
      return 0
    fi
    rm -f "${cache}.tmp" 2>/dev/null
    [[ -f "$cache" ]] && { cat "$cache"; return 0; }  # stale cache beats nothing
  fi

  local bundled
  bundled="$(cd "${PRICING_LIB_DIR}/.." && pwd)/pricing.json"
  [[ -f "$bundled" ]] && { cat "$bundled"; return 0; }
  return 1
}
