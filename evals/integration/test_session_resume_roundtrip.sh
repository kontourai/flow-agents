#!/usr/bin/env bash
# test_session_resume_roundtrip.sh — resumable-sessions (issue #153) round-trip eval
#
# Seeds a temporary repo fixture with an active session, runs the workflow-steering
# hook with a SessionStart event, and asserts:
#   AC1: RESUME block is present with status/phase/next_action/plan/handoff/trust fields
#   AC2: Liveness warning present when a fresh other-actor event is seeded
#   AC3: state.json / handoff.json / trust.bundle checksums are unchanged (non-destructive)
#
# Negative cases:
#   - UserPromptSubmit → no RESUME block
#   - Empty liveness stream → no LIVENESS WARNING
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

TMPDIR_EVAL="$(mktemp -d)"
errors=0

cleanup() {
  rm -rf "$TMPDIR_EVAL"
}
trap cleanup EXIT

_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

# ─── Portable sha256 helper ────────────────────────────────────────────────────
sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# ─── Seed fixture ─────────────────────────────────────────────────────────────
REPO="$TMPDIR_EVAL/repo"
SLUG="test-slug-153"
TASK_DIR="$REPO/.flow-agents/$SLUG"
mkdir -p "$TASK_DIR"
mkdir -p "$REPO/.flow-agents/liveness"
mkdir -p "$REPO/docs"

printf '# Test Repo\n' > "$REPO/AGENTS.md"
printf '# Context Map\n' > "$REPO/docs/context-map.md"

# state.json — active session in_progress/execution
cat > "$TASK_DIR/state.json" << 'JSON'
{
  "schema_version": "1.0",
  "task_slug": "test-slug-153",
  "status": "in_progress",
  "phase": "execution",
  "updated_at": "2026-06-25T00:00:00Z",
  "next_action": {
    "status": "active",
    "summary": "Continue implementing the RESUME block in workflow-steering.js",
    "target_phase": "verification"
  },
  "artifact_paths": ["test-slug-153--plan-work.md"]
}
JSON

# handoff.json
cat > "$TASK_DIR/handoff.json" << 'JSON'
{
  "schema_version": "1.0",
  "task_slug": "test-slug-153",
  "next_steps": ["Run eval and check RESUME output"],
  "blockers": []
}
JSON

# stub plan file
printf '# Plan: test-slug-153\n' > "$TASK_DIR/test-slug-153--plan-work.md"

# trust.bundle — one verified, one disputed
cat > "$TASK_DIR/trust.bundle" << 'JSON'
{
  "schema_version": "1.0",
  "task_slug": "test-slug-153",
  "claims": [
    {
      "id": "verified-claim-001",
      "status": "verified",
      "claimType": "implementation",
      "value": "feature implemented"
    },
    {
      "id": "disputed-claim-id",
      "status": "disputed",
      "claimType": "test-coverage",
      "value": "tests pass"
    }
  ]
}
JSON

# install.json — initial version
cat > "$REPO/.flow-agents/install.json" << 'JSON'
{
  "version": "v0.0.1",
  "installedAt": "2026-06-25T00:00:00Z",
  "runtime": "claude-code"
}
JSON

# Liveness stream: fresh other-agent event (5 min ago, within 1800 s TTL)
# and a self (local) event — self should NOT trigger a warning
FIVE_MIN_AGO="$(node -e "process.stdout.write(new Date(Date.now()-300000).toISOString().replace(/\\.\\d{3}Z$/,'Z'))")"
printf '{"type":"claim","subjectId":"test-slug-153","actor":"other-agent","at":"%s","ttlSeconds":1800}\n' "$FIVE_MIN_AGO" > "$REPO/.flow-agents/liveness/events.jsonl"
printf '{"type":"heartbeat","subjectId":"test-slug-153","actor":"local","at":"%s"}\n' "$FIVE_MIN_AGO" >> "$REPO/.flow-agents/liveness/events.jsonl"

