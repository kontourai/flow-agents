#!/usr/bin/env bash
# test_goal_fit_ghost_session.sh — WS8 (AC10) stop-goal-fit hardening.
#
# (a) GHOST-SESSION: when current.json names a slug whose session directory does not exist,
#     the hook LOGS the staleness and does NOT resurface an abandoned, markdown-only
#     directory (no state.json / trust.bundle) as "the active session" via a global mtime
#     scan. A directory is eligible as active only with real sidecar presence.
# (b) MALFORMED-EVIDENCE: a kind:"command" acceptance evidence ref whose excerpt is prose
#     (a sentence, not a runnable command) is classified `malformed-evidence` — it is NOT
#     spawned via `bash -lc "<a sentence>"` and NOT conflated with a caught false-completion.
#
# Deterministic, no model spend, self-cleaning.
# Usage: bash evals/integration/test_goal_fit_ghost_session.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="$ROOT/scripts/hooks/stop-goal-fit.js"

TMP="$(mktemp -d)"
errors=0
_pass() { echo "  PASS: $1"; }
_fail() { echo "  FAIL: $1"; errors=$((errors + 1)); }
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# ─── (a) GHOST-SESSION ─────────────────────────────────────────────────────────
echo "=== AC10a: stale current.json slug does not resurface an abandoned markdown-only session ==="
REPO="$TMP/repo"
FA="$REPO/.kontourai/flow-agents"
mkdir -p "$FA/old-abandoned"
printf '# Test Repo\n' > "$REPO/AGENTS.md"

# An abandoned session: ACTIVE status, but only a markdown artifact (no state.json / trust.bundle).
cat > "$FA/old-abandoned/old-abandoned--deliver.md" <<'MD'
# Old abandoned session

branch: main
worktree: main
created: 2026-01-01
status: executing
type: deliver

## Plan

Abandoned long ago; never had sidecars.
MD

# current.json points at a slug whose directory does NOT exist (stale pointer).
cat > "$FA/current.json" <<'JSON'
{ "schema_version": "1.0", "active_slug": "ghost-slug", "artifact_dir": "ghost-slug", "updated_at": "2026-07-02T00:00:00Z", "owner": "workflow-sidecar", "source": "ensure-session", "active_agents": [] }
JSON

out_a="$(echo '{"hook_event_name":"Stop","cwd":"'"$REPO"'"}' | node "$HOOK" 2>"$TMP/a.err")"
exit_a=$?
err_a="$(cat "$TMP/a.err")"

if echo "$err_a" | grep -q 'no such session directory exists'; then
  _pass "staleness is LOGGED (stale current.json slug is visible, not silently swallowed)"
else
  _fail "expected a staleness log for the stale current.json slug; stderr: $err_a"
fi

if echo "$err_a" | grep -q 'old-abandoned'; then
  _fail "abandoned markdown-only session was resurfaced as active (should be filtered — no sidecar): $err_a"
else
  _pass "abandoned markdown-only session (no state.json/trust.bundle) was NOT resurfaced as active"
fi

if [[ $exit_a -eq 0 ]]; then
  _pass "no block from a stale pointer + abandoned session (exit 0)"
else
  _fail "expected exit 0 (nothing genuinely active), got $exit_a"
fi

# ─── (b) MALFORMED-EVIDENCE ─────────────────────────────────────────────────────
echo ""
echo "=== AC10b: prose kind:command evidence ref is classified malformed, never spawned as bash ==="
if node - "$ROOT" << 'NODE'
const path = require('path');
const mod = require(path.join(process.argv[2], 'scripts/hooks/stop-goal-fit.js'));
const check = { id: 'unit', command: '', kind: 'test', status: 'not_verified' };
const prose = { criteria: [ { id: 'unit', evidence_refs: [ { kind: 'command', excerpt: 'Manually verify the dashboard renders the export button and click it.' } ] } ] };
const runnable = { criteria: [ { id: 'unit', evidence_refs: [ { kind: 'command', excerpt: 'npm test' } ] } ] };
const r1 = mod.resolveTrustedCommand('/repo', '/repo/.kontourai/flow-agents/x', check, prose);
const r2 = mod.resolveTrustedCommand('/repo', '/repo/.kontourai/flow-agents/x', check, runnable);
if (!(r1 && r1.malformed && !r1.argv)) { console.error('prose ref NOT classified malformed: ' + JSON.stringify(r1)); process.exit(1); }
if (!(r2 && Array.isArray(r2.argv) && r2.argv[0] === 'bash' && r2.argv[2] === 'npm test')) { console.error('runnable ref did not resolve to an argv: ' + JSON.stringify(r2)); process.exit(1); }
process.exit(0);
NODE
then
  _pass "prose acceptance command ref → {malformed} (no argv); runnable ref → executable argv"
else
  _fail "resolveTrustedCommand mishandled prose vs runnable command refs"
fi

echo ""
if [[ $errors -eq 0 ]]; then
  echo "test_goal_fit_ghost_session: all checks passed."
  exit 0
else
  echo "test_goal_fit_ghost_session: $errors check(s) failed."
  exit 1
fi
