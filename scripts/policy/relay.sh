#!/usr/bin/env bash
# relay.sh — OPTIONAL console policy-decision relay (#1025).
#
# Mirrors one `kontour.console.policy` record — a gate's allow/deny/error verdict — to the hosted
# Console, reusing the shared prologue (`record-relay.sh`) and the telemetry transport's
# `console_post_json` (endpoint-allow gate, Bearer + tenant auth, timeouts). One core, never forked.
#
# STRICTLY OPTIONAL and local-first: a no-op unless the policy relay is enabled AND a console
# endpoint is configured. Enablement is conf-driven — `console_policy_relay=1` in the console conf,
# or default-on once a console url resolves — matching liveness (#567) and economics (#469).
#
# Invoked fully detached from scripts/hooks/lib/policy-record.js AFTER the durable local append.
# Every failure path is a quiet `exit 0`: this must never affect a gate's verdict.
#
# Usage: relay.sh '<policy-record-json>'
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 0
export TELEMETRY_DIR="${TELEMETRY_DIR:-$SCRIPT_DIR/../telemetry}"

# shellcheck source=/dev/null
[[ -f "$TELEMETRY_DIR/lib/record-relay.sh" ]] && source "$TELEMETRY_DIR/lib/record-relay.sh" 2>/dev/null || exit 0
record_relay_prepare POLICY || exit 0

record_json="${1:-}"
[[ -z "$record_json" ]] && exit 0

# Re-shape through jq rather than forwarding the argument verbatim. policy-record.js already built a
# well-formed record, but this relay must not become a pipe that posts whatever it is handed:
# re-projecting named fields guarantees valid JSON, escapes untrusted strings (tool names, cwd) so
# hostile control bytes are \u-escaped rather than emitted raw, and drops anything unrecognized.
# Same injection discipline as the liveness relay. No jq ⇒ no-op.
command -v jq >/dev/null 2>&1 || exit 0
record="$(printf '%s' "$record_json" | jq -c '{
  schema: "kontour.console.policy",
  version: (.version // "0.1"),
  type: (.type // "policy.decision"),
  at: .at,
  hook: { id: (.hook.id // null), event: (.hook.event // null) },
  decision: (.decision // null),
  exit_code: (.exit_code // null),
  subject: { tool_name: (.subject.tool_name // null), cwd: (.subject.cwd // null) },
  signals: { runtime: (.signals.runtime // null), session_id: (.signals.session_id // null) }
}' 2>/dev/null)" || exit 0
[[ -z "$record" || "$record" == "null" ]] && exit 0

# `cwd` is a filesystem path and the likeliest field to carry something an operator would rather not
# ship; it stays redactable through the same channel mechanism the telemetry mirror uses.
processed="$(redact_event "$record" "${FLOW_AGENTS_CONSOLE_POLICY_REDACT:-none}")"
console_post_json "$endpoint" "$processed"
exit 0
