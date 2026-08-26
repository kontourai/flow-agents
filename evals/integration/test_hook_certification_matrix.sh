#!/usr/bin/env bash
# Certifies the Claude Code adapter's five policy classes against the decision
# contracts in docs/spec/runtime-hook-surface.md §2.  Deliberately does not
# touch the operator's HOME or Claude settings.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMPDIR_EVAL="$(mktemp -d)"
errors=0
declare -A cell
trap 'rm -rf "$TMPDIR_EVAL"' EXIT
# Pin the only Claude-specific filesystem surface. Do not replace HOME: toolchain
# shims may legitimately consult it, while this hook never needs the real ~/.claude.
export FLOW_AGENTS_USER_CLAUDE_SETTINGS="$TMPDIR_EVAL/home/.claude/settings.json"
mkdir -p "$TMPDIR_EVAL/home"

pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1"; errors=$((errors + 1)); }
cert() { cell["$1:$2"]="PASS"; pass "$1 / $2 — $3"; }
uncertified() { cell["$1:$2"]="NOT-CERTIFIED: $3"; echo "  NOT-CERTIFIED  $1 / $2 — $3"; }
covered() { cell["$1:$2"]="COVERED: $3"; echo "  COVERED-ELSEWHERE  $1 / $2 — $3"; }
failed() { cell["$1:$2"]="FAIL"; fail "$1 / $2 — $3"; }

json_has() {
  node -e 'const fs=require("fs"); const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if (!eval(process.argv[2])) process.exit(1)' "$1" "$2"
}
claude() {
  local event="$1" id="$2" script="$3" payload="$4" out="$5" err="$6"
  node "$ROOT/scripts/hooks/claude-hook-adapter.js" "$event" "$id" "$script" standard,strict >"$out" 2>"$err" <<<"$payload"
}

echo "=== Hook Certification Matrix (Claude Code) ==="

# workflow-steering: actual Claude additionalContext, including compact reset.
STEER_REPO="$TMPDIR_EVAL/steer-repo"
mkdir -p "$STEER_REPO/.kontourai/flow-agents/demo" "$STEER_REPO/docs"
printf '# map\n' >"$STEER_REPO/docs/context-map.md"
printf '%s\n' '{"task_slug":"demo","status":"not_verified","phase":"verification","next_action":{"summary":"Run the missing verification."}}' >"$STEER_REPO/.kontourai/flow-agents/demo/state.json"
# No current pointer is required for SessionStart's context-map contract.
steer_payload="{\"hook_event_name\":\"SessionStart\",\"source\":\"compact\",\"cwd\":\"$STEER_REPO\"}"
if claude SessionStart session:workflow-steering workflow-steering.js "$steer_payload" "$TMPDIR_EVAL/steer.json" "$TMPDIR_EVAL/steer.err" \
  && json_has "$TMPDIR_EVAL/steer.json" 'x.continue===true && x.hookSpecificOutput.additionalContext.includes("CONTEXT MAP:")'; then
  cert workflow-steering FIRES "SessionStart injects the context-map pointer"
else failed workflow-steering FIRES "SessionStart did not inject additionalContext"; fi
if claude PostToolUse post:workflow-steering workflow-steering.js "{\"hook_event_name\":\"PostToolUse\",\"cwd\":\"$STEER_REPO\"}" "$TMPDIR_EVAL/steer-benign.json" "$TMPDIR_EVAL/steer-benign.err" \
  && json_has "$TMPDIR_EVAL/steer-benign.json" 'x.suppressOutput===true && !(x.hookSpecificOutput?.additionalContext)'; then
  cert workflow-steering PASSES-THROUGH "ordinary PostToolUse injects no context"
else failed workflow-steering PASSES-THROUGH "ordinary event injected context"; fi
if json_has "$TMPDIR_EVAL/steer.json" 'x.hookSpecificOutput.additionalContext.includes("CONTEXT MAP:")'; then
  cert workflow-steering USEFUL "compaction SessionStart re-injects the context pointer"
else failed workflow-steering USEFUL "compaction lost the current-step recovery pointer"; fi

# quality-gate: fixture-declared Biome selects the canonical resolver without installing any
# formatter.  The local stub is also earliest on PATH; resolveFormatterBin deliberately chooses
# the fixture-local executable over npx.  It reports bad.json as malformed and records calls.
QUALITY_REPO="$TMPDIR_EVAL/quality-repo"; mkdir -p "$QUALITY_REPO/node_modules/.bin" "$QUALITY_REPO/bin"
printf '{}\n' >"$QUALITY_REPO/biome.json"
printf '{"bad":true}\n' >"$QUALITY_REPO/bad.json"
printf '{"clean":true}\n' >"$QUALITY_REPO/clean.json"
printf 'not formatted by biome\n' >"$QUALITY_REPO/README.txt"
cat >"$QUALITY_REPO/node_modules/.bin/biome" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$QUALITY_STUB_CALLS"
case "$*" in
  *bad.json*) echo 'stub biome: bad.json is malformed' >&2; exit 1 ;;
  *) exit 0 ;;
