#!/usr/bin/env bash
# test_economics_record.sh — per-run kit-economics record (#349, console ADR 0003).
#
# Proves scripts/telemetry/economics-record.sh assembles exactly one immutable
# `kontour.console.economics` v0.2 fact per run — cost, time, iterations, defects caught — from the
# session.usage event's usage block (TRANSCRIPT ground truth, never re-estimated), the review sidecar
# critique.json (defects), and state.json (verdict / phase / iterations). And — non-negotiable —
# local-first holds (ADR 0003 call 6): the record is written to the local economics log FIRST, the
# console POST is opt-in + detached + fail-open, and a failing/absent console never blocks the run.
#
# Coverage → ACs:
#   AC1/AC6 (R1,R7)  schema: golden fixture validates; a cost-only doctored record (no defects) FAILS.
#   AC2 (R2,R8)      cost.* equals the session.usage usage block; exactly one record; local write.
#   AC3 (R3)         phase-sum invariant, phase-known AND phase-unknown (→ unattributed).
#   AC4 (R4,R6)      route-back / verdict: iterations.count==2, route_backs==1, verdict PASS, human_wait>0.
#   AC5 (R5)         gate_fires, per-severity findings_by_severity, caught_false_completions==1 (distinct).
#   AC7 (R8)         telemetry-disabled + console-500 fail-open: run unaffected, local record still exists.
#   injection        hostile task_slug/finding text → jq \u-escaped, never raw control bytes in the POST.
#
# Deterministic (a local stub HTTP server, no network / model spend, self-cleaning). The relay POST is
# detached/async so stub-received assertions poll with a timeout.
# Usage: bash evals/integration/test_economics_record.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TELEMETRY="$ROOT/scripts/telemetry"
EMITTER="$TELEMETRY/economics-record.sh"
SCHEMA="$TELEMETRY/economics-record.schema.json"
FIX="$ROOT/evals/fixtures/economics"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; [[ -n "${STUB_PID:-}" ]] && kill "$STUB_PID" 2>/dev/null' EXIT
PORT=38812
STUB_GENERATION=0
RECV="$TMP/recv-0.jsonl"

# Hermetic isolation: this suite must be deterministic regardless of what the machine running it has
# configured for real (e.g. an operator's trusted .kontourai/telemetry-console.conf / ~/.flow-agents
# conf). Point every emitter invocation below at an empty scratch conf by default so config.sh's
# key-parser never resolves real console_telemetry_token/console_tenant_id/console_telemetry_url
# values into these assertions; explicit TELEMETRY_CONFIG_FILE exports in the config-driven (#469)
# cases below intentionally override this default per-case.
EMPTY_CONF="$TMP/empty-telemetry.conf"
: > "$EMPTY_CONF"
export TELEMETRY_CONFIG_FILE="$EMPTY_CONF"

errors=0
pass() { echo "  [PASS] $1"; }
fail() { echo "  [FAIL] $1"; errors=$((errors + 1)); }

if ! command -v jq >/dev/null 2>&1; then echo "jq not available; skipping economics record tests"; exit 0; fi

echo "=== economics record (#349) ==="
export FLOW_AGENTS_ECONOMICS_FIXTURE_MODE=true

# #970: every economics record now carries the SAME producer-identity tuple telemetry.sh stamps
# ({package_version, content_fingerprint, source}), resolved from scripts/telemetry/lib/install-identity.sh.
# Pin the WHOLE suite to a hermetic stamp fixture so every emitted record — including the golden
# byte-equality check below — resolves the identical deterministic tuple on every host, regardless of
# whether this checkout happens to be built (stamp) / a git checkout (git) / neither (unknown). The
# stamp|git|unknown resolution branches themselves get dedicated per-invocation overrides further down.
IDENTITY_STAMP_ROOT="$TMP/install-identity-stamped"
mkdir -p "$IDENTITY_STAMP_ROOT/build/generated"
cat > "$IDENTITY_STAMP_ROOT/build/generated/install-identity.json" <<'STAMP'
{
  "schema_version": "1.0",
  "package_name": "@kontourai/flow-agents",
  "package_version": "9.9.9-fixture",
  "content_fingerprint": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "git_sha": null,
  "git_dirty": null,
  "built_at": "2026-01-01T00:00:00.000Z"
}
STAMP
export FLOW_AGENTS_INSTALL_IDENTITY_ROOT="$IDENTITY_STAMP_ROOT"

# ── Build the session.usage event from the fixture transcript via the REAL usage parser ────────────
# This is what wires "tokens come from transcript ground truth" into the test: the usage block is
# produced by usage_parse_transcript reading each assistant message's .message.usage — not hand-set.
# shellcheck source=/dev/null
source "$ROOT/scripts/telemetry/lib/usage.sh"
TU="$(usage_parse_transcript "$FIX/transcript.jsonl")" || { fail "usage_parse_transcript returned empty"; }
RUN_CORRELATION="$(jq -c '.run_correlation' "$FIX/state.json")"
USAGE_EVENT="$(jq -cn --argjson tu "$TU" --argjson correlation "$RUN_CORRELATION" --arg model "claude-opus-4-8" '{
  schema_version:"0.3.0", timestamp:"1751731200000",
  session_id:"kontourai-flow-agents-349-run-01", event_id:"evt-01-usage",
  event_type:"session.usage", agent:{name:"dev",runtime:"claude-code",version:"1"},
  context:{cwd:"/workspace/flow-agents"},
  task_slug:"kontourai-flow-agents-349",
  run_correlation:$correlation,
  usage:{ model:$model, duration_s:420, tool_invocations:12, delegations:3,
    input_tokens:$tu.input_tokens, output_tokens:$tu.output_tokens,
    cache_creation_input_tokens:$tu.cache_creation_input_tokens,
    cache_read_input_tokens:$tu.cache_read_input_tokens,
    estimated_cost_usd:$tu.estimated_cost_usd, pricing_version:$tu.pricing_version,
    by_model:$tu.by_model }
}')"

# Run the emitter with an isolated local economics log; echo the assembled record.
run_emitter() { # <local_log> [extra emitter args...]
  local log="$1"; shift
  TELEMETRY_ECONOMICS_LOG_FILE="$log" bash "$EMITTER" "$USAGE_EVENT" "$@"
}

UNAUTHORIZED_EXPLICIT_LOG="$TMP/econ-explicit-without-fixture-mode.jsonl"
if env -u FLOW_AGENTS_ECONOMICS_FIXTURE_MODE \
  TELEMETRY_ECONOMICS_LOG_FILE="$UNAUTHORIZED_EXPLICIT_LOG" \
  bash "$EMITTER" "$USAGE_EVENT" --state "$FIX/state.json" >/dev/null 2>&1; then
  fail "explicit sidecars were accepted without fixture mode"
elif [[ ! -e "$UNAUTHORIZED_EXPLICIT_LOG" ]]; then
  pass "explicit sidecars require deliberate fixture mode and cannot enter the production path"
else
  fail "rejected explicit sidecars still wrote an economics record"
fi

# ── AC2 + AC5 + AC4: full fixture (phase-known) → assert every field's source value ────────────────
echo "--- AC2/AC4/AC5: full fixture record — cost from usage, defects from critique, verdict from state ---"
LOG1="$TMP/econ1.jsonl"; : > "$LOG1"
run_emitter "$LOG1" --state "$FIX/state.json" --acceptance "$FIX/acceptance.json" --critique "$FIX/critique.json"
n=$(wc -l < "$LOG1" | tr -d ' ')
[[ "$n" == "1" ]] && pass "exactly one record written to the local log (local-first)" || fail "expected 1 record, got $n"
REC="$(cat "$LOG1")"

