#!/usr/bin/env bash
# test_liveness_heartbeat.sh — integration eval for the shared tool-activity
# liveness heartbeat (issue #288, Wave 3 Task 3.2 of the plan artifact at
# .kontourai/flow-agents/kontourai-flow-agents-288/kontourai-flow-agents-288--plan-work.md).
#
# Covers, per the plan and AC3/AC4/AC5/AC8:
#   A. Policy semantics (scripts/hooks/lib/liveness-policy.js):
#      default-on when unset/empty/arbitrary value; explicit opt-out for each
#      of off|0|false|no|disabled (case-insensitive, whitespace-trimmed).
#   B. maybeEmitHeartbeat({cwd, env, now}) throttle boundary, called directly
#      via a stdin-piped `node -` script with an injected `now` for
#      deterministic <60s throttled / >=60s emits proof (the plan's
#      preferred, deterministic option (a)).
#   C. maybeEmitHeartbeat skip reasons: no-current (no active_slug at all),
#      no-claim (active_slug set but no prior claim event for the resolved
#      actor), released (actor's last event is a release), disabled (explicit
#      opt-out wins even with a fresh claim present), actor-unresolved (wins
#      even with a fresh claim present for a different, resolvable actor).
#   D. One end-to-end wrapper invocation (claude-telemetry-hook.js with a
#      PostToolUse fixture) proving a heartbeat is appended for a fresh claim,
#      plus a fail-open proof when the sidecar snapshot file is corrupted
#      (malformed JSON).
#   E. Telemetry-toggle independence (AC5): TELEMETRY_ENABLED=false still
#      heartbeats — liveness heartbeats do not read/depend on that gate.
#   F. Cross-runtime smoke: codex-telemetry-hook.js (distinct event-name path:
#      raw eventType passed straight through, no canonicalEvent() mapping).
#   G. Wrapper-level throttle smoke: two back-to-back real-clock invocations
#      append exactly one heartbeat (the deterministic node stdin-script
#      proof in B is the precise boundary test; this is the end-to-end
#      companion the plan also asks for).
#
# Deterministic, no model spend, self-cleaning (mktemp -d + trap EXIT).
# Usage: bash evals/integration/test_liveness_heartbeat.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB_DIR="$ROOT/scripts/hooks/lib"
POLICY_MODULE="$LIB_DIR/liveness-policy.js"
HEARTBEAT_MODULE="$LIB_DIR/liveness-heartbeat.js"
READ_MODULE="$LIB_DIR/liveness-read.js"
ACTOR_MODULE="$LIB_DIR/actor-identity.js"
CURRENT_POINTER_HELPER="$LIB_DIR/current-pointer.js"
CLAUDE_HOOK="$ROOT/scripts/hooks/claude-telemetry-hook.js"
CODEX_HOOK="$ROOT/scripts/hooks/codex-telemetry-hook.js"

for m in "$POLICY_MODULE" "$HEARTBEAT_MODULE" "$READ_MODULE" "$ACTOR_MODULE" "$CLAUDE_HOOK" "$CODEX_HOOK"; do
  if [[ ! -f "$m" ]]; then
    echo "liveness heartbeat eval skipped: $m does not exist yet." >&2
    exit 1
  fi
done

TMPDIR_EVAL="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_EVAL"' EXIT

errors=0
_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

echo "=== Liveness heartbeat integration (#288) ==="

# ─── Fixture helpers ────────────────────────────────────────────────────────

SNAPSHOT_FILENAME="current.json"

# new_scratch — fresh scratch directory under the eval's own tmpdir.
new_scratch() {
  mktemp -d "$TMPDIR_EVAL/scratch-XXXXXX"
}

# seed_current_snapshot <root> <slug> [actor] — #440: writes BOTH the legacy current.json
# (SNAPSHOT_FILENAME, unconditional — every fixture below keeps writing this) AND, when actor is
# given, the per-actor current/<actor>.json pointer with the SAME minimal {"active_slug": slug}
# payload — mirroring workflow-sidecar.ts's real writeCurrent() dual-write, via the shared
# current-pointer.js helper's own writePerActorCurrent (not a hand-rolled reimplementation of its
# sanitize/path rule), so #440's readOwnCurrentPointer finds this fixture's claimed subject
# exactly like a real session would. Every builder below that seeds a sidecar snapshot for a
# RESOLVED actor (the FLOW_AGENTS_ACTOR value the corresponding call_heartbeat/wrapper invocation
# uses) now routes through this, instead of hand-writing SNAPSHOT_FILENAME directly.
seed_current_snapshot() {
  local root="$1" slug="$2" actor="${3:-}"
  local artifact_root="$root/.kontourai/flow-agents"
  mkdir -p "$artifact_root"
  printf '{"active_slug":"%s"}\n' "$slug" >"$artifact_root/$SNAPSHOT_FILENAME"
  if [[ -n "$actor" ]]; then
    CP_HELPER_ARG="$CURRENT_POINTER_HELPER" FLOW_AGENTS_DIR_ARG="$artifact_root" \
      SLUG_ARG="$slug" ACTOR_ARG="$actor" node - <<'NODE'
const { writePerActorCurrent } = require(process.env.CP_HELPER_ARG);
writePerActorCurrent(process.env.FLOW_AGENTS_DIR_ARG, process.env.ACTOR_ARG, { active_slug: process.env.SLUG_ARG });
NODE
  fi
}

# seed_claim <scratch_root> <slug> <actor> <at_iso> [ttl_seconds]
# Seeds <root>/.kontourai/flow-agents/<SNAPSHOT_FILENAME> (active_slug) and a
# single `claim` event in liveness/events.jsonl for <actor>, matching the
# exact shape workflow-sidecar.ts's liveness writer produces
# (subjectId/actor/at/ttlSeconds).
seed_claim() {
  local root="$1" slug="$2" actor="$3" at="$4" ttl="${5:-1800}"
  local artifact_root="$root/.kontourai/flow-agents"
  mkdir -p "$artifact_root/liveness"
  seed_current_snapshot "$root" "$slug" "$actor"
  printf '{"type":"claim","subjectId":"%s","actor":"%s","at":"%s","ttlSeconds":%s}\n' \
    "$slug" "$actor" "$at" "$ttl" >"$artifact_root/liveness/events.jsonl"
}