esac
STUB
chmod +x "$QUALITY_REPO/node_modules/.bin/biome"
ln -s ../node_modules/.bin/biome "$QUALITY_REPO/bin/biome"
QUALITY_STUB_CALLS="$TMPDIR_EVAL/quality-stub.calls"
quality_bad_payload="{\"hook_event_name\":\"PostToolUse\",\"tool_input\":{\"path\":\"$QUALITY_REPO/bad.json\"}}"
if (cd "$QUALITY_REPO" && PATH="$QUALITY_REPO/bin:$PATH" QUALITY_STUB_CALLS="$QUALITY_STUB_CALLS" SA_QUALITY_GATE_STRICT=true claude PostToolUse post:quality-gate quality-gate.js "$quality_bad_payload" "$TMPDIR_EVAL/quality.json" "$TMPDIR_EVAL/quality.err") \
  && rg -q "\\[QualityGate\\] Biome check failed for $QUALITY_REPO/bad.json" "$TMPDIR_EVAL/quality.err" \
  && rg -q 'bad.json' "$QUALITY_STUB_CALLS"; then
  cert quality-gate FIRES "bad supported .json edit surfaces a warning and still exits 0"
  cert quality-gate USEFUL "stub-reported formatting defect names bad.json"
else
  failed quality-gate FIRES "bad supported .json edit did not surface a non-blocking warning"
  failed quality-gate USEFUL "planted formatting defect was not reported for bad.json"
fi
if (cd "$QUALITY_REPO" && PATH="$QUALITY_REPO/bin:$PATH" QUALITY_STUB_CALLS="$QUALITY_STUB_CALLS" SA_QUALITY_GATE_STRICT=true claude PostToolUse post:quality-gate quality-gate.js "{\"hook_event_name\":\"PostToolUse\",\"tool_input\":{\"path\":\"$QUALITY_REPO/clean.json\"}}" "$TMPDIR_EVAL/quality-clean.json" "$TMPDIR_EVAL/quality-clean.err") \
  && ! test -s "$TMPDIR_EVAL/quality-clean.err"; then
  cert quality-gate PASSES-THROUGH "clean supported .json edit emits no warning"
else failed quality-gate PASSES-THROUGH "clean supported .json edit warned"; fi
calls_before_unsupported="$(wc -l <"$QUALITY_STUB_CALLS")"
if (cd "$QUALITY_REPO" && PATH="$QUALITY_REPO/bin:$PATH" QUALITY_STUB_CALLS="$QUALITY_STUB_CALLS" SA_QUALITY_GATE_STRICT=true claude PostToolUse post:quality-gate quality-gate.js "{\"hook_event_name\":\"PostToolUse\",\"tool_input\":{\"path\":\"$QUALITY_REPO/README.txt\"}}" "$TMPDIR_EVAL/quality-unsupported.json" "$TMPDIR_EVAL/quality-unsupported.err") \
  && ! test -s "$TMPDIR_EVAL/quality-unsupported.err" \
  && [[ "$(wc -l <"$QUALITY_STUB_CALLS")" -eq "$calls_before_unsupported" ]]; then
  pass "quality-gate / unsupported extension — .txt short-circuits without formatter invocation"
else failed quality-gate PASSES-THROUGH "unsupported extension warned or invoked formatter"; fi

# stop-goal-fit and evidence-capture have intentionally deeper canonical suites.  Their cells
# remain named references rather than reimplementations here.
covered stop-goal-fit FIRES test_goal_fit_hook.sh
covered stop-goal-fit PASSES-THROUGH test_goal_fit_hook.sh
covered stop-goal-fit USEFUL test_goal_fit_hook.sh
covered evidence-capture FIRES test_evidence_capture_hook.sh
covered evidence-capture PASSES-THROUGH test_evidence_capture_hook.sh
covered evidence-capture USEFUL test_evidence_capture_hook.sh

# config-protection: assert adapter-level deny + model-visible reason, and a benign source write.
config_payload='{ "hook_event_name":"PreToolUse", "tool_input":{"path":"eslint.config.js","content":"module.exports = {}"} }'
if claude PreToolUse pre:config-protection config-protection.js "$config_payload" "$TMPDIR_EVAL/config.json" "$TMPDIR_EVAL/config.err" \
  && json_has "$TMPDIR_EVAL/config.json" 'x.hookSpecificOutput.permissionDecision==="deny" && x.hookSpecificOutput.permissionDecisionReason.includes("Fix the source")'; then
  cert config-protection FIRES "protected config write becomes model-visible deny"
else failed config-protection FIRES "protected config write was not denied with a reason"; fi
if claude PreToolUse pre:config-protection config-protection.js '{"hook_event_name":"PreToolUse","tool_input":{"path":"src/readme.txt"}}' "$TMPDIR_EVAL/config-benign.json" "$TMPDIR_EVAL/config-benign.err" \
  && json_has "$TMPDIR_EVAL/config-benign.json" 'x.continue===true && x.hookSpecificOutput?.permissionDecision!=="deny"'; then
  cert config-protection PASSES-THROUGH "ordinary source path is allowed"
