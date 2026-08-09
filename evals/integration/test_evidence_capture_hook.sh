#!/usr/bin/env bash
# test_evidence_capture_hook.sh — Capture-first evidence determinism contracts.
#
# Part A: evidence-capture.js deterministically records command executions to
#         .kontourai/flow-agents/<slug>/command-log.jsonl (machine-recorded, not model-claimed).
# Part B: stop-goal-fit.js cross-references evidence.json claimed-pass command
#         checks against the capture log, and re-runs a TRUSTED backstop command
#         only when the log has no execution for a claimed-pass command.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CAPTURE="$ROOT/scripts/hooks/evidence-capture.js"
GATE="$ROOT/scripts/hooks/stop-goal-fit.js"
CURRENT_POINTER_HELPER="$ROOT/scripts/hooks/lib/current-pointer.js"
# #440: every fixture this file builds is "owned" by this one constant actor, once a given
# invocation below applies FLOW_AGENTS_ACTOR="$EVIDENCE_ACTOR" to it (see seed_repo/capture()).
EVIDENCE_ACTOR="eval-evidence-capture-actor"

# Disable the block escape hatch so repeated independent assertions never trip it.
export FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=100000

TMP="$(mktemp -d)"
errors=0
_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

# ---- helpers -------------------------------------------------------------
seed_repo() { # $1 dir, $2 slug, $3 git|no_git (default: git)
  local p="$1" slug="$2" git_mode="${3:-git}"
  mkdir -p "$p/.kontourai/flow-agents/$slug"
  printf '# Repo\n' > "$p/AGENTS.md"
  printf '%s' "{\"schema_version\":\"1.0\",\"task_slug\":\"$slug\",\"status\":\"delivered\",\"phase\":\"done\",\"updated_at\":\"2026-06-23T00:00:00Z\",\"next_action\":{\"status\":\"done\",\"summary\":\"done\"}}" > "$p/.kontourai/flow-agents/$slug/state.json"
  cat > "$p/.kontourai/flow-agents/$slug/$slug--deliver.md" <<MD
# $slug

branch: main
status: delivered
type: deliver

## Definition Of Done
- [x] tests pass

## Goal Fit Gate
- [x] acceptance verified

### Verdict: PASS
MD
  # #440 FIXTURE-GAP: seed EVIDENCE_ACTOR's own per-actor current pointer for this repo/slug,
  # unconditionally (harmless/unused for any invocation below that does NOT set
  # FLOW_AGENTS_ACTOR="$EVIDENCE_ACTOR") -- mirroring workflow-sidecar.ts's real writeCurrent()
  # dual-write via current-pointer.js's own writePerActorCurrent, so #440's ownership-scoped
  # resolveArtifactDir/preferredArtifactDir find this fixture's session exactly like a real
  # ensure-session'd one would.
  CP_HELPER_ARG="$CURRENT_POINTER_HELPER" FLOW_AGENTS_DIR_ARG="$p/.kontourai/flow-agents" \
    SLUG_ARG="$slug" ACTOR_ARG="$EVIDENCE_ACTOR" node - <<'NODE'
const { writePerActorCurrent } = require(process.env.CP_HELPER_ARG);
writePerActorCurrent(process.env.FLOW_AGENTS_DIR_ARG, process.env.ACTOR_ARG, { active_slug: process.env.SLUG_ARG });
NODE
  if [[ "$git_mode" == "git" ]]; then
    # Keep capture output itself ignored, so each observation describes the host
    # result boundary rather than the previous hook append.
    printf '.kontourai/\n' > "$p/.gitignore"
    git -C "$p" init --quiet
    git -C "$p" add .
    git -C "$p" -c user.name='Flow Agents Eval' -c user.email='eval@flow-agents.invalid' commit --quiet -m 'seed fixture'
  fi
}

capture() { # stdin = payload json
  FLOW_AGENTS_ACTOR="$EVIDENCE_ACTOR" node "$CAPTURE" >/dev/null 2>&1
}

