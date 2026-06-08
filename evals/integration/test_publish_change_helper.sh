#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/publish-change-helper.js"
TMPDIR_EVAL="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_EVAL"' EXIT

errors=0
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

json_query() {
  node -e 'const fs=require("fs"); let cur=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); for (const part of process.argv[2].split(".")) cur=Array.isArray(cur) ? cur[Number(part)] : cur[part]; console.log(cur);' "$1" "$2"
}

echo "=== Publish Change Helper ==="

BODY="$TMPDIR_EVAL/body.md"
cat > "$BODY" <<'MD'
Summary line.

- first item
- second item

```sh
printf 'hello\n'
```

Closes #60
MD

cat > "$TMPDIR_EVAL/render-input.json" <<JSON
{
  "provider": "github",
  "change_provider": {"role": "ChangeProvider", "kind": "github"},
  "title": "Workflow hardening",
  "body_file": "$BODY",
  "expected_closing_refs": ["kontourai/flow-agents#60"]
}
JSON

node "$SCRIPT" render \
  --input-json "$TMPDIR_EVAL/render-input.json" \
  --body-out "$TMPDIR_EVAL/rendered-body.md" \
  > "$TMPDIR_EVAL/rendered.json"
status=$?
[[ "$status" -eq 0 ]] && pass "renders change request successfully" || fail "renders change request successfully"

cmp -s "$BODY" "$TMPDIR_EVAL/rendered-body.md" && pass "body file rendering preserves multiline markdown exactly" || fail "body file rendering preserves multiline markdown exactly"
node -e 'const fs=require("fs"); const expected=fs.readFileSync(process.argv[1],"utf8"); const actual=JSON.parse(fs.readFileSync(process.argv[2],"utf8")).body; process.exit(actual === expected ? 0 : 1);' "$BODY" "$TMPDIR_EVAL/rendered.json"
[[ "$?" -eq 0 ]] && pass "rendered JSON body preserves real multiline text" || fail "rendered JSON body preserves real multiline text"
[[ "$(json_query "$TMPDIR_EVAL/rendered.json" "change_provider.role")" == "ChangeProvider" ]] && pass "rendered request keeps provider-neutral ChangeProvider role" || fail "rendered request keeps provider-neutral ChangeProvider role"

cat > "$TMPDIR_EVAL/closing-pass.json" <<'JSON'
{
  "provider": "github",
  "default_owner": "kontourai",
  "default_repo": "flow-agents",
  "expected_closing_refs": ["#60"],
  "provider_output": {
    "recognized_closing_refs": ["kontourai/flow-agents#60"]
  }
}
JSON

node "$SCRIPT" validate-closing-refs \
  --input-json "$TMPDIR_EVAL/closing-pass.json" \
  > "$TMPDIR_EVAL/closing-pass.out"
status=$?
[[ "$status" -eq 0 ]] && pass "recognized closing refs pass validation" || fail "recognized closing refs pass validation"
[[ "$(json_query "$TMPDIR_EVAL/closing-pass.out" "status")" == "pass" ]] && pass "closing ref pass result is explicit" || fail "closing ref pass result is explicit"

cat > "$TMPDIR_EVAL/closing-missing.json" <<'JSON'
{
  "provider": "github",
  "default_owner": "kontourai",
  "default_repo": "flow-agents",
  "expected_closing_refs": ["#60"],
  "provider_output": {
    "recognized_closing_refs": []
  }
}
JSON

if node "$SCRIPT" validate-closing-refs \
  --input-json "$TMPDIR_EVAL/closing-missing.json" \
  > "$TMPDIR_EVAL/closing-missing.out" \
  2> "$TMPDIR_EVAL/closing-missing.err"; then
  fail "missing recognized closing refs should fail"
elif [[ "$(json_query "$TMPDIR_EVAL/closing-missing.out" "status")" == "fail" ]] && rg -q "missing recognized closing refs" "$TMPDIR_EVAL/closing-missing.err"; then
  pass "missing closing refs fail with actionable output"
else
  fail "missing closing refs failure was not actionable"
fi

