#!/usr/bin/env bash
# test_stop_gate_summary_record.sh — stop-gate cross-check summary record (#1266)
#
# Proves the machine-readable heartbeat the Stop gate emits alongside the economics record:
#   - a planted contradiction (the EXISTING conformance fixture
#     stop-goal-fit--block-capture-contradicts-claimed-pass.json) increments claims_contradicted
#     THROUGH THE DEDUP PATH: both contradiction sources (captureCrossReference and
#     capturedFailReconciliation) demonstrably fire for the same command, and the count is 1;
#   - claims_total vs claims_checked are both present (the slice(0,8) cap must stay disclosed);
#   - chain carries the verifier's real enum (this fixture's chainless log reads `legacy`,
#     never `ok`);
#   - commands_captured is distinct-normalized-commands (latest-wins map), not raw log lines:
#     re-running the same command adds a log line but not a count;
#   - a genuine re-run-to-pass clears the contradiction (latest-wins), and the record says so;
#   - absent hooks/session ⇒ absent record — never a fabricated zero row;
#   - the emitted record validates against scripts/telemetry/stop-gate-summary.schema.json
#     (sibling of economics-record.schema.json);
#   - both hook copies (scripts/ and context/ mirror) stay byte-identical.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

FIXTURE="$ROOT/packaging/conformance/fixtures/stop-goal-fit--block-capture-contradicts-claimed-pass.json"
HOOK="$ROOT/scripts/hooks/stop-goal-fit.js"
SCHEMA="$ROOT/scripts/telemetry/stop-gate-summary.schema.json"
TMPDIR_EVAL="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/eval-stop-gate-summary.XXXXXX")" && pwd -P)"
errors=0

cleanup() { rm -rf "$TMPDIR_EVAL"; }
trap cleanup EXIT

_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

echo "=== Layer 2: Stop-gate cross-check summary record (#1266) ==="
echo ""