# ============================================================================
# Part A — deterministic capture
# ============================================================================
A="$TMP/capture"; seed_repo "$A" t1
echo "Part A: deterministic capture"

printf '{"hook_event_name":"PostToolUse","tool_name":"Bash","cwd":"%s","tool_input":{"command":"npm test"},"tool_response":{"exitCode":0,"stdout":"ok"}}' "$A" | capture
printf '{"hook_event_name":"PostToolUse","tool_name":"Bash","cwd":"%s","tool_input":{"command":"npm run lint"},"error":"command failed"}' "$A" | capture
printf '{"hook_event_name":"PostToolUse","tool_name":"Bash","cwd":"%s","tool_input":{"command":"make build"},"tool_response":{"exit_code":2}}' "$A" | capture
# #470 rule-3 default: no exit code, no error, no stderr → ambiguous (never pass).
printf '{"hook_event_name":"PostToolUse","tool_name":"Bash","cwd":"%s","tool_input":{"command":"echo status-check"}}' "$A" | capture
# A non-command tool (Write) must NOT be captured.
printf '{"hook_event_name":"PostToolUse","tool_name":"Write","cwd":"%s","tool_input":{"file_path":"/tmp/x"}}' "$A" | capture

LOG="$A/.kontourai/flow-agents/t1/command-log.jsonl"
if [[ -f "$LOG" ]]; then _pass "capture writes command-log.jsonl"; else _fail "capture did not write command-log.jsonl"; fi

lines=$(wc -l < "$LOG" | tr -d ' ')
if [[ "$lines" == "4" ]]; then _pass "capture records 4 command executions (Write tool excluded)"; else _fail "expected 4 log lines, got $lines"; fi

if rg -q '"command":"npm test","observedResult":"pass","exitCode":0' "$LOG"; then
  _pass "clean exit 0 recorded as observedResult:pass exitCode:0"
else _fail "passing command not recorded correctly: $(cat "$LOG")"; fi

if rg -q '"command":"npm run lint","observedResult":"fail","exitCode":null' "$LOG"; then
  _pass "error field with no exit code recorded as fail exitCode:null"
else _fail "errored command not recorded correctly"; fi

if rg -q '"command":"make build","observedResult":"fail","exitCode":2' "$LOG"; then
  _pass "non-zero exit recorded as fail with exitCode"
else _fail "non-zero-exit command not recorded correctly"; fi

# #470 rule-3 default: absent any positive success evidence, observedResult is
# "ambiguous" (never "pass"). The error-bearing case above ("npm run lint" →
# fail, exitCode:null) already proves rule 2 (isFailureIndicated) is unchanged
# by the rule-3 flip.
if rg -q '"command":"echo status-check","observedResult":"ambiguous","exitCode":null' "$LOG"; then
  _pass "no-signal command (no exit code, no error, no stderr) recorded as ambiguous, never pass"
else _fail "no-signal command not recorded as ambiguous: $(cat "$LOG")"; fi

if rg -q '"source":"postToolUse-capture"' "$LOG"; then _pass "records source:postToolUse-capture"; else _fail "missing source field"; fi

A_HEAD=$(git -C "$A" rev-parse HEAD)
CAPTURE_LOG="$LOG" EXPECTED_HEAD="$A_HEAD" ROOT="$ROOT" node - <<'NODE'
const fs = require('fs');
const { verifyCommandLogRaw } = require(`${process.env.ROOT}/scripts/lib/command-log-chain.js`);
const raw = fs.readFileSync(process.env.CAPTURE_LOG, 'utf8');
const records = raw.trim().split('\n').map(JSON.parse);
if (!records.every((record) => record.observed_at_commit === process.env.EXPECTED_HEAD && record.worktree_clean === true)) process.exit(1);
if (verifyCommandLogRaw(raw).status !== 'ok') process.exit(1);
if (verifyCommandLogRaw(raw.replace('"worktree_clean":true', '"worktree_clean":false')).status === 'ok') process.exit(1);
NODE
if [[ "$?" -eq 0 ]]; then _pass "clean Git observations stamp exact commit and chain their provenance"; else _fail "clean Git provenance missing or excluded from chain"; fi

