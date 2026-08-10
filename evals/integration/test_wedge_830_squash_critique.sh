#!/usr/bin/env bash
# Regression eval for #830: a clean critique recorded on a feature commit must
# be re-attestable after that commit reaches main through a real squash merge.
# The fixture is isolated under mktemp and intentionally contains no network IO.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

TMP="$(mktemp -d)"
PROJECT="$TMP/project"
ARTIFACT_ROOT="$PROJECT/.kontourai/flow-agents"
SLUG="wedge-830"
SESSION="$ARTIFACT_ROOT/$SLUG"
errors=0

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT
_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

run_sidecar() {
  (cd "$PROJECT" && flow_agents_node workflow-sidecar "$@")
}

mkdir -p "$PROJECT" "$SESSION"
git -C "$PROJECT" init -q
git -C "$PROJECT" config user.email fixture@flow-agents.invalid
git -C "$PROJECT" config user.name "Flow Agents fixture"
printf '.kontourai/\n' > "$PROJECT/.gitignore"
printf 'base\n' > "$PROJECT/source.txt"
git -C "$PROJECT" add .gitignore source.txt
git -C "$PROJECT" commit -qm "fixture baseline"
BASE_BRANCH="$(git -C "$PROJECT" branch --show-current)"

if run_sidecar ensure-session --artifact-root "$ARTIFACT_ROOT" --task-slug "$SLUG" --flow-id builder.build \
  --title "#830 squash critique fixture" --summary "Exercise squash-merge critique recovery." \
  >"$TMP/start.out" 2>"$TMP/start.err"; then
  _pass "starts an isolated builder.build fixture"
else
  _fail "could not start fixture: $(cat "$TMP/start.out" "$TMP/start.err")"
fi
if ! run_sidecar init-plan "$SESSION/$SLUG--deliver.md" --source-request "#830 squash critique fixture" \
  --summary "Exercise squash-merge critique recovery." >"$TMP/plan.out" 2>"$TMP/plan.err"; then
  _fail "could not initialize fixture plan: $(cat "$TMP/plan.out" "$TMP/plan.err")"
fi

git -C "$PROJECT" checkout -qb feature
printf 'reviewed feature\n' > "$PROJECT/source.txt"
git -C "$PROJECT" add source.txt
git -C "$PROJECT" commit -qm "feature reviewed at X"
FEATURE_X="$(git -C "$PROJECT" rev-parse HEAD)"

if run_sidecar record-critique "$SESSION" --id code-review --reviewer reviewer-a --verdict pass \
  --summary "Clean feature review at X." --artifact-ref "$SESSION/$SLUG--deliver.md" \
  --lane-json "{\"id\":\"code\",\"status\":\"pass\",\"summary\":\"Clean at X.\",\"evidence_refs\":[{\"kind\":\"artifact\",\"file\":\"$SESSION/$SLUG--deliver.md\",\"summary\":\"Reviewed delivery artifact.\"}]}" \
  >"$TMP/first.out" 2>"$TMP/first.err"; then
  _pass "records clean critique at feature commit X"
else
  _fail "could not record first critique: $(cat "$TMP/first.out" "$TMP/first.err")"
fi

git -C "$PROJECT" checkout -q "$BASE_BRANCH"
git -C "$PROJECT" merge --squash feature >/dev/null
git -C "$PROJECT" commit -qm "squash feature as M"
SQUASH_M="$(git -C "$PROJECT" rev-parse HEAD)"
if git -C "$PROJECT" merge-base --is-ancestor "$FEATURE_X" "$SQUASH_M"; then
  _fail "fixture is invalid: feature X unexpectedly remains an ancestor of squash M"
else
  _pass "real squash merge makes X non-ancestral to M"
fi

mkdir -p "$PROJECT/delivery"
printf 'delivery evidence only\n' > "$PROJECT/delivery/evidence.txt"
git -C "$PROJECT" add delivery/evidence.txt
git -C "$PROJECT" commit -qm "delivery evidence only"

