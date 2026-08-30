#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/ci/codex-pr-review.mjs"
ACTION="$ROOT_DIR/.github/actions/codex-pr-review/action.yml"
DOC="$ROOT_DIR/docs/codex-pr-review-adoption.md"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

pass=0
fail=0
ok() { echo "  ✓ $1"; pass=$((pass + 1)); }
bad() { echo "  ✗ $1" >&2; fail=$((fail + 1)); }
expect_success() { if "$@"; then ok "$1 succeeds"; else bad "$1 should succeed"; fi; }
expect_failure() { if "$@" >/dev/null 2>&1; then bad "$1 should fail"; else ok "$1 fails closed"; fi; }

for file in \
  "$SCRIPT" \
  "$ACTION" \
  "$DOC" \
  "$ROOT_DIR/schemas/codex-pr-review-assessment.schema.json" \
  "$ROOT_DIR/schemas/codex-pr-review-result.schema.json"; do
  [[ -f "$file" ]] && ok "${file#$ROOT_DIR/} exists" || bad "${file#$ROOT_DIR/} is missing"
done

REPO="$TMP_ROOT/repo"
mkdir -p "$REPO/src"
git -C "$REPO" init -q
git -C "$REPO" config user.name "Flow Agents Test"
git -C "$REPO" config user.email "flow-agents-test@example.invalid"
printf '%s\n' 'export const value = 1;' > "$REPO/src/value.js"
git -C "$REPO" add src/value.js
git -C "$REPO" commit -qm base
BASE_SHA="$(git -C "$REPO" rev-parse HEAD)"
printf '%s\n' 'export const value = 2;' 'export const doubled = value * 2;' > "$REPO/src/value.js"
git -C "$REPO" add src/value.js
git -C "$REPO" commit -qm head
HEAD_SHA="$(git -C "$REPO" rev-parse HEAD)"

common_env=(
  "REVIEW_REPOSITORY=kontourai/test-repo"
  "REVIEW_PULL_REQUEST=42"
  "REVIEW_BASE_SHA=$BASE_SHA"
  "REVIEW_HEAD_SHA=$HEAD_SHA"
  "REVIEW_MODEL=gpt-5.6-sol"
  "REVIEW_EFFORT=xhigh"
  "REVIEW_RUN_ID=12345"
  "REVIEW_TRIGGER_ACTOR=trusted-reviewer"
  "REVIEW_WORKSPACE=$REPO"
)

OUTPUT_FILE="$TMP_ROOT/github-output"
: > "$OUTPUT_FILE"
if env "${common_env[@]}" GITHUB_OUTPUT="$OUTPUT_FILE" RUNNER_TEMP="$TMP_ROOT" node "$SCRIPT" prepare >/dev/null; then
  ok "prepare binds the exact checked-out head"
else
  bad "prepare should bind the exact checked-out head"
fi

output_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$OUTPUT_FILE" | tail -n 1
}

TARGET_FILE="$(output_value target-file)"
ASSESSMENT_FILE="$(output_value assessment-file)"
RESULT_FILE="$(output_value result-file)"

node -e 'const fs=require("fs"); const [file,head]=process.argv.slice(1); const value=JSON.parse(fs.readFileSync(file,"utf8")); if(value.head_sha!==head||value.changed_file_count!==1||value.changed_files[0].path!=="src/value.js") process.exit(1)' "$TARGET_FILE" "$HEAD_SHA" \
  && ok "target records the exact head and changed-file inventory" \
  || bad "target should record the exact head and changed-file inventory"

printf '%s\n' '{"verdict":"pass","summary":"No material findings.","coverage":[{"lane":"code","status":"pass","summary":"Reviewed the changed code."}],"findings":[],"gaps":[]}' > "$ASSESSMENT_FILE"
if env "${common_env[@]}" REVIEW_TARGET_FILE="$TARGET_FILE" REVIEW_ASSESSMENT_FILE="$ASSESSMENT_FILE" REVIEW_RESULT_FILE="$RESULT_FILE" node "$SCRIPT" finalize >/dev/null; then
  ok "clean assessment finalizes"
else
  bad "clean assessment should finalize"
fi

node -e 'const fs=require("fs"); const [file,head]=process.argv.slice(1); const value=JSON.parse(fs.readFileSync(file,"utf8")); if(value.role!=="CodexPullRequestReview"||value.target.head_sha!==head||value.reviewer.model!=="gpt-5.6-sol"||value.verdict!=="pass") process.exit(1)' "$RESULT_FILE" "$HEAD_SHA" \
  && ok "final result binds runner-owned target and reviewer identity" \
  || bad "final result should bind runner-owned target and reviewer identity"

printf '%s\n' '{"verdict":"fail","summary":"Blocking correctness finding.","coverage":[{"lane":"code","status":"fail","summary":"A changed line is incorrect."}],"findings":[{"id":"correctness-1","severity":"high","file":"src/value.js","line":2,"title":"Incorrect behavior","description":"The changed expression does not satisfy the stated invariant."}],"gaps":[]}' > "$ASSESSMENT_FILE"
if env "${common_env[@]}" REVIEW_TARGET_FILE="$TARGET_FILE" REVIEW_ASSESSMENT_FILE="$ASSESSMENT_FILE" REVIEW_RESULT_FILE="$RESULT_FILE" node "$SCRIPT" finalize >/dev/null; then
  ok "blocking finding finalizes only with fail verdict"
else
  bad "blocking finding should finalize with fail verdict"
fi