# Make a tracked file dirty only after the clean captures, then prove the next
# record is chained with the same commit and an explicit dirty observation.
printf '\nfixture dirt\n' >> "$A/AGENTS.md"
printf '{"hook_event_name":"PostToolUse","tool_name":"Bash","cwd":"%s","tool_input":{"command":"npm run dirty"},"tool_response":{"exitCode":0}}' "$A" | capture
CAPTURE_LOG="$LOG" EXPECTED_HEAD="$A_HEAD" ROOT="$ROOT" node - <<'NODE'
const fs = require('fs');
const { verifyCommandLogRaw } = require(`${process.env.ROOT}/scripts/lib/command-log-chain.js`);
const raw = fs.readFileSync(process.env.CAPTURE_LOG, 'utf8');
const records = raw.trim().split('\n').map(JSON.parse);
const last = records.at(-1);
if (!last || last.command !== 'npm run dirty' || last.observed_at_commit !== process.env.EXPECTED_HEAD || last.worktree_clean !== false || verifyCommandLogRaw(raw).status !== 'ok') process.exit(1);
NODE
if [[ "$?" -eq 0 ]]; then _pass "dirty Git observation is explicit and included in the chain"; else _fail "dirty Git provenance missing or excluded from chain"; fi

# A repository-shaped path whose Git metadata cannot resolve must never add a
# pass-capable record. A true non-Git workspace follows the same
# non-blocking, non-confirming behavior.
NG="$TMP/non-git"; seed_repo "$NG" t1 no_git
printf '{"hook_event_name":"PostToolUse","tool_name":"Bash","cwd":"%s","tool_input":{"command":"npm test"},"tool_response":{"exitCode":0}}' "$NG" | capture
if [[ ! -e "$NG/.kontourai/flow-agents/t1/command-log.jsonl" ]]; then _pass "non-Git capture is non-confirming and leaves no log record"; else _fail "non-Git capture wrote an optimistic log record"; fi

GF="$TMP/git-failure"; seed_repo "$GF" t1 no_git
printf 'gitdir: /not/a/repository\n' > "$GF/.git"
printf '{"hook_event_name":"PostToolUse","tool_name":"Bash","cwd":"%s","tool_input":{"command":"npm test"},"tool_response":{"exitCode":0}}' "$GF" | capture
if [[ ! -e "$GF/.kontourai/flow-agents/t1/command-log.jsonl" ]]; then _pass "Git failure is non-confirming and leaves no log record"; else _fail "Git failure wrote an optimistic log record"; fi

# Git can mark a tracked path assume-unchanged or skip-worktree. Both tags can
# hide bytes from ordinary status checks, so capture must leave its chain
# untouched rather than emit a pass-capable observation.
for index_flag in --assume-unchanged --skip-worktree; do
  HI="$TMP/hidden-index-${index_flag#--}"; seed_repo "$HI" t1
  git -C "$HI" update-index "$index_flag" AGENTS.md
  printf '{"hook_event_name":"PostToolUse","tool_name":"Bash","cwd":"%s","tool_input":{"command":"npm test"},"tool_response":{"exitCode":0}}' "$HI" | capture
  if [[ ! -e "$HI/.kontourai/flow-agents/t1/command-log.jsonl" ]]; then _pass "${index_flag} is non-confirming and leaves no log record"; else _fail "${index_flag} wrote a record despite a hidden-index state"; fi
done

