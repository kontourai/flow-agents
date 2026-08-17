#!/usr/bin/env bash
# Measure what a builder.build run COSTS in CLI invocations, in a fresh repo. #1264.
#
# The 52% figure that motivated this was derived by hand, driving a run and counting.
# A number nobody can re-derive cannot show a fix working, so this drives the same path
# and reports the same counts mechanically.
#
# Deliberately runs against a FRESH `init` in a throwaway repo with an isolated HOME. That
# is the whole point: the tests-evidence path worked in this repository and nowhere else,
# because this repository happens to ignore .kontourai/ and a fresh install did not. A
# measurement taken inside the developing repo would have reported everything healthy.
#
# Usage: run-cost.sh [--json]
set -uo pipefail

EMIT_JSON=0
[ "${1:-}" = "--json" ] && EMIT_JSON=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLI="$ROOT/build/src/cli.js"
if [ ! -f "$CLI" ]; then echo "run-cost.sh: no build at $CLI (run npm run build)" >&2; exit 69; fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/home"; mkdir -p "$HOME"
REPO="$TMP/repo"; mkdir -p "$REPO"

git -C "$REPO" init -q -b main
git -C "$REPO" config user.email cost@example.invalid
git -C "$REPO" config user.name "Run Cost"
printf 'node_modules\n' > "$REPO/.gitignore"
printf '# fixture\n' > "$REPO/README.md"
mkdir -p "$REPO/test"
cat > "$REPO/test/sanity.test.mjs" <<'EOF'
import test from "node:test";
import assert from "node:assert/strict";
test("sanity", () => { assert.equal(1 + 1, 2); });
EOF
cat > "$REPO/package.json" <<'EOF'
{ "name": "run-cost-fixture", "version": "1.0.0", "private": true,
  "scripts": { "test": "node --test test/sanity.test.mjs" } }
EOF
git -C "$REPO" add -A >/dev/null 2>&1
git -C "$REPO" commit -q -m "fixture baseline"

node "$CLI" init --runtime claude-code --dest "$REPO" >/dev/null 2>&1 || {
  echo "run-cost.sh: init failed" >&2; exit 70; }
git -C "$REPO" add -A >/dev/null 2>&1
git -C "$REPO" commit -q -m "install" >/dev/null 2>&1

SLUG="wedge-run-cost"
D=".kontourai/flow-agents/$SLUG"
mkdir -p "$REPO/$D"
printf 'Selected Work Item: wedge:run-cost\n' > "$REPO/$D/$SLUG--pull-work.md"
printf '# Plan\n' > "$REPO/$D/$SLUG--plan-work.md"
printf '# Delivery\n' > "$REPO/$D/$SLUG--deliver.md"
printf '# Evidence gate\n' > "$REPO/$D/$SLUG--evidence-gate.md"
git -C "$REPO" add -A >/dev/null 2>&1
git -C "$REPO" commit -q -m "run artifacts" >/dev/null 2>&1

TALLY="$TMP/tally.tsv"; : > "$TALLY"
fa() { # key, then argv
  local key="$1"; shift
  local out
  out="$( (cd "$REPO" && node "$CLI" "$@" 2>&1) )"
  local code=$?
  # A refusal records WHY. An instrument that reports only an exit code makes its own
  # output un-actionable, which is the defect class it was built to measure.
  local why=""
  # Two formats, deliberately: `flow-agents <verb>: msg` is what the current CLI emits
  # (#1260), `Error: msg` is what older builds emit. Parsing only the newer one would make
  # this instrument silently reasonless against any published version.
  if [ "$code" -ne 0 ]; then
    why="$(printf '%s\n' "$out" | sed -n 's/^flow-agents[^:]*: //p' | head -1 | cut -c1-150)"
    [ -n "$why" ] || why="$(printf '%s\n' "$out" | sed -n 's/^.*Error: //p' | head -1 | cut -c1-150)"
    [ -n "$why" ] || why="$(printf '%s\n' "$out" | head -1 | cut -c1-150)"
  fi
  printf '%s\t%s\t%s\n' "$key" "$code" "$why" >> "$TALLY"
  return $code
}

fa start workflow start --flow builder.build --work-item 'wedge:run-cost' --assignment-provider local-file

A="$D/$SLUG--pull-work.md"
ev() { # expectation, artifact
  fa "$1" workflow evidence --session-dir "$D" --status pass --expectation "$1" \
     --summary "Recorded $1." \
     --evidence-ref-json "{\"kind\":\"artifact\",\"file\":\"$2\",\"summary\":\"$1\"}"
}
ev pickup-probe-readiness "$A"
ev probe-decisions-or-accepted-gaps "$A"
ev implementation-plan "$D/$SLUG--plan-work.md"
ev implementation-scope "$D/$SLUG--deliver.md"

