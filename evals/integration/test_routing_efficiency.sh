#!/usr/bin/env bash
# shellcheck disable=SC2015
# ^ the `<cond> && pass ... || fail ...` assert idiom is deliberate (pass always returns 0).
# test_routing_efficiency.sh — routing-efficiency proposals from delegation outcomes (#415).
#
# Proves scripts/telemetry/routing-efficiency.sh turns real economics.jsonl delegation outcomes into
# ADVISORY per-(role,model) proposals, honestly: unavailable outcomes are excluded from every rate, a
# thin sample yields insufficient-signal (not a confident call), and the analyzer never writes config.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ANALYZER="$ROOT/scripts/telemetry/routing-efficiency.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
errors=0
pass() { echo "  [PASS] $1"; }
fail() { echo "  [FAIL] $1"; errors=$((errors + 1)); }
command -v jq >/dev/null 2>&1 || { echo "jq unavailable; skipping"; exit 0; }

echo "=== routing-efficiency (#415) ==="

# Fixture: mechanical is troubled (3 of 4 measurable reworked/diverged/failed), design is clean (3/3
# accepted), implementation is all-unavailable (no measurable signal on this harness).
LOG="$TMP/economics.jsonl"
cat > "$LOG" <<'EOF'
{"schema":"kontour.console.economics","version":"0.1","run_id":"r1","cost":{},"time":{},"iterations":{},"defects":{},"delegations":[{"role":"delegate-mechanical","resolved_model":"claude-haiku-4-5@anthropic","outcome":"rework"},{"role":"delegate-design","resolved_model":"claude-opus-4-8@anthropic","outcome":"accepted"}]}
{"schema":"kontour.console.economics","version":"0.1","run_id":"r2","cost":{},"time":{},"iterations":{},"defects":{},"delegations":[{"role":"delegate-mechanical","resolved_model":"claude-haiku-4-5@anthropic","outcome":"failed"},{"role":"delegate-design","resolved_model":"claude-opus-4-8@anthropic","outcome":"accepted"}]}
{"schema":"kontour.console.economics","version":"0.1","run_id":"r3","cost":{},"time":{},"iterations":{},"defects":{},"delegations":[{"role":"delegate-mechanical","resolved_model":"claude-haiku-4-5@anthropic","outcome":"diverged"},{"role":"delegate-design","resolved_model":"claude-opus-4-8@anthropic","outcome":"accepted"},{"role":"delegate-implementation","resolved_model":"claude-sonnet-5@anthropic","outcome":"unavailable"}]}
{"schema":"kontour.console.economics","version":"0.1","run_id":"r4","cost":{},"time":{},"iterations":{},"defects":{},"delegations":[{"role":"delegate-mechanical","resolved_model":"claude-haiku-4-5@anthropic","outcome":"accepted"},{"role":"delegate-implementation","resolved_model":"claude-sonnet-5@anthropic","outcome":"unavailable"}]}
EOF
OUT="$(bash "$ANALYZER" "$LOG")"
aeq() { # <label> <jq-expr> <expected>
  local got; got="$(printf '%s' "$OUT" | jq -c "$2" 2>/dev/null)"
  [[ "$got" == "$3" ]] && pass "$1 ($got)" || fail "$1: expected $3 got $got"
}

# AC: at least one real proposal (the #415 acceptance) — the troubled cheap tier flagged for escalation.
aeq "troubled cheap tier → escalate-minimum-tier proposal" \
  '.proposals[] | select(.role=="delegate-mechanical") | .kind' '"escalate-minimum-tier"'
aeq "clean expensive tier → keep-tier proposal" \
  '.proposals[] | select(.role=="delegate-design") | .kind' '"keep-tier"'
# AC: unavailable excluded from rates → thin measurable sample is insufficient-signal, NOT a confident call.
aeq "all-unavailable role → insufficient-signal (not a confident verdict)" \
  '.proposals[] | select(.role=="delegate-implementation") | .kind' '"insufficient-signal"'
aeq "unavailable EXCLUDED from measurable (mechanical measurable == 4)" \
  '.by_role_model[] | select(.role=="delegate-mechanical") | .measurable' '4'
aeq "implementation unavailable counted separately (== 2), measurable == 0" \
  '.by_role_model[] | select(.role=="delegate-implementation") | [.unavailable,.measurable]' '[2,0]'
aeq "trouble_rate excludes unavailable (mechanical 3/4 == 0.75)" \
  '.by_role_model[] | select(.role=="delegate-mechanical") | .trouble_rate' '0.75'
aeq "every proposal is advisory (never auto-applied)" \
  '[.proposals[] | select(.severity != "advisory")] | length' '0'
# a real, human-readable rationale exists on the escalation proposal
HAS_RAT="$(printf '%s' "$OUT" | jq -r '.proposals[] | select(.role=="delegate-mechanical") | .rationale' 2>/dev/null)"
[[ "$HAS_RAT" == *"under-routed"* ]] && pass "escalation proposal carries a human rationale" || fail "no rationale: $HAS_RAT"

# empty / no-delegations input → empty proposals, never a fabricated call
EMPTY="$TMP/empty.jsonl"; : > "$EMPTY"
EOUT="$(bash "$ANALYZER" "$EMPTY")"
[[ "$(printf '%s' "$EOUT" | jq -c '.proposals')" == "[]" ]] && pass "empty input → no proposals (no fabrication)" || fail "empty input produced proposals"
[[ "$(printf '%s' "$EOUT" | jq -r '.schema')" == "kontour.routing-efficiency" ]] && pass "empty input still emits a valid envelope" || fail "empty envelope malformed"

# honesty guard: the analyzer must NOT write .datum/config.json (advisory only)
if grep -qE '\.datum/config\.json' "$ANALYZER" && ! grep -qE 'never (edit|auto-appl)' "$ANALYZER"; then
  fail "analyzer references .datum/config.json outside a comment — must not write routing config"
else
  pass "analyzer never writes .datum/config.json (advisory only, human-ratified)"
fi

echo ""
if [[ "$errors" -eq 0 ]]; then echo "test_routing_efficiency: all checks passed."; exit 0
else echo "test_routing_efficiency: $errors check(s) failed."; exit 1; fi
