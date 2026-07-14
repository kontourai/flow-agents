#!/usr/bin/env bash
# Frozen narrative sources project into a complete, deterministic runtime account.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURES="$ROOT/evals/fixtures/narrative-sources"
TMP="$(mktemp -d)"
errors=0
_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }
trap 'rm -rf "$TMP"' EXIT

json_assert() {
  local file="$1" expression="$2"
  node - "$file" "$expression" <<'NODE'
const fs = require('fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!Function('value', `return Boolean(${process.argv[3]})`)(value)) process.exit(1);
NODE
}
sha256_file() { node -e "const fs=require('fs'),c=require('crypto');process.stdout.write(c.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))" "$1"; }
sha8_line() { node -e "const fs=require('fs'),c=require('crypto');const l=fs.readFileSync(process.argv[1],'utf8').trimEnd().split(/\\r?\\n/)[Number(process.argv[2])];process.stdout.write(c.createHash('sha256').update(l).digest('hex').slice(0,8))" "$1" "$2"; }
telemetry_pin() {
  node -e "const fs=require('fs'),c=require('crypto');const line=fs.readFileSync(process.argv[1],'utf8').split('\\n').find(l=>l.trim()&&JSON.parse(l).event_id===process.argv[2]);process.stdout.write(c.createHash('sha256').update(Buffer.from(line)).digest('hex').slice(0,8))" "$1" "$2"
}

echo "Narrative runtime projection integration"
if npm run build --silent; then _pass "TypeScript build completed"; else _fail "TypeScript build failed"; fi

RAW="$TMP/raw"
ARTIFACT_ROOT="$TMP/artifacts"
SESSION="$RAW/fixture-session"
AGENTS_DIR="$SESSION/agents"
NESTED_EVENTS="$AGENTS_DIR/nested-worker/events.jsonl"
TELEMETRY="$RAW/telemetry"
FLOW="$RAW/flow"
REPO="$RAW/repo"
mkdir -p "$RAW"
cp -R "$FIXTURES/session" "$SESSION"
cp -R "$FIXTURES/telemetry" "$TELEMETRY"
cp -R "$FIXTURES/flow" "$FLOW"
cp -R "$FIXTURES/repo" "$REPO"

# Two genuine chained observations preserve a fail -> re-run sequence.
node - "$ROOT/scripts/lib/command-log-chain.js" "$SESSION/command-log.jsonl" <<'NODE'
const fs = require('fs');
const chain = require(process.argv[2]);
const records = [
  { command: 'npm test', result: 'fail', exitCode: 1, capturedAt: '2026-07-14T13:00:04.000Z', source: 'narrative-runtime-fixture' },
  { command: 'npm test', result: 'pass', exitCode: 0, capturedAt: '2026-07-14T13:00:05.000Z', source: 'narrative-runtime-fixture' },
];
let previous = chain.CHAIN_GENESIS;
for (let index = 0; index < records.length; index += 1) {
  const record = records[index];
  const hash = chain.computeChainHash(previous, record);
  record._chain = { seq: index, prevHash: previous, hash };
  previous = hash;
}
fs.writeFileSync(process.argv[3], records.map((record) => JSON.stringify(record)).join('\n') + '\n');
NODE

CMD0_HASH8="$(node -e "const r=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8').split('\\n')[0]);process.stdout.write(r._chain.hash.slice(0,8))" "$SESSION/command-log.jsonl")"
CMD1_HASH8="$(node -e "const r=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8').split('\\n')[1]);process.stdout.write(r._chain.hash.slice(0,8))" "$SESSION/command-log.jsonl")"
DELEGATION_HASH8="$(sha8_line "$NESTED_EVENTS" 0)"
FLOW_HASH8="$(sha256_file "$FLOW/runs/run-runtime/state.json")"; FLOW_HASH8="${FLOW_HASH8:0:8}"
FILE_SHA="$(sha256_file "$REPO/created.txt")"
MISSING_SHA="$(printf 'missing fixture' | node -e "const c=require('crypto');let d='';process.stdin.on('data',x=>d+=x).on('end',()=>process.stdout.write(c.createHash('sha256').update(d).digest('hex')))")"

TURN_PIN="$(telemetry_pin "$TELEMETRY/runtime.jsonl" runtime-turn-explicit)"
TIMEOUT_PIN="$(telemetry_pin "$TELEMETRY/runtime.jsonl" runtime-tool-timeout)"
DERIVED_PIN="$(telemetry_pin "$TELEMETRY/runtime.jsonl" runtime-turn-derived)"
END_PIN="$(telemetry_pin "$TELEMETRY/runtime.jsonl" runtime-session-end)"
MCP_PIN="$(telemetry_pin "$TELEMETRY/full.jsonl" evt-mcp-gap)"

SOURCES=(
  "fa1:telemetry:runtime/runtime-session:runtime-turn-explicit/$TURN_PIN"
  "fa1:telemetry:runtime/runtime-session:runtime-tool-timeout/$TIMEOUT_PIN"
  "fa1:flow-state:run-runtime:state/$FLOW_HASH8"
  "fa1:delegation:fixture-session/nested-worker:0/$DELEGATION_HASH8"
  "fa1:telemetry:runtime/runtime-session:runtime-turn-derived/$DERIVED_PIN"
  "fa1:telemetry:runtime/runtime-session:runtime-session-end/$END_PIN"
  "fa1:cmdlog:fixture-session:0/$CMD0_HASH8"
  "fa1:cmdlog:fixture-session:1/$CMD1_HASH8"
  "fa1:file:created.txt:$FILE_SHA"
  "fa1:file:missing.txt:$MISSING_SHA"
  "fa1:telemetry:full/session-fixture:evt-mcp-gap/$MCP_PIN"
)

ARGS=(narrative-sources snapshot --artifact-root "$ARTIFACT_ROOT" --narrative-id runtime-fixture
  --telemetry-root "$TELEMETRY" --session-root "$SESSION" --flow-root "$FLOW" --repo-root "$REPO"
  --capture-completeness "$FIXTURES/expected-capture-completeness.json")
for source in "${SOURCES[@]}"; do ARGS+=(--source "$source"); done

if node "$ROOT/build/src/cli.js" "${ARGS[@]}" >"$TMP/snapshot.json" 2>"$TMP/snapshot.err"; then
  _pass "snapshot captured the projection fixture"
else
  _fail "snapshot failed: $(<"$TMP/snapshot.err")"
fi

NARRATIVE_DIR="$ARTIFACT_ROOT/narrative/runtime-fixture"
PROJECTED_AT="2026-07-14T14:00:00.000Z"
node "$ROOT/build/src/cli.js" narrative-sources project --narrative-dir "$NARRATIVE_DIR" --out "$TMP/one.json" --projected-at "$PROJECTED_AT" 2>"$TMP/project-one.err"
first_status=$?
node "$ROOT/build/src/cli.js" narrative-sources project --narrative-dir "$NARRATIVE_DIR" --out "$TMP/two.json" --projected-at "$PROJECTED_AT" 2>"$TMP/project-two.err"
second_status=$?
if [[ "$first_status" -eq 0 && "$second_status" -eq 0 ]]; then _pass "project verb wrote two schema-valid projections"; else _fail "project failed: $(<"$TMP/project-one.err") $(<"$TMP/project-two.err")"; fi

if cmp -s "$TMP/one.json" "$TMP/two.json"; then _pass "AC5: caller-pinned double projection is byte-identical"; else _fail "AC5: double projection differs"; fi
if json_assert "$TMP/one.json" 'value.schema_version === "grounded-runtime-projection/v1" && value.turns.some(t => t.turnId === "turn-explicit") && value.turns.some(t => !("turnId" in t))'; then
  _pass "AC1: projection accounts for turn-id and spine-less runtime turns"
else
  _fail "AC1: turn shapes are incomplete"
fi
if json_assert "$TMP/one.json" 'value.turns.some(t => t.purpose && t.purpose.step === "execute" && t.purpose.gate === "tests-evidence")'; then
  _pass "AC1: workflow-derived purpose is projected verbatim on the adjacent turn"
else
  _fail "AC1: purpose projection is missing"
fi
if json_assert "$TMP/one.json" 'JSON.stringify(value).includes("was observed to fail") && JSON.stringify(value).includes("was retried across 2 attempts") && JSON.stringify(value).includes("30000 ms timeout") && JSON.stringify(value).includes("classified as a no-op") && JSON.stringify(value).includes("created.txt")'; then
  _pass "AC2: failure, retry, timeout, no-op, and created-file facts survive projection"
else
  _fail "AC2: a material runtime fact was dropped"
fi
if json_assert "$TMP/one.json" '[...value.turns.flatMap(t => t.statements), ...value.document_statements].some(s => s.actor === "unattributed" && s.proposition.includes("delegated"))'; then
  _pass "AC4: nested delegation without lineage is explicitly unattributed"
else
  _fail "AC4: missing unattributed delegation"
fi
if json_assert "$TMP/one.json" 'value.capture_completeness.known_gaps.some(g => g.class === "mcp_non_native_tools" && g.ref === "flow-agents#492") && value.turns.every(t => Array.isArray(t.known_gap_refs) && t.known_gap_refs.includes("flow-agents#492"))'; then
  _pass "AC6: MCP completeness gap is in the header and adjacent to every turn"
else
  _fail "AC6: completeness disclosure is not turn-adjacent"
fi
if json_assert "$TMP/one.json" 'value.coverage.sources === 11 && value.coverage.cited === 11 && value.coverage.unavailable === 1 && JSON.stringify(value.document_statements).includes("unavailable because not_captured")'; then
  _pass "coverage accounts for every source including unavailable disclosure"
else
  _fail "coverage block or unavailable disclosure is incomplete"
fi

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "narrative runtime projection tests passed: 10/10."
  exit 0
fi
echo "narrative runtime projection tests FAILED: $errors issue(s)."
exit 1
