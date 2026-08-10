#!/usr/bin/env bash
# Regression eval for #1164: a sidecar verifier record at builder.build/verify
# must not make the next public writer permanently unrecoverable.
#
# Before #1170, the final command failed with:
#   BuilderBuildRunInputError: invalid Builder build run input for
#   evidence.claims.metadata.gate_claim.flow_run_head: must match the canonical
#   Flow state authorized when the gate claim was recorded
#
# The fixture deliberately uses the two real writers: public `workflow evidence`
# / `workflow critique`, then `workflow-sidecar record-evidence` from an
# independent verifier.  It is entirely isolated under mktemp.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

TMP="$(mktemp -d)"
PROJECT="$TMP/project"
ARTIFACT_ROOT="$PROJECT/.kontourai/flow-agents"
WORK_ITEM="wedge:1164"
SLUG="wedge-1164"
SESSION="$ARTIFACT_ROOT/$SLUG"
errors=0

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

run_public() {
  local actor="$1"
  shift
  (cd "$PROJECT" && FLOW_AGENTS_ACTOR="$actor" node "$ROOT/build/src/cli.js" workflow "$@")
}

echo ""
echo "=== #1164 fixture: public and sidecar writers share an active builder.build run ==="

mkdir -p "$SESSION" "$PROJECT/checks"
git -C "$PROJECT" init -q
git -C "$PROJECT" config user.email fixture@flow-agents.invalid
git -C "$PROJECT" config user.name "Flow Agents fixture"
printf '.kontourai/\n' > "$PROJECT/.gitignore"
git -C "$PROJECT" add .gitignore
git -C "$PROJECT" commit -qm "fixture baseline"

printf 'Selected Work Item: %s\n' "$WORK_ITEM" > "$SESSION/$SLUG--pull-work.md"
if run_public wedge-owner start --artifact-root "$ARTIFACT_ROOT" --flow builder.build \
  --work-item "$WORK_ITEM" --assignment-provider local-file --title "#1164 wedge fixture" \
  --summary "Exercise public and sidecar evidence writers." --criterion "Public evidence remains writable." \
  >"$TMP/start.out" 2>"$TMP/start.err"; then
  _pass "starts an isolated active builder.build run"
else
  _fail "could not start fixture: $(cat "$TMP/start.out" "$TMP/start.err")"
fi

printf '# Plan\n\nVerification remains recoverable.\n' > "$SESSION/$SLUG--plan-work.md"
printf '# Delivery\n\nPublic and sidecar writers are composed.\n' > "$SESSION/$SLUG--deliver.md"

record_public() {
  local expectation="$1" artifact="$2"
  if run_public wedge-owner evidence --session-dir "$SESSION" --status pass --expectation "$expectation" \
    --summary "Fixture public writer records $expectation." \
    --evidence-ref-json "{\"kind\":\"artifact\",\"file\":\"$artifact\",\"summary\":\"Fixture durable artifact for $expectation.\"}" \
    >"$TMP/$expectation.out" 2>"$TMP/$expectation.err"; then
    _pass "public writer records $expectation"
  else
    _fail "public writer could not record $expectation: $(cat "$TMP/$expectation.out" "$TMP/$expectation.err")"
  fi
}

record_public pickup-probe-readiness "$SESSION/$SLUG--pull-work.md"
record_public probe-decisions-or-accepted-gaps "$SESSION/$SLUG--pull-work.md"
record_public implementation-plan "$SESSION/$SLUG--plan-work.md"
record_public implementation-scope "$SESSION/$SLUG--deliver.md"

# Create and commit the later command before review captures its workspace
# snapshot. The #1164 sequence itself has no code mutation after the critique.
cat > "$PROJECT/checks/wedge-1164.test.mjs" <<'JS'
import test from 'node:test';
import assert from 'node:assert/strict';

test('the #1164 fixture follow-up command is substantive', () => {
  assert.equal(1 + 1, 2);
});
JS
git -C "$PROJECT" add checks/wedge-1164.test.mjs
git -C "$PROJECT" commit -qm "add final public evidence command"
TEST_COMMAND="node --test checks/wedge-1164.test.mjs"

