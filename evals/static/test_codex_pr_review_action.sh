#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/ci/codex-pr-review.mjs"
ACTION="$ROOT_DIR/.github/actions/codex-pr-review/action.yml"
DOC="$ROOT_DIR/docs/codex-pr-review-adoption.md"
TMP_ROOT="$(mktemp -d)"
SERVER_PID=""
cleanup() {
  [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

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
printf '%s\n' 'export const unusual = true;' > "$REPO/src/@review\`path.js"
git -C "$REPO" add src/value.js
git -C "$REPO" add 'src/@review`path.js'
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

node -e 'const fs=require("fs"); const [file,head]=process.argv.slice(1); const value=JSON.parse(fs.readFileSync(file,"utf8")); if(value.head_sha!==head||value.changed_file_count!==2||!value.changed_files.some((entry)=>entry.path==="src/value.js")) process.exit(1)' "$TARGET_FILE" "$HEAD_SHA" \
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

printf '%s\n' '{"verdict":"fail","summary":"Blocking correctness finding.","coverage":[{"lane":"code","status":"fail","summary":"A changed line is incorrect."}],"findings":[{"id":"correctness-1","severity":"high","requires_change":true,"file":"src/value.js","line":2,"title":"Incorrect behavior","description":"The changed expression does not satisfy the stated invariant."}],"gaps":[]}' > "$ASSESSMENT_FILE"
if env "${common_env[@]}" REVIEW_TARGET_FILE="$TARGET_FILE" REVIEW_ASSESSMENT_FILE="$ASSESSMENT_FILE" REVIEW_RESULT_FILE="$RESULT_FILE" node "$SCRIPT" finalize >/dev/null; then
  ok "blocking finding finalizes only with fail verdict"
else
  bad "blocking finding should finalize with fail verdict"
fi

printf '%s\n' '{"verdict":"pass","summary":"Incorrectly clean.","coverage":[{"lane":"code","status":"pass","summary":"Claimed clean."}],"findings":[{"id":"hidden-blocker","severity":"high","requires_change":true,"file":"src/value.js","line":2,"title":"Blocker","description":"A blocker cannot be paired with pass."}],"gaps":[]}' > "$ASSESSMENT_FILE"
if env "${common_env[@]}" REVIEW_TARGET_FILE="$TARGET_FILE" REVIEW_ASSESSMENT_FILE="$ASSESSMENT_FILE" REVIEW_RESULT_FILE="$RESULT_FILE" node "$SCRIPT" finalize >/dev/null 2>&1; then
  bad "pass verdict should not launder a blocking finding"
else
  ok "pass verdict cannot launder a blocking finding"
fi

printf '%s\n' '{"verdict":"comment","summary":"Improperly advisory.","coverage":[{"lane":"code","status":"pass","summary":"A medium defect needs a fix."}],"findings":[{"id":"medium-fix","severity":"medium","requires_change":true,"file":"src/value.js","line":2,"title":"Fix required","description":"This medium finding requires a code change before delivery."}],"gaps":[]}' > "$ASSESSMENT_FILE"
if env "${common_env[@]}" REVIEW_TARGET_FILE="$TARGET_FILE" REVIEW_ASSESSMENT_FILE="$ASSESSMENT_FILE" REVIEW_RESULT_FILE="$RESULT_FILE" node "$SCRIPT" finalize >/dev/null 2>&1; then
  bad "comment verdict should not launder a medium finding that requires change"
else
  ok "medium requires_change finding routes as fail"
fi

printf '%s\n' '{"verdict":"fail","summary":"Inconsistent critical finding.","coverage":[{"lane":"code","status":"fail","summary":"Critical finding."}],"findings":[{"id":"critical-advisory","severity":"critical","requires_change":false,"file":"src/value.js","line":2,"title":"Critical advisory","description":"Critical severity cannot be advisory."}],"gaps":[]}' > "$ASSESSMENT_FILE"
if env "${common_env[@]}" REVIEW_TARGET_FILE="$TARGET_FILE" REVIEW_ASSESSMENT_FILE="$ASSESSMENT_FILE" REVIEW_RESULT_FILE="$RESULT_FILE" node "$SCRIPT" finalize >/dev/null 2>&1; then
  bad "critical finding should require requires_change=true"
else
  ok "critical/high findings cannot contradict required-change routing"
fi

printf '%s\n' '{"verdict":"fail","summary":"Inconsistent low finding.","coverage":[{"lane":"code","status":"pass","summary":"Low advisory finding."}],"findings":[{"id":"low-blocking","severity":"low","requires_change":true,"file":"src/value.js","line":2,"title":"Low blocker","description":"Low severity cannot request route-back."}],"gaps":[]}' > "$ASSESSMENT_FILE"
if env "${common_env[@]}" REVIEW_TARGET_FILE="$TARGET_FILE" REVIEW_ASSESSMENT_FILE="$ASSESSMENT_FILE" REVIEW_RESULT_FILE="$RESULT_FILE" node "$SCRIPT" finalize >/dev/null 2>&1; then
  bad "low finding should require requires_change=false"
else
  ok "low/info findings cannot contradict advisory routing"
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
grep -Fq 'project_doc_max_bytes=0' "$ACTION" \
  && grep -Fq 'project_doc_fallback_filenames=[]' "$ACTION" \
  && grep -Fq "steps.prepare.outputs['review-working-directory']" "$ACTION" \
  && ! grep -Fq -- '--ignore-user-config' "$ACTION" \
  && ! grep -Fq -- '--skip-git-repo-check' "$ACTION" \
  && ok "protected Codex args disable project instruction discovery from a separate trusted cwd" \
  || bad "Codex action must use protected-compatible args and a trusted non-project cwd"
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

node - "$ROOT_DIR/schemas/codex-pr-review-assessment.schema.json" <<'NODE'
const fs = require("node:fs");
const schema = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const unsupported = new Set([
  "allOf",
  "contains",
  "dependentRequired",
  "dependentSchemas",
  "else",
  "if",
  "not",
  "then",
]);
function walk(value, path = "$") {
  if (Array.isArray(value)) return value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (unsupported.has(key)) throw new Error(`${path}.${key} is unsupported by OpenAI Structured Outputs`);
    walk(entry, `${path}.${key}`);
  }
}
walk(schema);
NODE
if [[ "$?" -eq 0 ]]; then
  ok "provider assessment schema uses the OpenAI Structured Outputs subset"
else
  bad "provider assessment schema must avoid unsupported Structured Outputs keywords"
fi

# Validate the public result schema with the same Ajv 2020 implementation used
# elsewhere in this repository. The schema must reject malformed core arrays,
# not merely rely on the producer's private validation.
printf '%s\n' '{"verdict":"fail","summary":"Blocking correctness finding.","coverage":[{"lane":"code","status":"fail","summary":"A changed line is incorrect."}],"findings":[{"id":"correctness-1","severity":"high","requires_change":true,"file":"src/value.js","line":2,"title":"Incorrect behavior","description":"The changed expression does not satisfy the stated invariant."},{"id":"odd-path","severity":"low","requires_change":false,"file":"src/@review`path.js","line":99,"title":"Advisory path note","description":"This finding is intentionally outside a changed line."}],"gaps":[]}' > "$ASSESSMENT_FILE"
env "${common_env[@]}" REVIEW_TARGET_FILE="$TARGET_FILE" REVIEW_ASSESSMENT_FILE="$ASSESSMENT_FILE" REVIEW_RESULT_FILE="$RESULT_FILE" node "$SCRIPT" finalize >/dev/null
node --input-type=module - "$ROOT_DIR/schemas/codex-pr-review-result.schema.json" "$RESULT_FILE" <<'NODE'
import fs from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
const [schemaFile, resultFile] = process.argv.slice(2);
const schema = JSON.parse(fs.readFileSync(schemaFile, "utf8"));
const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
const validate = new Ajv2020({ strict: false, allErrors: true, formats: { "date-time": true } }).compile(schema);
if (!validate(result)) process.exit(1);
for (const [field, invalid] of [["coverage", [42]], ["findings", ["bad"]], ["gaps", [{}]]]) {
  const candidate = structuredClone(result);
  candidate[field] = invalid;
  if (validate(candidate)) process.exit(2);
}
const laundered = structuredClone(result);
laundered.verdict = "pass";
if (validate(laundered)) process.exit(3);
const inconsistentHigh = structuredClone(result);
inconsistentHigh.findings[0].requires_change = false;
if (validate(inconsistentHigh)) process.exit(4);
const inconsistentLow = structuredClone(result);
inconsistentLow.findings[0].severity = "low";
if (validate(inconsistentLow)) process.exit(5);
const hiddenBlocker = structuredClone(result);
hiddenBlocker.verdict = "not_verified";
hiddenBlocker.gaps = ["A gap cannot conceal an implementation defect."];
if (validate(hiddenBlocker)) process.exit(6);
const missingCodeLane = structuredClone(result);
missingCodeLane.verdict = "pass";
missingCodeLane.coverage = [{ lane: "security", status: "pass", summary: "Security-only coverage is incomplete." }];
missingCodeLane.findings = [];
missingCodeLane.gaps = [];
if (validate(missingCodeLane)) process.exit(7);
NODE
if [[ "$?" -eq 0 ]]; then
  ok "public result schema validates core arrays and rejects malformed entries"
else
  bad "public result schema must validate core arrays and reject malformed entries"
fi

# Exercise the GitHub review boundary against a loopback fake. It captures the
# exact request, returns the posted review for deduplication, and can reject a
# token to prove API failures stay visible.
MOCK_SERVER="$TMP_ROOT/mock-github-api.mjs"
PORT_FILE="$TMP_ROOT/mock-port"
REQUEST_FILE="$TMP_ROOT/mock-posts.json"
cat > "$MOCK_SERVER" <<'NODE'
import fs from "node:fs";
import http from "node:http";
const [portFile, requestFile] = process.argv.slice(2);
const posts = [];
const server = http.createServer(async (request, response) => {
  const reject = request.headers.authorization === "Bearer reject";
  if (request.method === "GET") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(reject ? [] : posts.map((body, id) => ({ id: id + 1, body: body.body }))));
    return;
  }
  if (reject) {
    response.writeHead(500, { "content-type": "application/json" });
    response.end('{"message":"injected failure"}');
    return;
  }
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  posts.push(body);
  fs.writeFileSync(requestFile, JSON.stringify(posts));
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ id: posts.length, body: body.body }));
});
server.listen(0, "127.0.0.1", () => fs.writeFileSync(portFile, String(server.address().port)));
NODE
node "$MOCK_SERVER" "$PORT_FILE" "$REQUEST_FILE" &
SERVER_PID=$!
for _ in $(seq 1 50); do [[ -s "$PORT_FILE" ]] && break; sleep 0.05; done
MOCK_URL="http://127.0.0.1:$(cat "$PORT_FILE")"
publish_env=("${common_env[@]}" "REVIEW_TARGET_FILE=$TARGET_FILE" "REVIEW_RESULT_FILE=$RESULT_FILE" "FLOW_AGENTS_TEST_MODE=1" "FLOW_AGENTS_TEST_GITHUB_API_URL=$MOCK_URL")
if env "${publish_env[@]}" REVIEW_GITHUB_TOKEN=test node "$SCRIPT" publish >/dev/null; then
  ok "publish creates an advisory GitHub review through the external API boundary"