crit() {
  (cd "$REPO" && FLOW_AGENTS_ACTOR=cost-reviewer node "$CLI" workflow critique --session-dir "$D" \
     --id cost-review --verdict pass --summary 'Independent review clean.' \
     --artifact-ref "$D/$SLUG--deliver.md" \
     --lane-json "{\"id\":\"code-review\",\"status\":\"pass\",\"summary\":\"Reviewed.\",\"evidence_refs\":[{\"kind\":\"artifact\",\"file\":\"$D/$SLUG--deliver.md\",\"summary\":\"Delivery\"}]}" \
     >/dev/null 2>&1)
  printf 'critique\t%s\t\n' "$?" >> "$TALLY"
}
crit
ev clean-critique "$D/$SLUG--deliver.md"
ev acceptance-criteria "$D/$SLUG--plan-work.md"

# The declared criterion id is DERIVED from the run, never guessed: guessing it was one of
# the ten discovery failures this instrument exists to count.
crit  # a current clean critique is required AFTER the other verify evidence

# The declared acceptance-criterion id is NOT readable from `workflow status` or state.json.
# The only channel that names it is the refusal itself, so the honest way to model the cost
# is to take the refusal and count it. This probe deliberately fails first.
# Probing with a KNOWINGLY WRONG id, because omitting the flag yields only a generic
# "supply one for every declared criterion" while supplying a wrong one yields
# "expected: <the actual id>; received: <yours>". The id is discoverable only by being
# wrong about it first. That is the cost being measured, not a trick of this script.
first_out="$( (cd "$REPO" && node "$CLI" workflow evidence --session-dir "$D" --status pass \
  --expectation tests-evidence --summary "Observed the declared test command." --command 'npm test' \
  --criterion-json '{"id":"probe-for-the-declared-id","status":"pass","evidence_refs":[]}' \
  --evidence-ref-json '{"kind":"command","excerpt":"npm test","summary":"Declared test command"}' 2>&1) )"
first_code=$?
if [ "$first_code" -eq 0 ]; then
  printf 'tests-evidence\t0\t\n' >> "$TALLY"
else
  printf 'tests-evidence-discovery\t%s\t%s\n' "$first_code" \
    "$(printf '%s\n' "$first_out" | sed -n 's/^flow-agents[^:]*: //p' | head -1 | cut -c1-150)" >> "$TALLY"
  CRIT_ID="$(printf '%s\n' "$first_out" | sed -n 's/.*expected: \([a-z0-9-]*\).*/\1/p' | head -1)"
  if [ -n "$CRIT_ID" ] && [ "$CRIT_ID" != "none" ]; then
    fa tests-evidence workflow evidence --session-dir "$D" --status pass --expectation tests-evidence \
      --summary "Observed the declared test command." --command 'npm test' \
      --criterion-json "{\"id\":\"$CRIT_ID\",\"status\":\"pass\",\"evidence_refs\":[{\"kind\":\"command\",\"excerpt\":\"npm test\",\"summary\":\"Declared test command\"}]}" \
      --evidence-ref-json '{"kind":"command","excerpt":"npm test","summary":"Declared test command"}'
  else
    printf 'tests-evidence\t%s\t%s\n' "$first_code" "criterion id not discoverable from the refusal" >> "$TALLY"
  fi
fi

ev merge-readiness "$D/$SLUG--evidence-gate.md"

STEP="$( (cd "$REPO" && node "$CLI" workflow status --session-dir "$D" --json 2>/dev/null) \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);
      process.stdout.write(String(j.current_step??j.step??"unknown"))}catch{process.stdout.write("unknown")}})' )"

total=$(wc -l < "$TALLY" | tr -d ' ')
failed=$(awk -F'\t' '$2!=0' "$TALLY" | wc -l | tr -d ' ')
rate=0; [ "$total" -gt 0 ] && rate=$(( failed * 100 / total ))

if [ "$EMIT_JSON" -eq 1 ]; then
  rows=""
  while IFS=$'\t' read -r k c w; do
    [ -n "$rows" ] && rows="$rows,"
    esc="$(printf '%s' "$w" | sed 's/\\/\\\\/g; s/"/\\"/g')"
    rows="$rows{\"id\":\"$k\",\"verdict\":\"$([ "$c" = 0 ] && echo LANDED || echo REFUSED)\",\"exit\":$c,\"reason\":\"$esc\"}"
  done < "$TALLY"
  printf '{"measurement":"builder-run-cost","reached_step":"%s","invocations":%s,"failed":%s,"failure_pct":%s,"probes":[%s]}\n' \
    "$STEP" "$total" "$failed" "$rate" "$rows"
else
  printf '\nBUILDER RUN COST (fresh init, isolated HOME)\n\n'
  awk -F'\t' '{printf "  %-34s %s\n", $1, ($2==0 ? "LANDED" : "REFUSED  " $3)}' "$TALLY"
  printf '\n  reached step: %s\n' "$STEP"
  printf '  %s invocations, %s refused (%s%%)\n\n' "$total" "$failed" "$rate"
fi
exit 0
