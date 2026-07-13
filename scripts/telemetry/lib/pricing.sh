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

pricing_registry_valid_json() {
  command -v jq >/dev/null 2>&1 || return 1
  jq -e '.current_version and .versions' >/dev/null 2>&1
}

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
      mtime=$(stat -c %Y "$cache" 2>/dev/null || stat -f %m "$cache" 2>/dev/null || echo 0)
      [[ "$mtime" =~ ^[0-9]+$ ]] || mtime=0
      now=$(date +%s)
      age=$(( now - mtime ))
      if [[ "$age" -lt "$ttl" ]] && pricing_registry_valid_json < "$cache"; then cat "$cache"; return 0; fi
    fi
    # Cache-only callers (per-tool-call join; see usage.sh's usage_last_turn_usage,
    # which runs once per tool call, not once per session) never perform a
    # network fetch here. A STALE-but-JSON-valid cache is still served (by the
    # unconditional `[[ -f "$cache" ]] && pricing_registry_valid_json ...`
    # fallback just below) before ever falling through to the bundled
    # snapshot -- only a genuinely MISSING (or invalid) cache reaches the
    # bundled snapshot. This still avoids blocking on a `curl --max-time 5`
    # round-trip (and racing this function's fixed ${cache}.tmp path) on
    # every tool call. session.usage (once per session, at stop) is
    # unaffected and still resolves the registry normally (network-eligible).
    if [[ "${TELEMETRY_PRICING_CACHE_ONLY:-}" != "1" ]]; then
      if curl -fsS --max-time 5 "$url" -o "${cache}.tmp" 2>/dev/null && [[ -s "${cache}.tmp" ]]; then
        if pricing_registry_valid_json < "${cache}.tmp"; then
          mv "${cache}.tmp" "$cache"
          cat "$cache"
          return 0
        fi
      fi
      rm -f "${cache}.tmp" 2>/dev/null
    fi
    [[ -f "$cache" ]] && pricing_registry_valid_json < "$cache" && { cat "$cache"; return 0; }
  fi

  local bundled
  bundled="$(cd "${PRICING_LIB_DIR}/.." && pwd)/pricing.json"
  [[ -f "$bundled" ]] && { cat "$bundled"; return 0; }
  return 1
}