# ─── Snapshot checksums before hook run ───────────────────────────────────────
CKSUM_STATE_BEFORE="$(sha256_file "$TASK_DIR/state.json")"
CKSUM_HANDOFF_BEFORE="$(sha256_file "$TASK_DIR/handoff.json")"
CKSUM_TRUST_BEFORE="$(sha256_file "$TASK_DIR/trust.bundle")"

# ─── Hot-upgrade simulation: bump install.json version ───────────────────────
node -e "
const fs = require('fs');
const f = '$REPO/.flow-agents/install.json';
const obj = JSON.parse(fs.readFileSync(f,'utf8'));
obj.version = 'v0.0.2';
fs.writeFileSync(f, JSON.stringify(obj, null, 2) + '\n');
"

# ─── Run hook with SessionStart ───────────────────────────────────────────────
if echo "{\"hook_event_name\":\"SessionStart\",\"cwd\":\"$REPO\"}" | \
  FLOW_AGENTS_ACTOR="local" node "$ROOT/scripts/hooks/workflow-steering.js" > "$TMPDIR_EVAL/resume.out" 2>&1; then
  _pass "hook exits 0 for SessionStart"
else
  _fail "hook should exit 0 for SessionStart (exit $?)"
fi

# ─── AC1: RESUME block presence and fields ────────────────────────────────────
if grep -q "RESUME:" "$TMPDIR_EVAL/resume.out"; then
  _pass "RESUME block present in SessionStart output"
else
  _fail "RESUME block missing from SessionStart output: $(cat "$TMPDIR_EVAL/resume.out")"
fi

if grep -q "in_progress" "$TMPDIR_EVAL/resume.out"; then
  _pass "status 'in_progress' echoed in RESUME block"
else
  _fail "status missing from RESUME block"
fi

if grep -q "execution" "$TMPDIR_EVAL/resume.out"; then
  _pass "phase 'execution' echoed in RESUME block"
else
  _fail "phase missing from RESUME block"
fi

if grep -q "Continue implementing the RESUME block" "$TMPDIR_EVAL/resume.out"; then
  _pass "full next_action summary present in RESUME block"
else
  _fail "next_action summary missing from RESUME block: $(grep 'Next action' "$TMPDIR_EVAL/resume.out" || echo 'no Next action line')"
fi

if grep -q "test-slug-153--plan-work.md" "$TMPDIR_EVAL/resume.out"; then
  _pass "plan artifact path present in RESUME block"
else
  _fail "plan artifact path missing from RESUME block"
fi

if grep -q "Run eval and check RESUME output" "$TMPDIR_EVAL/resume.out"; then
  _pass "handoff next_step present in RESUME block"
else
  _fail "handoff next_step missing from RESUME block"
fi

if grep -q "disputed" "$TMPDIR_EVAL/resume.out"; then
  _pass "trust takeaway mentions disputed status"
else
  _fail "trust takeaway missing disputed status"
fi

if grep -q "disputed-claim-id" "$TMPDIR_EVAL/resume.out"; then
  _pass "disputed claim id present in RESUME block"
else
  _fail "disputed claim id missing from RESUME block"
fi

if grep -q "workflow:sidecar -- claim" "$TMPDIR_EVAL/resume.out"; then
  _pass "disputed claim remedy command present in RESUME block"
else
  _fail "disputed claim remedy command missing from RESUME block"
fi

if grep -q "pull-work" "$TMPDIR_EVAL/resume.out"; then
  _pass "pull-work route hint present in RESUME block"
else
  _fail "pull-work route hint missing from RESUME block"
fi

# ─── AC2: Liveness warning present ────────────────────────────────────────────
if grep -q "LIVENESS WARNING" "$TMPDIR_EVAL/resume.out"; then
  _pass "LIVENESS WARNING present in RESUME block"
else
  _fail "LIVENESS WARNING missing from RESUME block: $(cat "$TMPDIR_EVAL/resume.out")"
fi

if grep -q "other-agent" "$TMPDIR_EVAL/resume.out"; then
  _pass "other-agent actor named in liveness warning"
else
  _fail "other-agent actor missing from liveness warning"
fi