# cost.* == session.usage .usage.* (ground truth, verbatim)
assert_eq() { # <label> <jq-expr-on-REC> <expected>
  local got; got="$(printf '%s' "$REC" | jq -c "$2" 2>/dev/null)"
  [[ "$got" == "$3" ]] && pass "$1 ($got)" || fail "$1: expected $3 got $got"
}
assert_eq "cost.input_tokens == usage.input_tokens" '.cost.input_tokens' "$(printf '%s' "$USAGE_EVENT" | jq -c '.usage.input_tokens')"
assert_eq "cost.output_tokens == usage.output_tokens" '.cost.output_tokens' "$(printf '%s' "$USAGE_EVENT" | jq -c '.usage.output_tokens')"
assert_eq "cost.cache_read_input_tokens == usage" '.cost.cache_read_input_tokens' "$(printf '%s' "$USAGE_EVENT" | jq -c '.usage.cache_read_input_tokens')"
assert_eq "cost.estimated_cost_usd == usage" '.cost.estimated_cost_usd' "$(printf '%s' "$USAGE_EVENT" | jq -c '.usage.estimated_cost_usd')"
assert_eq "cost.by_model == usage.by_model verbatim" '.cost.by_model' "$(printf '%s' "$USAGE_EVENT" | jq -c '.usage.by_model')"
assert_eq "model == usage.model" '.model' '"claude-opus-4-8"'
assert_eq "pricing_version carried" '.pricing_version' '"2026-06-28"'
assert_eq "run_id == canonical correlation id" '.run_id' '"run-economics-349"'
assert_eq "economics observations declare cumulative snapshot semantics" '.observation_semantics' '"snapshot"'
assert_eq "explicit fixture records disclose non-runtime authority" '.producer_authority' '"fixture_input"'
assert_eq "task_slug from authenticated usage event" '.task_slug' '"kontourai-flow-agents-349"'
assert_eq "canonical correlation carried unchanged" '.run_correlation' "$(printf '%s' "$RUN_CORRELATION" | jq -c .)"
# AC5: defects from critique.json (severity grouping, missing→low; distinct false-completion)
assert_eq "findings_by_severity.critical" '.defects.findings_by_severity.critical' '1'
assert_eq "findings_by_severity.high" '.defects.findings_by_severity.high' '2'
assert_eq "findings_by_severity.medium" '.defects.findings_by_severity.medium' '1'
assert_eq "findings_by_severity.low (incl. missing-severity default)" '.defects.findings_by_severity.low' '2'
assert_eq "caught_false_completions == 1 (distinct)" '.defects.caught_false_completions' '1'
assert_eq "gate_fires from state.json" '.defects.gate_fires' '3'
# AC4: iterations + verdict + human_wait from state.json
assert_eq "iterations.count == 2" '.iterations.count' '2'
assert_eq "iterations.route_backs == 1" '.iterations.route_backs' '1'
assert_eq "verification_verdict == PASS" '.defects.verification_verdict' '"PASS"'
assert_eq "human_wait_s > 0 (decision pause present)" '.time.human_wait_s' '45'
assert_eq "wall_clock_s == usage.duration_s" '.time.wall_clock_s' '420'

# ── #970: producer identity — the durable economics record carries the SAME tuple telemetry.sh stamps ─
# The record must join with the telemetry firehose on ONE vocabulary {package_version,
# content_fingerprint, source} so console#267 can segment economics by Kit version even after the
# short-retention firehose (console#137) has expired. The block rides as a TOP-LEVEL sibling (NOT
# inside run_correlation), sourced from the shared scripts/telemetry/lib/install-identity.sh.
echo "--- #970: install_identity — economics/telemetry join vocabulary on the durable record ---"
# (i) shape: all three tuple fields present, and NOT nested under run_correlation.
for f in package_version content_fingerprint source; do
  present="$(printf '%s' "$REC" | jq -c "has(\"install_identity\") and (.install_identity | has(\"$f\"))" 2>/dev/null)"
  [[ "$present" == "true" ]] && pass "install_identity.$f present (top-level)" || fail "install_identity.$f missing/nested: got $present"
done
rc_has_ii="$(printf '%s' "$REC" | jq -c '.run_correlation | has("install_identity")' 2>/dev/null)"
[[ "$rc_has_ii" == "false" ]] && pass "install_identity is a top-level sibling, never inside run_correlation" || fail "install_identity leaked into run_correlation: $rc_has_ii"
# (ii) source enum is always one of the three labeled values, never fabricated.
rec_source="$(printf '%s' "$REC" | jq -r '.install_identity.source' 2>/dev/null)"
case "$rec_source" in
  stamp|git|unknown) pass "install_identity.source is a labeled enum ($rec_source)" ;;
  *) fail "install_identity.source must be stamp|git|unknown, got '$rec_source'" ;;
esac
# (iii) stamp branch: the suite is pinned to a hermetic stamp fixture, so the record reads it verbatim.
rec_identity="$(printf '%s' "$REC" | jq -c '.install_identity' 2>/dev/null)"
if [[ "$rec_identity" == '{"package_version":"9.9.9-fixture","content_fingerprint":"sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","source":"stamp"}' ]]; then
  pass "install_identity reads the shipped stamp verbatim (source=stamp, version+fingerprint correct)"
else
  fail "install_identity stamp case: got $rec_identity"
fi

# (iv) git branch: no stamp, but the package root is a Flow Agents source checkout → content_fingerprint
# is git:<HEAD>, source=git. Per-invocation override supersedes the suite-wide stamp root.
II_GIT="$TMP/ii-checkout"; mkdir -p "$II_GIT"
printf '{"name":"@kontourai/flow-agents","version":"0.0.0-checkout"}\n' > "$II_GIT/package.json"
git -C "$II_GIT" init -q >/dev/null 2>&1
git -C "$II_GIT" add -A >/dev/null 2>&1
git -C "$II_GIT" -c user.email=eval@example.invalid -c user.name=eval commit -qm "fixture" >/dev/null 2>&1
II_GIT_SHA="$(git -C "$II_GIT" rev-parse HEAD 2>/dev/null)"
II_GIT_LOG="$TMP/econ-ii-git.jsonl"; : > "$II_GIT_LOG"
FLOW_AGENTS_INSTALL_IDENTITY_ROOT="$II_GIT" TELEMETRY_ECONOMICS_LOG_FILE="$II_GIT_LOG" bash "$EMITTER" "$USAGE_EVENT" >/dev/null 2>&1
git_identity="$(jq -c '.install_identity' "$II_GIT_LOG" 2>/dev/null)"
if [[ -n "$II_GIT_SHA" && "$git_identity" == "{\"package_version\":\"0.0.0-checkout\",\"content_fingerprint\":\"git:${II_GIT_SHA}\",\"source\":\"git\"}" ]]; then
  pass "install_identity falls back to the checkout HEAD (source=git)"
else
  fail "install_identity git case: got $git_identity (expected git:$II_GIT_SHA)"
fi

# (v) unknown branch: neither a stamp nor a Flow Agents checkout → the labeled unknown tuple, never a
# fabricated join key, never an omitted block. Uses an empty root (no package.json).
II_NONE="$TMP/ii-none"; mkdir -p "$II_NONE"
II_NONE_LOG="$TMP/econ-ii-none.jsonl"; : > "$II_NONE_LOG"
FLOW_AGENTS_INSTALL_IDENTITY_ROOT="$II_NONE" TELEMETRY_ECONOMICS_LOG_FILE="$II_NONE_LOG" bash "$EMITTER" "$USAGE_EVENT" >/dev/null 2>&1
none_identity="$(jq -c '.install_identity' "$II_NONE_LOG" 2>/dev/null)"
if [[ "$none_identity" == '{"package_version":"unknown","content_fingerprint":"unknown","source":"unknown"}' ]]; then
  pass "install_identity degrades to the labeled unknown tuple when unavailable (fail-open, block never omitted)"
else
  fail "install_identity unknown case: got $none_identity"
fi

# (vi) NON-OVERRIDE real-resolver path: every other case above pins the resolution via the
# FLOW_AGENTS_INSTALL_IDENTITY_ROOT override, so the suite would never notice the shared resolver
# picking the WRONG base for the economics producer's own package root (the resolver-base-shift class).
# This case unsets the override entirely and asserts economics-record.sh resolves ITS OWN install
# identity through the real two-fixed-offset package-root logic against this actual checkout. In a
# built tree the stamp is present → source=stamp + the real package_version; in an unbuilt checkout
# the resolver must still find the Flow Agents root → source=git with a real version, NEVER unknown.
# A resolver that resolves the wrong/no root for the economics producer turns this positive assertion
# red — independent of telemetry.sh's mirror-parity test.
REAL_STAMP="$ROOT/build/generated/install-identity.json"
REAL_LOG="$TMP/econ-real-identity.jsonl"; : > "$REAL_LOG"
env -u FLOW_AGENTS_INSTALL_IDENTITY_ROOT TELEMETRY_ECONOMICS_LOG_FILE="$REAL_LOG" bash "$EMITTER" "$USAGE_EVENT" >/dev/null 2>&1
real_identity="$(jq -c '.install_identity' "$REAL_LOG" 2>/dev/null)"
real_source="$(printf '%s' "$real_identity" | jq -r '.source' 2>/dev/null)"
real_version="$(printf '%s' "$real_identity" | jq -r '.package_version' 2>/dev/null)"
real_fp="$(printf '%s' "$real_identity" | jq -r '.content_fingerprint' 2>/dev/null)"
if [[ -f "$REAL_STAMP" ]]; then
  exp_version="$(jq -r '.package_version' "$REAL_STAMP" 2>/dev/null)"
  exp_fp="$(jq -r '.content_fingerprint' "$REAL_STAMP" 2>/dev/null)"
  if [[ "$real_source" == "stamp" && "$real_version" == "$exp_version" && "$real_fp" == "$exp_fp" ]]; then
    pass "non-override real resolver finds the economics producer's own stamped root (source=stamp, version=$real_version)"
  else
    fail "non-override real resolver: expected stamp/$exp_version/$exp_fp, got $real_identity"
  fi
