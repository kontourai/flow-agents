#!/usr/bin/env bash
# relay.sh — OPTIONAL console liveness relay (#295, ADR 0021 §4/§7).
#
# Mirrors a single liveness event (claim/heartbeat/release) to the hosted Console as a
# `kontour.console.liveness` record, reusing the telemetry transport's shared `console_post_json`
# (endpoint-allow gate, Bearer + tenant auth, timeouts, temp-file handling, detached fire — one core,
# never forked). The Console side ingests this record type and projects the fleet view + runs the
# janitor (console repo #125); this script is only the flow-agents EMIT half.
#
# STRICTLY OPTIONAL and local-first (ADR 0012 §5): a no-op unless the liveness relay is enabled AND a
# console endpoint is configured. Enablement is conf-driven (#567, parity with economics #469): an
# operator sets `console_liveness_relay=1` in the console conf (or it defaults on once a console url
# resolves) — NOT an env var. config.sh (sourced below) is the authoritative, trust-gated decision
# and also supplies the endpoint/token/tenant from the conf. Best-effort throughout — it must NEVER
# block, slow, or fail the local liveness write that already happened before this was invoked. Every
# failure path is a quiet `exit 0`.
#
# Invoked (fully detached, best-effort) from scripts/hooks/lib/liveness-write.js after the durable
# local append. Usage: relay.sh '<liveness-event-json>'
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 0

# transport.sh sources ${TELEMETRY_DIR}/lib/redact.sh at load — point it at the telemetry lib dir,
# then reuse the SAME console POST core the telemetry mirror uses.
export TELEMETRY_DIR="${TELEMETRY_DIR:-$SCRIPT_DIR/../telemetry}"

# Shared prologue (#1025): config.sh resolution, the family enable gate, transport.sh, endpoint and
# auth normalization all live in record-relay.sh now — this file used to carry its own copy, and
# economics carried a second. Only the record shaping below is liveness-specific.
# shellcheck source=/dev/null
[[ -f "$TELEMETRY_DIR/lib/record-relay.sh" ]] && source "$TELEMETRY_DIR/lib/record-relay.sh" 2>/dev/null || exit 0
record_relay_prepare LIVENESS || exit 0

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
  artifact_dir: (.artifact_dir // .artifactDir // null),
  source: (.source // null),
  activity: (.activity // null)
}' 2>/dev/null)" || exit 0
[[ -z "$record" || "$record" == "null" ]] && exit 0

# Optional field redaction (default none — jq escaping already neutralizes injection), then the
# shared best-effort POST. console_post_json enforces the https/localhost endpoint-allow gate.
processed="$(redact_event "$record" "${FLOW_AGENTS_CONSOLE_LIVENESS_REDACT:-none}")"
console_post_json "$endpoint" "$processed"
exit 0
