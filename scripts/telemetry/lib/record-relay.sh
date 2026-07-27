#!/usr/bin/env bash
# record-relay.sh — the shared prologue every per-family console relay needs (#1025).
#
# `scripts/liveness/relay.sh` (#295/#567) and `scripts/telemetry/economics-record.sh` (#469) each
# carried their own copy of: source config.sh, check the family's enable flag, source transport.sh,
# resolve the endpoint, normalize auth. Only the record *shaping* actually differs per family.
# Rather than let policy records become a third copy, that prologue lives here once and the
# families supply just their shape.
#
# Usage, from a family relay:
#   source "<telemetry-lib>/record-relay.sh"
#   record_relay_prepare LIVENESS || exit 0     # sets $endpoint, sources transport.sh
#   ... shape $record ...
#   console_post_json "$endpoint" "$record"
#
# `record_relay_prepare <FAMILY>` returns non-zero (never exits) whenever the relay must no-op, so a
# caller always ends in a quiet `exit 0`. Best-effort throughout: it must NEVER block, slow, or fail
# the durable local write that already happened before the relay was invoked.

# Resolve config + transport and the endpoint for FAMILY (e.g. LIVENESS, POLICY).
# Honors <FAMILY>-specific overrides: FLOW_AGENTS_CONSOLE_<FAMILY>_RELAY (the gate, which config.sh
# resolves from the conf) and FLOW_AGENTS_CONSOLE_<FAMILY>_ENDPOINT_URL.
record_relay_prepare() {
  local family="${1:?record_relay_prepare requires a FAMILY}"
  local gate_var="FLOW_AGENTS_CONSOLE_${family}_RELAY"
  local endpoint_var="FLOW_AGENTS_CONSOLE_${family}_ENDPOINT_URL"

  # config.sh is the authoritative, trust-gated resolution for BOTH enablement and the endpoint —
  # the JS-side pre-gate is deliberately lenient and never forces the flag on (see record-relay.js).
  # shellcheck source=/dev/null
  [[ -f "$TELEMETRY_DIR/lib/config.sh" ]] && source "$TELEMETRY_DIR/lib/config.sh" 2>/dev/null || true

  case "${!gate_var:-}" in
    1 | true | TRUE | yes | on) ;;
    *) return 1 ;;
  esac

  [[ -f "$TELEMETRY_DIR/lib/transport.sh" ]] || return 1
  # shellcheck source=/dev/null
  source "$TELEMETRY_DIR/lib/transport.sh" 2>/dev/null || return 1

  endpoint="${!endpoint_var:-}"
  if [[ -z "$endpoint" ]]; then
    local base="${FLOW_AGENTS_CONSOLE_URL:-${CONSOLE_TELEMETRY_URL:-${CONSOLE_URL:-}}}"
    [[ -z "$base" ]] && return 1
    endpoint="${base%/}/records"
  fi

  # Auth reuses the env names console_post_json reads, accepting FLOW_AGENTS_CONSOLE_* aliases and an
  # optional token file. Never fatal on a missing/bad token — console_post_json only adds a header
  # when the value passes its own safety check.
  if [[ -z "${CONSOLE_TELEMETRY_TOKEN:-}" ]]; then
    local token_file="${FLOW_AGENTS_CONSOLE_TOKEN_FILE:-${CONSOLE_TELEMETRY_TOKEN_FILE:-}}"
    if [[ -n "$token_file" && -r "$token_file" ]]; then
      CONSOLE_TELEMETRY_TOKEN="$(tr -d '\r\n' < "$token_file" 2>/dev/null || true)"
      export CONSOLE_TELEMETRY_TOKEN
    fi
  fi
  if [[ -z "${CONSOLE_TENANT_ID:-}" && -n "${FLOW_AGENTS_CONSOLE_TENANT:-}" ]]; then
    export CONSOLE_TENANT_ID="$FLOW_AGENTS_CONSOLE_TENANT"
  fi

  return 0
}