if run_sidecar record-critique "$SESSION" --id code-review --reviewer reviewer-a --verdict pass \
  --summary "Clean re-attestation after squash merge." --artifact-ref "$SESSION/$SLUG--deliver.md" \
  --lane-json "{\"id\":\"code\",\"status\":\"pass\",\"summary\":\"Clean at current workspace.\",\"evidence_refs\":[{\"kind\":\"artifact\",\"file\":\"$SESSION/$SLUG--deliver.md\",\"summary\":\"Reviewed delivery artifact.\"}]}" \
  >"$TMP/recheck.out" 2>"$TMP/recheck.err"; then
  _pass "REGRESSION GREEN: same-reviewer re-attestation survives squash ancestry"
else
  _fail "REGRESSION RED: same-reviewer re-attestation failed: $(cat "$TMP/recheck.out" "$TMP/recheck.err")"
fi

# record-critique writes the same-reviewer resolution edge but deliberately
# does not run the graph validator. Validate it while the re-attested snapshot
# is still current: this is the call that must exercise the squash bridge.
read -r FIRST_REVIEW_SHA SECOND_REVIEW_SHA < <(node -e '
const bundle = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
const critiques = bundle.claims.filter((claim) => claim?.metadata?.origin === "critique")
  .map((claim) => claim.metadata).sort((a, b) => a.critique_sequence - b.critique_sequence);
if (critiques.length !== 2) throw new Error(`expected two critique records, found ${critiques.length}`);
console.log(critiques[0].review_target.workspace_snapshot.head_sha, critiques[1].review_target.workspace_snapshot.head_sha);
' "$SESSION/trust.bundle")
if [ "$FIRST_REVIEW_SHA" != "$FEATURE_X" ]; then
  _fail "fixture first review snapshot is not feature X"
fi
if git -C "$PROJECT" merge-base --is-ancestor "$FIRST_REVIEW_SHA" "$SECOND_REVIEW_SHA"; then
  _fail "fixture is invalid: re-attestation snapshot unexpectedly has strict ancestry"
else
  _pass "re-attestation validation compares non-ancestral snapshots $FIRST_REVIEW_SHA -> $SECOND_REVIEW_SHA"
fi
if (cd "$PROJECT" && node "$ROOT/build/src/cli/validate-workflow-artifacts.js" --require-critique "$SESSION") >"$TMP/recheck-validate.out" 2>"$TMP/recheck-validate.err"; then
  _pass "REGRESSION GREEN: validator accepts the same-reviewer squash resolution edge"
else
  _fail "REGRESSION RED: validator rejected the squash resolution edge: $(cat "$TMP/recheck-validate.out" "$TMP/recheck-validate.err")"
fi

# A later source mutation is a different workspace from the re-attested one.
# The validator must refuse to regard that critique as current and tell the
# operator to re-attest the actual workspace.
printf 'unreviewed source change\n' > "$PROJECT/source.txt"
if (cd "$PROJECT" && node "$ROOT/build/src/cli/validate-workflow-artifacts.js" --require-critique "$SESSION") >"$TMP/launder.out" 2>"$TMP/launder.err"; then
  _fail "ANTI-LAUNDERING: validator accepted a critique for a different workspace"
elif grep -q "workspace snapshot changed; re-attest the current workspace" "$TMP/launder.out" "$TMP/launder.err"; then
  _pass "ANTI-LAUNDERING: changed source tree is refused with re-attestation remediation"
else
  _fail "validator refused changed workspace without remediation: $(cat "$TMP/launder.out" "$TMP/launder.err")"
fi

if [ "$errors" -gt 0 ]; then
  echo "test_wedge_830_squash_critique: $errors check(s) FAILED."
  exit 1
fi
echo "test_wedge_830_squash_critique: all checks passed."