# A nested AGENTS.md must not narrow the observed worktree or artifact route.
# The capture runs from the nested directory while the dirty tracked file is at
# the repository root, so a subtree-scoped observation would incorrectly claim
# cleanliness or miss the active artifact.
NESTED="$TMP/nested-root"; seed_repo "$NESTED" t1
mkdir -p "$NESTED/nested"
printf '# Nested instructions\n' > "$NESTED/nested/AGENTS.md"
git -C "$NESTED" add nested/AGENTS.md
git -C "$NESTED" -c user.name='Flow Agents Eval' -c user.email='eval@flow-agents.invalid' commit --quiet -m 'nested instructions'
printf 'dirty root change\n' >> "$NESTED/AGENTS.md"
printf '{"hook_event_name":"PostToolUse","tool_name":"Bash","cwd":"%s","tool_input":{"command":"npm test"},"tool_response":{"exitCode":0}}' "$NESTED/nested" | capture
if rg -q '"command":"npm test".*"worktree_clean":false' "$NESTED/.kontourai/flow-agents/t1/command-log.jsonl" 2>/dev/null; then
  _pass "nested AGENTS capture observes the full Git root and root-level dirtiness"
else _fail "nested AGENTS capture missed the canonical root or active artifact: $(cat "$NESTED/.kontourai/flow-agents/t1/command-log.jsonl" 2>/dev/null)"; fi

# Trusted diff observation must not execute repository-configured external or
# text-conversion commands while inspecting a dirty file.
HOSTILE="$TMP/hostile-diff"; seed_repo "$HOSTILE" t1
printf 'AGENTS.md diff=evil\n' > "$HOSTILE/.gitattributes"
git -C "$HOSTILE" add .gitattributes
git -C "$HOSTILE" -c user.name='Flow Agents Eval' -c user.email='eval@flow-agents.invalid' commit --quiet -m 'declare diff driver'
HOSTILE_MARKER="$TMP/hostile-diff-ran"
HOSTILE_SCRIPT="$TMP/hostile-diff.sh"
printf '#!/usr/bin/env sh\nprintf hostile > "%s"\n' "$HOSTILE_MARKER" > "$HOSTILE_SCRIPT"
chmod 700 "$HOSTILE_SCRIPT"
git -C "$HOSTILE" config diff.external "$HOSTILE_SCRIPT"
git -C "$HOSTILE" config diff.evil.textconv "$HOSTILE_SCRIPT"
printf 'dirty diff input\n' >> "$HOSTILE/AGENTS.md"
printf '{"hook_event_name":"PostToolUse","tool_name":"Bash","cwd":"%s","tool_input":{"command":"npm test"},"tool_response":{"exitCode":0}}' "$HOSTILE" | capture
if [[ ! -e "$HOSTILE_MARKER" ]] && rg -q '"command":"npm test"' "$HOSTILE/.kontourai/flow-agents/t1/command-log.jsonl" 2>/dev/null; then
  _pass "trusted Git diff ignores repository external and text-conversion commands"
else _fail "trusted Git diff executed repository-configured helper or skipped capture"; fi

# A normal repository can have an index listing beyond the old shared 64 KiB
# cap. Inject such a bounded output directly to verify the dedicated 4 MiB
# tracked-index cap without building a slow filesystem fixture.
HOOK_PATH="$CAPTURE" node - <<'NODE'
const { ordinaryTrackedIndex } = require(process.env.HOOK_PATH);
const entry = `H ${'x'.repeat(240)}\0`;
const output = Buffer.from(entry.repeat(300));
let observedLimit = null;
const accepted = ordinaryTrackedIndex('/fixture', (_root, _args, maxOutput) => {
  observedLimit = maxOutput;
  return output;
});
if (!accepted || output.length <= 64 * 1024 || observedLimit !== 4 * 1024 * 1024) process.exit(1);
NODE
if [[ "$?" -eq 0 ]]; then _pass "large ordinary tracked index uses the dedicated 4 MiB cap"; else _fail "large ordinary tracked index cap is incorrect"; fi

# The second bounded diff/list read closes the interval after the first inputs
# were collected. Exercise both additions deterministically through the
# exported hook seam: neither may become a confirming observation.
for mutation_kind in tracked untracked; do
  SM="$TMP/settle-${mutation_kind}"; seed_repo "$SM" t1
  HOOK_PATH="$CAPTURE" SNAPSHOT_ROOT="$SM" MUTATION_KIND="$mutation_kind" node - <<'NODE'