# append_release <scratch_root> <slug> <actor> <at_iso>
append_release() {
  local root="$1" slug="$2" actor="$3" at="$4"
  local stream="$root/.kontourai/flow-agents/liveness/events.jsonl"
  printf '{"type":"release","subjectId":"%s","actor":"%s","at":"%s"}\n' "$slug" "$actor" "$at" >>"$stream"
}

stream_file() {
  printf '%s' "$1/.kontourai/flow-agents/liveness/events.jsonl"
}

stream_line_count() {
  local f
  f="$(stream_file "$1")"
  [[ -f "$f" ]] && wc -l <"$f" | tr -d ' ' || echo 0
}

# iso_offset_ms <delta_ms> — real-clock ISO timestamp `delta_ms` from now (used
# to seed a claim that is definitely past the heartbeat throttle window).
iso_offset_ms() {
  DELTA_MS="$1" node - <<'NODE'
process.stdout.write(new Date(Date.now() + Number(process.env.DELTA_MS)).toISOString());
NODE
}

# is_valid_json_stdin <string> — true if the given string parses as JSON.
is_valid_json() {
  JSON_ARG="$1" node - <<'NODE'
try {
  JSON.parse(process.env.JSON_ARG);
  process.exit(0);
} catch {
  process.exit(1);
}
NODE
}

# call_heartbeat <scratch_root> <env_json> [now_iso]
# Calls maybeEmitHeartbeat({cwd, env, now}) directly via a stdin-piped `node -`
# script (env passed through the process environment, not argv) and prints
# its JSON result (single line, stable key order per liveness-heartbeat.js).
call_heartbeat() {
  local root="$1" env_json="$2" now="${3:-}"
  MODULE_ARG="$HEARTBEAT_MODULE" ROOT_ARG="$root" ENV_JSON_ARG="$env_json" NOW_ARG="$now" \
    node - <<'NODE'
const { maybeEmitHeartbeat } = require(process.env.MODULE_ARG);
const env = JSON.parse(process.env.ENV_JSON_ARG);
const opts = { cwd: process.env.ROOT_ARG, env };
if (process.env.NOW_ARG) opts.now = process.env.NOW_ARG;
process.stdout.write(JSON.stringify(maybeEmitHeartbeat(opts)));
NODE
}

# ─── A. Policy semantics (liveness-policy.js) ───────────────────────────────
echo "--- A. Policy semantics ---"

if MODULE_ARG="$POLICY_MODULE" node - <<'NODE'
const { isLivenessEnabled } = require(process.env.MODULE_ARG);
if (isLivenessEnabled({}) !== true) throw new Error("isLivenessEnabled({}) (unset) must default to true");
if (isLivenessEnabled({ FLOW_AGENTS_LIVENESS: "" }) !== true) throw new Error("isLivenessEnabled with empty string must default to true");
if (isLivenessEnabled({ FLOW_AGENTS_LIVENESS: "on" }) !== true) throw new Error("isLivenessEnabled('on') must be enabled (any non-off-token enables)");
if (isLivenessEnabled({ FLOW_AGENTS_LIVENESS: "1" }) !== true) throw new Error("isLivenessEnabled('1') must be enabled (any non-off-token enables)");
NODE
then
  _pass "isLivenessEnabled defaults to true when unset/empty and for arbitrary non-off values (AC1)"
else
  _fail "isLivenessEnabled did not default-on as expected"
fi

for token in off OFF Off " off " 0 false False FALSE no No NO disabled Disabled " disabled "; do
  if MODULE_ARG="$POLICY_MODULE" TOKEN_ARG="$token" node - <<'NODE'
const { isLivenessEnabled } = require(process.env.MODULE_ARG);
const token = process.env.TOKEN_ARG;
const out = isLivenessEnabled({ FLOW_AGENTS_LIVENESS: token });
if (out !== false) throw new Error(`isLivenessEnabled did not disable for token ${JSON.stringify(token)}: got ${out}`);
NODE
  then
    _pass "isLivenessEnabled honors opt-out token $(printf '%q' "$token") (AC1)"
  else
    _fail "isLivenessEnabled did not honor opt-out token $(printf '%q' "$token")"
  fi
done

# F4 (#288 fix iteration 1, sec-LOW): zero-width/format characters (U+200B/U+200C/U+200D/U+FEFF)
# must be stripped before the opt-out token compare — 'off<ZWSP>' must still disable. Codepoints
# are constructed entirely inside the node script (via String.fromCodePoint on a decimal
# codepoint passed through the env) to avoid ever embedding an invisible/BOM character literally
# in this shell script's own source text.
for zw_spec in "ZWSP:0x200B:before" "ZWJ:0x200D:middle" "ZWNJ:0x200C:middle" "BOM:0xFEFF:before"; do
  zw_name="${zw_spec%%:*}"
  zw_rest="${zw_spec#*:}"
  zw_codepoint="${zw_rest%%:*}"
  zw_position="${zw_rest#*:}"
  if ZW_CODEPOINT_ARG="$zw_codepoint" ZW_POSITION_ARG="$zw_position" MODULE_ARG="$POLICY_MODULE" node - <<'NODE'
const { isLivenessEnabled } = require(process.env.MODULE_ARG);
const zwChar = String.fromCodePoint(Number(process.env.ZW_CODEPOINT_ARG));
const token = process.env.ZW_POSITION_ARG === 'before' ? `${zwChar}off` : `o${zwChar}ff`;
const out = isLivenessEnabled({ FLOW_AGENTS_LIVENESS: token });
if (out !== false) throw new Error(`isLivenessEnabled did not disable for a zero-width-embedded token: got ${out}`);
NODE
  then
    _pass "isLivenessEnabled strips zero-width/format chars ($zw_name) before comparing the opt-out token (F4)"
  else
    _fail "isLivenessEnabled did not strip zero-width/format chars ($zw_name) before comparing the opt-out token"
  fi
done

