#!/usr/bin/env bash
# #622: bounded, capability-declared, at-action agent_stated intent annotation.
# Covers AC1-AC5: supported bounded capture; unsupported -> typed
# workflow_derived_purpose fallback; post-hoc write EEXIST-rejected;
# agent_stated can never be gate evidence; A/B delta reported WITH uncertainty.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
errors=0
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

CLI="$ROOT/build/src/cli.js"
ACTION="fa1:file:action.json:$(printf 'a%.0s' {1..64})"
GATE="fa1:file:gate.json:$(printf 'b%.0s' {1..64})"

echo "Narrative intent annotation integration"
if npm run build --silent; then pass "TypeScript build completed"; else fail "TypeScript build failed"; fi

json_field() { # $1=file $2=js-expr over `value`
  node - "$1" "$2" <<'NODE'
const fs = require('fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
process.stdout.write(String(Function('value', `return (${process.argv[3]})`)(value)));
NODE
}

# ── AC1: supported runtime (fixture-provided status) captures a bounded annotation ──
AC1_DIR="$TMP/ac1"
if node "$CLI" narrative-sources capture-intent --narrative-dir "$AC1_DIR" \
  --runtime claude-code --actor codex --action-ref "$ACTION" --active-gate-ref "$GATE" \
  --capability-fixture supported --purpose "prepare the release notes" \
  >"$TMP/ac1.out" 2>"$TMP/ac1.err"; then
  mode="$(json_field "$TMP/ac1.out" 'value.mode')"
  cls="$(json_field "$TMP/ac1.out" 'value.statement.class')"
  self="$(json_field "$TMP/ac1.out" 'value.statement.self_report')"
  hasReasoning="$(json_field "$TMP/ac1.out" '"reasoning" in value.statement || "alternatives_considered" in value.statement || "hidden_alternative" in value.statement')"
  onStdout="$(node -e "const fs=require('fs');JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write('ok')" "$TMP/ac1.out" 2>/dev/null)"
  if [[ "$mode" == "agent_stated" && "$cls" == "agent_stated" && "$self" == "true" \
        && "$hasReasoning" == "false" && "$onStdout" == "ok" ]]; then
    pass "AC1: supported runtime captures a bounded agent_stated self-report with no reasoning field"
  else
    fail "AC1: unexpected annotation shape (mode=$mode class=$cls self_report=$self reasoning=$hasReasoning)"
  fi
else
  fail "AC1: supported capture failed: $(tail -n 2 "$TMP/ac1.err")"
fi

# AC1 schema bound: a multi-clause / reasoning-dump purpose is rejected at construct.
if node "$CLI" narrative-sources capture-intent --narrative-dir "$TMP/ac1-dump" \
  --runtime claude-code --actor codex --action-ref "$ACTION" --active-gate-ref "$GATE" \
  --capability-fixture supported --purpose "ship the fix and explain my full reasoning at length" \
  >"$TMP/ac1-dump.out" 2>"$TMP/ac1-dump.err"; then
  fail "AC1: a multi-clause reasoning-dump purpose was accepted"
elif [[ ! -e "$TMP/ac1-dump/intent-annotation.json" ]]; then
  pass "AC1: multi-clause reasoning-dump purpose rejected at construct (no annotation written)"
else
  fail "AC1: reasoning-dump rejected but an annotation channel leaked"
fi

# ── AC2: an unsupported runtime yields ONLY a typed workflow_derived_purpose ──
# claude-code declares intent_annotation NOT_IMPLEMENTED_INTENT (#620), so the
# real queryCapability path (no fixture) resolves to unsupported.
AC2_DIR="$TMP/ac2"
if node "$CLI" narrative-sources capture-intent --narrative-dir "$AC2_DIR" \
  --runtime claude-code --actor codex --action-ref "$ACTION" --active-gate-ref "$GATE" \
  --purpose "prepare the release notes" \
  >"$TMP/ac2.out" 2>"$TMP/ac2.err"; then
  mode="$(json_field "$TMP/ac2.out" 'value.mode')"
  cls="$(json_field "$TMP/ac2.out" 'value.statement.class')"
  ruleId="$(json_field "$TMP/ac2.out" 'value.statement.rule && value.statement.rule.id')"
  isSelf="$(json_field "$TMP/ac2.out" '"self_report" in value.statement')"
  if [[ "$mode" == "workflow_derived_purpose" && "$cls" == "deterministic_derived" \
        && "$ruleId" == "workflow-derived-purpose" && "$isSelf" == "false" ]]; then
    pass "AC2: unsupported runtime yields a typed workflow_derived_purpose, never a fabricated agent_stated"
  else
    fail "AC2: unexpected fallback shape (mode=$mode class=$cls rule=$ruleId self_report=$isSelf)"
  fi
else
  fail "AC2: fallback capture failed: $(tail -n 2 "$TMP/ac2.err")"
fi

# ── AC3: a post-hoc / second write to the frozen channel is EEXIST-rejected ──
FROZEN_BEFORE="$(node -e "const fs=require('fs'),c=require('crypto');process.stdout.write(c.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))" "$AC1_DIR/intent-annotation.json")"
if node "$CLI" narrative-sources capture-intent --narrative-dir "$AC1_DIR" \
  --runtime claude-code --actor codex --action-ref "$ACTION" --active-gate-ref "$GATE" \
  --capability-fixture supported --purpose "reconstruct a rationale after the fact" \
  >"$TMP/ac3.out" 2>"$TMP/ac3.err"; then
  fail "AC3: a post-hoc write to the frozen annotation channel was accepted"