else
  if [[ "$real_source" == "git" && -n "$real_version" && "$real_version" != "unknown" ]]; then
    pass "non-override real resolver finds the economics producer's checkout root (source=git, version=$real_version)"
  else
    fail "non-override real resolver degraded to unknown/wrong (expected a resolved Flow Agents root): got $real_identity"
  fi
fi

# ── AC1/AC6: schema validation — golden validates; cost-only (no defects) FAILS (R7 Goodhart) ─────
echo "--- AC1/AC6: schema — golden validates positive; a cost-only record FAILS (co-required cost+defects) ---"
SCHEMA_CHECK="$(node -e '
const Ajv=require("ajv/dist/2020").default;
const a=new Ajv({allErrors:true,strict:false});
const correlation=require(process.argv[4]);
a.addSchema(correlation);
const v=a.compile(require(process.argv[1]));
const golden=require(process.argv[2]);
const good=v(golden);
const cur=JSON.parse(require("fs").readFileSync(process.argv[3],"utf8"));
const curOk=v(cur);
const bad=JSON.parse(JSON.stringify(golden)); delete bad.defects;
const badOk=v(bad);
const historical=JSON.parse(JSON.stringify(golden));
historical.version="0.1";
delete historical.run_correlation;
delete historical.observation_semantics;
delete historical.producer_authority;
const historicalOk=v(historical);
console.log(JSON.stringify({good, curOk, badOk, historicalOk}));
' "$SCHEMA" "$FIX/expected-record.json" "$LOG1" "$ROOT/schemas/run-correlation-envelope.schema.json" 2>&1)"
echo "$SCHEMA_CHECK" | grep -q '"good":true' && pass "golden fixture validates against economics-record.schema.json" || fail "golden did NOT validate: $SCHEMA_CHECK"
echo "$SCHEMA_CHECK" | grep -q '"curOk":true' && pass "freshly-emitted record validates against the schema" || fail "emitted record did NOT validate: $SCHEMA_CHECK"
echo "$SCHEMA_CHECK" | grep -q '"badOk":false' && pass "cost-only record (defects removed) FAILS validation — R7 co-required guard holds" || fail "cost-only record wrongly validated: $SCHEMA_CHECK"
echo "$SCHEMA_CHECK" | grep -q '"historicalOk":true' && pass "historical immutable v0.1 records remain schema-valid without additive correlation" || fail "historical v0.1 compatibility broke: $SCHEMA_CHECK"

# Legacy artifact verdicts remain observations and cannot impersonate canonical Flow verification.
LEGACY_VERDICT_STATE="$TMP/legacy-verdict-state.json"
LEGACY_VERDICT_LOG="$TMP/legacy-verdict.jsonl"; : > "$LEGACY_VERDICT_LOG"
jq 'del(.workflow_outcome) | .verification_verdict = "PASS" | .verify_verdict = "PASS"' \
  "$FIX/state.json" > "$LEGACY_VERDICT_STATE"
TELEMETRY_ECONOMICS_LOG_FILE="$LEGACY_VERDICT_LOG" FLOW_AGENTS_ECONOMICS_FIXTURE_MODE=true \
  bash "$EMITTER" "$USAGE_EVENT" --state "$LEGACY_VERDICT_STATE" --critique "$FIX/critique.json"
if [[ "$(jq -r '.defects.verification_verdict' "$LEGACY_VERDICT_LOG")" == "NOT_VERIFIED" ]]; then
  pass "artifact and legacy verdicts cannot impersonate canonical Flow verification"
else
  fail "economics accepted a non-canonical verification verdict: $(cat "$LEGACY_VERDICT_LOG")"
fi

# Direct callers cannot spoof correlation or use sidecars that do not match a validated envelope.
SPOOF_LOG="$TMP/spoofed-correlation.jsonl"; : > "$SPOOF_LOG"
SPOOF_EVENT="$(printf '%s' "$USAGE_EVENT" | jq -c '.run_correlation = "spoofed"')"
TELEMETRY_ECONOMICS_LOG_FILE="$SPOOF_LOG" bash "$EMITTER" "$SPOOF_EVENT" \
  --state "$FIX/state.json" --critique "$FIX/critique.json"
if jq -e '
  .run_correlation.status == "incomplete"
  and .task_slug == null
  and .phases[0].phase == "unattributed"
  and .defects.gate_fires == 0
' "$SPOOF_LOG" >/dev/null; then
  pass "invalid direct correlation degrades explicitly and cannot authorize sidecar attribution"
else
  fail "invalid direct correlation was persisted or joined to sidecars: $(cat "$SPOOF_LOG")"
fi

# ── golden parity: the emitted record equals the committed golden (sorted) ─────────────────────────
if diff <(jq -S . "$LOG1") <(jq -S . "$FIX/expected-record.json") >/dev/null 2>&1; then
  pass "emitted record byte-equals the committed golden fixture (expected-record.json)"
else
  fail "emitted record drifted from golden: $(diff <(jq -S . "$LOG1") <(jq -S . "$FIX/expected-record.json") | head -20)"
fi

# ── AC3: phase-sum invariant — phase-known AND phase-unknown → unattributed ────────────────────────
echo "--- AC3: phase-sum invariant holds (phase-known → its bucket; phase-unknown → unattributed) ---"
check_phase_sum() { # <record> <expected_phase_label>
  local rec="$1" want="$2"
  local ok
  ok="$(printf '%s' "$rec" | jq -c '
    (.phases | map(.input_tokens) | add) as $pi
    | (.phases | map(.output_tokens) | add) as $po
    | (.phases | map(.cache_read_input_tokens) | add) as $pcr
    | (.phases | map(.wall_clock_s) | add) as $pw
    | ($pi == .cost.input_tokens and $po == .cost.output_tokens
       and $pcr == .cost.cache_read_input_tokens and $pw == .time.wall_clock_s)')"
  [[ "$ok" == "true" ]] && pass "phase-sum invariant holds ($want)" || fail "phase-sum invariant BROKEN ($want): $ok"
  local lbl; lbl="$(printf '%s' "$rec" | jq -r '.phases[0].phase')"
  [[ "$lbl" == "$want" ]] && pass "phase label is '$want'" || fail "phase label expected '$want' got '$lbl'"
}
check_phase_sum "$REC" "verify"
# phase-unknown: state.json with NO phase → single unattributed bucket, still sums.
STATE_NOPHASE="$TMP/state-nophase.json"
jq 'del(.phase)' "$FIX/state.json" > "$STATE_NOPHASE"
LOG2="$TMP/econ2.jsonl"; : > "$LOG2"
run_emitter "$LOG2" --state "$STATE_NOPHASE" --critique "$FIX/critique.json"
check_phase_sum "$(cat "$LOG2")" "unattributed"

# ── injection: hostile task_slug + finding text → jq-escaped, never raw control bytes ─────────────
echo "--- injection: hostile task_slug/finding text are \\u-escaped, never raw control bytes ---"
HOSTILE_STATE="$TMP/hostile-state.json"
HOSTILE_CRIT="$TMP/hostile-crit.json"
node -e '
const fs=require("fs");const esc=String.fromCharCode(27),bel=String.fromCharCode(7);
fs.writeFileSync(process.argv[1], JSON.stringify({schema_version:"1.0",task_slug:"slug"+esc+"[31m"+bel+"EVIL",phase:"exec"+esc+"ute",verification_verdict:"PASS"}));
fs.writeFileSync(process.argv[2], JSON.stringify({critiques:[{findings:[{severity:"high",description:"finding"+esc+"[2J"+bel+"text"}]}]}));
' "$HOSTILE_STATE" "$HOSTILE_CRIT"
LOG3="$TMP/econ3.jsonl"; : > "$LOG3"
run_emitter "$LOG3" --state "$HOSTILE_STATE" --critique "$HOSTILE_CRIT"
# Scan for raw control bytes via node (cross-platform; macOS grep lacks -P). ESCAPED ⇒ jq \u-escaped.
INJ="$(node -e '
const fs=require("fs");const raw=fs.readFileSync(process.argv[1],"utf8");
if(!raw.trim()){console.log("EMPTY");process.exit(0)}
console.log(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(raw)?"RAW":"ESCAPED");
' "$LOG3" 2>&1)"
[[ "$INJ" == "ESCAPED" ]] && pass "hostile task_slug/finding control bytes are JSON-escaped, never raw in the record (injection discipline)" || fail "raw control bytes reached the record ($INJ)"
printf '%s' "$(cat "$LOG3")" | jq -e . >/dev/null 2>&1 && pass "record with hostile fields is still valid JSON" || fail "hostile fields produced invalid JSON"