# F7 (#288 fix iteration 1, cr-LOW): parsePositiveIntOr uses a strict /^[0-9]+$/ literal match —
# non-integer-literal coercions Number() would otherwise accept (hex "0x10", exponential "1e3")
# must fall back to the default, not be silently accepted as 16 / 1000.
if MODULE_ARG="$POLICY_MODULE" node - <<'NODE'
const { resolveTtlSeconds, resolveHeartbeatThrottleSeconds, DEFAULT_TTL_SECONDS, DEFAULT_HEARTBEAT_THROTTLE_SECONDS } = require(process.env.MODULE_ARG);
const cases = [
  ["FLOW_AGENTS_LIVENESS_TTL_SECONDS", "0x10", resolveTtlSeconds, DEFAULT_TTL_SECONDS],
  ["FLOW_AGENTS_LIVENESS_TTL_SECONDS", "1e3", resolveTtlSeconds, DEFAULT_TTL_SECONDS],
  ["FLOW_AGENTS_LIVENESS_HEARTBEAT_THROTTLE_SECONDS", "0x10", resolveHeartbeatThrottleSeconds, DEFAULT_HEARTBEAT_THROTTLE_SECONDS],
  ["FLOW_AGENTS_LIVENESS_HEARTBEAT_THROTTLE_SECONDS", "1e3", resolveHeartbeatThrottleSeconds, DEFAULT_HEARTBEAT_THROTTLE_SECONDS],
];
for (const [envVar, rawValue, resolver, expectedDefault] of cases) {
  const got = resolver({ [envVar]: rawValue });
  if (got !== expectedDefault) {
    throw new Error(`${envVar}=${rawValue} should fall back to default ${expectedDefault}, got ${got}`);
  }
}
// A genuine strict positive-integer literal must still parse correctly.
if (resolveTtlSeconds({ FLOW_AGENTS_LIVENESS_TTL_SECONDS: "300" }) !== 300) {
  throw new Error("resolveTtlSeconds('300') should resolve to 300");
}
NODE
then
  _pass "parsePositiveIntOr rejects hex (0x10) / exponential (1e3) coercions and falls back to defaults (F7)"
else
  _fail "parsePositiveIntOr did not reject hex/exponential coercions as expected"
fi

# ─── B. maybeEmitHeartbeat throttle boundary (direct, injected `now`) ───────
echo "--- B. Throttle boundary (deterministic, injected now) ---"

B_ROOT="$(new_scratch)"
seed_claim "$B_ROOT" "b-subj" "agent-b" "2026-06-25T12:00:00.000Z" 1800

B_59S="$(call_heartbeat "$B_ROOT" '{"FLOW_AGENTS_ACTOR":"agent-b"}' "2026-06-25T12:00:59.000Z")"
if [[ "$B_59S" == '{"emitted":false,"reason":"throttled"}' ]] && [[ "$(stream_line_count "$B_ROOT")" -eq 1 ]]; then
  _pass "maybeEmitHeartbeat throttles at 59s since last event (< 60s, no append) (AC3)"
else
  _fail "maybeEmitHeartbeat did not throttle at 59s: result=$B_59S lines=$(stream_line_count "$B_ROOT")"
fi

B_60S="$(call_heartbeat "$B_ROOT" '{"FLOW_AGENTS_ACTOR":"agent-b"}' "2026-06-25T12:01:00.000Z")"
if [[ "$B_60S" == '{"emitted":true}' ]] && [[ "$(stream_line_count "$B_ROOT")" -eq 2 ]]; then
  _pass "maybeEmitHeartbeat emits at exactly 60s since last event (>= 60s boundary) (AC3)"
else
  _fail "maybeEmitHeartbeat did not emit at the 60s boundary: result=$B_60S lines=$(stream_line_count "$B_ROOT")"
fi

# Chained throttle: the newly-appended heartbeat is now the "last matching event"; an
# immediate follow-up call (0s later) must throttle against IT, not the original claim.
B_CHAIN="$(call_heartbeat "$B_ROOT" '{"FLOW_AGENTS_ACTOR":"agent-b"}' "2026-06-25T12:01:00.000Z")"
if [[ "$B_CHAIN" == '{"emitted":false,"reason":"throttled"}' ]] && [[ "$(stream_line_count "$B_ROOT")" -eq 2 ]]; then
  _pass "maybeEmitHeartbeat throttle re-anchors to the most recent heartbeat, not the original claim (AC3)"
else
  _fail "maybeEmitHeartbeat throttle did not re-anchor to the most recent heartbeat: result=$B_CHAIN lines=$(stream_line_count "$B_ROOT")"
fi

# F2 (#288 fix iteration 1, cr-HIGH coverage gap): FLOW_AGENTS_LIVENESS_HEARTBEAT_THROTTLE_SECONDS
# moves the throttle boundary to a custom value (5s here, not the 60s default) — proves the env
# var is actually consulted, not just the hard-coded default.
B2_ROOT="$(new_scratch)"
seed_claim "$B2_ROOT" "b2-subj" "agent-b2" "2026-06-25T12:00:00.000Z" 1800

B2_4S="$(call_heartbeat "$B2_ROOT" '{"FLOW_AGENTS_ACTOR":"agent-b2","FLOW_AGENTS_LIVENESS_HEARTBEAT_THROTTLE_SECONDS":"5"}' "2026-06-25T12:00:04.000Z")"
if [[ "$B2_4S" == '{"emitted":false,"reason":"throttled"}' ]] && [[ "$(stream_line_count "$B2_ROOT")" -eq 1 ]]; then
  _pass "maybeEmitHeartbeat honors a custom FLOW_AGENTS_LIVENESS_HEARTBEAT_THROTTLE_SECONDS=5: throttles at 4s (F2, AC3)"
else
  _fail "maybeEmitHeartbeat did not throttle at 4s under a custom 5s throttle: result=$B2_4S lines=$(stream_line_count "$B2_ROOT")"
fi

B2_5S="$(call_heartbeat "$B2_ROOT" '{"FLOW_AGENTS_ACTOR":"agent-b2","FLOW_AGENTS_LIVENESS_HEARTBEAT_THROTTLE_SECONDS":"5"}' "2026-06-25T12:00:05.000Z")"
if [[ "$B2_5S" == '{"emitted":true}' ]] && [[ "$(stream_line_count "$B2_ROOT")" -eq 2 ]]; then
  _pass "maybeEmitHeartbeat honors a custom FLOW_AGENTS_LIVENESS_HEARTBEAT_THROTTLE_SECONDS=5: emits at the 5s boundary, not the 60s default (F2, AC3)"
