#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

TMPDIR_EVAL="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_EVAL"' EXIT

errors=0
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

echo "=== Fixture Retirement Audit ==="

flow_agents_node fixture-retirement-audit --json > "$TMPDIR_EVAL/audit.json"
status=$?
[[ "$status" -eq 0 ]] && pass "fixture audit exits successfully" || fail "fixture audit exits successfully"

json_query() {
  node -e 'const fs=require("fs"); let cur=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); for (const part of process.argv[2].split(".")) cur=Array.isArray(cur) ? cur[Number(part)] : cur[part]; console.log(cur);' "$1" "$2"
}

[[ "$(json_query "$TMPDIR_EVAL/audit.json" "totals.scanned")" == "17" ]] && pass "audit scans all fixture groups" || fail "audit scans all fixture groups"
[[ "$(json_query "$TMPDIR_EVAL/audit.json" "totals.retire_candidates")" == "0" ]] && pass "audit finds no unowned retire candidates" || fail "audit finds no unowned retire candidates"
[[ "$(json_query "$TMPDIR_EVAL/audit.json" "totals.kept")" == "17" ]] && pass "audit keeps all owned fixture groups" || fail "audit keeps all owned fixture groups"

node - "$TMPDIR_EVAL/audit.json" <<'NODE'
const fs = require("node:fs");
const audit = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
for (const item of audit.fixtures) {
  if (item.classification !== "kept") throw new Error(`${item.fixture} should be kept`);
  if (!item.owners.length) throw new Error(`${item.fixture} has no owners`);
  if (!item.direct_refs.length) throw new Error(`${item.fixture} has no direct refs`);
  if (!item.reasons.includes("owned fixture with live eval/script references")) throw new Error(`${item.fixture} missing keep reason`);
}
NODE
status=$?
[[ "$status" -eq 0 ]] && pass "all kept fixtures have owners and live refs" || fail "all kept fixtures have owners and live refs"

flow_agents_node fixture-retirement-audit > "$TMPDIR_EVAL/audit.txt"
grep -q "Retire candidates: 0" "$TMPDIR_EVAL/audit.txt" && pass "text audit reports zero retire candidates" || fail "text audit reports zero retire candidates"
grep -q "kept: evals/fixtures/hook-influence" "$TMPDIR_EVAL/audit.txt" && pass "text audit lists kept hook influence fixture" || fail "text audit lists kept hook influence fixture"

flow_agents_node fixture-retirement-audit --help > "$TMPDIR_EVAL/help.txt"
if grep -Eq -- "--(apply|delete|archive)" "$TMPDIR_EVAL/help.txt"; then
  fail "help does not advertise destructive fixture actions"
else
  pass "help does not advertise destructive fixture actions"
fi

if [[ "$errors" -eq 0 ]]; then
  echo "Fixture retirement audit checks passed"
else
  echo "Fixture retirement audit checks failed: $errors"
fi

exit "$errors"