const fs = require('fs');
const path = require('path');
const { observeGitWorktree } = require(process.env.HOOK_PATH);
const observation = observeGitWorktree(process.env.SNAPSHOT_ROOT, {
  afterInitialInputsRead() {
    const file = process.env.MUTATION_KIND === 'tracked' ? 'AGENTS.md' : 'arrived.txt';
    fs.appendFileSync(path.join(process.env.SNAPSHOT_ROOT, file), 'mutation\n');
  },
});
if (observation !== null) process.exit(1);
NODE
  if [[ "$?" -eq 0 ]]; then _pass "mid-capture ${mutation_kind} mutation is non-confirming"; else _fail "mid-capture ${mutation_kind} mutation produced an observation"; fi
done

# Capture is non-blocking: it always exits 0 and echoes stdin.
out=$(printf '{"hook_event_name":"PostToolUse","tool_name":"Bash","cwd":"%s","tool_input":{"command":"echo hi"},"error":"boom"}' "$A" | node "$CAPTURE"; echo "EXIT=$?")
if rg -q 'EXIT=0' <<<"$out" && rg -q 'echo hi' <<<"$out"; then
  _pass "capture is non-blocking (exit 0, echoes stdin) even on a failing command"
else _fail "capture should be non-blocking and echo stdin"; fi

# An unexpected append/filesystem error must stay process-nonblocking but be
# auditable. A directory at the log path forces appendFileSync to fail after
# Git observation, without exposing the underlying exception text.
AF="$TMP/append-failure"; seed_repo "$AF" t1
mkdir "$AF/.kontourai/flow-agents/t1/command-log.jsonl"
append_failure_out=$(printf '{"hook_event_name":"PostToolUse","tool_name":"Bash","cwd":"%s","tool_input":{"command":"npm test"},"tool_response":{"exitCode":0}}' "$AF" \
  | FLOW_AGENTS_ACTOR="$EVIDENCE_ACTOR" node "$CAPTURE" 2>&1; echo "EXIT=$?")
if rg -q 'EXIT=0' <<<"$append_failure_out" \
  && rg -q '\[evidence-capture\] capture failed; command-log left unchanged' <<<"$append_failure_out" \
  && [[ -d "$AF/.kontourai/flow-agents/t1/command-log.jsonl" ]] \
  && ! rg -q 'EISDIR|appendFileSync|/Users/' <<<"$append_failure_out"; then
  _pass "unexpected append failure is diagnostic, non-blocking, and non-confirming"
else _fail "unexpected append failure was silent, blocking, or exposed exception details: $append_failure_out"; fi

# ============================================================================
# Part B1 — gate cross-references log: claimed pass but log shows FAIL → block
# ============================================================================
echo "Part B1: log contradicts claimed pass → block"
B="$TMP/contradict"; seed_repo "$B" t1
printf '%s' '{"schema_version":"1.0","task_slug":"t1","verdict":"pass","checks":[{"id":"unit-tests","kind":"command","status":"pass","command":"npm test","summary":"tests passed"}]}' > "$B/.kontourai/flow-agents/t1/evidence.json"
printf '%s\n' '{"command":"npm test","observedResult":"fail","exitCode":1,"capturedAt":"2026-06-23T00:00:00Z","source":"postToolUse-capture"}' > "$B/.kontourai/flow-agents/t1/command-log.jsonl"

if FLOW_AGENTS_ACTOR="$EVIDENCE_ACTOR" FLOW_AGENTS_GOAL_FIT_MODE=block FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip node "$GATE" >/dev/null 2>"$TMP/b1.err" <<JSON
{"hook_event_name":"Stop","cwd":"$B"}
JSON
then _fail "gate should BLOCK when capture log contradicts claimed pass"
else
  status=$?
  if [[ "$status" -eq 2 ]] && rg -q 'capture log CONTRADICTS claimed pass' "$TMP/b1.err" && rg -q 'caught false-completion' "$TMP/b1.err"; then
    _pass "gate blocks (exit 2) caught false-completion via capture log"
  else _fail "gate returned unexpected result: status=$status output=$(cat "$TMP/b1.err")"; fi