# Self-actor (local) should NOT appear as a liveness warning
if ! grep -q "LIVENESS WARNING.*local\|local.*LIVENESS WARNING" "$TMPDIR_EVAL/resume.out"; then
  _pass "self-actor (local) correctly excluded from liveness warning"
else
  _fail "self-actor should not be warned in liveness advisory"
fi

# ─── AC3: Checksums unchanged (non-destructive) ───────────────────────────────
CKSUM_STATE_AFTER="$(sha256_file "$TASK_DIR/state.json")"
CKSUM_HANDOFF_AFTER="$(sha256_file "$TASK_DIR/handoff.json")"
CKSUM_TRUST_AFTER="$(sha256_file "$TASK_DIR/trust.bundle")"

if [[ "$CKSUM_STATE_BEFORE" == "$CKSUM_STATE_AFTER" ]]; then
  _pass "state.json checksum unchanged (non-destructive)"
else
  _fail "state.json was modified by the hook (checksums differ)"
fi

if [[ "$CKSUM_HANDOFF_BEFORE" == "$CKSUM_HANDOFF_AFTER" ]]; then
  _pass "handoff.json checksum unchanged (non-destructive)"
else
  _fail "handoff.json was modified by the hook (checksums differ)"
fi

if [[ "$CKSUM_TRUST_BEFORE" == "$CKSUM_TRUST_AFTER" ]]; then
  _pass "trust.bundle checksum unchanged (non-destructive)"
else
  _fail "trust.bundle was modified by the hook (checksums differ)"
fi

# ─── Negative: UserPromptSubmit should produce NO RESUME block ────────────────
echo "{\"hook_event_name\":\"UserPromptSubmit\",\"cwd\":\"$REPO\",\"prompt\":\"continue\"}" | \
  FLOW_AGENTS_ACTOR="local" node "$ROOT/scripts/hooks/workflow-steering.js" > "$TMPDIR_EVAL/prompt.out" 2>&1

if ! grep -q "RESUME:" "$TMPDIR_EVAL/prompt.out"; then
  _pass "RESUME block absent for UserPromptSubmit (negative case)"
else
  _fail "RESUME block must not appear for UserPromptSubmit"
fi

# ─── Negative: Empty liveness stream → no LIVENESS WARNING ───────────────────
REPO2="$TMPDIR_EVAL/repo2"
TASK_DIR2="$REPO2/.flow-agents/$SLUG"
mkdir -p "$TASK_DIR2"
mkdir -p "$REPO2/docs"
printf '# Test Repo 2\n' > "$REPO2/AGENTS.md"
printf '# Context Map\n' > "$REPO2/docs/context-map.md"
cp "$TASK_DIR/state.json" "$TASK_DIR2/state.json"
cp "$TASK_DIR/handoff.json" "$TASK_DIR2/handoff.json"
cp "$TASK_DIR/trust.bundle" "$TASK_DIR2/trust.bundle"
printf 'test-slug-153--plan-work.md stub\n' > "$TASK_DIR2/test-slug-153--plan-work.md"
# No liveness directory → empty stream

echo "{\"hook_event_name\":\"SessionStart\",\"cwd\":\"$REPO2\"}" | \
  FLOW_AGENTS_ACTOR="local" node "$ROOT/scripts/hooks/workflow-steering.js" > "$TMPDIR_EVAL/nolive.out" 2>&1

if grep -q "RESUME:" "$TMPDIR_EVAL/nolive.out"; then
  _pass "RESUME block present when no liveness stream (absence case)"
else
  _fail "RESUME block should still be present with empty liveness stream"
fi

if ! grep -q "LIVENESS WARNING" "$TMPDIR_EVAL/nolive.out"; then
  _pass "no LIVENESS WARNING when liveness stream is empty (absence case)"
else
  _fail "LIVENESS WARNING must not appear when no fresh other-actor events exist"
fi

# ─── Summary ──────────────────────────────────────────────────────────────────
if [[ "$errors" -eq 0 ]]; then
  echo "Session resume roundtrip eval passed."
  exit 0
fi

echo "Session resume roundtrip eval failed: $errors issue(s)."
exit 1
