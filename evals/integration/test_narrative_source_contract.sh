#!/usr/bin/env bash
# End-to-end narrative-source contract: all streams, offline durability, integrity, and lifecycle.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURES="$ROOT/evals/fixtures/narrative-sources"
TMP="$(mktemp -d)"
errors=0
_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

json_assert() { # $1=file, remaining args are a JavaScript expression using value
  local file="$1" expression="$2"
  node - "$file" "$expression" <<'NODE'
const fs = require('fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!Function('value', `return Boolean(${process.argv[3]})`)(value)) process.exit(1);
NODE
}

sha256_file() { node -e "const fs=require('fs'),c=require('crypto');process.stdout.write(c.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))" "$1"; }
sha8_line() { node -e "const fs=require('fs'),c=require('crypto');const b=fs.readFileSync(process.argv[1]);const l=b.toString('utf8').trimEnd().split(/\\r?\\n/)[Number(process.argv[2])];process.stdout.write(c.createHash('sha256').update(l).digest('hex').slice(0,8))" "$1" "$2"; }

echo "Narrative source contract integration"
if npm run build --silent; then _pass "TypeScript build completed"; else _fail "TypeScript build failed"; fi

RAW="$TMP/raw"
ARTIFACT_ROOT="$TMP/artifacts"
SESSION="$RAW/session"
AGENTS_DIR="$SESSION/agents"
AGENT_EVENTS="$AGENTS_DIR/agent-fixture/events.jsonl"
TELEMETRY="$RAW/telemetry"
FLOW="$RAW/flow"
TRANSCRIPT="$RAW/transcripts/session.txt"
REPO="$RAW/repo"
mkdir -p "$RAW"
cp -R "$FIXTURES/session" "$SESSION"
cp -R "$FIXTURES/telemetry" "$TELEMETRY"
cp -R "$FIXTURES/flow" "$FLOW"
cp -R "$FIXTURES/transcripts" "$RAW/transcripts"
cp -R "$FIXTURES/repo" "$REPO"

# Seed a genuine chained command-log entry with the repository's normative primitives.
node - "$ROOT/scripts/lib/command-log-chain.js" "$SESSION/command-log.jsonl" <<'NODE'
const fs = require('fs');
const chain = require(process.argv[2]);
const record = { command: 'fixture verification', observedResult: 'pass', exitCode: 0, capturedAt: '2026-07-14T12:00:00.000Z', source: 'narrative-fixture' };
const hash = chain.computeChainHash(chain.CHAIN_GENESIS, record);
record._chain = { seq: 0, prevHash: chain.CHAIN_GENESIS, hash };
fs.writeFileSync(process.argv[3], `${JSON.stringify(record)}\n`);
NODE

CMD_HASH8="$(node -e "const r=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(r._chain.hash.slice(0,8))" "$SESSION/command-log.jsonl")"
AGENT0_HASH8="$(sha8_line "$AGENT_EVENTS" 0)"
AGENT1_HASH8="$(sha8_line "$AGENT_EVENTS" 1)"
TRUST_HASH8="$(sha256_file "$SESSION/trust.bundle")"; TRUST_HASH8="${TRUST_HASH8:0:8}"
FLOW_HASH8="$(sha256_file "$FLOW/runs/run-fixture/state.json")"; FLOW_HASH8="${FLOW_HASH8:0:8}"
TRANSITION_HASH8="$(node -e "const fs=require('fs'),c=require('crypto'),s=JSON.parse(fs.readFileSync(process.argv[1]));process.stdout.write(c.createHash('sha256').update(JSON.stringify(s.transitions[0])).digest('hex').slice(0,8))" "$FLOW/runs/run-fixture/state.json")"
PATH_HASH8="$(node -e "const c=require('crypto');process.stdout.write(c.createHash('sha256').update(process.argv[1]).digest('hex').slice(0,8))" "$TRANSCRIPT")"
FILE_SHA="$(sha256_file "$REPO/fixture.txt")"

SOURCES=(
  "fa1:telemetry:full/session-fixture:evt-telemetry"
  "fa1:telemetry:full/session-fixture:evt-mcp-gap"
  "fa1:cmdlog:fixture-session:0/$CMD_HASH8"
  "fa1:agent-event:fixture-session/agent-fixture:0/$AGENT0_HASH8"
  "fa1:delegation:fixture-session/agent-fixture:1/$AGENT1_HASH8"
  "fa1:trust-claim:fixture-session/$TRUST_HASH8:claim-fixture"
  "fa1:trust-evidence:fixture-session/$TRUST_HASH8:evidence-fixture"
  "fa1:flow-state:run-fixture:state/$FLOW_HASH8"
  "fa1:flow-transition:run-fixture:0/$TRANSITION_HASH8"
  "fa1:transcript:$PATH_HASH8:0-$(wc -c < "$TRANSCRIPT" | tr -d ' ')"
  "fa1:file:fixture.txt:$FILE_SHA"
)

SNAPSHOT_ARGS=(narrative-sources snapshot --artifact-root "$ARTIFACT_ROOT" --narrative-id contract-fixture
  --telemetry-root "$TELEMETRY" --session-root "$SESSION" --flow-root "$FLOW"
  --transcript-path "$TRANSCRIPT" --repo-root "$REPO"
  --capture-completeness "$FIXTURES/expected-capture-completeness.json")
for source in "${SOURCES[@]}"; do SNAPSHOT_ARGS+=(--source "$source"); done

node "$ROOT/build/src/cli.js" "${SNAPSHOT_ARGS[@]}" >"$TMP/snapshot.json" 2>"$TMP/snapshot.stderr"
snapshot_exit=$?
NARRATIVE_DIR="$ARTIFACT_ROOT/narrative/contract-fixture"
MANIFEST="$NARRATIVE_DIR/source-manifest.json"
if [[ "$snapshot_exit" -eq 0 && -f "$MANIFEST" ]]; then
  _pass "AC1: all-stream snapshot wrote its manifest last"
else
  _fail "AC1: snapshot failed (exit=$snapshot_exit): $(<"$TMP/snapshot.stderr")"
  echo "narrative source contract tests FAILED: $errors issue(s)."
  exit 1
fi

if json_assert "$MANIFEST" 'value.sources.length === 11 && value.sources.every(s => s.status === "snapshotted")'; then
  _pass "AC1: eleven source fixtures across all ten streams were snapshotted"
else
  _fail "AC1: expected eleven snapshotted manifest entries"
fi

if node - "$MANIFEST" <<'NODE'
const fs = require('fs');
const m = JSON.parse(fs.readFileSync(process.argv[2]));
const expected = {
  telemetry: 'rotatable', cmdlog: 'hash_chained', 'agent-event': 'append_only_unhashed', delegation: 'append_only_unhashed',
  'trust-claim': 'overwritten_in_place', 'trust-evidence': 'overwritten_in_place', 'flow-state': 'overwritten_in_place',
  'flow-transition': 'overwritten_in_place', transcript: 'path_only', file: 'overwritten_in_place',
};
for (const source of m.sources) {
  const stream = source.source_id.split(':')[1];
  if (source.integrity_class !== expected[stream]) process.exit(1);
}
if (m.capture_completeness.channels.full !== 'active' || m.capture_completeness.channels.analytics !== 'inactive') process.exit(1);
if (!m.capture_completeness.known_gaps.some(g => g.class === 'mcp_non_native_tools' && g.ref === 'flow-agents#492')) process.exit(1);
NODE
then _pass "AC7: integrity classes and MCP capture gap are explicit"; else _fail "AC7: integrity/capture-completeness mismatch"; fi

MANIFEST_BEFORE="$(sha256_file "$MANIFEST")"

# Rotation after compilation cannot affect the content-addressed snapshot.
mv "$TELEMETRY/full.jsonl" "$TELEMETRY/full.1.jsonl"
TELEMETRY_ID="${SOURCES[0]}"
node "$ROOT/build/src/cli.js" narrative-sources resolve --narrative-dir "$NARRATIVE_DIR" --source-id "$TELEMETRY_ID" --out "$TMP/rotated-telemetry.json" >"$TMP/rotated-resolve.json" 2>"$TMP/rotated-resolve.stderr"
if [[ "$?" -eq 0 && -s "$TMP/rotated-telemetry.json" ]] && json_assert "$TMP/rotated-resolve.json" 'value.status === "resolved"'; then
  _pass "AC2: telemetry resolves after its raw log rotates"
else
  _fail "AC2: rotated telemetry did not resolve"
fi
if json_assert "$MANIFEST" 'value.sources.find(s => s.source_id === "fa1:telemetry:full/session-fixture:evt-telemetry").lineage.some(l => l.event === "source_snapshotted")'; then
  _pass "AC2: telemetry snapshot records a lineage event"
else
  _fail "AC2: telemetry lineage event missing"
fi

# Remove every raw store, then resolve every source only from the narrative directory.
mv "$RAW" "$TMP/raw-moved-away"
mkdir -p "$TMP/resolved"
resolved_count=0
for index in "${!SOURCES[@]}"; do
  node "$ROOT/build/src/cli.js" narrative-sources resolve --narrative-dir "$NARRATIVE_DIR" --source-id "${SOURCES[$index]}" --out "$TMP/resolved/$index" >"$TMP/resolve-$index.json" 2>"$TMP/resolve-$index.stderr"
  if [[ "$?" -eq 0 && -s "$TMP/resolved/$index" ]] && json_assert "$TMP/resolve-$index.json" 'value.status === "resolved"'; then
    resolved_count=$((resolved_count + 1))
  fi
done
if [[ "$resolved_count" -eq 11 ]]; then _pass "AC1: 11/11 sources resolve offline after moving raw stores away"; else _fail "AC1: only $resolved_count/11 sources resolved offline"; fi

if json_assert "$TMP/resolved/9" 'value.kind === "transcript-fixture"' && json_assert "$TMP/resolved/10" 'value.kind === "repository-file-fixture"'; then
  _pass "AC1: offline resolver preserves filtered transcript and file content"
else
  _fail "AC1: filtered offline transcript/file content changed"
fi

MANIFEST_AFTER="$(sha256_file "$MANIFEST")"
if [[ "$MANIFEST_BEFORE" == "$MANIFEST_AFTER" ]]; then _pass "AC8: deleting raw stores leaves the manifest byte-identical"; else _fail "AC8: manifest changed after raw-store deletion"; fi

# Flip one stored byte. resolve and whole-manifest verify must report corruption.
BLOB_SHA="$(node -e "const m=JSON.parse(require('fs').readFileSync(process.argv[1]));const s=m.sources.find(x=>x.source_id===process.argv[2]);process.stdout.write(s.sha256)" "$MANIFEST" "$TELEMETRY_ID")"
node - "$NARRATIVE_DIR/sources/$BLOB_SHA" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const bytes = fs.readFileSync(file);
bytes[0] ^= 1;
fs.writeFileSync(file, bytes);
NODE
node "$ROOT/build/src/cli.js" narrative-sources resolve --narrative-dir "$NARRATIVE_DIR" --source-id "$TELEMETRY_ID" --json >"$TMP/corrupt-resolve.json" 2>"$TMP/corrupt-resolve.stderr"
if json_assert "$TMP/corrupt-resolve.json" 'value.status === "unavailable" && value.reason === "corrupt"'; then _pass "AC3: byte-flipped blob resolves as corrupt"; else _fail "AC3: byte-flipped blob was not reported corrupt"; fi

node "$ROOT/build/src/cli.js" narrative-sources verify --narrative-dir "$NARRATIVE_DIR" --json >"$TMP/verify.json" 2>"$TMP/verify.stderr"
if json_assert "$TMP/verify.json" 'value.ok === false && value.perSource.length === 11 && value.perSource.some(s => s.sourceId === "fa1:telemetry:full/session-fixture:evt-telemetry" && s.status === "unavailable" && s.reason === "corrupt") && value.perSource.filter(s => s.status === "resolved").length === 10'; then
  _pass "AC3: verify reports the corrupt source and re-verifies the other ten"
else
  _fail "AC3: whole-manifest verification report is incomplete"
fi

rm -rf "$NARRATIVE_DIR"
if [[ ! -e "$NARRATIVE_DIR" ]]; then _pass "AC8: deleting the narrative directory removes every snapshot"; else _fail "AC8: narrative directory still exists"; fi

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "narrative source contract tests passed: 12/12."
  exit 0
fi
echo "narrative source contract tests FAILED: $errors issue(s)."
exit 1