else
  _fail "maybeEmitHeartbeat did not emit at the custom 5s boundary: result=$B2_5S lines=$(stream_line_count "$B2_ROOT")"
fi

# The default (no env override) at the SAME 5s elapsed must still throttle (60s default) —
# proves the custom-value boundary shift in B2 is real, not a fixture artifact.
B2_DEFAULT_ROOT="$(new_scratch)"
seed_claim "$B2_DEFAULT_ROOT" "b2d-subj" "agent-b2d" "2026-06-25T12:00:00.000Z" 1800
B2_DEFAULT="$(call_heartbeat "$B2_DEFAULT_ROOT" '{"FLOW_AGENTS_ACTOR":"agent-b2d"}' "2026-06-25T12:00:05.000Z")"
if [[ "$B2_DEFAULT" == '{"emitted":false,"reason":"throttled"}' ]] && [[ "$(stream_line_count "$B2_DEFAULT_ROOT")" -eq 1 ]]; then
  _pass "maybeEmitHeartbeat default throttle (60s) still applies at 5s elapsed with no env override (F2 control case)"
else
  _fail "maybeEmitHeartbeat default throttle did not hold at 5s elapsed: result=$B2_DEFAULT lines=$(stream_line_count "$B2_DEFAULT_ROOT")"
fi

# ─── C. Skip reasons: no-current / no-claim / released / disabled / actor-unresolved ──
echo "--- C. Skip reasons ---"

# C1: the sidecar snapshot is missing entirely -> no-current, no stream file created.
C1_ROOT="$(new_scratch)"
mkdir -p "$C1_ROOT/.kontourai/flow-agents"
C1_RESULT="$(call_heartbeat "$C1_ROOT" '{"FLOW_AGENTS_ACTOR":"agent-c1"}')"
if [[ "$C1_RESULT" == '{"emitted":false,"reason":"no-current"}' ]] && [[ ! -f "$(stream_file "$C1_ROOT")" ]]; then
  _pass "maybeEmitHeartbeat returns no-current when the sidecar snapshot / active_slug is absent (AC4)"
else
  _fail "maybeEmitHeartbeat did not report no-current for a missing sidecar snapshot: result=$C1_RESULT"
fi

# C2: the sidecar snapshot names a slug with no prior events at all -> no-claim.
C2_ROOT="$(new_scratch)"
# #440 FIXTURE-GAP: agent-c2 owns c2-subj (never claimed) -- needs its own per-actor pointer so
# readOwnCurrentPointer finds it and the code reaches the no-claim check, not an earlier no-current.
seed_current_snapshot "$C2_ROOT" "c2-subj" "agent-c2"
C2_RESULT="$(call_heartbeat "$C2_ROOT" '{"FLOW_AGENTS_ACTOR":"agent-c2"}')"
if [[ "$C2_RESULT" == '{"emitted":false,"reason":"no-claim"}' ]]; then
  _pass "maybeEmitHeartbeat returns no-claim when the named subject has no prior claim for the actor (AC4)"
else
  _fail "maybeEmitHeartbeat did not report no-claim for an unclaimed subject: result=$C2_RESULT"
fi

# C3: a released claim (actor's last event is release) -> released, never re-claims.
C3_ROOT="$(new_scratch)"
seed_claim "$C3_ROOT" "c3-subj" "agent-c3" "2026-06-25T11:00:00.000Z" 1800
append_release "$C3_ROOT" "c3-subj" "agent-c3" "2026-06-25T11:05:00.000Z"
C3_RESULT="$(call_heartbeat "$C3_ROOT" '{"FLOW_AGENTS_ACTOR":"agent-c3"}' "2026-06-25T11:10:00.000Z")"
if [[ "$C3_RESULT" == '{"emitted":false,"reason":"released"}' ]] && [[ "$(stream_line_count "$C3_ROOT")" -eq 2 ]]; then
  _pass "maybeEmitHeartbeat returns released when the actor's last event for the subject is a release (AC4)"
else
  _fail "maybeEmitHeartbeat did not report released after a release event: result=$C3_RESULT lines=$(stream_line_count "$C3_ROOT")"
fi

# C4: explicit disabled wins even with a fresh, unreleased claim present.
C4_ROOT="$(new_scratch)"
seed_claim "$C4_ROOT" "c4-subj" "agent-c4" "2026-06-25T11:00:00.000Z" 1800
C4_RESULT="$(call_heartbeat "$C4_ROOT" '{"FLOW_AGENTS_ACTOR":"agent-c4","FLOW_AGENTS_LIVENESS":"off"}' "2026-06-25T11:01:00.000Z")"
if [[ "$C4_RESULT" == '{"emitted":false,"reason":"disabled"}' ]] && [[ "$(stream_line_count "$C4_ROOT")" -eq 1 ]]; then
  _pass "maybeEmitHeartbeat returns disabled and wins over a fresh claim (AC1, AC4)"
else
  _fail "maybeEmitHeartbeat did not report disabled with a fresh claim present: result=$C4_RESULT lines=$(stream_line_count "$C4_ROOT")"
fi

# C5: actor-unresolved wins even with a fresh claim present for a DIFFERENT, resolvable
# actor (proves the actor-unresolved check runs before the claim lookup, per the plan's
# step ordering, not merely "no claim for the unresolved actor").
C5_ROOT="$(new_scratch)"
seed_claim "$C5_ROOT" "c5-subj" "agent-c5-other" "2026-06-25T11:00:00.000Z" 1800
C5_RESULT="$(call_heartbeat "$C5_ROOT" '{"FLOW_AGENTS_ACTOR_TEST_FORCE_UNRESOLVED":"1","NODE_ENV":"test"}' "2026-06-25T11:01:00.000Z")"
if [[ "$C5_RESULT" == '{"emitted":false,"reason":"actor-unresolved"}' ]] && [[ "$(stream_line_count "$C5_ROOT")" -eq 1 ]]; then
  _pass "maybeEmitHeartbeat returns actor-unresolved and wins over a fresh claim held by another actor (AC4)"
else
  _fail "maybeEmitHeartbeat did not report actor-unresolved: result=$C5_RESULT lines=$(stream_line_count "$C5_ROOT")"