fi

# ============================================================================
# Part B2 — bundle-less sidecar/log pass remains nonconfirming and uses backstop
# ============================================================================
echo "Part B2: bundle-less sidecar/log pass remains NOT_VERIFIED"
C="$TMP/confirm"; seed_repo "$C" t1
printf '%s' '{"name":"x","scripts":{"test":"exit 0"}}' > "$C/package.json"
printf '%s' '{"schema_version":"1.0","task_slug":"t1","status":"in_progress","phase":"verification","updated_at":"2026-06-23T00:00:00Z","next_action":{"status":"continue","summary":"verify command evidence"}}' > "$C/.kontourai/flow-agents/t1/state.json"
printf '%s' '{"schema_version":"1.0","task_slug":"t1","verdict":"pass","checks":[{"id":"unit-tests","kind":"command","status":"pass","command":"npm test","summary":"tests passed"}]}' > "$C/.kontourai/flow-agents/t1/evidence.json"
printf '%s\n' '{"command":"npm test","observedResult":"pass","exitCode":0,"capturedAt":"2026-06-23T00:00:00Z","source":"postToolUse-capture"}' > "$C/.kontourai/flow-agents/t1/command-log.jsonl"
# The unsigned, provenance-free command-log record may report pass but cannot
# confirm an evidence.json claim. The trusted manifest target must run and the
# missing authoritative bundle keeps the result NOT_VERIFIED.
if FLOW_AGENTS_ACTOR="$EVIDENCE_ACTOR" FLOW_AGENTS_GOAL_FIT_MODE=block node "$GATE" >/dev/null 2>"$TMP/b2.err" <<JSON
{"hook_event_name":"Stop","cwd":"$C"}
JSON
then _fail "bundle-less evidence.json plus command-log pass must not confirm a stop"
else
  status=$?
  if [[ "$status" -eq 2 ]] && rg -q 'trust.bundle is required' "$TMP/b2.err" && rg -q 'trusted backstop \(manifest\) passed' "$TMP/b2.err" && rg -q 'NOT_VERIFIED' "$TMP/b2.err"; then
    _pass "bundle-less v1 sidecar/log data uses the trusted backstop but remains NOT_VERIFIED"
  else _fail "bundle-less sidecar/log path returned unexpected result: status=$status output=$(cat "$TMP/b2.err")"; fi
fi

# ============================================================================
# Part B3 — never-captured claimed-pass command → trusted backstop re-run (declared manifest target FAILS) → block
# ============================================================================
echo "Part B3: never-captured claim → trusted manifest backstop catches a fail"
D="$TMP/backstop"; seed_repo "$D" t1
printf '%s' '{"name":"x","scripts":{"test":"exit 7"}}' > "$D/package.json"
printf '%s' '{"schema_version":"1.0","task_slug":"t1","verdict":"pass","checks":[{"id":"unit-tests","kind":"command","status":"pass","command":"npm test","summary":"tests passed"}]}' > "$D/.kontourai/flow-agents/t1/evidence.json"
# command-log.jsonl intentionally absent — the command was never actually run.

if FLOW_AGENTS_ACTOR="$EVIDENCE_ACTOR" FLOW_AGENTS_GOAL_FIT_MODE=block node "$GATE" >/dev/null 2>"$TMP/b3.err" <<JSON
{"hook_event_name":"Stop","cwd":"$D"}
JSON
then _fail "gate should BLOCK when trusted backstop re-run of declared manifest target fails"
else
  status=$?
  if [[ "$status" -eq 2 ]] && rg -q 'trusted backstop \(manifest\)' "$TMP/b3.err" && rg -q 'FAILED with exit 7' "$TMP/b3.err"; then
    _pass "gate runs trusted declared manifest target as backstop and blocks on its failure"
  else _fail "backstop did not catch declared-target failure: status=$status output=$(cat "$TMP/b3.err")"; fi
fi