else
  FROZEN_AFTER="$(node -e "const fs=require('fs'),c=require('crypto');process.stdout.write(c.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))" "$AC1_DIR/intent-annotation.json")"
  if grep -q "already frozen" "$TMP/ac3.err" && [[ "$FROZEN_BEFORE" == "$FROZEN_AFTER" ]]; then
    pass "AC3: post-hoc write rejected (EEXIST); frozen channel bytes unchanged"
  else
    fail "AC3: post-hoc rejection missing diagnostic or channel mutated"
  fi
fi

# ── AC4: an agent_stated annotation can never satisfy a gate expectation ──
if node --input-type=module - "$ROOT/build/src/index.js" "$AC1_DIR/intent-annotation.json" <<'NODE'
const api = await import(`file://${process.argv[2]}`);
const { evidenceMatchesExpectation } = await import('@kontourai/flow');
const fs = await import('node:fs');
const annotation = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const expectation = { id: 'implementation-scope', kind: 'trust.bundle', bundle_claim: { claimType: 'builder.execute.scope', subjectType: 'change' } };
// A narrative-kind entry referencing the frozen annotation channel must NOT satisfy a trust.bundle.
const entry = { id: 'intent-annotation', kind: 'file', requested_kind: 'file', status: 'passed', original_path: '.kontourai/narrative/run-622/n1/intent-annotation.json' };
if (evidenceMatchesExpectation(entry, expectation) !== false) process.exit(1);
// And agent_stated can never assert a gate-evidence category.
for (const kind of ['gate_status', 'observed_outcome', 'authority', 'hidden_alternative']) {
  if (api.isAssertionProhibited('agent_stated', kind) !== true) process.exit(2);
}
if (annotation.statement.class !== 'agent_stated' || annotation.statement.self_report !== true) process.exit(3);
NODE
then
  pass "AC4: agent_stated annotation cannot satisfy a gate expectation and cannot assert gate evidence"
else
  fail "AC4: gate-evidence isolation failed"
fi

# ── AC5: A/B measurement records both modes and reports a delta WITH uncertainty ──
ABDIR="$TMP/ab"
record_econ() { node "$CLI" narrative-sources intent-economics --narrative-dir "$ABDIR" --record \
  --mode "$1" --input-tokens "$2" --output-tokens "$3" --wall-clock-ms "$4" >/dev/null 2>>"$TMP/ab.err"; }
record_econ annotation_off 100 40 1000
record_econ annotation_on 130 44 1100
record_econ annotation_off 100 40 1000
record_econ annotation_on 150 48 1200
if node "$CLI" narrative-sources intent-economics --narrative-dir "$ABDIR" --report >"$TMP/ab.out" 2>>"$TMP/ab.err"; then
  pairs="$(json_field "$TMP/ab.out" 'value.pairs')"
  meanIn="$(json_field "$TMP/ab.out" 'value.delta_input_tokens.mean')"
  stdIn="$(json_field "$TMP/ab.out" 'value.delta_input_tokens.sample_std')"
  hasUncertainty="$(json_field "$TMP/ab.out" 'Number(value.delta_input_tokens.sample_std) > 0 && "min" in value.delta_input_tokens && "max" in value.delta_input_tokens')"
  if [[ "$pairs" -ge 1 && "$meanIn" == "40" && "$hasUncertainty" == "true" ]]; then
    pass "AC5: A/B reports a mean delta ($meanIn input tokens) WITH an uncertainty spread (std=$stdIn)"
  else
    fail "AC5: A/B summary missing paired delta or uncertainty (pairs=$pairs mean=$meanIn std=$stdIn)"
  fi
else
  fail "AC5: A/B report failed: $(tail -n 2 "$TMP/ab.err")"
fi

if [[ "$errors" -eq 0 ]]; then
  echo "narrative intent annotation tests passed."
  exit 0
fi
echo "narrative intent annotation tests FAILED: $errors issue(s)."
exit 1