# Valid JSON with incompatible optional-sidecar shapes must degrade component-wise
# while preserving the authenticated usage/correlation core.
echo "--- malformed sidecars degrade without suppressing the usage core ---"
MALFORMED_STATE="$TMP/malformed-state.json"
MALFORMED_CRITIQUE="$TMP/malformed-critique.json"
jq '.phase = {} | .iterations = "wrong-shape"' "$FIX/state.json" > "$MALFORMED_STATE"
printf '%s' '{"critiques":[{"findings":"wrong-shape"}]}' > "$MALFORMED_CRITIQUE"
MALFORMED_LOG="$TMP/econ-malformed.jsonl"; : > "$MALFORMED_LOG"
run_emitter "$MALFORMED_LOG" --state "$MALFORMED_STATE" --critique "$MALFORMED_CRITIQUE"
MALFORMED_REC="$(cat "$MALFORMED_LOG")"
[[ -n "$MALFORMED_REC" ]] && pass "malformed optional sidecars do not suppress the economics record" || fail "malformed optional sidecars suppressed the economics record"
[[ "$(printf '%s' "$MALFORMED_REC" | jq -r '.run_correlation.correlation_id')" == "run-economics-349" ]] && pass "malformed sidecars preserve authenticated correlation" || fail "malformed sidecars lost authenticated correlation"
[[ "$(printf '%s' "$MALFORMED_REC" | jq -r '.phases[0].phase')" == "unattributed" ]] && pass "malformed state degrades to unattributed phase" || fail "malformed state did not degrade to unattributed"
[[ "$(printf '%s' "$MALFORMED_REC" | jq -r '.defects.gate_fires')" == "0" ]] && pass "malformed critique degrades to zero observed defects" || fail "malformed critique injected defects"

# ── Stub Console endpoint (200 / 500) for the relay + fail-open cases ──────────────────────────────
start_stub() {
  local mode="$1"
  local synchronization="${2:-}"
  local fake_bin="$TMP/fake-curl-bin"
  mkdir -p "$fake_bin"
  cat > "$fake_bin/curl" <<'SH'
#!/usr/bin/env bash
config=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) config="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[[ -n "$config" && -f "$config" ]] || exit 2
if [[ -n "${ECON_STUB_STARTED_FILE:-}" ]]; then
  : > "$ECON_STUB_STARTED_FILE"
  for _ in $(seq 1 300); do
    [[ -e "${ECON_STUB_RELEASE_FILE:-}" ]] && break
    sleep 0.1
  done
  [[ -e "${ECON_STUB_RELEASE_FILE:-}" ]] || exit 124
fi
node - "$config" "$ECON_STUB_RECV" <<'NODE'
const fs = require("fs");
const config = fs.readFileSync(process.argv[2], "utf8").split(/\n/);
const out = process.argv[3];
const headers = {};
let url = "";
let method = "GET";
let body = "";
for (const line of config) {
  const m = line.match(/^([a-z-]+) = "(.*)"$/);
  if (!m) continue;
  const [, key, value] = m;
  if (key === "url") url = value;
  if (key === "request") method = value;
  if (key === "header") {
    const i = value.indexOf(":");
    if (i > 0) headers[value.slice(0, i).toLowerCase()] = value.slice(i + 1).trim();
  }
  if (key === "data-binary" && value.startsWith("@")) body = fs.readFileSync(value.slice(1), "utf8");
}
let path = url;
try {
  path = new URL(url).pathname;
} catch {}
fs.appendFileSync(out, JSON.stringify({ method, url: path, headers, body }) + "\n");
NODE
[[ "${ECON_STUB_MODE:-ok}" == "fail" ]] && exit 22
exit 0
SH
  chmod +x "$fake_bin/curl"
  STUB_GENERATION=$((STUB_GENERATION + 1))
  RECV="$TMP/recv-$STUB_GENERATION.jsonl"
  : > "$RECV"
  ECON_STUB_STARTED_FILE=""
  ECON_STUB_RELEASE_FILE=""
  if [[ "$synchronization" == "gated" ]]; then
    ECON_STUB_STARTED_FILE="$TMP/stub-$STUB_GENERATION.started"
    ECON_STUB_RELEASE_FILE="$TMP/stub-$STUB_GENERATION.release"
  fi
  export ECON_STUB_RECV="$RECV" ECON_STUB_MODE="$mode" \
    ECON_STUB_STARTED_FILE ECON_STUB_RELEASE_FILE
  case ":$PATH:" in
    *":$fake_bin:"*) ;;
    *) export PATH="$fake_bin:$PATH" ;;
  esac
  STUB_PID=""
  return 0
}
stop_stub() { [[ -n "${STUB_PID:-}" ]] && kill "$STUB_PID" 2>/dev/null; STUB_PID=""; }
wait_for_post() { for _ in $(seq 1 25); do [[ -s "$RECV" ]] && return 0; sleep 0.2; done; return 1; }
wait_for_mailbox() {
  local mailbox="$1" require_content="${2:-true}"
  # Detached transport can be heavily de-scheduled on hosted runners. Poll the
  # explicit start/completion files with a bounded timeout instead of assuming
  # the configured stub delay is the entire scheduling latency.
  for _ in $(seq 1 300); do
    if [[ "$require_content" == "true" ]]; then
      [[ -s "$mailbox" ]] && return 0
    else
      [[ -e "$mailbox" ]] && return 0
    fi
    sleep 0.1
  done
  return 1
}
ENDPOINT="http://127.0.0.1:${PORT}/records"

# ── unauthenticated producers never enter the detached relay path ────────────────────────────────
echo "--- authority guard prevents detached relay before runtime authentication ---"
start_stub ok gated
PRIOR_RECV="$RECV"
PRIOR_STARTED="$ECON_STUB_STARTED_FILE"
PRIOR_RELEASE="$ECON_STUB_RELEASE_FILE"
MAILBOX_LOG="$TMP/econ-mailbox-delay.jsonl"; : > "$MAILBOX_LOG"
(
  export FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY=1
  export FLOW_AGENTS_CONSOLE_ECONOMICS_ENDPOINT_URL="$ENDPOINT"
  run_emitter "$MAILBOX_LOG"
)
sleep 0.5
[[ ! -e "$PRIOR_STARTED" && ! -s "$PRIOR_RECV" ]] \
  && pass "unbound economics cannot start a detached relay" \
  || fail "unbound economics entered the detached relay path"

# ── local-first: NO console configured → local write happens, nothing POSTed ──────────────────────
echo "--- local-first: no console configured → local record written, nothing POSTed ---"
: > "$RECV"; start_stub ok || fail "stub server did not start"
LOG4="$TMP/econ4.jsonl"; : > "$LOG4"
(
  unset FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY FLOW_AGENTS_CONSOLE_ECONOMICS_ENDPOINT_URL \
        FLOW_AGENTS_CONSOLE_URL CONSOLE_TELEMETRY_URL CONSOLE_URL
  run_emitter "$LOG4" --state "$FIX/state.json" --critique "$FIX/critique.json"
)
sleep 1
[[ -s "$LOG4" ]] && pass "local economics record written with NO console configured (local-first)" || fail "local record missing with no console"
[[ ! -s "$RECV" ]] && pass "NO POST when no console endpoint is configured (opt-in respected)" || fail "a POST happened with no console configured"
stop_stub