fi

# ─── D. End-to-end wrapper invocation (claude-telemetry-hook.js) ───────────
echo "--- D. End-to-end wrapper (claude-telemetry-hook.js) ---"

POST_TOOL_USE_PAYLOAD='{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"echo hi"},"tool_response":{"stdout":"hi"}}'
POST_TOOL_USE_PAYLOAD_FILE="$TMPDIR_EVAL/post-tool-use-payload.json"
printf '%s' "$POST_TOOL_USE_PAYLOAD" >"$POST_TOOL_USE_PAYLOAD_FILE"

# D1: a fresh (well past the 60s throttle, real clock) claim exists for the resolved
# actor -> exactly one heartbeat event is appended by the wrapper's postToolUse path.
D1_ROOT="$(new_scratch)"
D1_STALE_AT="$(iso_offset_ms -300000)"
seed_claim "$D1_ROOT" "d1-subj" "agent-hb" "$D1_STALE_AT" 1800
D1_OUT="$(cd "$D1_ROOT" && TELEMETRY_ENABLED=false FLOW_AGENTS_ACTOR=agent-hb \
  node "$CLAUDE_HOOK" PostToolUse dev <"$POST_TOOL_USE_PAYLOAD_FILE")"
D1_STATUS=$?
if [[ "$D1_STATUS" -eq 0 ]] \
  && is_valid_json "$D1_OUT" \
  && [[ "$(stream_line_count "$D1_ROOT")" -eq 2 ]] \
  && grep -q '"type":"heartbeat"' "$(stream_file "$D1_ROOT")"; then
  _pass "claude-telemetry-hook.js PostToolUse appends exactly one heartbeat for a fresh claim (AC3)"
else
  _fail "claude-telemetry-hook.js PostToolUse did not append a heartbeat as expected: status=$D1_STATUS out=$D1_OUT lines=$(stream_line_count "$D1_ROOT")"
fi

# D2: a corrupted sidecar snapshot (malformed JSON) fails open — wrapper still exits 0
# with its normal stdout contract, and no heartbeat is fabricated from unparseable state.
# #440 FIX 2 (de-vacuate, independent review): corrupt agent-hb's OWN per-actor pointer file (the
# new collision-resistant mapping), not the legacy current.json — a resolved actor never reads
# the legacy file at all (#440 D1), so corrupting only that no longer exercises anything; this
# now proves fail-open tolerance for a corrupt OWN pointer, the actually-reachable code path.
D2_ROOT="$(new_scratch)"
mkdir -p "$D2_ROOT/.kontourai/flow-agents/liveness"
D2_PER_ACTOR_FILE="$(CP_HELPER_ARG="$CURRENT_POINTER_HELPER" ROOT_ARG="$D2_ROOT/.kontourai/flow-agents" ACTOR_ARG="agent-hb" node - <<'NODE'
const { perActorCurrentFile } = require(process.env.CP_HELPER_ARG);
process.stdout.write(perActorCurrentFile(process.env.ROOT_ARG, process.env.ACTOR_ARG));
NODE
)"
mkdir -p "$(dirname "$D2_PER_ACTOR_FILE")"
printf '{not valid json' >"$D2_PER_ACTOR_FILE"
D2_OUT="$(cd "$D2_ROOT" && TELEMETRY_ENABLED=false FLOW_AGENTS_ACTOR=agent-hb \
  node "$CLAUDE_HOOK" PostToolUse dev <"$POST_TOOL_USE_PAYLOAD_FILE" 2>"$TMPDIR_EVAL/d2.err")"
D2_STATUS=$?
if [[ "$D2_STATUS" -eq 0 ]] \
  && is_valid_json "$D2_OUT" \
  && [[ "$(stream_line_count "$D2_ROOT")" -eq 0 ]]; then
  _pass "claude-telemetry-hook.js fails open on a corrupted sidecar snapshot (exit 0, no heartbeat fabricated) (AC3)"
else
  _fail "claude-telemetry-hook.js did not fail open on a corrupted sidecar snapshot: status=$D2_STATUS out=$D2_OUT lines=$(stream_line_count "$D2_ROOT") stderr=$(cat "$TMPDIR_EVAL/d2.err")"
fi

# ─── E. Telemetry-toggle independence (AC5) ─────────────────────────────────
echo "--- E. Telemetry-toggle independence ---"

E_ROOT="$(new_scratch)"
E_STALE_AT="$(iso_offset_ms -300000)"
seed_claim "$E_ROOT" "e-subj" "agent-hb" "$E_STALE_AT" 1800
E_OUT="$(cd "$E_ROOT" && TELEMETRY_ENABLED=false FLOW_AGENTS_ACTOR=agent-hb \
  node "$CLAUDE_HOOK" PostToolUse dev <"$POST_TOOL_USE_PAYLOAD_FILE")"
E_STATUS=$?
if [[ "$E_STATUS" -eq 0 ]] && [[ "$(stream_line_count "$E_ROOT")" -eq 2 ]] \
  && grep -q '"type":"heartbeat"' "$(stream_file "$E_ROOT")"; then
  _pass "TELEMETRY_ENABLED=false still heartbeats — liveness is decoupled from the telemetry toggle (AC5)"
else
  _fail "heartbeat did not fire with TELEMETRY_ENABLED=false: status=$E_STATUS out=$E_OUT lines=$(stream_line_count "$E_ROOT")"
fi

# ─── F. Cross-runtime smoke (codex-telemetry-hook.js) ───────────────────────
echo "--- F. Cross-runtime smoke (codex-telemetry-hook.js) ---"

CODEX_PAYLOAD='{"hook_event_name":"PostToolUse","tool_name":"shell","tool_input":{"command":"echo hi"}}'
CODEX_PAYLOAD_FILE="$TMPDIR_EVAL/codex-payload.json"
printf '%s' "$CODEX_PAYLOAD" >"$CODEX_PAYLOAD_FILE"
F_ROOT="$(new_scratch)"
F_STALE_AT="$(iso_offset_ms -300000)"
seed_claim "$F_ROOT" "f-subj" "agent-hb" "$F_STALE_AT" 1800
F_OUT="$(cd "$F_ROOT" && TELEMETRY_ENABLED=false FLOW_AGENTS_ACTOR=agent-hb \
  node "$CODEX_HOOK" PostToolUse dev <"$CODEX_PAYLOAD_FILE")"
