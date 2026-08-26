#!/usr/bin/env bash
# test_pr_body_file_refs.sh — black-box coverage for the PR-body file-reference contract (#1375).
#
# The incident: #1366's body carried a verification table naming
# `src/cli/trust-bundle-verifying-actor.test.mjs` at "9 tests, 9 pass". That file lived
# on a sibling branch (#1368) and appeared 0 times in #1366's diff. Merging would have
# auto-closed #1363 and #1365 against a change that does not touch them.
#
# Every case below runs the validator as a real child process and reads its EXIT STATUS,
# not a counter — the validator sets `process.exitCode` rather than calling
# `process.exit()`, and that has to be proven to still exit non-zero.
#
# The repository fixtures under evals/fixtures/pr-body-file-refs/ are the VERBATIM
# GitHub-stored bodies (fabricated + corrected #1366, and three unrelated merged PRs).
# The tree they are measured against is synthesized here so the suite is hermetic:
# refs/pull/*/head objects are not present in a CI checkout.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VALIDATOR="$ROOT/scripts/ci/validate-pr-body-file-refs.mjs"
FIXTURES="$ROOT/evals/fixtures/pr-body-file-refs"
WORKFLOW="$ROOT/.github/workflows/ci.yml"
RUNNER="$ROOT/evals/run.sh"
CONTRIBUTING="$ROOT/CONTRIBUTING.md"

