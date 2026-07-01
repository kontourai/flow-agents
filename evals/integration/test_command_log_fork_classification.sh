#!/usr/bin/env bash
# test_command_log_fork_classification.sh
#
# The verifier must tell a BENIGN concurrent fork apart from real TAMPER, and
# the repair tool must refuse to touch tamper. This is what prevents an honest
# parallel-write race from becoming a hard block an agent is tempted to launder.
#
#   forked  = two PostToolUse captures share a parent; all hashes self-consistent
#             and reachable. NON-blocking advisory; records stay trusted.
#   broken  = content edit (self-hash mismatch) / reorder / deletion / a
#             non-capture sibling on a shared parent. Hard block (unchanged).
#
# Also proves: repair re-linearizes forked→ok, and REFUSES broken (no laundering).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export GATE="$ROOT/scripts/hooks/stop-goal-fit.js"
REPAIR="$ROOT/scripts/repair-command-log.js"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
errors=0
_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

SD=".kontourai/flow-agents/s"

# Build a command-log from a spec: JSON array of {cmd,exit,src,parent} where
# parent is the 0-based index of the entry whose hash is this entry's prevHash
# (-1 = genesis). Lets us construct linear chains AND forks deterministically.
build() { # $1=dir $2=spec-json
  mkdir -p "$1/$SD"
  DIR="$1" node -e '
    const fs=require("fs"),crypto=require("crypto"),path=require("path");
    const g=require(process.env.GATE), GEN=g.CHAIN_GENESIS_VERIFY;
    const canon=r=>{const k=Object.keys(r).filter(x=>x!=="_chain").sort();const o={};for(const x of k)o[x]=r[x];return JSON.stringify(o);};
    const H=(p,r)=>crypto.createHash("sha256").update(p+canon(r)).digest("hex");
    const spec=JSON.parse(process.argv[1]); const hashes=[],lines=[];
    spec.forEach((s,i)=>{
      const rec={command:s.cmd,observedResult:s.exit===0?"pass":"fail",exitCode:s.exit,
        capturedAt:new Date(Date.UTC(2026,0,1,0,0,i)).toISOString(),source:s.src||"postToolUse-capture"};
      const prev=s.parent===-1?GEN:hashes[s.parent]; const h=H(prev,rec);
      hashes.push(h); lines.push(JSON.stringify({...rec,_chain:{seq:i,prevHash:prev,hash:h}}));
    });
    fs.writeFileSync(path.join(process.env.DIR,".kontourai/flow-agents/s/command-log.jsonl"),lines.join("\n")+"\n");
  ' "$2"
}
status() { DIR="$1" node -e 'const g=require(process.env.GATE);console.log(g.verifyCommandLogChain(process.env.DIR+"/.kontourai/flow-agents/s").status)' ; }

# ── 1. linear → ok ────────────────────────────────────────────────────────────
D="$TMP/linear"; build "$D" '[{"cmd":"a","exit":0,"parent":-1},{"cmd":"b","exit":0,"parent":0}]'
[ "$(status "$D")" = "ok" ] && _pass "linear chain → ok" || _fail "linear → $(status "$D"), want ok"

# ── 2. concurrent fork (two captures share a parent) → forked ─────────────────
D="$TMP/fork"; build "$D" '[{"cmd":"a","exit":0,"parent":-1},{"cmd":"b","exit":0,"parent":0},{"cmd":"c","exit":0,"parent":0}]'
[ "$(status "$D")" = "forked" ] && _pass "concurrent fork → forked (not broken)" || _fail "fork → $(status "$D"), want forked"

# ── 3. content edit (flip exitCode, keep hash) → broken ───────────────────────
D="$TMP/flip"; build "$D" '[{"cmd":"npm test","exit":0,"parent":-1},{"cmd":"npm run lint","exit":1,"parent":0}]'
python3 - "$D/$SD/command-log.jsonl" <<'PY'
import json,sys
L=open(sys.argv[1]).read().strip().split("\n"); e=json.loads(L[1]); e["exitCode"]=0; e["observedResult"]="pass"
L[1]=json.dumps(e); open(sys.argv[1],"w").write("\n".join(L)+"\n")
PY
[ "$(status "$D")" = "broken" ] && _pass "content edit → broken (tamper, not fork)" || _fail "flip → $(status "$D"), want broken"

# ── 4. reorder → broken ───────────────────────────────────────────────────────
D="$TMP/reorder"; build "$D" '[{"cmd":"a","exit":0,"parent":-1},{"cmd":"b","exit":0,"parent":0}]'
python3 - "$D/$SD/command-log.jsonl" <<'PY'
import sys
L=open(sys.argv[1]).read().strip().split("\n"); L[0],L[1]=L[1],L[0]; open(sys.argv[1],"w").write("\n".join(L)+"\n")
PY
[ "$(status "$D")" = "broken" ] && _pass "reorder → broken" || _fail "reorder → $(status "$D"), want broken"

