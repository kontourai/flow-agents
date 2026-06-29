#!/usr/bin/env bash
# test_command_log_concurrency.sh — concurrent captures must NOT fork the chain.
#
# Regression test for the benign-race that broke command-log.jsonl integrity:
# two capture processes writing to the SAME log concurrently each read the same
# prevHash and appended entries with an identical seq/prevHash, forking the
# hash-chain so the tamper-evidence verifier reported "broken" on honest work.
#
# evidence-capture.js now serializes the read→compute→append critical section
# with an atomic lockfile. This test launches many captures in parallel against
# one log and asserts:
#   1. Every launched entry is present (capture never drops a record).
#   2. seq values are unique and contiguous (no fork — the lock held).
#   3. verifyCommandLogChain() returns "ok" (chain verifies end-to-end).
#   4. No stale .lock file is left behind.
#
# Usage: bash evals/integration/test_command_log_concurrency.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CAPTURE="$ROOT/scripts/hooks/evidence-capture.js"
GATE="$ROOT/scripts/hooks/stop-goal-fit.js"

TMP="$(mktemp -d)"
errors=0
_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

REPO="$TMP/repo"
SLUG="conc"
mkdir -p "$REPO/.flow-agents/$SLUG"
printf '# Repo\n' > "$REPO/AGENTS.md"
# Anchor the capture log to this slug. evidence-capture.js resolves the artifact
# dir via .flow-agents/current.json (active_slug) or the newest state.json; seed
# both so resolveArtifactDir() points at .flow-agents/<slug>/.
printf '{"active_slug":"%s","artifact_dir":".flow-agents/%s"}' "$SLUG" "$SLUG" \
  > "$REPO/.flow-agents/current.json"
printf '%s' "{\"schema_version\":\"1.0\",\"task_slug\":\"$SLUG\",\"status\":\"in_progress\",\"phase\":\"build\",\"updated_at\":\"2026-06-23T00:00:00Z\",\"next_action\":{\"status\":\"in_progress\",\"summary\":\"work\"}}" \
  > "$REPO/.flow-agents/$SLUG/state.json"

N=24
echo "Test: $N concurrent captures into one command-log must not fork the chain"

# Launch N capture processes in parallel against the same log. Each is a fresh
# process reading its event from stdin, exactly like the PostToolUse hook.
for i in $(seq 1 "$N"); do
  printf '{"hook_event_name":"PostToolUse","tool_name":"Bash","cwd":"%s","tool_input":{"command":"echo cmd-%s"},"tool_response":{"exitCode":0,"stdout":"ok"}}' "$REPO" "$i" \
    | node "$CAPTURE" >/dev/null 2>&1 &
done
wait

LOG="$REPO/.flow-agents/$SLUG/command-log.jsonl"

# 1. All N records present.
count=$(grep -c '' "$LOG" 2>/dev/null || echo 0)
if [[ "$count" -eq "$N" ]]; then
  _pass "all $N records captured (none dropped)"
else
  _fail "expected $N records, found $count"
fi

# 2. seq values unique and contiguous 0..N-1 (no fork).
seq_report=$(python3 - "$LOG" "$N" << 'PY'
import json, sys
log, n = sys.argv[1], int(sys.argv[2])
seqs = []
for line in open(log):
    line = line.strip()
    if not line:
        continue
    e = json.loads(line)
    ch = e.get('_chain')
    if not ch:
        print("UNCHAINED")  # an entry without a chain link = a gap = fork risk
        sys.exit(0)
    seqs.append(ch['seq'])
expected = list(range(n))
if sorted(seqs) == expected:
    print("OK")
else:
    dups = sorted({s for s in seqs if seqs.count(s) > 1})
    print(f"BAD seqs={sorted(seqs)} dups={dups}")
PY
)
if [[ "$seq_report" == "OK" ]]; then
  _pass "seq values unique and contiguous 0..$((N - 1)) — no fork"
else
  _fail "seq integrity broken: $seq_report"
fi

# 3. The verifier confirms an intact chain.
chain_status=$(node -e "const g = require('$GATE'); console.log(g.verifyCommandLogChain('$REPO/.flow-agents/$SLUG').status);")
if [[ "$chain_status" == "ok" ]]; then
  _pass "verifyCommandLogChain → ok under concurrency"
else
  _fail "expected ok, got $chain_status"
fi

# 4. No stale lock left behind.
if [[ ! -e "$LOG.lock" ]]; then
  _pass "lockfile cleaned up (no stale .lock)"
else
  _fail "stale lockfile remains: $LOG.lock"
fi

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "command-log concurrency test passed."
  exit 0
fi
echo "command-log concurrency test FAILED: $errors issue(s)."
exit 1