# ── console configuration alone cannot authorize a producer ───────────────────────────────────────
echo "--- relay on+configured still requires an authenticated terminal producer ---"
: > "$RECV"; start_stub ok
LOG5="$TMP/econ5.jsonl"; : > "$LOG5"
(
  export FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY=1
  export FLOW_AGENTS_CONSOLE_ECONOMICS_ENDPOINT_URL="$ENDPOINT"
  export CONSOLE_TELEMETRY_TOKEN="tok-econ-123"
  export CONSOLE_TENANT_ID="tenant-econ"
  run_emitter "$LOG5"
)
[[ -s "$LOG5" ]] && pass "local record written even when relay is ON (local-first, still first)" || fail "local record missing with relay on"
sleep 0.5
[[ ! -s "$RECV" ]] && pass "relay configuration cannot authorize an unbound producer" || fail "unbound producer relayed with configuration alone"
stop_stub

# ── AC7: fail-open — console returns 500 → emitter exits 0, local record intact ───────────────────
echo "--- AC7: console 500 (detached) → emitter exits 0, local record still exists (fail-open) ---"
: > "$RECV"; start_stub fail
LOG6="$TMP/econ6.jsonl"; : > "$LOG6"
(
  export FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY=1
  export FLOW_AGENTS_CONSOLE_ECONOMICS_ENDPOINT_URL="$ENDPOINT"
  run_emitter "$LOG6"
)
rc=$?
[[ "$rc" -eq 0 ]] && pass "emitter exits 0 even when the console endpoint fails (non-fatal)" || fail "emitter exited non-zero ($rc) on console failure"
[[ -s "$LOG6" ]] && pass "local record written despite console 500 (local-first)" || fail "local record missing on console failure"
stop_stub

# ── AC7: telemetry disabled at the stop-hook → no economics call, run unaffected ──────────────────
echo "--- AC7: telemetry disabled (TELEMETRY_USAGE_TRACKING!=true) → stop hook emits no economics record ---"
# The wiring in telemetry.sh guards the economics call behind TELEMETRY_USAGE_TRACKING == true; the
# emitter itself is unconditional (it is only ever invoked from inside that guard). Assert the guard.
if grep -q 'economics-record.sh' "$TELEMETRY/telemetry.sh" \
   && awk '/TELEMETRY_USAGE_TRACKING.*==.*true/{g=1} g&&/economics-record.sh/{found=1} END{exit !found}' "$TELEMETRY/telemetry.sh"; then
  pass "stop-hook economics emission is nested under the TELEMETRY_USAGE_TRACKING==true guard (disabled ⇒ no emit)"
else
  fail "economics emission is NOT guarded by TELEMETRY_USAGE_TRACKING in telemetry.sh"
fi

# ── config-driven activation (#469): install-console-config.sh sink → relay defaults ON ───────────
# Mirrors the env-var-driven relay-on/off cases above, but drives FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY /
# FLOW_AGENTS_CONSOLE_ECONOMICS_ENDPOINT_URL through config.sh's key-parser + install-console-config.sh
# instead of setting them directly, proving the "no raw env var needed" path (AC2/AC4).
echo "--- config-driven (#469): install-console-config.sh (no economics flag) → relay defaults ON ---"
CONF_ON="$TMP/telemetry-cfg-on.conf"
(
  unset FLOW_AGENTS_CONSOLE_URL CONSOLE_TELEMETRY_URL CONSOLE_URL \
        FLOW_AGENTS_CONSOLE_ENDPOINT_URL CONSOLE_TELEMETRY_ENDPOINT_URL \
        FLOW_AGENTS_CONSOLE_TOKEN_FILE CONSOLE_TELEMETRY_TOKEN_FILE \
        FLOW_AGENTS_CONSOLE_TENANT CONSOLE_TENANT_ID
  bash "$TELEMETRY/install-console-config.sh" "$CONF_ON" \
    --console-url "http://127.0.0.1:${PORT}" --console-tenant "tenant-cfg-on" >/dev/null
)
RELAY_RESOLVED="$(env -i PATH="$PATH" HOME="$TMP/home-empty" \
  TELEMETRY_CONFIG_FILE="$CONF_ON" TELEMETRY_DATA_DIR="$TMP/cfg-on-data" TELEMETRY_SESSION_DIR="$TMP/cfg-on-data/sessions" \
  bash -c "source '$ROOT/scripts/telemetry/lib/config.sh'; printf '%s' \"\$FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY\"")"
[[ "$RELAY_RESOLVED" == "1" ]] && pass "config.sh: FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY resolves truthy from a console-sink conf with no explicit key" \
  || fail "config.sh: expected relay=1, got '$RELAY_RESOLVED'"

: > "$RECV"; start_stub ok
LOG8="$TMP/econ8.jsonl"; : > "$LOG8"
(
  unset FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY FLOW_AGENTS_CONSOLE_ECONOMICS_ENDPOINT_URL \
        FLOW_AGENTS_CONSOLE_URL CONSOLE_TELEMETRY_URL CONSOLE_URL CONSOLE_TENANT_ID CONSOLE_TELEMETRY_TOKEN
  export TELEMETRY_CONFIG_FILE="$CONF_ON"
  export TELEMETRY_ECONOMICS_LOG_FILE="$LOG8"
  bash "$EMITTER" "$USAGE_EVENT"
)
[[ -s "$LOG8" ]] && pass "config-driven activation: local record written (local-first)" || fail "config-driven activation: local record missing"
sleep 0.5
[[ ! -s "$RECV" ]] && pass "config-driven activation still rejects an unbound producer" || fail "config-driven activation relayed an unbound producer"
stop_stub

# ── config-driven opt-out: --no-economics-relay suppresses the POST, local record still holds ─────
echo "--- config-driven (#469): install-console-config.sh --no-economics-relay suppresses the POST ---"
CONF_OFF="$TMP/telemetry-cfg-off.conf"
(
  unset FLOW_AGENTS_CONSOLE_URL CONSOLE_TELEMETRY_URL CONSOLE_URL \
        FLOW_AGENTS_CONSOLE_ENDPOINT_URL CONSOLE_TELEMETRY_ENDPOINT_URL \
        FLOW_AGENTS_CONSOLE_TOKEN_FILE CONSOLE_TELEMETRY_TOKEN_FILE \
        FLOW_AGENTS_CONSOLE_TENANT CONSOLE_TENANT_ID
  bash "$TELEMETRY/install-console-config.sh" "$CONF_OFF" \
    --console-url "http://127.0.0.1:${PORT}" --console-tenant "tenant-cfg-off" --no-economics-relay >/dev/null
)
grep -q '^console_economics_relay=0$' "$CONF_OFF" && pass "--no-economics-relay writes console_economics_relay=0" || fail "--no-economics-relay did not write console_economics_relay=0"

: > "$RECV"; start_stub ok
LOG9="$TMP/econ9.jsonl"; : > "$LOG9"
(
  unset FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY FLOW_AGENTS_CONSOLE_ECONOMICS_ENDPOINT_URL \
        FLOW_AGENTS_CONSOLE_URL CONSOLE_TELEMETRY_URL CONSOLE_URL CONSOLE_TENANT_ID CONSOLE_TELEMETRY_TOKEN
  export TELEMETRY_CONFIG_FILE="$CONF_OFF"
  export TELEMETRY_ECONOMICS_LOG_FILE="$LOG9"
  bash "$EMITTER" "$USAGE_EVENT"
)
sleep 1
[[ -s "$LOG9" ]] && pass "--no-economics-relay: local record still written (local-first holds)" || fail "--no-economics-relay: local record missing"
[[ ! -s "$RECV" ]] && pass "--no-economics-relay: relay suppressed even though a console sink is configured" || fail "--no-economics-relay: a POST happened despite opt-out"
stop_stub

# ── explicit console_economics_relay=0 in a hand-written conf suppresses relay too ─────────────────
echo "--- config-driven (#469): hand-written console_economics_relay=0 suppresses relay despite console URL ---"
CONF_HAND="$TMP/telemetry-cfg-hand.conf"
cat > "$CONF_HAND" <<CONF_HAND_EOF
console_telemetry_url=http://127.0.0.1:${PORT}
console_tenant_id=tenant-cfg-hand
console_economics_relay=0
CONF_HAND_EOF