else failed config-protection PASSES-THROUGH "ordinary source path was denied"; fi
if json_has "$TMPDIR_EVAL/config.json" 'x.hookSpecificOutput.permissionDecision==="deny"'; then
  cert config-protection USEFUL "attempted linter weakening is vetoed"
else failed config-protection USEFUL "attempted linter weakening was allowed"; fi

# POWER: production run-hook disable is the controlled neutering mechanism.  The relevant FIRES
# and USEFUL observations must disappear, then the normal hook remains enabled for the matrix.
if SA_DISABLED_HOOKS=session:workflow-steering claude SessionStart session:workflow-steering workflow-steering.js "$steer_payload" "$TMPDIR_EVAL/power-steer.json" "$TMPDIR_EVAL/power-steer.err" \
  && json_has "$TMPDIR_EVAL/power-steer.json" 'x.suppressOutput===true && !(x.hookSpecificOutput?.additionalContext)'; then
  echo "POWER workflow-steering: injected=RED restored=GREEN (FIRES/USEFUL lose additionalContext when disabled)"
else echo "POWER workflow-steering: injected=NOT-RED restored=GREEN"; errors=$((errors + 1)); fi
if SA_DISABLED_HOOKS=pre:config-protection claude PreToolUse pre:config-protection config-protection.js "$config_payload" "$TMPDIR_EVAL/power-config.json" "$TMPDIR_EVAL/power-config.err" \
  && json_has "$TMPDIR_EVAL/power-config.json" 'x.hookSpecificOutput?.permissionDecision!=="deny"'; then
  echo "POWER config-protection: injected=RED restored=GREEN (FIRES/USEFUL lose deny when disabled)"
else echo "POWER config-protection: injected=NOT-RED restored=GREEN"; errors=$((errors + 1)); fi
if SA_DISABLED_HOOKS=post:quality-gate PATH="$QUALITY_REPO/bin:$PATH" QUALITY_STUB_CALLS="$QUALITY_STUB_CALLS" SA_QUALITY_GATE_STRICT=true claude PostToolUse post:quality-gate quality-gate.js "$quality_bad_payload" "$TMPDIR_EVAL/power-quality.json" "$TMPDIR_EVAL/power-quality.err" \
  && ! test -s "$TMPDIR_EVAL/power-quality.err"; then
  power_quality_disabled_calls="$(wc -l <"$QUALITY_STUB_CALLS")"
  if (cd "$QUALITY_REPO" && PATH="$QUALITY_REPO/bin:$PATH" QUALITY_STUB_CALLS="$QUALITY_STUB_CALLS" SA_QUALITY_GATE_STRICT=true claude PostToolUse post:quality-gate quality-gate.js "$quality_bad_payload" "$TMPDIR_EVAL/power-quality-restored.json" "$TMPDIR_EVAL/power-quality-restored.err") \
    && rg -q "\\[QualityGate\\] Biome check failed for $QUALITY_REPO/bad.json" "$TMPDIR_EVAL/power-quality-restored.err" \
    && [[ "$(wc -l <"$QUALITY_STUB_CALLS")" -eq $((power_quality_disabled_calls + 1)) ]]; then
    echo "POWER quality-gate / FIRES: injected=RED restored=GREEN (warning disappears, then returns)"
    echo "POWER quality-gate / USEFUL: injected=RED restored=GREEN (bad.json defect report disappears, then returns)"
  else
    echo "POWER quality-gate / FIRES: injected=RED restored=NOT-GREEN"
    echo "POWER quality-gate / USEFUL: injected=RED restored=NOT-GREEN"
    errors=$((errors + 1))
  fi
else
  echo "POWER quality-gate / FIRES: injected=NOT-RED restored=GREEN"
  echo "POWER quality-gate / USEFUL: injected=NOT-RED restored=GREEN"
  errors=$((errors + 1))
fi

echo
printf '%-20s | %-26s | %-26s | %-26s\n' 'HOOK' 'FIRES' 'PASSES-THROUGH' 'USEFUL'
printf '%s\n' '---------------------+----------------------------+----------------------------+----------------------------'
for hook in workflow-steering quality-gate stop-goal-fit config-protection evidence-capture; do
  printf '%-20s | %-26s | %-26s | %-26s\n' "$hook" "${cell[$hook:FIRES]}" "${cell[$hook:PASSES-THROUGH]}" "${cell[$hook:USEFUL]}"
done
if [[ $errors -gt 0 ]]; then echo "HOOK CERTIFICATION MATRIX: FAIL ($errors cells/power probes)"; exit 1; fi
echo "HOOK CERTIFICATION MATRIX: PASS (covered-elsewhere cells are named above)"
