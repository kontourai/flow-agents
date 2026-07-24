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
#   4. Persistent generation locks all remain durably released.
#
# Usage: bash evals/integration/test_command_log_concurrency.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# #440 FIXTURE-GAP: this suite's fixtures were written before #440's per-actor ownership scoping
# and never establish a per-actor current pointer for the invoking actor -- under a RESOLVED
# ambient actor (ancestry-derived locally, GITHUB_RUN_ID-derived CI-runtime in CI), stop-goal-fit.js's
# analyze() now scopes to that actor's own (nonexistent) pointer and never reaches the
# fixture-under-test at all. This suite is about anti-gaming/gate mechanics, not #440's ownership
# scoping, so forcing the documented test-only unresolved-actor escape hatch restores EXACTLY this
# suite's pre-#440 behavior (D3 compat: an unresolved actor keeps the unchanged legacy-fallback/
# global-scan discovery every assertion below was written against).
export FLOW_AGENTS_ACTOR_TEST_FORCE_UNRESOLVED=1
export NODE_ENV=test
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
mkdir -p "$REPO/.kontourai/flow-agents/$SLUG"
printf '# Repo\n' > "$REPO/AGENTS.md"
# Anchor the capture log to this slug. evidence-capture.js resolves the artifact
# dir via .kontourai/flow-agents/current.json (active_slug) or the newest state.json; seed
# both so resolveArtifactDir() points at .kontourai/flow-agents/<slug>/.
printf '{"active_slug":"%s","artifact_dir":".kontourai/flow-agents/%s"}' "$SLUG" "$SLUG" \
  > "$REPO/.kontourai/flow-agents/current.json"
printf '%s' "{\"schema_version\":\"1.0\",\"task_slug\":\"$SLUG\",\"status\":\"in_progress\",\"phase\":\"build\",\"updated_at\":\"2026-06-23T00:00:00Z\",\"next_action\":{\"status\":\"in_progress\",\"summary\":\"work\"}}" \
  > "$REPO/.kontourai/flow-agents/$SLUG/state.json"

N=24
echo "Test: $N concurrent captures into one command-log must not fork the chain"

# Launch N capture processes in parallel against the same log. Each is a fresh
# process reading its event from stdin, exactly like the PostToolUse hook.
for i in $(seq 1 "$N"); do
  printf '{"hook_event_name":"PostToolUse","tool_name":"Bash","cwd":"%s","tool_input":{"command":"echo cmd-%s"},"tool_response":{"exitCode":0,"stdout":"ok"}}' "$REPO" "$i" \
    | node "$CAPTURE" >/dev/null 2>&1 &
done
wait

LOG="$REPO/.kontourai/flow-agents/$SLUG/command-log.jsonl"

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
chain_status=$(node -e "const g = require('$GATE'); console.log(g.verifyCommandLogChain('$REPO/.kontourai/flow-agents/$SLUG').status);")
if [[ "$chain_status" == "ok" ]]; then
  _pass "verifyCommandLogChain → ok under concurrency"
else
  _fail "expected ok, got $chain_status"
fi

# 4. Persistent generations are audit history, not pathnames to unlink. Every
# generation must be parseable and durably released.
lock_report=$(node - "$LOG.lock" <<'NODE'
const fs = require('fs'), path = require('path');
const base = process.argv[2], prefix = `${path.basename(base)}.`;
const files = fs.readdirSync(path.dirname(base)).filter((name) => name.startsWith(prefix));
let ok = files.length > 0;
for (const name of files) {
  try { if (JSON.parse(fs.readFileSync(path.join(path.dirname(base), name), 'utf8')).state !== 'released') ok = false; }
  catch { ok = false; }
}
console.log(ok ? `OK:${files.length}` : 'BAD');
NODE
)
if [[ "$lock_report" == OK:* ]]; then
  _pass "all ${lock_report#OK:} persistent lock generations are released"
else
  _fail "persistent lock generation remains active or malformed: $lock_report"
fi

# ─── Test 2: permanent version fence excludes legacy writers and blocks bad generations ───
echo ""
echo "Test: permanent version fence serializes legacy/new writers and fails closed on malformed active state"

# Use an isolated fixture so the assertion is about the protocol boundary rather
# than the concurrent entries above. A new writer must establish a durable,
# permanent base fence before immutable generations; legacy O_EXCL ownership then
# cannot overlap it. Malformed fences and active crashed generations preserve the
# log and return no authority with a visible blocked diagnostic.
FENCE="$TMP/fence"
mkdir -p "$FENCE"
fence_result=$(node - "$ROOT" "$FENCE" <<'NODE'
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
const dir = process.argv[3];
const chain = require(path.join(root, 'scripts/lib/command-log-chain.js'));
const base = path.join(dir, 'command-log.jsonl.lock');
const log = path.join(dir, 'command-log.jsonl');
fs.writeFileSync(log, 'broken command-log bytes\n');
const before = fs.readFileSync(log, 'utf8');
const first = chain.acquireGenerationLock(base, { wait: false });
if (!first) throw new Error('new writer could not establish a fence');
if (!fs.existsSync(base)) throw new Error('missing permanent version fence at legacy lock pathname');
const fence = JSON.parse(fs.readFileSync(base, 'utf8'));
if (fence.protocol !== 'command-log-generation-fence-v1') throw new Error('malformed or wrong-version permanent fence');
let legacyWon = false;
try { fs.openSync(base, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); legacyWon = true; } catch (error) { if (error.code !== 'EEXIST') throw error; }
if (legacyWon) throw new Error('legacy writer acquired base lock after new fence');
chain.releaseGenerationLock(first);
const highest = `${base}.1`;
fs.writeFileSync(highest, JSON.stringify({ generation: 1, nonce: 'crashed', state: 'active' }) + '\n');
if (chain.acquireGenerationLock(base, { wait: false }) !== null) throw new Error('crashed active generation was silently superseded');
if (fs.readFileSync(log, 'utf8') !== before) throw new Error('blocked authority mutated command log');
console.log('OK: visible recovery_required authority block');
NODE
)
if [[ "$fence_result" == "OK: visible recovery_required authority block" ]]; then
  _pass "permanent version fence excludes legacy overlap and blocks malformed/crashed generations without mutation"
else
  _fail "version-fence protocol failure: $fence_result"
fi

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "command-log concurrency test passed."
  exit 0
fi
echo "command-log concurrency test FAILED: $errors issue(s)."
exit 1