errors=0
passes=0
pass() { passes=$((passes + 1)); echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

echo "=== Pull request body file references ==="

if [[ -f "$VALIDATOR" ]]; then
  pass "validator exists"
else
  fail "validator is missing at scripts/ci/validate-pr-body-file-refs.mjs"
  echo "FAIL: PR body file-reference contract"
  exit 1
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/flow-agents-pr-body-refs.XXXXXX")" || {
  echo "FAIL: could not create a temporary directory" >&2
  exit 1
}
trap 'rm -rf -- "$TMP"' EXIT
REPO="$TMP/repo"

# --- the synthetic branch shapes -------------------------------------------------
# The one path that made #1366 an incident: claimed by its body, owned by sibling
# branch #1368, and absent from #1366's own tree and diff.
FABRICATED_PATH="src/cli/trust-bundle-verifying-actor.test.mjs"

# BASE_FILES is DERIVED from the fixtures' own answer keys — the paths that really
# resolve at the heads of those PRs — minus the fabricated one. Deriving it means the
# tree and the expectations cannot drift apart, and the equality assertions below still
# red in both directions: an extractor that over-matches prose produces a path the tree
# does not carry, and one that under-matches drops a line from the ok-list.
BASE_FILES=()
while IFS= read -r fixture_path; do
  [[ -z "$fixture_path" || "$fixture_path" == "$FABRICATED_PATH" ]] && continue
  BASE_FILES+=("$fixture_path")
done < <(cat "$FIXTURES"/*.expected-paths.txt | sort -u)
if [[ "${#BASE_FILES[@]}" -lt 10 ]]; then
  echo "FAIL: the fixture answer keys yielded only ${#BASE_FILES[@]} paths; the fixtures are missing" >&2
  exit 1
fi
# Scenario files the answer keys do not supply: a dot-directory root, the delete and
# rename cases, and the tracked/ignored pair under an otherwise-ignored root.
BASE_FILES+=(
  ".github/workflows/example.yml"
  "src/cli/deleted-by-this-branch.ts"
  "src/cli/old-name.ts"
  "delivery/README.md"
  "delivery/DECLARED"
)

mkdir -p "$REPO"
git -C "$REPO" init -q -b main
git -C "$REPO" config user.email "eval@example.invalid"
git -C "$REPO" config user.name "Eval"
cat > "$REPO/.gitignore" <<'IGNORE'
build/
delivery/*
!delivery/README.md
!delivery/DECLARED
IGNORE
for f in "${BASE_FILES[@]}"; do
  mkdir -p "$REPO/$(dirname "$f")"
  printf 'placeholder\n' > "$REPO/$f"
done
# `delivery/*` is ignored, so the two tracked delivery files need -f exactly as the repo does.
git -C "$REPO" add -A >/dev/null 2>&1
git -C "$REPO" add -f delivery/README.md delivery/DECLARED >/dev/null 2>&1
git -C "$REPO" commit -qm "base"
BASE_SHA="$(git -C "$REPO" rev-parse HEAD)"

# HEAD = the #1366 branch shape: deletes one file, renames another, and does NOT carry
# src/cli/trust-bundle-verifying-actor.test.mjs.
git -C "$REPO" checkout -q -b pr-head
git -C "$REPO" rm -q src/cli/deleted-by-this-branch.ts
git -C "$REPO" mv src/cli/old-name.ts src/cli/new-name.ts
printf 'changed\n' > "$REPO/src/cli/workflow.ts"
git -C "$REPO" add -A >/dev/null 2>&1
git -C "$REPO" commit -qm "head"
HEAD_SHA="$(git -C "$REPO" rev-parse HEAD)"

# SIBLING = the #1368 branch shape: the same base, plus the file #1366's body claimed.
git -C "$REPO" checkout -q -b sibling "$BASE_SHA"
mkdir -p "$REPO/$(dirname "$FABRICATED_PATH")"
printf 'placeholder\n' > "$REPO/$FABRICATED_PATH"
git -C "$REPO" add -A >/dev/null 2>&1
git -C "$REPO" commit -qm "sibling"
SIBLING_SHA="$(git -C "$REPO" rev-parse HEAD)"
git -C "$REPO" checkout -q pr-head

# --- harness ---------------------------------------------------------------------
LAST_OUTPUT=""
LAST_STATUS=0
run_check() {
  local body="$1" head="${2:-$HEAD_SHA}" base="${3:-$BASE_SHA}" author="${4:-a-human}"
  LAST_OUTPUT="$(cd "$REPO" && PR_BODY="$body" PR_HEAD_SHA="$head" PR_BASE_SHA="$base" PR_AUTHOR="$author" node "$VALIDATOR" 2>&1)"
  LAST_STATUS=$?
}

expect_pass() {
  local label="$1" body="$2" head="${3:-$HEAD_SHA}"
  run_check "$body" "$head"
  if [[ "$LAST_STATUS" -eq 0 ]]; then
    pass "$label"
  else
    fail "$label (expected exit 0, got $LAST_STATUS)"
    printf '%s\n' "$LAST_OUTPUT" | sed 's/^/      /'
  fi
}

expect_fail_naming() {
  local label="$1" body="$2" needle="$3" head="${4:-$HEAD_SHA}"
  run_check "$body" "$head"
  if [[ "$LAST_STATUS" -ne 0 && "$LAST_OUTPUT" == *"$needle"* ]]; then
    pass "$label"
  else
    fail "$label (expected a non-zero exit naming '$needle', got exit $LAST_STATUS)"
    printf '%s\n' "$LAST_OUTPUT" | sed 's/^/      /'
  fi
}

# Pins the exact extraction set: over-matching prose or under-matching a real reference
# both change these lines.
expect_ok_paths() {
  local label="$1"
  shift
  local actual expected
  actual="$(printf '%s\n' "$LAST_OUTPUT" | sed -n 's/^  ok  //p' | sort)"
  expected="$(printf '%s\n' "$@" | sort)"
  if [[ "$actual" == "$expected" ]]; then
    pass "$label"
  else
    fail "$label (extracted set differs)"
    echo "      expected: $(printf '%s ' $expected)"
    echo "      actual:   $(printf '%s ' $actual)"
  fi
}

# Same assertion against a fixture's hand-checked answer key.
expect_ok_paths_from_key() {
  local label="$1" key="$2"
  local actual expected
  actual="$(printf '%s\n' "$LAST_OUTPUT" | sed -n 's/^  ok  //p' | sort)"
  expected="$(sort "$key" | sed '/^$/d')"
  if [[ "$actual" == "$expected" ]]; then
    pass "$label"
  else
    fail "$label (extracted set differs from $(basename "$key"))"
    echo "      expected: $(printf '%s ' $expected)"
    echo "      actual:   $(printf '%s ' $actual)"
  fi
}

# --- 1. the real incident ---------------------------------------------------------
FABRICATED="$(cat "$FIXTURES/pr-1366-fabricated-body.md")"
CORRECTED="$(cat "$FIXTURES/pr-1366-corrected-body.md")"

expect_fail_naming \
  "reds on #1366's real fabricated body" \
  "$FABRICATED" \
  "$FABRICATED_PATH"

if [[ "$LAST_OUTPUT" == *"does not exist at the PR head"* && "$LAST_OUTPUT" == *"git diff --name-only"* ]]; then
  pass "the refusal says what is wrong and what to run"
else
  fail "the refusal does not name the failure and a remedy"
fi

# The same body against the branch that really owns that file must pass — the check has
# to discriminate on tree content, not on anything about the body itself.
expect_pass \
  "the same body passes against the sibling branch that owns the file (#1368 shape)" \
  "$FABRICATED" \
  "$SIBLING_SHA"
expect_ok_paths_from_key "extracts exactly the answer key for #1366's fabricated body" \
  "$FIXTURES/pr-1366-fabricated-body.expected-paths.txt"

# --- 2. real merged bodies must not red -------------------------------------------
expect_pass "passes #1366's corrected body" "$CORRECTED"
expect_ok_paths_from_key "extracts exactly the answer key for #1366's corrected body" \
  "$FIXTURES/pr-1366-corrected-body.expected-paths.txt"

for fixture in pr-1101-body pr-1041-body pr-1354-body; do
  expect_pass "passes the real merged body ${fixture%-body}" "$(cat "$FIXTURES/$fixture.md")"
  expect_ok_paths_from_key "extracts exactly the answer key for ${fixture%-body}" \
    "$FIXTURES/$fixture.expected-paths.txt"
done

# --- 2b. the one measured bot false positive --------------------------------------
# #28's real dependabot body quotes an upstream commit subject naming a file in
# actions/setup-python. Both directions are asserted: exempt as dependabot, and RED when
# the same body is attributed to anyone else — so the exemption is what does the work
# here, not an accident of the synthetic tree.
DEPENDABOT_BODY="$(cat "$FIXTURES/pr-28-dependabot-body.md")"
UPSTREAM_PATH="$(head -1 "$FIXTURES/pr-28-dependabot-body.upstream-paths.txt")"

run_check "$DEPENDABOT_BODY" "$HEAD_SHA" "$BASE_SHA" "dependabot[bot]"
if [[ "$LAST_STATUS" -eq 0 && "$LAST_OUTPUT" == *"skipped for dependabot[bot]"* ]]; then
  pass "exempts dependabot, whose body is upstream attribution it cannot rewrite"
else
  fail "dependabot exemption did not apply (exit $LAST_STATUS: $LAST_OUTPUT)"
fi

expect_fail_naming "reds on the same dependabot body when any other author claims it" \
  "$DEPENDABOT_BODY" "$UPSTREAM_PATH"

expect_fail_naming "does not exempt release-please, whose changelog is about this repository" \
  "Adds \`src/cli/never-existed.test.mjs\`." "src/cli/never-existed.test.mjs"
run_check "Adds \`src/cli/never-existed.test.mjs\`." "$HEAD_SHA" "$BASE_SHA" "github-actions[bot]"
if [[ "$LAST_STATUS" -ne 0 ]]; then
  pass "the exemption is one named author, not every bot"
else
  fail "an unlisted bot author was exempted"
fi

# --- 3. the legitimate-body classes ------------------------------------------------
expect_pass "accepts a file this branch deletes" \
  "This removes \`src/cli/deleted-by-this-branch.ts\` outright."
if [[ "$LAST_OUTPUT" == *"ok  src/cli/deleted-by-this-branch.ts"* ]]; then
  pass "the deleted file was checked, not skipped"
else
  fail "the deleted file did not reach the resolution path"
fi

expect_pass "accepts the pre-rename path of a file this branch renames" \
  "Renamed \`src/cli/old-name.ts\` to \`src/cli/new-name.ts\`."

expect_pass "skips a gitignored runtime artifact" \
  "Step 2 reconciles \`delivery/trust.bundle\` against CI."
if [[ "$LAST_OUTPUT" == *"1 skipped as gitignored"* ]]; then
  pass "the gitignored path was skipped by the gitignore rule"
else
  fail "delivery/trust.bundle did not take the gitignore skip path"
fi

expect_pass "accepts a tracked path under an otherwise-ignored root" \
  "This appends one entry to \`delivery/DECLARED\`."

expect_pass "accepts a path allowed by a directive with a reason" \
  "Adds \`src/cli/not-here-yet.ts\`.
<!-- pr-body-paths: allow src/cli/not-here-yet.ts — added by the follow-up in #1400 -->"

expect_fail_naming "rejects an allow directive that gives no reason" \
  "Adds \`src/cli/not-here-yet.ts\`.
<!-- pr-body-paths: allow src/cli/not-here-yet.ts -->" \
  "gives no reason"

expect_pass "ignores globs, bare directories, issue refs, and prose" \
  "Closes #1363. Reworks \`src/**\` and everything under \`scripts/ci/\`; see src and evals.
Version 6.2.0 touches evals/static/test_unit_helpers.sh"
expect_ok_paths "extracts nothing but the one real path from glob-and-prose text" \
  "evals/static/test_unit_helpers.sh"

expect_pass "ignores a path inside a URL" \
  "See https://github.com/kontourai/flow-agents/blob/main/src/cli/does-not-exist.ts for context."
expect_ok_paths "extracts nothing from a blob URL"

expect_pass "ignores an absolute path and a node_modules path from quoted output" \
  "\`\`\`
Error: Cannot find module '/Users/someone/checkout/src/cli/gone.ts'
    at node_modules/some-pkg/src/loader.js:12
\`\`\`"
expect_ok_paths "extracts nothing from an absolute or node_modules path"

expect_pass "accepts an empty body" ""

# --- 4. a fenced code block is not an exemption ------------------------------------
expect_fail_naming "reds on a fabricated path inside a fenced code block" \
  'Verification:
```
node --test src/cli/never-existed.test.mjs
# 9 tests, 9 pass
```' \
  "src/cli/never-existed.test.mjs"

expect_fail_naming "reds on a fabricated path inside inline code" \
  'Ran `src/cli/never-existed.test.mjs` — 9 pass.' \
  "src/cli/never-existed.test.mjs"

# --- 5. resolution is at the PR head, not main -------------------------------------
# The sibling branch owns trust-bundle-verifying-actor.test.mjs. A body on the pr-head
# branch naming it must red even though the object is reachable elsewhere in the repo.
expect_fail_naming "resolves at the PR head, not anywhere in the repository" \
  "Ran \`src/cli/trust-bundle-verifying-actor.test.mjs\`." \
  "does not exist at the PR head"

# --- 6. fails loudly on misconfiguration -------------------------------------------
missing_body_output="$(cd "$REPO" && env -u PR_BODY PR_HEAD_SHA="$HEAD_SHA" PR_BASE_SHA="$BASE_SHA" node "$VALIDATOR" 2>&1)"
missing_body_status=$?
if [[ "$missing_body_status" -ne 0 && "$missing_body_output" == *"PR_BODY is required"* ]]; then
  pass "fails loudly when PR_BODY is unset"
else
  fail "unset PR_BODY should fail loudly (exit $missing_body_status: $missing_body_output)"
fi

missing_sha_output="$(cd "$REPO" && PR_BODY="x" env -u PR_HEAD_SHA -u PR_BASE_SHA node "$VALIDATOR" 2>&1)"
missing_sha_status=$?
if [[ "$missing_sha_status" -ne 0 && "$missing_sha_output" == *"PR_HEAD_SHA and PR_BASE_SHA are required"* ]]; then
  pass "fails loudly when the head/base SHAs are unset"
else
  fail "unset SHAs should fail loudly (exit $missing_sha_status: $missing_sha_output)"
fi

absent_head_output="$(cd "$REPO" && PR_BODY="x" PR_HEAD_SHA="0000000000000000000000000000000000000000" PR_BASE_SHA="$BASE_SHA" node "$VALIDATOR" 2>&1)"
absent_head_status=$?
if [[ "$absent_head_status" -ne 0 && "$absent_head_output" == *"is not in this checkout"* ]]; then
  pass "fails loudly, and names the checkout, when the PR head object is absent"
else
  fail "an absent head object should fail loudly (exit $absent_head_status: $absent_head_output)"
fi

# --- 7. the rejection is a real process exit ---------------------------------------
(cd "$REPO" && PR_BODY="Ran \`src/cli/never-existed.test.mjs\`." PR_HEAD_SHA="$HEAD_SHA" PR_BASE_SHA="$BASE_SHA" node "$VALIDATOR" >/dev/null 2>&1)
real_exit=$?
if [[ "$real_exit" -eq 1 ]]; then
  pass "the rejection path exits the process with status 1"
else
  fail "the rejection path did not exit non-zero (status $real_exit)"
fi

# --- 8. body content is inert data --------------------------------------------------
marker="$TMP/injection-marker"
rm -f -- "$marker"
run_check "Touched \`src/cli/workflow.ts\` \$(touch $marker) \`$(printf '%s' '`touch '"$marker"'`')\`"
if [[ ! -e "$marker" ]]; then
  pass "never evaluates PR body content"
else
  fail "PR body content was unexpectedly evaluated"
fi

traversal_before="$(ls "$TMP" | wc -l | tr -d ' ')"
expect_pass "treats a traversal segment as prose, not a path" \
  "See \`src/../../../etc/passwd.txt\` and \`src/cli/workflow.ts\`."
expect_ok_paths "a traversal candidate never reaches resolution" "src/cli/workflow.ts"
traversal_after="$(ls "$TMP" | wc -l | tr -d ' ')"
if [[ "$traversal_before" == "$traversal_after" ]]; then
  pass "a traversal candidate creates nothing on disk"
else
  fail "a traversal candidate touched the filesystem"
fi

# --- 9. CI wiring -------------------------------------------------------------------
source_and_static="$(sed -n '/^  source-and-static:/,/^  workflow-contracts:/p' "$WORKFLOW")"

if [[ "$source_and_static" == *"run: node scripts/ci/validate-pr-body-file-refs.mjs"* ]]; then
  pass "CI runs the validator"
else
  fail "CI does not run scripts/ci/validate-pr-body-file-refs.mjs"
fi

if [[ "$source_and_static" == *'PR_BODY: ${{ github.event.pull_request.body }}'* \
  && "$source_and_static" == *'PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}'* \
  && "$source_and_static" == *'PR_BASE_SHA: ${{ github.event.pull_request.base.sha }}'* \
  && "$source_and_static" == *'PR_AUTHOR: ${{ github.event.pull_request.user.login }}'* ]]; then
  pass "CI passes the body, both SHAs, and the author through the environment, never a shell argument"
else
  fail "CI does not use the required env boundary for the body, SHAs, and author"
fi

body_step="$(sed -n '/name: Validate pull request body file references/,/name: Install Node dependencies/p' "$WORKFLOW")"
if [[ -n "$body_step" && "$body_step" == *"if: github.event_name == 'pull_request'"* ]]; then
  pass "CI runs the body check only for pull requests"
else
  fail "CI body-check step is missing its pull_request guard"
fi

if [[ "$body_step" != *"github.actor"* && "$body_step" != *"continue-on-error"* ]]; then
  pass "CI has no actor exemption or soft failure for the body check"
else
  fail "CI body check contains an actor exemption or soft failure"
fi

checkout_block="$(sed -n '/^  source-and-static:/,/name: Set up Node.js/p' "$WORKFLOW")"
if [[ "$checkout_block" == *"fetch-depth: 0"* ]]; then
  pass "the lane checks out unshallowed history, which the head/merge-base lookups need"
else
  fail "the lane is shallow; the body check cannot resolve the PR head or a merge base"
fi

static_runner="$(sed -n '/^run_static()/,/^run_integration()/p' "$RUNNER")"
if [[ "$static_runner" == *'bash "$EVAL_DIR/static/test_pr_body_file_refs.sh"'* ]]; then
  pass "static runner registers this suite"
else
  fail "static runner does not register this suite"
fi

if grep -qF 'pr-body-paths: allow' "$CONTRIBUTING" \
  && grep -qF 'scripts/ci/validate-pr-body-file-refs.mjs' "$CONTRIBUTING"; then
  pass "CONTRIBUTING documents the contract and its escape directive"
else
  fail "CONTRIBUTING is missing the PR-body file-reference contract"
fi

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "$passes passed"
  echo "PASS: PR body file-reference contract"
  exit 0
else
  echo "FAIL: $errors PR body file-reference check(s) failed"
  exit 1
fi
