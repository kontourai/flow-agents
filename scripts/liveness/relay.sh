#!/usr/bin/env bash
# relay.sh — OPTIONAL console liveness relay (#295, ADR 0021 §4/§7).
#
# Mirrors a single liveness event (claim/heartbeat/release) to the hosted Console as a
# `kontour.console.liveness` record, reusing the telemetry transport's shared `console_post_json`
# (endpoint-allow gate, Bearer + tenant auth, timeouts, temp-file handling, detached fire — one core,
# never forked). The Console side ingests this record type and projects the fleet view + runs the
# janitor (console repo #125); this script is only the flow-agents EMIT half.
#
# STRICTLY OPTIONAL and local-first (ADR 0012 §5): a no-op unless FLOW_AGENTS_CONSOLE_LIVENESS_RELAY
# is enabled AND a console endpoint is configured. Best-effort throughout — it must NEVER block, slow,
# or fail the local liveness write that already happened before this was invoked. Every failure path
# is a quiet `exit 0`.
#
# Invoked (fully detached, best-effort) from scripts/hooks/lib/liveness-write.js after the durable
# local append. Usage: relay.sh '<liveness-event-json>'
set -uo pipefail

# Opt-in gate — off by default.
case "${FLOW_AGENTS_CONSOLE_LIVENESS_RELAY:-}" in
  1 | true | TRUE | yes | on) ;;
  *) exit 0 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 0

# transport.sh sources ${TELEMETRY_DIR}/lib/redact.sh at load — point it at the telemetry lib dir,
# then reuse the SAME console POST core the telemetry mirror uses.
export TELEMETRY_DIR="${TELEMETRY_DIR:-$SCRIPT_DIR/../telemetry}"
[[ -f "$TELEMETRY_DIR/lib/transport.sh" ]] || exit 0
# shellcheck source=/dev/null
source "$TELEMETRY_DIR/lib/transport.sh" 2>/dev/null || exit 0

# Resolve the liveness records endpoint: an explicit override wins, else the base console URL + /records
# ("POST /records with a liveness record type"). No console configured ⇒ no-op.
endpoint="${FLOW_AGENTS_CONSOLE_LIVENESS_ENDPOINT_URL:-}"
if [[ -z "$endpoint" ]]; then
  base="${FLOW_AGENTS_CONSOLE_URL:-${CONSOLE_TELEMETRY_URL:-${CONSOLE_URL:-}}}"
  [[ -z "$base" ]] && exit 0
  endpoint="${base%/}/records"
fi

# Auth reuses the env names console_post_json reads (CONSOLE_TELEMETRY_TOKEN / CONSOLE_TENANT_ID),
# accepting FLOW_AGENTS_CONSOLE_* aliases and an optional token file. Never fatal on a missing/bad
# token — console_post_json only adds a header when the value passes its safety check.
if [[ -z "${CONSOLE_TELEMETRY_TOKEN:-}" ]]; then
  token_file="${FLOW_AGENTS_CONSOLE_TOKEN_FILE:-${CONSOLE_TELEMETRY_TOKEN_FILE:-}}"
  if [[ -n "$token_file" && -r "$token_file" ]]; then
    CONSOLE_TELEMETRY_TOKEN="$(tr -d '\r\n' < "$token_file" 2>/dev/null || true)"
    export CONSOLE_TELEMETRY_TOKEN
  fi
fi
if [[ -z "${CONSOLE_TENANT_ID:-}" && -n "${FLOW_AGENTS_CONSOLE_TENANT:-}" ]]; then
  export CONSOLE_TENANT_ID="$FLOW_AGENTS_CONSOLE_TENANT"
fi

# The liveness event arrives as a single JSON argument.
event_json="${1:-}"
[[ -z "$event_json" ]] && exit 0

# Build the kontour.console.liveness record with jq — guarantees valid JSON and, critically,
# proper string escaping of every untrusted field (actor/subjectId/branch/artifact_dir), so hostile
# control bytes are \u-escaped rather than emitted raw (injection discipline). No jq ⇒ no-op.
command -v jq >/dev/null 2>&1 || exit 0
record="$(printf '%s' "$event_json" | jq -c '{
  schema: "kontour.console.liveness",
  version: "0.1",
  type: (.type // "claim"),
  subjectId: .subjectId,
  actor: .actor,
  actor_key: (.actor_key // .actorKey // null),
  at: .at,
  ttlSeconds: (.ttlSeconds // null),
  host: (.host // null),
  branch: (.branch // null),
  artifact_dir: (.artifact_dir // .artifactDir // null)
}' 2>/dev/null)" || exit 0
[[ -z "$record" || "$record" == "null" ]] && exit 0

# Optional field redaction (default none — jq escaping already neutralizes injection), then the
# shared best-effort POST. console_post_json enforces the https/localhost endpoint-allow gate.
processed="$(redact_event "$record" "${FLOW_AGENTS_CONSOLE_LIVENESS_REDACT:-none}")"
console_post_json "$endpoint" "$processed"
exit 0