printf '%s\n' '{"verdict":"pass","summary":"Incorrectly clean.","coverage":[{"lane":"code","status":"pass","summary":"Claimed clean."}],"findings":[{"id":"hidden-blocker","severity":"high","file":"src/value.js","line":2,"title":"Blocker","description":"A blocker cannot be paired with pass."}],"gaps":[]}' > "$ASSESSMENT_FILE"
if env "${common_env[@]}" REVIEW_TARGET_FILE="$TARGET_FILE" REVIEW_ASSESSMENT_FILE="$ASSESSMENT_FILE" REVIEW_RESULT_FILE="$RESULT_FILE" node "$SCRIPT" finalize >/dev/null 2>&1; then
  bad "pass verdict should not launder a blocking finding"
else
  ok "pass verdict cannot launder a blocking finding"
fi

printf '%s\n' '{"verdict":"not_verified","summary":"Coverage unavailable.","coverage":[{"lane":"code","status":"not_verified","summary":"Reviewer could not inspect the change."}],"findings":[],"gaps":["Required source coverage was unavailable."]}' > "$ASSESSMENT_FILE"
if env "${common_env[@]}" REVIEW_TARGET_FILE="$TARGET_FILE" REVIEW_ASSESSMENT_FILE="$ASSESSMENT_FILE" REVIEW_RESULT_FILE="$RESULT_FILE" node "$SCRIPT" finalize >/dev/null; then
  ok "NOT_VERIFIED assessment preserves a named gap"
else
  bad "NOT_VERIFIED assessment should preserve a named gap"
fi

if env "${common_env[@]}" REVIEW_TARGET_FILE="$TARGET_FILE" REVIEW_RESULT_FILE="$RESULT_FILE" node "$SCRIPT" skip >/dev/null \
  && node -e 'const fs=require("fs"); const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(value.verdict!=="not_verified"||value.gaps.length===0) process.exit(1)' "$RESULT_FILE"; then
  ok "missing credential path emits exact-head NOT_VERIFIED"
else
  bad "missing credential path should emit exact-head NOT_VERIFIED"
fi

if env "${common_env[@]}" REVIEW_HEAD_SHA="$BASE_SHA" GITHUB_OUTPUT="$TMP_ROOT/stale-output" RUNNER_TEMP="$TMP_ROOT" node "$SCRIPT" prepare >/dev/null 2>&1; then
  bad "prepare should reject stale expected head"
else
  ok "prepare rejects stale expected head"
fi

printf '%s\n' '{"verdict":"pass","summary":"Malformed.","coverage":[{"lane":"code","status":"pass","summary":"Reviewed."}],"findings":[],"gaps":[],"extra":true}' > "$ASSESSMENT_FILE"
if env "${common_env[@]}" REVIEW_TARGET_FILE="$TARGET_FILE" REVIEW_ASSESSMENT_FILE="$ASSESSMENT_FILE" REVIEW_RESULT_FILE="$RESULT_FILE" node "$SCRIPT" finalize >/dev/null 2>&1; then
  bad "finalize should reject undeclared assessment fields"
else
  ok "finalize rejects undeclared assessment fields"
fi

if env "${common_env[@]}" REVIEW_TRIGGER_ACTOR="" REVIEW_TARGET_FILE="$TARGET_FILE" REVIEW_ASSESSMENT_FILE="$ASSESSMENT_FILE" REVIEW_RESULT_FILE="$RESULT_FILE" node "$SCRIPT" finalize >/dev/null 2>&1; then
  bad "finalize should reject missing trigger identity"
else
  ok "finalize rejects missing trigger identity"
fi

grep -Fq 'openai/codex-action@86365089eb2b84e0a8fb0717b304f8bdcb13b20e' "$ACTION" \
  && ok "official Codex action is pinned to an exact revision" \
  || bad "official Codex action must be pinned to an exact revision"
grep -Fq 'sandbox: read-only' "$ACTION" && grep -Fq 'safety-strategy: drop-sudo' "$ACTION" \
  && ok "Codex review is report-only and drops sudo" \
  || bad "Codex review must be report-only and drop sudo"
grep -Fq 'openai-api-key:' "$ACTION" \
  && grep -Fq "inputs['openai-api-key']" "$ACTION" \
  && ! grep -Eq '^\s+OPENAI_API_KEY:' "$ACTION" \
  && ok "OpenAI credential is action-scoped rather than job environment state" \
  || bad "OpenAI credential must be action-scoped"
grep -Fq 'continue-on-error: true' "$ACTION" \
  && ok "comment publication cannot rewrite the review verdict" \
  || bad "comment publication should remain advisory"
grep -Fq 'model: gpt-5.6-sol' "$DOC" && grep -Fq 'Station is a useful first consumer' "$DOC" \
  && ok "adoption docs target Sol and preserve Station as consumer" \
  || bad "adoption docs should target Sol and preserve Station as consumer"
grep -Fq -- '--route-reason implementation_defect' "$ROOT_DIR/kits/builder/skills/release-readiness/SKILL.md" \
  && grep -Fq -- '--route-reason missing_evidence' "$ROOT_DIR/kits/builder/skills/release-readiness/SKILL.md" \
  && ok "release-readiness documents exact route-back classifiers" \
  || bad "release-readiness should document exact route-back classifiers"

node -e 'const fs=require("fs"); for (const file of process.argv.slice(1)) JSON.parse(fs.readFileSync(file,"utf8"));' \
  "$ROOT_DIR/schemas/codex-pr-review-assessment.schema.json" \
  "$ROOT_DIR/schemas/codex-pr-review-result.schema.json" \
  && ok "review schemas are valid JSON" \
  || bad "review schemas should be valid JSON"

echo ""
echo "Results: ${pass}/$((pass + fail)) passed, ${fail} failed"
[[ "$fail" -eq 0 ]]