else
  bad "publish should create an advisory GitHub review"
fi
node -e 'const fs=require("fs"); const posts=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const body=posts[0]; if(posts.length!==1||body.event!=="COMMENT"||body.commit_id!==process.argv[2]||body.comments.length!==1||body.comments[0].path!=="src/value.js"||body.comments[0].line!==2||!body.comments[0].body.includes("requires a code change")) process.exit(1)' "$REQUEST_FILE" "$HEAD_SHA" \
  && ok "publish attaches the finding to the changed right-side line with fix rationale" \
  || bad "publish should attach the finding to the changed right-side line with fix rationale"
node -e 'const fs=require("fs"); const body=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))[0].body; if(body.includes("src/@review`path.js")||body.includes("@review")) process.exit(1)' "$REQUEST_FILE" \
  && ok "publication sanitizes unusual repository filenames before Markdown rendering" \
  || bad "publication should sanitize unusual repository filenames"
env "${publish_env[@]}" REVIEW_GITHUB_TOKEN=test node "$SCRIPT" publish >/dev/null
node -e 'const fs=require("fs"); if(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).length!==1) process.exit(1)' "$REQUEST_FILE" \
  && ok "same-head publication is idempotent" \
  || bad "same-head publication should be idempotent"
if env "${publish_env[@]}" REVIEW_GITHUB_TOKEN=reject node "$SCRIPT" publish >/dev/null 2>&1; then
  bad "GitHub API rejection should be visible to the advisory publication step"
else
  ok "GitHub API rejection remains visible without changing the validated artifact"
fi

echo ""
echo "Results: ${pass}/$((pass + fail)) passed, ${fail} failed"
[[ "$fail" -eq 0 ]]