if run_public wedge-reviewer critique --session-dir "$SESSION" --id wedge-review --verdict pass \
  --summary "Independent review is clean before verifier evidence." \
  --artifact-ref "$SESSION/$SLUG--deliver.md" \
  --lane-json "{\"id\":\"code-review\",\"status\":\"pass\",\"summary\":\"Fixture review completed.\",\"evidence_refs\":[{\"kind\":\"artifact\",\"file\":\"$SESSION/$SLUG--deliver.md\",\"summary\":\"Reviewed fixture delivery artifact.\"}]}" \
  >"$TMP/critique.out" 2>"$TMP/critique.err"; then
  _pass "public critique records clean review at verify"
else
  _fail "public critique failed: $(cat "$TMP/critique.out" "$TMP/critique.err")"
fi

# This is the independent verifier's exact shape: ten external partial checks.
sidecar_args=(record-evidence "$SESSION" --verdict partial)
for number in $(seq 1 10); do
  sidecar_args+=(--check-json "{\"id\":\"wedge-external-$number\",\"kind\":\"external\",\"status\":\"not_verified\",\"summary\":\"Independent verifier check $number is pending.\"}")
done
if (cd "$PROJECT" && flow_agents_node workflow-sidecar "${sidecar_args[@]}") >"$TMP/sidecar.out" 2>"$TMP/sidecar.err"; then
  _pass "sidecar records ten partial external verifier checks"
else
  _fail "sidecar record-evidence failed: $(cat "$TMP/sidecar.out" "$TMP/sidecar.err")"
fi

if node - "$SESSION/state.json" "$SESSION/trust.bundle" <<'NODE'
const fs = require('node:fs');
const [statePath, bundlePath] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
const checks = (bundle.claims || []).filter((claim) => String(claim.subjectId || '').match(/\/wedge-external-[1-9][0]?$/));
if (state.status !== 'not_verified') throw new Error(`expected state.status=not_verified, got ${state.status}`);
if (checks.length !== 10) throw new Error(`expected ten retained verifier checks, got ${checks.length}`);
if (!checks.every((claim) => claim.claimType === 'builder.verify.tests')) throw new Error('sidecar checks were not emitted as builder.verify.tests claims');
if (!checks.every((claim) => !claim.metadata?.gate_claim && claim.metadata?.verification_workspace_snapshot?.kind === 'git-worktree')) {
  throw new Error('sidecar checks must omit guessed gate_claim.flow_run_head and retain a Git-worktree snapshot');
}
NODE
then
  _pass "sidecar projects not_verified state and retains ten snapshot-bound builder.verify.tests checks"
else
  _fail "sidecar did not retain its partial verifier evidence"
fi

CRITERION_JSON="$(node - "$TEST_COMMAND" <<'NODE'
const command = process.argv[2];
process.stdout.write(JSON.stringify({
  id: 'public-evidence-remains-writable', status: 'pass',
  evidence_refs: [{ kind: 'command', excerpt: command, summary: 'Runs the fixture follow-up command.' }],
}));
NODE
)"
COMMAND_REF="$(node - "$TEST_COMMAND" <<'NODE'
const command = process.argv[2];
process.stdout.write(JSON.stringify({ kind: 'command', excerpt: command, summary: 'Runs the fixture follow-up command.' }));
NODE
)"

# This was the historical wedge point.  It must succeed: a head mismatch may
# only be reconciled by the recorded workspace snapshot, never accepted blindly.
if run_public wedge-owner evidence --session-dir "$SESSION" --status pass --expectation tests-evidence \
  --summary "The post-sidecar public evidence write succeeds." --command "$TEST_COMMAND" \
  --criterion-json "$CRITERION_JSON" --evidence-ref-json "$COMMAND_REF" \
  >"$TMP/follow-up.out" 2>"$TMP/follow-up.err"; then
  _pass "REGRESSION GREEN: post-sidecar public workflow evidence remains writable"
else
  _fail "REGRESSION RED: post-sidecar public workflow evidence wedged: $(cat "$TMP/follow-up.out" "$TMP/follow-up.err")"
fi

if grep -q "flow_run_head.*must match the canonical Flow state authorized" "$TMP/follow-up.out" "$TMP/follow-up.err" 2>/dev/null; then
  _fail "follow-up exposed the historical flow_run_head wedge"
else
  _pass "follow-up does not expose the historical flow_run_head wedge"
fi

if [ "$errors" -gt 0 ]; then
  echo ""
  echo "test_wedge_1164_head_desync: $errors check(s) FAILED."
  exit 1
fi

echo ""
echo "test_wedge_1164_head_desync: all checks passed."