cat > "$TMPDIR_EVAL/docs-files.json" <<'JSON'
{"files": ["docs/workflow-usage-guide.md", "docs/work-item-adapters.md"]}
JSON
cat > "$TMPDIR_EVAL/empty-checks.json" <<'JSON'
[]
JSON

node "$SCRIPT" evaluate-provider-checks \
  --change-files-json "$TMPDIR_EVAL/docs-files.json" \
  --provider-checks-json "$TMPDIR_EVAL/empty-checks.json" \
  > "$TMPDIR_EVAL/docs-checks.out"
status=$?
[[ "$status" -eq 0 ]] && pass "docs-only missing provider checks are accepted as skip" || fail "docs-only missing provider checks are accepted as skip"
[[ "$(json_query "$TMPDIR_EVAL/docs-checks.out" "evidence_status")" == "skip" ]] && pass "docs-only missing checks map to evidence skip" || fail "docs-only missing checks map to evidence skip"
[[ "$(json_query "$TMPDIR_EVAL/docs-checks.out" "release_gate_status")" == "not_required" ]] && pass "docs-only missing checks map to release not_required" || fail "docs-only missing checks map to release not_required"

for risk in runtime schema package hook security; do
  case "$risk" in
    runtime) path="scripts/flow-kit.js" ;;
    schema) path="schemas/workflow-evidence.schema.json" ;;
    package) path="package.json" ;;
    hook) path="scripts/hooks/quality-gate.js" ;;
    security) path="security/policy.md" ;;
  esac
  printf '{"files":["%s"]}\n' "$path" > "$TMPDIR_EVAL/$risk-files.json"
  if node "$SCRIPT" evaluate-provider-checks \
    --change-files-json "$TMPDIR_EVAL/$risk-files.json" \
    --provider-checks-json "$TMPDIR_EVAL/empty-checks.json" \
    > "$TMPDIR_EVAL/$risk-checks.out" \
    2> "$TMPDIR_EVAL/$risk-checks.err"; then
    fail "$risk missing provider checks should not pass"
  elif [[ "$(json_query "$TMPDIR_EVAL/$risk-checks.out" "evidence_status")" == "not_verified" ]] \
    && [[ "$(json_query "$TMPDIR_EVAL/$risk-checks.out" "release_gate_status")" == "hold" ]]; then
    pass "$risk missing provider checks map to not_verified and hold"
  else
    fail "$risk missing provider checks did not map to not_verified and hold"
  fi
done

mkdir -p "$TMPDIR_EVAL/final-state"
cat > "$TMPDIR_EVAL/final-state/evidence.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "final-state",
  "updated_at": "2026-05-29T00:00:00Z",
  "verdict": "pass",
  "summary": "Final orchestrated evidence passed.",
  "checks": [
    {"id": "focused-tests", "kind": "test", "status": "pass", "summary": "Focused tests passed."}
  ]
}
JSON
cat > "$TMPDIR_EVAL/final-state/release.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "final-state",
  "updated_at": "2026-05-29T00:00:00Z",
  "decision": "merge",
  "scope": "Final state reconciliation fixture.",
  "summary": "Final release state passed.",
  "evidence_ref": "evidence.json",
  "gates": [
    {"id": "merge", "kind": "merge", "status": "pass", "required": true, "summary": "Merge gate passed.", "evidence_refs": ["evidence.json"]}
  ],
  "rollback_plan": {"status": "not_required", "summary": "Merge-only fixture."}
}
JSON

node "$SCRIPT" reconcile-final-state "$TMPDIR_EVAL/final-state" > "$TMPDIR_EVAL/reconcile.out"
status=$?
[[ "$status" -eq 0 ]] && pass "final reconciled evidence and release sidecars pass" || fail "final reconciled evidence and release sidecars pass"
[[ "$(json_query "$TMPDIR_EVAL/reconcile.out" "status")" == "pass" ]] && pass "final reconciliation result is explicit" || fail "final reconciliation result is explicit"

if [[ "$errors" -eq 0 ]]; then
  echo "Publish change helper checks passed"
else
  echo "Publish change helper checks failed: $errors"
fi

exit "$errors"