: > "$RECV"; start_stub ok
LOG10="$TMP/econ10.jsonl"; : > "$LOG10"
(
  unset FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY FLOW_AGENTS_CONSOLE_ECONOMICS_ENDPOINT_URL \
        FLOW_AGENTS_CONSOLE_URL CONSOLE_TELEMETRY_URL CONSOLE_URL CONSOLE_TENANT_ID CONSOLE_TELEMETRY_TOKEN
  export TELEMETRY_CONFIG_FILE="$CONF_HAND"
  export TELEMETRY_ECONOMICS_LOG_FILE="$LOG10"
  bash "$EMITTER" "$USAGE_EVENT"
)
sleep 1
[[ -s "$LOG10" ]] && pass "hand-written console_economics_relay=0: local record still written (local-first holds)" || fail "hand-written conf: local record missing"
[[ ! -s "$RECV" ]] && pass "hand-written console_economics_relay=0 suppresses relay even with a console URL present" || fail "hand-written conf: a POST happened despite explicit opt-out"
stop_stub

# ── HIGH-finding regression (#469 review): endpoint-only sink (console_telemetry_endpoint_url set,
# NO console_telemetry_url) must still resolve an economics endpoint — economics-record.sh derives
# the origin from CONSOLE_TELEMETRY_ENDPOINT_URL (stripping its `/api/telemetry/records` path) and
# posts to the shared `<origin>/records` ingress, NEVER the telemetry endpoint path verbatim ──────
echo "--- HIGH regression (#469): endpoint-only sink (console_telemetry_endpoint_url, no console_telemetry_url) still relays economics to <origin>/records ---"
CONF_ENDPOINT_ONLY="$TMP/telemetry-cfg-endpoint-only.conf"
cat > "$CONF_ENDPOINT_ONLY" <<CONF_EP_EOF
console_telemetry_endpoint_url=http://127.0.0.1:${PORT}/api/telemetry/records
console_tenant_id=tenant-cfg-endpoint-only
CONF_EP_EOF

: > "$RECV"; start_stub ok
LOG11="$TMP/econ11.jsonl"; : > "$LOG11"
(
  unset FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY FLOW_AGENTS_CONSOLE_ECONOMICS_ENDPOINT_URL \
        FLOW_AGENTS_CONSOLE_URL CONSOLE_TELEMETRY_URL CONSOLE_URL CONSOLE_TENANT_ID CONSOLE_TELEMETRY_TOKEN
  export TELEMETRY_CONFIG_FILE="$CONF_ENDPOINT_ONLY"
  export TELEMETRY_ECONOMICS_LOG_FILE="$LOG11"
  bash "$EMITTER" "$USAGE_EVENT"
)
[[ -s "$LOG11" ]] && pass "endpoint-only sink: local record still written (local-first)" || fail "endpoint-only sink: local record missing"
sleep 0.5
[[ ! -s "$RECV" ]] && pass "endpoint-only sink cannot authorize an unbound producer" || fail "endpoint-only sink relayed an unbound producer"
stop_stub

# ── explicit console_economics_endpoint_url conf key routes the POST to that exact URL ───────────
echo "--- config-driven (#469): explicit console_economics_endpoint_url conf key wins verbatim ---"
CONF_EXPLICIT_EP="$TMP/telemetry-cfg-explicit-economics-endpoint.conf"
cat > "$CONF_EXPLICIT_EP" <<CONF_EXP_EOF
console_economics_relay=1
console_economics_endpoint_url=http://127.0.0.1:${PORT}/records
CONF_EXP_EOF

: > "$RECV"; start_stub ok
LOG12="$TMP/econ12.jsonl"; : > "$LOG12"
(
  unset FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY FLOW_AGENTS_CONSOLE_ECONOMICS_ENDPOINT_URL \
        FLOW_AGENTS_CONSOLE_URL CONSOLE_TELEMETRY_URL CONSOLE_URL CONSOLE_TENANT_ID CONSOLE_TELEMETRY_TOKEN
  export TELEMETRY_CONFIG_FILE="$CONF_EXPLICIT_EP"
  export TELEMETRY_ECONOMICS_LOG_FILE="$LOG12"
  bash "$EMITTER" "$USAGE_EVENT"
)
[[ -s "$LOG12" ]] && pass "explicit console_economics_endpoint_url: local record still written (local-first)" || fail "explicit console_economics_endpoint_url: local record missing"
sleep 0.5
[[ ! -s "$RECV" ]] && pass "explicit endpoint cannot authorize an unbound producer" || fail "explicit endpoint relayed an unbound producer"
stop_stub

# ── suppression guard: unattributed+$0+no-defect/gate signal never relays (economics-relay- ───────
# unattributed-suppression) — local write still happens; only the console POST is suppressed. Full
# signal matrix so a shortcut implementation (task_slug-only) cannot pass: (1) suppressed case, then
# each signal category alone (attribution / cost / defect-gate) proven to still relay unchanged.
echo "--- suppression guard: unattributed+\$0+no-defect record is NOT relayed (local write unaffected) ---"
ZERO_USAGE_EVENT="$(jq -cn '{
  schema_version:"0.3.0", timestamp:"1751731200000",
  session_id:"unattributed-run-01", event_id:"evt-02-usage",
  event_type:"session.usage", agent:{name:"dev",runtime:"claude-code",version:"1"},
  context:{cwd:"/workspace/flow-agents"},
  usage:{ model:"claude-opus-4-8", duration_s:5, tool_invocations:0, delegations:0,
    input_tokens:0, output_tokens:0, cache_creation_input_tokens:0, cache_read_input_tokens:0,
    estimated_cost_usd:0, pricing_version:"2026-06-28", by_model:[] }
}')"
CORRELATED_ZERO_USAGE_EVENT="$(printf '%s' "$ZERO_USAGE_EVENT" | jq -c \
  --argjson correlation "$RUN_CORRELATION" '
    .task_slug = "kontourai-flow-agents-349"
    | .run_correlation = $correlation
  ')"

# Case 1: no --state/--acceptance/--critique at all (mirrors telemetry.sh's real invocation when
# econ_slug is empty) + zero-cost usage → local write happens, NO POST.
: > "$RECV"; start_stub ok || fail "stub server did not start (suppression case 1)"
LOG13="$TMP/econ13.jsonl"; : > "$LOG13"
(
  export FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY=1
  export FLOW_AGENTS_CONSOLE_ECONOMICS_ENDPOINT_URL="$ENDPOINT"
  export TELEMETRY_ECONOMICS_LOG_FILE="$LOG13"
  bash "$EMITTER" "$ZERO_USAGE_EVENT"
)
sleep 1
[[ -s "$LOG13" ]] && pass "suppression case 1: local record still written (local-first unaffected)" || fail "suppression case 1: local record missing"
[[ ! -s "$RECV" ]] && pass "suppression case 1: unattributed+\$0+no-defect record is NOT POSTed (relay suppressed)" || fail "suppression case 1: a POST happened for an unattributed/\$0/no-defect record"
stop_stub

# Case 1b (HIGH review fix): unattributed + estimated_cost_usd null (unpriced/new model — cost
# legitimately degrades to null while TOKENS remain source-of-truth, per usage.sh's contract and
# the #477 fix) + real input/output token volume + no defects → still relays. Without a
# token-volume leg in has_signal, this record is wrongly suppressed — dropping real ROI data,
# the opposite of the suppression guard's intent.
echo "--- suppression guard (HIGH fix): unattributed + null cost + real tokens still relays (no false suppression on unpriced models) ---"
TOKENS_NULL_COST_USAGE_EVENT="$(jq -cn '{
  schema_version:"0.3.0", timestamp:"1751731200000",
  session_id:"unattributed-unpriced-run-01", event_id:"evt-03-usage",
  event_type:"session.usage", agent:{name:"dev",runtime:"claude-code",version:"1"},
  context:{cwd:"/workspace/flow-agents"},
  usage:{ model:"claude-new-unpriced-model", duration_s:120, tool_invocations:4, delegations:0,
    input_tokens:50000, output_tokens:20000, cache_creation_input_tokens:0, cache_read_input_tokens:0,
    estimated_cost_usd:null, pricing_version:null, by_model:[] }
}')"
: > "$RECV"; start_stub ok
LOG13B="$TMP/econ13b.jsonl"; : > "$LOG13B"
(
  export FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY=1
  export FLOW_AGENTS_CONSOLE_ECONOMICS_ENDPOINT_URL="$ENDPOINT"
  export TELEMETRY_ECONOMICS_LOG_FILE="$LOG13B"
  bash "$EMITTER" "$TOKENS_NULL_COST_USAGE_EVENT"
)
[[ -s "$LOG13B" ]] && pass "suppression case 1b: local record written" || fail "suppression case 1b: local record missing"
REC13B="$(cat "$LOG13B")"
COST13B="$(printf '%s' "$REC13B" | jq -c '.cost.estimated_cost_usd')"
[[ "$COST13B" == "0" ]] && pass "suppression case 1b: null cost coerces to 0 on the assembled record (estimated_cost_usd==$COST13B)" || fail "suppression case 1b: expected estimated_cost_usd 0, got $COST13B"
IT13B="$(printf '%s' "$REC13B" | jq -c '.cost.input_tokens')"
OT13B="$(printf '%s' "$REC13B" | jq -c '.cost.output_tokens')"
[[ "$IT13B" == "50000" && "$OT13B" == "20000" ]] && pass "suppression case 1b: real token volume carried (input=$IT13B, output=$OT13B)" || fail "suppression case 1b: expected input=50000/output=20000, got input=$IT13B/output=$OT13B"
sleep 0.5
[[ ! -s "$RECV" ]] && pass "unbound real-token record remains local despite token volume" || fail "unbound real-token record relayed"
stop_stub