# ============================================================================
# Part B4 — never-captured claim, no trusted command resolves → NOT_VERIFIED (never a silent pass)
# ============================================================================
echo "Part B4: never-captured claim, nothing trusted resolves → NOT_VERIFIED"
E="$TMP/notverified"; seed_repo "$E" t1
printf '%s' '{"schema_version":"1.0","task_slug":"t1","status":"in_progress","phase":"verification","updated_at":"2026-06-23T00:00:00Z","next_action":{"status":"continue","summary":"verify command evidence"}}' > "$E/.kontourai/flow-agents/t1/state.json"
printf '%s' '{"schema_version":"1.0","task_slug":"t1","verdict":"pass","checks":[{"id":"custom","kind":"command","status":"pass","command":"./my-thing.sh","summary":"ran custom"}]}' > "$E/.kontourai/flow-agents/t1/evidence.json"

if FLOW_AGENTS_ACTOR="$EVIDENCE_ACTOR" FLOW_AGENTS_GOAL_FIT_MODE=block FLOW_AGENTS_GOAL_FIT_RECHECK=false node "$GATE" >/dev/null 2>"$TMP/b4.err" <<JSON
{"hook_event_name":"Stop","cwd":"$E"}
JSON
then _fail "gate should not silently pass an un-captured, un-verifiable claimed-pass command"
else
  status=$?
  if [[ "$status" -eq 2 ]] && rg -q 'NOT_VERIFIED' "$TMP/b4.err" && rg -q 'no trusted command' "$TMP/b4.err"; then
    _pass "gate records NOT_VERIFIED (never a guess) when no trusted command resolves"
  else _fail "NOT_VERIFIED path returned unexpected result: status=$status output=$(cat "$TMP/b4.err")"; fi
fi

# ============================================================================
# Part B5 — arbitrary model command is opt-in only (FLOW_AGENTS_GOAL_FIT_RECHECK)
# ============================================================================
echo "Part B5: free-form model command re-run is opt-in only"
F="$TMP/recheck"; seed_repo "$F" t1
# #494: the opt-in RECHECK re-run of model-recorded free-form commands applies to IN-FLIGHT
# sessions. On terminal delivered/done sessions the model-asserted RECHECK is skipped (captured
# execution evidence + L2 CI remain the anchors) — terminal-skip is covered in test_goal_fit_hook.sh.
# seed_repo defaults to delivered/done, so make this session in-flight to exercise the opt-in re-run.
printf '%s' '{"schema_version":"1.0","task_slug":"t1","status":"in_progress","phase":"verification","updated_at":"2026-06-23T00:00:00Z","next_action":{"status":"continue","summary":"verify command evidence"}}' > "$F/.kontourai/flow-agents/t1/state.json"
printf '%s' '{"schema_version":"1.0","task_slug":"t1","verdict":"pass","checks":[{"id":"custom","kind":"command","status":"pass","command":"exit 5","summary":"ran custom"}]}' > "$F/.kontourai/flow-agents/t1/evidence.json"
# Opt-in ON (in-flight): the model's free-form "exit 5" is re-run and fails → block.
if FLOW_AGENTS_ACTOR="$EVIDENCE_ACTOR" FLOW_AGENTS_GOAL_FIT_MODE=block FLOW_AGENTS_GOAL_FIT_RECHECK=true node "$GATE" >/dev/null 2>"$TMP/b5.err" <<JSON
{"hook_event_name":"Stop","cwd":"$F"}
JSON
then _fail "with RECHECK=true the failing model command should block"
else
  status=$?
  if [[ "$status" -eq 2 ]] && rg -q 'FLOW_AGENTS_GOAL_FIT_RECHECK' "$TMP/b5.err"; then
    _pass "FLOW_AGENTS_GOAL_FIT_RECHECK=true opts into re-running the model's free-form command"
  else _fail "recheck opt-in path returned unexpected result: status=$status output=$(cat "$TMP/b5.err")"; fi
fi

if [[ "$errors" -eq 0 ]]; then
  echo "Evidence capture hook integration passed."
  exit 0
fi
echo "Evidence capture hook integration failed: $errors issue(s)."
exit 1