F_STATUS=$?
if [[ "$F_STATUS" -eq 0 ]] && [[ "$(stream_line_count "$F_ROOT")" -eq 2 ]] \
  && grep -q '"type":"heartbeat"' "$(stream_file "$F_ROOT")"; then
  _pass "codex-telemetry-hook.js PostToolUse appends a heartbeat for a fresh claim (cross-runtime, AC3)"
else
  _fail "codex-telemetry-hook.js PostToolUse did not append a heartbeat as expected: status=$F_STATUS out=$F_OUT lines=$(stream_line_count "$F_ROOT")"
fi

# ─── G. Wrapper-level throttle smoke (two back-to-back real-clock calls) ───
echo "--- G. Wrapper-level throttle smoke ---"

G_ROOT="$(new_scratch)"
G_STALE_AT="$(iso_offset_ms -300000)"
seed_claim "$G_ROOT" "g-subj" "agent-hb" "$G_STALE_AT" 1800
(cd "$G_ROOT" && TELEMETRY_ENABLED=false FLOW_AGENTS_ACTOR=agent-hb node "$CLAUDE_HOOK" PostToolUse dev <"$POST_TOOL_USE_PAYLOAD_FILE" >/dev/null)
(cd "$G_ROOT" && TELEMETRY_ENABLED=false FLOW_AGENTS_ACTOR=agent-hb node "$CLAUDE_HOOK" PostToolUse dev <"$POST_TOOL_USE_PAYLOAD_FILE" >/dev/null)
if [[ "$(stream_line_count "$G_ROOT")" -eq 2 ]]; then
  _pass "two back-to-back wrapper invocations append exactly one heartbeat (real-clock throttle smoke, AC3)"
else
  _fail "two back-to-back wrapper invocations did not throttle to one heartbeat: lines=$(stream_line_count "$G_ROOT") content=$(cat "$(stream_file "$G_ROOT")" 2>/dev/null)"
fi

# ─── H. Bounded tail read (F3, #288 fix iteration 1, sec-MED + cr-MED) ──────
echo "--- H. Bounded tail read (F3) ---"

# build_large_liveness_stream <root> <slug> <actor> <claim_at_iso> <include_recent_hb:true|false> [hb_at_iso]
# Seeds current.json's active_slug and a >64KB liveness/events.jsonl: ~900 unrelated filler
# lines (~85KB), then the target CLAIM event (now provably >64KB from EOF once the rest of the
# file is written), then ~900 more filler lines (~85KB), then optionally one target HEARTBEAT
# event as the very last line (provably within the last 64KB — it IS the last line). Margins are
# ~20KB+ on both sides of the 64KB boundary, comfortably clear of any off-by-one ambiguity.
build_large_liveness_stream() {
  local root="$1" slug="$2" actor="$3" claim_at="$4" include_hb="${5:-false}" hb_at="${6:-}"
  local artifact_root="$root/.kontourai/flow-agents"
  mkdir -p "$artifact_root/liveness"
  seed_current_snapshot "$root" "$slug" "$actor"
  SLUG_ARG="$slug" ACTOR_ARG="$actor" CLAIM_AT_ARG="$claim_at" INCLUDE_HB_ARG="$include_hb" \
  HB_AT_ARG="$hb_at" STREAM_ARG="$artifact_root/liveness/events.jsonl" node - <<'NODE'
const fs = require('fs');
const filler = (i) =>
  JSON.stringify({
    type: 'heartbeat',
    subjectId: `filler-subj-${i}`,
    actor: `filler-actor-${i}`,
    at: '2020-01-01T00:00:00.000Z',
  });
const lines = [];
for (let i = 0; i < 900; i++) lines.push(filler(i));
lines.push(
  JSON.stringify({
    type: 'claim',
    subjectId: process.env.SLUG_ARG,
    actor: process.env.ACTOR_ARG,
    at: process.env.CLAIM_AT_ARG,
    ttlSeconds: 1800,
  })
);
for (let i = 900; i < 1800; i++) lines.push(filler(i));
if (process.env.INCLUDE_HB_ARG === 'true') {
  lines.push(
    JSON.stringify({
      type: 'heartbeat',
      subjectId: process.env.SLUG_ARG,
      actor: process.env.ACTOR_ARG,
      at: process.env.HB_AT_ARG,
    })
  );
}
fs.writeFileSync(process.env.STREAM_ARG, lines.join('\n') + '\n');
NODE
}

# call_heartbeat_instrumented <scratch_root> <env_json> [now_iso]
# Same as call_heartbeat, but monkey-patches fs.readFileSync to count calls against the
# liveness/events.jsonl stream specifically (readLivenessEvents, the FULL-read path) —
# readLivenessEventsTail uses fs.statSync/openSync/readSync/closeSync, never readFileSync, so
# any nonzero count here proves the full-read fallback executed. Prints
# {"result": <maybeEmitHeartbeat result>, "fullReadCalls": <n>}.
call_heartbeat_instrumented() {
  local root="$1" env_json="$2" now="${3:-}"
  MODULE_ARG="$HEARTBEAT_MODULE" ROOT_ARG="$root" ENV_JSON_ARG="$env_json" NOW_ARG="$now" \
    node - <<'NODE'
const fs = require('fs');
const path = require('path');
const originalReadFileSync = fs.readFileSync;
const streamSuffix = path.join('liveness', 'events.jsonl');
let fullReadCalls = 0;
fs.readFileSync = function (p, ...rest) {
  if (typeof p === 'string' && p.endsWith(streamSuffix)) fullReadCalls += 1;
  return originalReadFileSync.call(fs, p, ...rest);
};
const { maybeEmitHeartbeat } = require(process.env.MODULE_ARG);
const env = JSON.parse(process.env.ENV_JSON_ARG);
const opts = { cwd: process.env.ROOT_ARG, env };
if (process.env.NOW_ARG) opts.now = process.env.NOW_ARG;
const result = maybeEmitHeartbeat(opts);
process.stdout.write(JSON.stringify({ result, fullReadCalls }));
NODE
}

