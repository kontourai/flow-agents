#!/usr/bin/env bash
# demo-cast.sh — paced, two-column "ours vs theirs" narrative for recording (VHS).
#
# It is HONEST: before rendering, it actually runs the real test suite and the real
# stop-goal-fit hook and asserts the outcomes (buggy -> tests fail -> hook blocks;
# fixed -> tests pass -> hook allows). It only renders the story if reality matches,
# so the GIF can never show a claim the code doesn't back.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=100000

# ---------- 1. verify the facts are real (silent) ----------
PROJ="$(mktemp -d)"; mkdir -p "$PROJ/.flow-agents/calc"; printf '# calc\n' > "$PROJ/AGENTS.md"
cat > "$PROJ/calculator.js" <<'JS'
const add = (a, b) => a + b;
const multiply = (a, b) => a + b;   // BUG
module.exports = { add, multiply };
JS
cat > "$PROJ/calculator.test.js" <<'JS'
const { add, multiply } = require('./calculator');
let f = 0;
const c = (n, g, w) => { if (g !== w) { console.error(`FAIL ${n}: got ${g}, want ${w}`); f++; } else console.log(`ok ${n}`); };
c('add(2,3)', add(2, 3), 5); c('multiply(2,3)', multiply(2, 3), 6);
process.exit(f ? 1 : 0);
JS
cat > "$PROJ/.flow-agents/calc/calc--deliver.md" <<'MD'
# calc
status: executing
type: deliver
## Definition Of Done
- [x] tests pass
## Goal Fit Gate
- [x] verified
### Verdict: PASS
MD
printf '{"schema_version":"1.0","task_slug":"calc","status":"in_progress","phase":"verification","updated_at":"2026-06-18T00:00:00Z","next_action":{"status":"continue","summary":"Make all tests pass."}}' > "$PROJ/.flow-agents/calc/state.json"
# ev() runs the REAL test suite and writes only evidence.json from the real result.
ev(){ local v; if node "$PROJ/calculator.test.js" >/dev/null 2>&1; then v=pass; else v=fail; fi
  printf '{"schema_version":"1.0","task_slug":"calc","verdict":"%s","checks":[{"id":"t","kind":"test","status":"%s","summary":"calc tests"}]}' "$v" "$v" > "$PROJ/.flow-agents/calc/evidence.json"; echo "$v"; }
hook(){ printf '{"hook_event_name":"Stop","cwd":"%s"}' "$PROJ" | FLOW_AGENTS_GOAL_FIT_MODE=block node "$ROOT/scripts/hooks/stop-goal-fit.js" >/dev/null 2>&1; echo $?; }
[ "$(ev)" = "fail" ] || { echo "precondition failed: tests should fail"; exit 1; }
[ "$(hook)" = "2" ] || { echo "precondition failed: hook should block"; exit 1; }
# fixed
sed -i.bak 's#const multiply = (a, b) => a + b;.*#const multiply = (a, b) => a * b;#' "$PROJ/calculator.js"; rm -f "$PROJ/calculator.js.bak"
sed -i.bak 's/^status: executing/status: delivered/' "$PROJ/.flow-agents/calc/calc--deliver.md"; rm -f "$PROJ/.flow-agents/calc/calc--deliver.md.bak"
printf '{"schema_version":"1.0","task_slug":"calc","status":"delivered","phase":"done","updated_at":"2026-06-18T00:00:00Z","next_action":{"status":"done","summary":"done"}}' > "$PROJ/.flow-agents/calc/state.json"
[ "$(ev)" = "pass" ] || { echo "precondition failed: tests should pass after fix"; exit 1; }
[ "$(hook)" = "0" ] || { echo "precondition failed: hook should allow after fix"; exit 1; }
rm -rf "$PROJ"

# ---------- 2. render the paced two-column story (real outcomes) ----------
W=52; DASH="$(python3 -c "print('─'*$W)")"
RST=$'\e[0m'; B=$'\e[1m'; R=$'\e[1;31m'; G=$'\e[1;32m'; Y=$'\e[1;33m'; C=$'\e[36m'; D=$'\e[2m'
pad(){ local s="$1" p wide; p=$(printf '%s' "$s" | sed $'s/\e\\[[0-9;]*m//g')
  # emoji ✅ ⛔ ❌ render two columns wide but count as one char — correct the padding
  wide=$(printf '%s' "$p" | grep -o $'✅\|⛔\|❌' | wc -l | tr -d ' '); wide=${wide:-0}
  local n=$((W-${#p}-wide)); ((n<0))&&n=0; printf '%s%*s' "$s" "$n" ''; }
row(){ printf '   │ %s │ %s │\n' "$(pad "${1:-}")" "$(pad "${2:-}")"; sleep "${3:-0.5}"; }
top(){ printf '   ┌─%s─┬─%s─┐\n' "$DASH" "$DASH"; }
mid(){ printf '   ├─%s─┼─%s─┤\n' "$DASH" "$DASH"; }
bot(){ printf '   └─%s─┴─%s─┘\n' "$DASH" "$DASH"; }

clear
# ---- branded title card ----
printf '\n\n\n'
printf '        %s⬡  FLOW AGENTS%s\n\n' "$Y" "$RST"
printf '        %sThe agent says it'\''s done. The tests are failing.%s\n' "$B" "$RST"
sleep 1.3
clear
# ---- side-by-side ----
top
row "${B}WITHOUT Flow Agents${RST}" "${B}WITH Flow Agents${RST}" 0.6
mid
row "${D}goal: implement multiply()${RST}" "${D}goal: implement multiply()${RST}" 0.45
row "" ""
row "agent edits calculator.js" "agent edits calculator.js" 0.5
row "${G}agent: \"Implemented it. Done ✅\"${RST}" "${G}agent: \"Implemented it. Done ✅\"${RST}" 1.1
row "" ""
row "${D}completion = the agent's word${RST}" "${R}⛔ completion requires evidence${RST}" 1.0
row "${R}→ marked done, never verified${RST}" "  ${C}verify-work${RST} runs the suite:" 0.8
row "" "  ${R}FAIL multiply(2,3): got 5, want 6${RST}" 1.0
row "${R}→ ships the broken code${RST}" "  ${Y}refuses to mark complete${RST}" 1.1
row "${D}  bug surfaces later in CI / prod${RST}" "" 0.9
row "" "${C}→ agent fixes; verify re-runs${RST}" 0.8
row "" "${G}all tests pass ✓${RST}" 0.7
row "" "${G}✅ now allowed to complete${RST}" 1.0
mid
row "${R}❌ unverified \"done\" shipped${RST}" "${G}✅ \"done\" means proven done${RST}" 1.0
bot
printf '\n   %sOne judges the claim.  The other judges the proof.%s\n' "$B" "$RST"
printf '   %s⬡ FLOW AGENTS%s  %s— evidence-gated agents%s\n\n' "$Y" "$RST" "$D" "$RST"
sleep 1.8