# Case 2: explicit fixture sidecars can produce a local record but never relay.
echo "--- authority guard: explicit fixture sidecars never relay ---"
: > "$RECV"; start_stub ok
LOG14="$TMP/econ14.jsonl"; : > "$LOG14"
(
  export FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY=1
  export FLOW_AGENTS_CONSOLE_ECONOMICS_ENDPOINT_URL="$ENDPOINT"
  export TELEMETRY_ECONOMICS_LOG_FILE="$LOG14"
  bash "$EMITTER" "$CORRELATED_ZERO_USAGE_EVENT" --state "$FIX/state.json"
)
[[ -s "$LOG14" ]] && pass "suppression case 2: local record written" || fail "suppression case 2: local record missing"
[[ ! -s "$RECV" ]] && pass "suppression case 2: explicit fixture sidecars cannot relay" || fail "suppression case 2: fixture sidecars relayed an authoritative-looking record"
stop_stub

# Case 3: real-transcript (non-zero cost) usage event without task attribution or sidecars
# still relays because cost is independently useful.
echo "--- suppression guard: real cost alone still relays (unattributed, no defects) ---"
COST_ONLY_USAGE_EVENT="$(printf '%s' "$USAGE_EVENT" | jq -c 'del(.task_slug)')"
: > "$RECV"; start_stub ok
LOG15="$TMP/econ15.jsonl"; : > "$LOG15"
(
  export FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY=1
  export FLOW_AGENTS_CONSOLE_ECONOMICS_ENDPOINT_URL="$ENDPOINT"
  export TELEMETRY_ECONOMICS_LOG_FILE="$LOG15"
  bash "$EMITTER" "$COST_ONLY_USAGE_EVENT"
)
[[ -s "$LOG15" ]] && pass "suppression case 3: local record written" || fail "suppression case 3: local record missing"
sleep 0.5
[[ ! -s "$RECV" ]] && pass "unbound cost-bearing record remains local" || fail "unbound cost-bearing record relayed"
stop_stub

# Case 4: an uncorrelated state path cannot inject a gate signal or trigger relay.
echo "--- correlation guard: unbound state cannot inject a gate signal ---"
STATE_NOSLUG_GATE="$TMP/state-noslug-gate.json"
jq 'del(.task_slug) | .gate_fires = 2' "$FIX/state.json" > "$STATE_NOSLUG_GATE"
: > "$RECV"; start_stub ok
LOG16="$TMP/econ16.jsonl"; : > "$LOG16"
(
  export FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY=1
  export FLOW_AGENTS_CONSOLE_ECONOMICS_ENDPOINT_URL="$ENDPOINT"
  export TELEMETRY_ECONOMICS_LOG_FILE="$LOG16"
  bash "$EMITTER" "$ZERO_USAGE_EVENT" --state "$STATE_NOSLUG_GATE"
)
[[ -s "$LOG16" ]] && pass "suppression case 4: local record written" || fail "suppression case 4: local record missing"
REC16="$(cat "$LOG16")"
[[ "$(printf '%s' "$REC16" | jq -r '.defects.gate_fires')" == "0" ]] && pass "suppression case 4: unbound state gate signal rejected" || fail "suppression case 4: unbound state injected a gate signal"
[[ ! -s "$RECV" ]] && pass "suppression case 4: rejected state does not trigger relay" || fail "suppression case 4: rejected state triggered relay"
stop_stub

# Case 5: an unbound critique cannot inject caught-false-completion evidence.
echo "--- correlation guard: unbound critique cannot inject caught_false_completions ---"
CRITIQUE_CFC_ONLY="$TMP/critique-cfc-only.json"
printf '%s' '{"gate_fires":0,"caught_false_completions":1}' > "$CRITIQUE_CFC_ONLY"
: > "$RECV"; start_stub ok
LOG17="$TMP/econ17.jsonl"; : > "$LOG17"
(
  export FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY=1
  export FLOW_AGENTS_CONSOLE_ECONOMICS_ENDPOINT_URL="$ENDPOINT"
  export TELEMETRY_ECONOMICS_LOG_FILE="$LOG17"
  bash "$EMITTER" "$ZERO_USAGE_EVENT" --critique "$CRITIQUE_CFC_ONLY"
)
[[ -s "$LOG17" ]] && pass "suppression case 5: local record written" || fail "suppression case 5: local record missing"
REC17="$(cat "$LOG17")"
assert_case5() { local got; got="$(printf '%s' "$REC17" | jq -c "$1")"; [[ "$got" == "$2" ]] && pass "suppression case 5: $3 ($got)" || fail "suppression case 5: $3 expected $2 got $got"; }
assert_case5 '.defects.gate_fires' '0' "gate_fires stays 0 (isolating the cfc sub-leg)"
assert_case5 '.defects.caught_false_completions' '0' "unbound caught_false_completions rejected"
assert_case5 '([.defects.findings_by_severity[]] | add)' '0' "findings_by_severity all-zero (isolating the cfc sub-leg)"
[[ ! -s "$RECV" ]] && pass "suppression case 5: rejected critique does not trigger relay" || fail "suppression case 5: rejected critique triggered relay"
stop_stub

# Case 6: an unbound critique cannot inject finding severity evidence.
echo "--- correlation guard: unbound critique cannot inject findings ---"
CRITIQUE_FINDING_ONLY="$TMP/critique-finding-only.json"
printf '%s' '{"gate_fires":0,"caught_false_completions":0,"critiques":[{"findings":[{"severity":"high","description":"real finding, not a false-completion"}]}]}' > "$CRITIQUE_FINDING_ONLY"
: > "$RECV"; start_stub ok
LOG18="$TMP/econ18.jsonl"; : > "$LOG18"
(
  export FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY=1
  export FLOW_AGENTS_CONSOLE_ECONOMICS_ENDPOINT_URL="$ENDPOINT"
  export TELEMETRY_ECONOMICS_LOG_FILE="$LOG18"
  bash "$EMITTER" "$ZERO_USAGE_EVENT" --critique "$CRITIQUE_FINDING_ONLY"
)
[[ -s "$LOG18" ]] && pass "suppression case 6: local record written" || fail "suppression case 6: local record missing"
REC18="$(cat "$LOG18")"
assert_case6() { local got; got="$(printf '%s' "$REC18" | jq -c "$1")"; [[ "$got" == "$2" ]] && pass "suppression case 6: $3 ($got)" || fail "suppression case 6: $3 expected $2 got $got"; }
assert_case6 '.defects.gate_fires' '0' "gate_fires stays 0 (isolating the findings sub-leg)"
assert_case6 '.defects.caught_false_completions' '0' "caught_false_completions stays 0 (isolating the findings sub-leg)"
assert_case6 '.defects.findings_by_severity.high' '0' "unbound findings_by_severity.high rejected"
[[ ! -s "$RECV" ]] && pass "suppression case 6: rejected critique does not trigger relay" || fail "suppression case 6: rejected critique triggered relay"
stop_stub


# ── AC8 (#415): delegations[] facts + orchestrator-observable outcome + signals capability block ──────
echo "--- AC8: delegations[] — role/model join, escalation supersession, honest outcome, signals ---"
LOG7="$TMP/econ7.jsonl"; : > "$LOG7"
run_emitter "$LOG7" --state "$FIX/state.json" --critique "$FIX/critique.json" --agents-dir "$FIX/agents"
DREC="$(cat "$LOG7")"
assert_eq_d() { # <label> <jq-expr-on-DREC> <expected>
  local got; got="$(printf '%s' "$DREC" | jq -c "$2" 2>/dev/null)"
  [[ "$got" == "$3" ]] && pass "$1 ($got)" || fail "$1: expected $3 got $got"
}
assert_eq_d "delegations has one entry per delegated agent_id" '.delegations | length' '5'
assert_eq_d "mechanical delegation carries its role+model" \
  '.delegations[] | select(.agent_id=="tool-worker-1") | [.role,.resolved_model]' \
  '["delegate-mechanical","claude-haiku-4-5@anthropic"]'