# H1: claim is old (beyond the tail window) and a heartbeat for the SAME pair sits inside the
# tail, but that heartbeat is itself still within the throttle window of `now` -> the THROTTLE
# decision is bounded-tail-only (F8(ii): unchanged from F3) and refuses without ever needing to
# confirm claim evidence, so this must cost zero full reads.
H1_ROOT="$(new_scratch)"
build_large_liveness_stream "$H1_ROOT" "h1-subj" "agent-h1" "2026-06-25T09:00:00.000Z" true "2026-06-25T11:59:30.000Z"
H1_OUT="$(call_heartbeat_instrumented "$H1_ROOT" '{"FLOW_AGENTS_ACTOR":"agent-h1"}' "2026-06-25T12:00:00.000Z")"
if [[ "$H1_OUT" == '{"result":{"emitted":false,"reason":"throttled"},"fullReadCalls":0}' ]]; then
  _pass "maybeEmitHeartbeat throttle decision uses the bounded tail alone (no full read), even though the original claim has scrolled out of it (F3, F8(ii))"
else
  _fail "maybeEmitHeartbeat did not take the bounded-only throttle path as expected: $H1_OUT"
fi

# H1B (F8(ii), #288 fix iteration 2): same shape as H1, but the in-tail heartbeat is old enough
# that the throttle window has elapsed — this is now an EMIT-time decision. The tail alone does
# NOT contain a `claim` event for the pair (only the heartbeat), so a bare heartbeat is no longer
# accepted as sufficient claim evidence on its own (that was the reviewer-reproduced orphan-
# heartbeat defect): exactly one full read must run to confirm the claim genuinely exists earlier
# in the true history, and only then does the heartbeat emit.
H1B_ROOT="$(new_scratch)"
build_large_liveness_stream "$H1B_ROOT" "h1b-subj" "agent-h1b" "2026-06-25T09:00:00.000Z" true "2026-06-25T11:55:00.000Z"
H1B_OUT="$(call_heartbeat_instrumented "$H1B_ROOT" '{"FLOW_AGENTS_ACTOR":"agent-h1b"}' "2026-06-25T12:00:00.000Z")"
if [[ "$H1B_OUT" == '{"result":{"emitted":true},"fullReadCalls":1}' ]]; then
  _pass "maybeEmitHeartbeat's EMIT decision pays exactly one full read to confirm claim evidence when only a heartbeat (no claim) is visible in the tail, and still emits once confirmed (F8(ii))"
else
  _fail "maybeEmitHeartbeat did not fall back to a confirming full read for the claim-out-of-tail emit case: $H1B_OUT"
fi

# H2: the pair is entirely ABSENT from the tail (claim only, no subsequent heartbeat for this
# pair, and the claim itself has scrolled out of the last 64KB) -> the bounded read alone finds
# nothing, so exactly one full read must run as a fallback (fullReadCalls === 1), and the result
# must still be correct (the full read finds the old claim and emits, since it is well past the
# throttle window).
H2_ROOT="$(new_scratch)"
build_large_liveness_stream "$H2_ROOT" "h2-subj" "agent-h2" "2026-06-25T09:00:00.000Z" false
H2_OUT="$(call_heartbeat_instrumented "$H2_ROOT" '{"FLOW_AGENTS_ACTOR":"agent-h2"}' "2026-06-25T12:00:00.000Z")"
if [[ "$H2_OUT" == '{"result":{"emitted":true},"fullReadCalls":1}' ]]; then
  _pass "maybeEmitHeartbeat falls back to exactly one full read when the pair is entirely absent from the bounded tail, and still emits correctly (F3)"
else
  _fail "maybeEmitHeartbeat did not fall back to a full read as expected: $H2_OUT"
fi

# H3 control: a SMALL stream (well under 64KB) behaves identically to before this change — the
# bounded tail read covers the whole file (including the claim event itself), so no fallback is
# ever needed (fullReadCalls === 0).
H3_ROOT="$(new_scratch)"
seed_claim "$H3_ROOT" "h3-subj" "agent-h3" "2026-06-25T09:00:00.000Z" 1800
H3_OUT="$(call_heartbeat_instrumented "$H3_ROOT" '{"FLOW_AGENTS_ACTOR":"agent-h3"}' "2026-06-25T12:00:00.000Z")"
if [[ "$H3_OUT" == '{"result":{"emitted":true},"fullReadCalls":0}' ]]; then
  _pass "maybeEmitHeartbeat never falls back to a full read for a small (< 64KB) stream (F3 regression control)"
else
  _fail "maybeEmitHeartbeat behaved unexpectedly for a small stream: $H3_OUT"
fi

# build_large_liveness_stream_release <root> <slug> <actor> <claim_at_iso> <release_at_iso>
# Like build_large_liveness_stream, but seeds a claim FOLLOWED (many filler lines later) by a
# release for the same pair, with >64KB of filler both before the claim, between claim and
# release, and after the release — so the pair is entirely absent from the bounded tail and a
# full-read fallback is required to discover it at all.
build_large_liveness_stream_release() {
  local root="$1" slug="$2" actor="$3" claim_at="$4" release_at="$5"
  local artifact_root="$root/.kontourai/flow-agents"
  mkdir -p "$artifact_root/liveness"
  seed_current_snapshot "$root" "$slug" "$actor"
  SLUG_ARG="$slug" ACTOR_ARG="$actor" CLAIM_AT_ARG="$claim_at" RELEASE_AT_ARG="$release_at"   STREAM_ARG="$artifact_root/liveness/events.jsonl" node - <<'NODE'
const fs = require('fs');
const filler = (i) =>
  JSON.stringify({
    type: 'heartbeat',
    subjectId: `filler-subj-${i}`,
    actor: `filler-actor-${i}`,
    at: '2020-01-01T00:00:00.000Z',
  });
const lines = [];
for (let i = 0; i < 900; i++) lines.push(filler(i));
lines.push(
  JSON.stringify({
    type: 'claim',
    subjectId: process.env.SLUG_ARG,
    actor: process.env.ACTOR_ARG,
    at: process.env.CLAIM_AT_ARG,
    ttlSeconds: 1800,
  })
);
for (let i = 900; i < 1800; i++) lines.push(filler(i));
lines.push(
  JSON.stringify({
    type: 'release',
    subjectId: process.env.SLUG_ARG,
    actor: process.env.ACTOR_ARG,
    at: process.env.RELEASE_AT_ARG,
  })
);
for (let i = 1800; i < 2700; i++) lines.push(filler(i));
fs.writeFileSync(process.env.STREAM_ARG, lines.join('\n') + '\n');
NODE
}