# ── Materialize the EXISTING contradiction fixture into a temp workspace ─────────────────
WS="$TMPDIR_EVAL/contradiction"
node - "$FIXTURE" "$WS" <<'NODE'
const fs = require('fs'), path = require('path'), cp = require('child_process');
const fixture = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const ws = process.argv[3];
fs.mkdirSync(ws, { recursive: true });
for (const [rel, content] of Object.entries(fixture.workspace_setup)) {
  const file = path.join(ws, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
if (fixture.workspace_git) {
  cp.execSync('git init -q && git add -A && git -c user.email=eval@local -c user.name=eval commit -qm init', { cwd: ws });
}
fs.writeFileSync(path.join(ws, 'fixture-env.json'), JSON.stringify(fixture.env || {}));
NODE
if [[ -f "$WS/.kontourai/flow-agents/false-pass/command-log.jsonl" ]]; then
  _pass "conformance contradiction fixture materialized (claimed pass vs captured FAIL)"
else
  _fail "could not materialize $FIXTURE"
fi

RECORD="$WS/.kontourai/telemetry/stop-gate-summary.jsonl"

run_hook() {
  # Runs the hook against $WS with the fixture's env; prints the hook's exit code.
  local out="$1" err="$2"
  local mode backstop actor
  mode="$(jq -r '.FLOW_AGENTS_GOAL_FIT_MODE // "block"' "$WS/fixture-env.json")"
  backstop="$(jq -r '.FLOW_AGENTS_GOAL_FIT_BACKSTOP // "skip"' "$WS/fixture-env.json")"
  actor="$(jq -r '.FLOW_AGENTS_ACTOR // "conformance"' "$WS/fixture-env.json")"
  FLOW_AGENTS_GOAL_FIT_MODE="$mode" FLOW_AGENTS_GOAL_FIT_BACKSTOP="$backstop" \
    FLOW_AGENTS_ACTOR="$actor" FLOW_AGENTS_GOAL_FIT_MAX_BLOCKS=100000 \
    node "$HOOK" >"$out" 2>"$err" <<JSON
{"hook_event_name":"Stop","cwd":"$WS"}
JSON
  echo $?
}

# ── AC: contradiction increments claims_contradicted through the dedup path ──────────────
code="$(run_hook "$TMPDIR_EVAL/run1.out" "$TMPDIR_EVAL/run1.err")"
if [[ "$code" -eq 2 ]]; then
  _pass "hook blocks the fixture's caught false-completion (exit 2, unchanged gate behavior)"
else
  _fail "expected exit 2 from the contradiction fixture, got $code — stderr: $(cat "$TMPDIR_EVAL/run1.err")"
fi

if grep -qF "capture log CONTRADICTS claimed pass" "$TMPDIR_EVAL/run1.err" \
  && grep -qF "namespace-agnostic caught false-completion" "$TMPDIR_EVAL/run1.err"; then
  _pass "BOTH contradiction sources fired for the same command (captureCrossReference + capturedFailReconciliation)"
else
  _fail "expected both contradiction sources in stderr — the dedup assertion below would be vacuous: $(cat "$TMPDIR_EVAL/run1.err")"
fi

if [[ -f "$RECORD" ]]; then
  _pass "summary record emitted at Stop to .kontourai/telemetry/stop-gate-summary.jsonl"
else
  _fail "no summary record was emitted"
fi

if [[ -f "$RECORD" ]] && tail -1 "$RECORD" | jq -e '
  .schema == "flow-agents.stop-gate-summary" and
  .session == "false-pass" and
  .blocking == true and
  .claims_contradicted == 1
' >/dev/null 2>&1; then
  _pass "claims_contradicted == 1: two firing sources merged to ONE contradiction (dedup by command)"
else
  _fail "record does not show the deduplicated contradiction count: $(tail -1 "$RECORD" 2>/dev/null)"
fi

if tail -1 "$RECORD" 2>/dev/null | jq -e '
  .claims_total == 1 and .claims_checked == 1 and (.claims_total | type) == "number" and (.claims_checked | type) == "number"
' >/dev/null 2>&1; then
  _pass "claims_total and claims_checked are both present (slice(0,8) cap stays disclosed)"
else
  _fail "claims_total/claims_checked missing or wrong: $(tail -1 "$RECORD" 2>/dev/null)"
fi

if tail -1 "$RECORD" 2>/dev/null | jq -e '.chain == "legacy"' >/dev/null 2>&1; then
  _pass "chain carries the verifier's real enum: chainless fixture log reads 'legacy', not 'ok'"
else
  _fail "chain did not report 'legacy' for a chainless log: $(tail -1 "$RECORD" 2>/dev/null)"
fi

if tail -1 "$RECORD" 2>/dev/null | jq -e '
  .commands_captured == 1 and .claims_confirmed_from_capture == 0 and .backstop_reruns == 0
' >/dev/null 2>&1; then
  _pass "commands_captured/confirmed/backstop counts match the fixture (1 distinct command, nothing confirmed, backstop skipped)"
else
  _fail "unexpected counts: $(tail -1 "$RECORD" 2>/dev/null)"
fi

# ── AC: commands_captured counts DISTINCT NORMALIZED COMMANDS, not raw log lines ─────────
printf '%s\n' '{"command":"npm test","observedResult":"fail","exitCode":1,"capturedAt":"2026-06-23T00:01:00Z","source":"postToolUse-capture"}' \
  >> "$WS/.kontourai/flow-agents/false-pass/command-log.jsonl"
code="$(run_hook "$TMPDIR_EVAL/run2.out" "$TMPDIR_EVAL/run2.err")"
if tail -1 "$RECORD" 2>/dev/null | jq -e '.commands_captured == 1 and .claims_contradicted == 1' >/dev/null 2>&1; then
  _pass "a second raw log line for the same command does not inflate commands_captured (latest-wins map)"
else
  _fail "commands_captured is counting raw log entries, not distinct commands: $(tail -1 "$RECORD" 2>/dev/null)"
fi

if [[ "$(wc -l < "$RECORD" | tr -d ' ')" == "2" ]]; then
  _pass "one JSON line appended per Stop evaluation (latest row is the current reading)"
else
  _fail "expected 2 record lines after 2 evaluations, got $(wc -l < "$RECORD")"
fi

# ── AC: genuine re-run-to-pass clears the contradiction (latest-wins) ────────────────────
printf '%s\n' '{"command":"npm test","observedResult":"pass","exitCode":0,"capturedAt":"2026-06-23T00:02:00Z","source":"postToolUse-capture"}' \
  >> "$WS/.kontourai/flow-agents/false-pass/command-log.jsonl"
code="$(run_hook "$TMPDIR_EVAL/run3.out" "$TMPDIR_EVAL/run3.err")"
if tail -1 "$RECORD" 2>/dev/null | jq -e '.claims_contradicted == 0 and .commands_captured == 1' >/dev/null 2>&1; then
  _pass "re-run-to-pass clears claims_contradicted (only a real re-run can — a new claim cannot)"
else
  _fail "contradiction did not clear after a genuine passing re-run: $(tail -1 "$RECORD" 2>/dev/null)"
fi

# ── AC: schema validation (sibling of economics-record.schema.json) ──────────────────────
SCHEMA_CHECK="$(cd "$ROOT" && node -e '
const Ajv = require("ajv/dist/2020").default;
const fs = require("fs");
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(JSON.parse(fs.readFileSync(process.argv[1], "utf8")));
const lines = fs.readFileSync(process.argv[2], "utf8").trim().split("\n").map((l) => JSON.parse(l));
const allOk = lines.every((rec) => validate(rec));
const zeroRow = { ...lines[0] };
delete zeroRow.claims_total;
const missingFieldOk = validate(zeroRow);
const badChain = { ...lines[0], chain: "verified" };
const badChainOk = validate(badChain);
console.log(JSON.stringify({ allOk, missingFieldOk, badChainOk, count: lines.length }));
' "$SCHEMA" "$RECORD" 2>&1)"
if echo "$SCHEMA_CHECK" | grep -q '"allOk":true'; then
  _pass "every emitted record validates against stop-gate-summary.schema.json"
else
  _fail "emitted records did not validate: $SCHEMA_CHECK"
fi
if echo "$SCHEMA_CHECK" | grep -q '"missingFieldOk":false' && echo "$SCHEMA_CHECK" | grep -q '"badChainOk":false'; then
  _pass "schema has teeth: dropping claims_total fails; an out-of-enum chain value fails"
else
  _fail "schema accepted a doctored record: $SCHEMA_CHECK"
fi

# ── AC: absent hooks/session ⇒ absent record (never a fabricated zero row) ───────────────
NOSESS="$TMPDIR_EVAL/no-session"
mkdir -p "$NOSESS"
printf '# Test Repo\n' > "$NOSESS/AGENTS.md"
git -C "$NOSESS" init -q
FLOW_AGENTS_GOAL_FIT_MODE=block FLOW_AGENTS_ACTOR=conformance FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip \
  node "$HOOK" >/dev/null 2>&1 <<JSON
{"hook_event_name":"Stop","cwd":"$NOSESS"}
JSON
if [[ ! -e "$NOSESS/.kontourai/telemetry/stop-gate-summary.jsonl" ]]; then
  _pass "no scoped session ⇒ no record file (no fabricated zero row)"
else
  _fail "a record was fabricated for a session-less stop: $(cat "$NOSESS/.kontourai/telemetry/stop-gate-summary.jsonl")"
fi

# ── Mirror: both hook copies stay byte-identical (eval-enforced repo trap) ───────────────
if cmp -s "$ROOT/scripts/hooks/stop-goal-fit.js" "$ROOT/context/scripts/hooks/stop-goal-fit.js"; then
  _pass "scripts/ and context/ Stop hook copies are byte-identical"
else
  _fail "scripts/hooks/stop-goal-fit.js and context/scripts/hooks/stop-goal-fit.js diverged"
fi

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "Stop-gate summary record integration passed."
  exit 0
fi
echo "Stop-gate summary record integration failed: $errors issue(s)."
exit 1