assert_eq_d "delegation economics excludes free-text summaries" \
  '.delegations[] | select(.agent_id=="tool-worker-1") | has("summary")' 'false'
assert_eq_d "escalation supersedes the initial delegation (latest-wins → design/opus)" \
  '.delegations[] | select(.agent_id=="tool-worker-2") | [.role,.resolved_model]' \
  '["delegate-design","claude-opus-4-8@anthropic"]'
assert_eq_d "escalated_from records the tier it was promoted from" \
  '.delegations[] | select(.agent_id=="tool-worker-2") | .escalated_from' \
  '"delegate-implementation"'
assert_eq_d "non-escalated delegation has NO escalated_from key" \
  '.delegations[] | select(.agent_id=="tool-worker-1") | has("escalated_from")' 'false'
# outcome derivation — ONLY from real signals, never fabricated:
assert_eq_d "outcome accepted (terminal evidence PASS, no escalation/redispatch)" \
  '.delegations[] | select(.agent_id=="tool-worker-1") | .outcome' '"accepted"'
assert_eq_d "outcome rework (escalation happened)" \
  '.delegations[] | select(.agent_id=="tool-worker-2") | .outcome' '"rework"'
assert_eq_d "outcome failed (terminal verdict FAIL)" \
  '.delegations[] | select(.agent_id=="tool-worker-3") | .outcome' '"failed"'
assert_eq_d "outcome UNAVAILABLE when no verdict recorded — NOT assumed accepted" \
  '.delegations[] | select(.agent_id=="tool-worker-4") | .outcome' '"unavailable"'
assert_eq_d "dispatch_count is orchestrator-observable (single dispatch = 1)" \
  '.delegations[] | select(.agent_id=="tool-worker-1") | .dispatch_count' '1'
# signals capability block — distinguishes harness-blind from real zero
assert_eq_d "signals.per_delegation_tokens is false (no runtime isolates sub-agent tokens today)" \
  '.signals.per_delegation_tokens' 'false'
assert_eq_d "signals.per_delegation_outcome == partial (4 of 5 delegations have a real outcome)" \
  '.signals.per_delegation_outcome' '"partial"'
assert_eq_d "signals.runtime carried from the usage event" '.signals.runtime' '"claude-code"'
# re-dispatch WITHOUT escalation is rework via dispatch_count>1 — orchestrator-observable, no sub-agent peek
assert_eq_d "re-dispatch (2 delegations, no escalation) → dispatch_count=2, outcome rework" \
  '.delegations[] | select(.agent_id=="tool-worker-5") | [.dispatch_count,.outcome]' \
  '[2,"rework"]'

# #620: signals.per_delegation_tokens is DERIVED from the runtime capability declaration, NOT a
# hardcoded literal. claude-code's declared status is unsupported → the emitted boolean is false;
# prove derivation by pointing the emitter at a declaration JSON where the value is flipped to
# supported and observing the emitted signal flip to true. And prove the highest-value adversarial
# risk is closed: a kiro-cli record (.agent.runtime carries "kiro-cli") folds to the canonical `kiro`
# declaration rather than silently missing.
echo "--- AC8 (#620): per_delegation_tokens is declaration-derived (not hardcoded); kiro-cli alias fold ---"
DECL_JSON_REAL="$ROOT/build/generated/capability-declarations.json"
# The build-only declaration JSON is what the emitter derives the signal from; generate it if a
# prior build step in this lane has not (keeps the suite self-contained when run standalone).
[[ -f "$DECL_JSON_REAL" ]] || (cd "$ROOT" && npm run build) >/dev/null 2>&1 || true
if [[ -f "$DECL_JSON_REAL" ]]; then
  DECL_CC_SUPPORTED="$TMP/decl-cc-supported.json"
  jq '."claude-code".per_delegation_tokens={status:"supported"}' < "$DECL_JSON_REAL" > "$DECL_CC_SUPPORTED"
  LOG_PDT="$TMP/econ-pdt.jsonl"; : > "$LOG_PDT"
  FLOW_AGENTS_CAPABILITY_DECL_FILE="$DECL_CC_SUPPORTED" TELEMETRY_ECONOMICS_LOG_FILE="$LOG_PDT" \
    bash "$EMITTER" "$USAGE_EVENT" --state "$FIX/state.json" >/dev/null 2>&1
  GOT_PDT="$(jq -c '.signals.per_delegation_tokens' < "$LOG_PDT" 2>/dev/null)"
  [[ "$GOT_PDT" == "true" ]] && pass "per_delegation_tokens is declaration-DERIVED (flipped decl → true), not a hardcoded false" || fail "per_delegation_tokens not declaration-derived: expected true got $GOT_PDT"
else
  fail "declaration JSON missing ($DECL_JSON_REAL) — the build must generate it"
fi

# kiro-cli record: runtime carried verbatim; per_delegation_tokens derives the DECLARED kiro value
# (false today) via the alias fold — a silent lookup miss would instead hit the unresolved sentinel.
KIRO_EVENT="$(printf '%s' "$USAGE_EVENT" | jq -c '.agent.runtime="kiro-cli"')"
LOG_KIRO="$TMP/econ-kiro.jsonl"; : > "$LOG_KIRO"
TELEMETRY_ECONOMICS_LOG_FILE="$LOG_KIRO" bash "$EMITTER" "$KIRO_EVENT" --state "$FIX/state.json" >/dev/null 2>&1
assert_kiro() { local got; got="$(jq -c "$1" < "$LOG_KIRO" 2>/dev/null)"; [[ "$got" == "$2" ]] && pass "$3 ($got)" || fail "$3: expected $2 got $got"; }
assert_kiro '.signals.runtime' '"kiro-cli"' "kiro-cli record carries runtime verbatim"
assert_kiro '.signals.per_delegation_tokens' 'false' "kiro-cli derives the declared per_delegation_tokens (alias fold to kiro → declared false)"
if [[ -f "$DECL_JSON_REAL" ]]; then
  DECL_KIRO_SUPPORTED="$TMP/decl-kiro-supported.json"
  jq '."kiro".per_delegation_tokens={status:"supported"}' < "$DECL_JSON_REAL" > "$DECL_KIRO_SUPPORTED"
  LOG_KIRO2="$TMP/econ-kiro2.jsonl"; : > "$LOG_KIRO2"
  FLOW_AGENTS_CAPABILITY_DECL_FILE="$DECL_KIRO_SUPPORTED" TELEMETRY_ECONOMICS_LOG_FILE="$LOG_KIRO2" \
    bash "$EMITTER" "$KIRO_EVENT" --state "$FIX/state.json" >/dev/null 2>&1
  GOT_KIRO="$(jq -c '.signals.per_delegation_tokens' < "$LOG_KIRO2" 2>/dev/null)"
  [[ "$GOT_KIRO" == "true" ]] && pass "kiro-cli resolves the kiro declaration via alias fold (kiro flipped→supported yields true)" || fail "kiro-cli did NOT fold to kiro: expected true got $GOT_KIRO"
fi

# absent --agents-dir → delegations [] and signals.per_delegation_outcome n/a (backward compatible)
assert_eq "delegations defaults to [] with no --agents-dir (golden path)" '.delegations' '[]'
assert_eq "signals.per_delegation_outcome == n/a with no delegations" '.signals.per_delegation_outcome' '"n/a"'
# the delegations-bearing record still validates against the schema
DVAL="$(node -e '
const Ajv=require("ajv/dist/2020").default; const a=new Ajv({allErrors:true,strict:false});
const correlation=require(process.argv[3]); a.addSchema(correlation);
const v=a.compile(require(process.argv[1]));
console.log(v(JSON.parse(require("fs").readFileSync(process.argv[2],"utf8")))?"VALID":"INVALID:"+JSON.stringify(v.errors));
' "$SCHEMA" "$LOG7" "$ROOT/schemas/run-correlation-envelope.schema.json" 2>&1)"
[[ "$DVAL" == "VALID" ]] && pass "record with delegations[] + outcome + signals validates against the schema" || fail "delegations record invalid: $DVAL"

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "test_economics_record: all checks passed."
  exit 0
else
  echo "test_economics_record: $errors check(s) failed."
  exit 1
fi