# H4 (F8(ii), #288 fix iteration 2): release-most-recent still refuses even when BOTH the claim
# and the release have scrolled out of the bounded tail entirely, forcing the full-read fallback
# to be the one that discovers the pair's history — the fallback must still honor "release wins",
# not treat the earlier claim as license to emit.
H4_ROOT="$(new_scratch)"
build_large_liveness_stream_release "$H4_ROOT" "h4-subj" "agent-h4" "2026-06-25T09:00:00.000Z" "2026-06-25T10:00:00.000Z"
H4_OUT="$(call_heartbeat_instrumented "$H4_ROOT" '{"FLOW_AGENTS_ACTOR":"agent-h4"}' "2026-06-25T12:00:00.000Z")"
if [[ "$H4_OUT" == '{"result":{"emitted":false,"reason":"released"},"fullReadCalls":1}' ]]; then
  _pass "maybeEmitHeartbeat's full-read fallback still refuses on a most-recent release, even when both claim and release are absent from the bounded tail (F8(ii))"
else
  _fail "maybeEmitHeartbeat did not honor a most-recent release discovered via the full-read fallback: $H4_OUT"
fi

# ─── I. Hostile active_slug never emits raw (F5, #288 fix iteration 1, sec-LOW) ─────
echo "--- I. Hostile active_slug sanitization (F5) ---"

I_ROOT="$(new_scratch)"
mkdir -p "$I_ROOT/.kontourai/flow-agents/liveness"
I_RAW_SLUG='evil;rm -rf /hb-subj'
I_SANITIZED_SLUG="$(ACTOR_MODULE_ARG="$ACTOR_MODULE" RAW_ARG="$I_RAW_SLUG" node - <<'NODE'
const { sanitizeSegment } = require(process.env.ACTOR_MODULE_ARG);
process.stdout.write(sanitizeSegment(process.env.RAW_ARG));
NODE
)"
# #440 FIXTURE-GAP: agent-hb-i owns this (hostile-slug-named) subject -- needs its own per-actor
# pointer. seed_current_snapshot writes the payload's active_slug verbatim (no pre-sanitization on
# the write side), preserving this scenario's whole point: sanitization happens at READ time.
seed_current_snapshot "$I_ROOT" "$I_RAW_SLUG" "agent-hb-i"
printf '{"type":"claim","subjectId":"%s","actor":"agent-hb-i","at":"2026-06-25T11:00:00.000Z","ttlSeconds":1800}\n' \
  "$I_SANITIZED_SLUG" >"$(stream_file "$I_ROOT")"
I_RESULT="$(call_heartbeat "$I_ROOT" '{"FLOW_AGENTS_ACTOR":"agent-hb-i"}' "2026-06-25T11:05:00.000Z")"
I_STREAM_CONTENT="$(cat "$(stream_file "$I_ROOT")" 2>/dev/null)"
if [[ "$I_RESULT" == '{"emitted":true}' ]] \
  && echo "$I_STREAM_CONTENT" | grep -qF "\"subjectId\":\"$I_SANITIZED_SLUG\"" \
  && ! echo "$I_STREAM_CONTENT" | grep -qF ';rm -rf'; then
  _pass "maybeEmitHeartbeat sanitizes a hostile active_slug (charset+cap, mirroring sanitizeSegment) before use — the emitted heartbeat's subjectId is never the raw hostile value (F5)"
else
  _fail "maybeEmitHeartbeat did not sanitize a hostile active_slug as expected: result=$I_RESULT sanitized=$I_SANITIZED_SLUG stream=$I_STREAM_CONTENT"
fi

# ─── J. Orphan-heartbeat invariant (F8, #288 fix iteration 2) ──────────────
echo "--- J. Orphan-heartbeat invariant (F8) ---"

# seed_heartbeat_only <scratch_root> <slug> <actor> <at_iso>
# Seeds a liveness stream containing ONLY a heartbeat event for (slug, actor) — no claim was
# ever recorded. Reproduces the reviewer-found defect precondition: a direct CLI
# `liveness heartbeat` with no prior claim writes exactly this shape.
seed_heartbeat_only() {
  local root="$1" slug="$2" actor="$3" at="$4"
  local artifact_root="$root/.kontourai/flow-agents"
  mkdir -p "$artifact_root/liveness"
  seed_current_snapshot "$root" "$slug" "$actor"
  printf '{"type":"heartbeat","subjectId":"%s","actor":"%s","at":"%s"}\n' \
    "$slug" "$actor" "$at" >"$artifact_root/liveness/events.jsonl"
}

# J1: an orphan heartbeat (no claim ever recorded for the pair), old enough to be past the
# throttle window, must resolve to no-claim — NOT be mistaken for its own claim evidence (the
# exact defect reproduced by the reviewer: "maybeEmitHeartbeat's bounded-tail path then treats it
# as claim evidence and perpetuates a phantom holder"). The tail alone has no `claim` event for
# the pair, so exactly one full read runs to confirm — and still finds none.
J1_ROOT="$(new_scratch)"
seed_heartbeat_only "$J1_ROOT" "j1-subj" "agent-j1" "2026-06-25T09:00:00.000Z"
J1_OUT="$(call_heartbeat_instrumented "$J1_ROOT" '{"FLOW_AGENTS_ACTOR":"agent-j1"}' "2026-06-25T12:00:00.000Z")"
if [[ "$J1_OUT" == '{"result":{"emitted":false,"reason":"no-claim"},"fullReadCalls":1}' ]]; then
  _pass "maybeEmitHeartbeat treats a pre-existing orphan heartbeat (no claim ever recorded) as no-claim, neutralizing a phantom holder instead of perpetuating it (F8(ii))"
else
  _fail "maybeEmitHeartbeat did not neutralize an orphan heartbeat as expected: $J1_OUT"
fi

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "Liveness heartbeat integration passed."
  exit 0
fi

echo "Liveness heartbeat integration failed: $errors issue(s)."
exit 1