# ── 5. deleted predecessor → broken ───────────────────────────────────────────
D="$TMP/delete"; build "$D" '[{"cmd":"a","exit":0,"parent":-1},{"cmd":"b","exit":0,"parent":0}]'
python3 - "$D/$SD/command-log.jsonl" <<'PY'
import sys
L=open(sys.argv[1]).read().strip().split("\n"); open(sys.argv[1],"w").write(L[1]+"\n")
PY
[ "$(status "$D")" = "broken" ] && _pass "deleted predecessor → broken" || _fail "delete → $(status "$D"), want broken"

# ── 6. non-capture sibling on a shared parent → broken (not a benign fork) ─────
D="$TMP/badfork"; build "$D" '[{"cmd":"a","exit":0,"parent":-1},{"cmd":"b","exit":0,"parent":0},{"cmd":"c","exit":0,"parent":0,"src":"manual-inject"}]'
[ "$(status "$D")" = "broken" ] && _pass "non-capture sibling fork → broken (conservative)" || _fail "badfork → $(status "$D"), want broken"

# ── 7. repair re-linearizes forked → ok; refuses broken ───────────────────────
D="$TMP/fork2"; build "$D" '[{"cmd":"a","exit":0,"parent":-1},{"cmd":"b","exit":0,"parent":0},{"cmd":"c","exit":0,"parent":0}]'
node "$REPAIR" "$D/$SD" --reason "test" >/dev/null 2>&1
[ "$(status "$D")" = "ok" ] && _pass "repair: forked → ok" || _fail "repair forked → $(status "$D"), want ok"

D="$TMP/flip2"; build "$D" '[{"cmd":"x","exit":0,"parent":-1},{"cmd":"y","exit":1,"parent":0}]'
python3 - "$D/$SD/command-log.jsonl" <<'PY'
import json,sys
L=open(sys.argv[1]).read().strip().split("\n"); e=json.loads(L[1]); e["exitCode"]=0
L[1]=json.dumps(e); open(sys.argv[1],"w").write("\n".join(L)+"\n")
PY
before=$(cat "$D/$SD/command-log.jsonl")
set +e; node "$REPAIR" "$D/$SD" >/dev/null 2>&1; rc=$?; set -e
after=$(cat "$D/$SD/command-log.jsonl")
if [ "$rc" -ne 0 ] && [ "$before" = "$after" ]; then _pass "repair: REFUSES broken (exit!=0, log unchanged — no laundering)"; else _fail "repair touched/accepted a broken log (rc=$rc)"; fi

# ── 8. the Stop gate does NOT hard-block a forked log ─────────────────────────
D="$TMP/gate"; mkdir -p "$D/$SD"
printf '# Repo\n' > "$D/AGENTS.md"
printf '%s' '{"schema_version":"1.0","task_slug":"s","status":"delivered","phase":"done","updated_at":"2026-06-23T00:00:00Z","next_action":{"status":"done","summary":"done"}}' > "$D/$SD/state.json"
cat > "$D/$SD/s--deliver.md" <<'MD'
# s

branch: main
status: delivered
type: deliver

## Definition Of Done
- [x] tests pass

## Goal Fit Gate
- [x] acceptance verified

### Verdict: PASS
MD
# forked log whose captures are all PASS, so there is no contradiction to flag
build "$D" '[{"cmd":"npm test","exit":0,"parent":-1},{"cmd":"npm run build","exit":0,"parent":0},{"cmd":"npm run build","exit":0,"parent":0}]'
printf '%s' '{"schema_version":"1.0","task_slug":"s","verdict":"pass","checks":[{"id":"t","kind":"command","status":"pass","command":"npm test","summary":"ok"}]}' > "$D/$SD/evidence.json"
set +e
out=$(FLOW_AGENTS_GOAL_FIT_MODE=block FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip node "$GATE" 2>&1 <<< "{\"hook_event_name\":\"Stop\",\"cwd\":\"$D\"}")
rc=$?
set -e
if [ "$rc" -eq 0 ]; then _pass "gate does NOT hard-block forked log (exit 0)"; else _fail "gate blocked forked log (exit $rc): $out"; fi
echo "$out" | grep -q "concurrent-capture fork" && _pass "gate emits the concurrent-fork advisory" || _fail "missing fork advisory: $out"
echo "$out" | grep -q "command-log integrity check FAILED" && _fail "gate wrongly emitted tamper warning for a fork" || _pass "no false tamper warning for a fork"

echo ""
if [ "$errors" -eq 0 ]; then echo "fork classification tests passed."; exit 0; fi
echo "fork classification tests FAILED: $errors issue(s)."; exit 1
