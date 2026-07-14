#!/usr/bin/env bash
# Frozen authorities compose into a deterministic, grounded execution narrative.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURES="$ROOT/evals/fixtures/narrative-sources"
TMP="$(mktemp -d)"
errors=0
_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }
trap 'rm -rf "$TMP"' EXIT

sha256_file() { node -e "const fs=require('fs'),c=require('crypto');process.stdout.write(c.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))" "$1"; }
sha8_line() { node -e "const fs=require('fs'),c=require('crypto');const l=fs.readFileSync(process.argv[1],'utf8').trimEnd().split(/\\r?\\n/)[Number(process.argv[2])];process.stdout.write(c.createHash('sha256').update(l).digest('hex').slice(0,8))" "$1" "$2"; }
telemetry_pin() { node -e "const fs=require('fs'),c=require('crypto');const l=fs.readFileSync(process.argv[1],'utf8').split('\\n').find(x=>x.trim()&&JSON.parse(x).event_id===process.argv[2]);process.stdout.write(c.createHash('sha256').update(l).digest('hex').slice(0,8))" "$1" "$2"; }
json_assert() {
  node - "$1" "$2" <<'NODE'
const fs = require('fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!Function('value', `return Boolean(${process.argv[3]})`)(value)) process.exit(1);
NODE
}

echo "Narrative grounded envelope integration"
if npm run build --silent; then _pass "TypeScript build completed"; else _fail "TypeScript build failed"; fi

RAW="$TMP/raw"
ARTIFACT_ROOT="$TMP/artifacts"
SESSION="$RAW/fixture-session"
AGENTS_DIR="$SESSION/agents"
NESTED_EVENTS="$AGENTS_DIR/nested-worker/events.jsonl"
TELEMETRY="$RAW/telemetry"
FLOW="$RAW/flow"
REPO="$RAW/repo"
TRANSCRIPT="$RAW/canary.txt"
mkdir -p "$RAW"
cp -R "$FIXTURES/session" "$SESSION"
cp -R "$FIXTURES/telemetry" "$TELEMETRY"
cp -R "$FIXTURES/flow" "$FLOW"
cp -R "$FIXTURES/repo" "$REPO"
printf '%s\n' 'AC6_CANARY' >"$TRANSCRIPT"

# Add one attributed nested-worker event beside the fixture's lineage-less event.
printf '%s\n' '{"kind":"delegation","at":"2026-07-14T13:00:03.000Z","target":"attributed-leaf","task":"attributed fixture","lineage":{"actor":"nested-worker"}}' >>"$NESTED_EVENTS"

# Genuine chained observations preserve fail -> retry.
node - "$ROOT/scripts/lib/command-log-chain.js" "$SESSION/command-log.jsonl" <<'NODE'
const fs = require('fs');
const chain = require(process.argv[2]);
const records = [
  { command: 'npm test', result: 'fail', exitCode: 1, capturedAt: '2026-07-14T13:00:04.000Z', source: 'narrative-envelope-fixture' },
  { command: 'npm test', result: 'pass', exitCode: 0, capturedAt: '2026-07-14T13:00:05.000Z', source: 'narrative-envelope-fixture' },
];
let previous = chain.CHAIN_GENESIS;
for (let index = 0; index < records.length; index += 1) {
  const record = records[index];
  const hash = chain.computeChainHash(previous, record);
  record._chain = { seq: index, prevHash: previous, hash };
  previous = hash;
}
fs.writeFileSync(process.argv[3], records.map(JSON.stringify).join('\n') + '\n');
NODE

CMD0="$(node -e "const r=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8').split('\\n')[0]);process.stdout.write(r._chain.hash.slice(0,8))" "$SESSION/command-log.jsonl")"
CMD1="$(node -e "const r=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8').split('\\n')[1]);process.stdout.write(r._chain.hash.slice(0,8))" "$SESSION/command-log.jsonl")"
NESTED0="$(sha8_line "$NESTED_EVENTS" 0)"
NESTED1="$(sha8_line "$NESTED_EVENTS" 1)"
FLOW_STATE="$(sha256_file "$FLOW/runs/run-runtime/state.json")"; FLOW_STATE="${FLOW_STATE:0:8}"
FLOW_REPORT="$(sha256_file "$FLOW/runs/run-fixture/report.json")"; FLOW_REPORT="${FLOW_REPORT:0:8}"
BUNDLE="$(sha256_file "$SESSION/trust.bundle")"; BUNDLE="${BUNDLE:0:8}"
FILE_SHA="$(sha256_file "$REPO/created.txt")"
MISSING_SHA="$(printf 'missing fixture' | node -e "const c=require('crypto');let d='';process.stdin.on('data',x=>d+=x).on('end',()=>process.stdout.write(c.createHash('sha256').update(d).digest('hex')))")"
PATH_HASH="$(node -e "const c=require('crypto'),p=require('path');process.stdout.write(c.createHash('sha256').update(p.resolve(process.argv[1])).digest('hex').slice(0,8))" "$TRANSCRIPT")"
TURN="$(telemetry_pin "$TELEMETRY/runtime.jsonl" runtime-turn-explicit)"
TIMEOUT="$(telemetry_pin "$TELEMETRY/runtime.jsonl" runtime-tool-timeout)"
DERIVED="$(telemetry_pin "$TELEMETRY/runtime.jsonl" runtime-turn-derived)"
END="$(telemetry_pin "$TELEMETRY/runtime.jsonl" runtime-session-end)"
MCP="$(telemetry_pin "$TELEMETRY/full.jsonl" evt-mcp-gap)"

SOURCES=(
  "fa1:telemetry:runtime/runtime-session:runtime-turn-explicit/$TURN"
  "fa1:telemetry:runtime/runtime-session:runtime-tool-timeout/$TIMEOUT"
  "fa1:flow-state:run-runtime:state/$FLOW_STATE"
  "fa1:flow-report:run-fixture:report/$FLOW_REPORT"
  "fa1:surface-explanation:fixture-session/$BUNDLE:claim-fixture"
  "fa1:delegation:fixture-session/nested-worker:0/$NESTED0"
  "fa1:delegation:fixture-session/nested-worker:1/$NESTED1"
  "fa1:telemetry:runtime/runtime-session:runtime-turn-derived/$DERIVED"
  "fa1:telemetry:runtime/runtime-session:runtime-session-end/$END"
  "fa1:cmdlog:fixture-session:0/$CMD0"
  "fa1:cmdlog:fixture-session:1/$CMD1"
  "fa1:file:created.txt:$FILE_SHA"
  "fa1:file:missing.txt:$MISSING_SHA"
  "fa1:telemetry:full/session-fixture:evt-mcp-gap/$MCP"
  "fa1:transcript:$PATH_HASH:0-$(wc -c <"$TRANSCRIPT" | tr -d ' ')"
)
ARGS=(narrative-sources snapshot --artifact-root "$ARTIFACT_ROOT" --narrative-id grounded-fixture
  --telemetry-root "$TELEMETRY" --session-root "$SESSION" --flow-root "$FLOW" --repo-root "$REPO"
  --transcript-path "$TRANSCRIPT" --capture-completeness "$FIXTURES/expected-capture-completeness.json")
for source in "${SOURCES[@]}"; do ARGS+=(--source "$source"); done

export https_proxy=http://127.0.0.1:9 http_proxy=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 NO_PROXY='*'
if node "$ROOT/build/src/cli.js" "${ARGS[@]}" >"$TMP/snapshot.json" 2>"$TMP/snapshot.err"; then _pass "AC9: snapshot succeeds with network disabled"; else _fail "snapshot failed: $(<"$TMP/snapshot.err")"; fi

NARRATIVE_DIR="$ARTIFACT_ROOT/narrative/grounded-fixture"
OUT1="$TMP/out-one"; OUT2="$TMP/out-two"
COMPILED_AT="2026-07-14T16:00:00.000Z"
if node "$ROOT/build/src/cli.js" narrative-sources compose --narrative-dir "$NARRATIVE_DIR" --compiled-at "$COMPILED_AT" --out-dir "$OUT1" --render >"$TMP/compose-one.json" 2>"$TMP/compose-one.err"; then _pass "AC1/AC9: compose validates and renders offline"; else _fail "compose failed: $(<"$TMP/compose-one.err")"; fi
if node "$ROOT/build/src/cli.js" narrative-sources compose --narrative-dir "$NARRATIVE_DIR" --compiled-at "$COMPILED_AT" --out-dir "$OUT2" --render >"$TMP/compose-two.json" 2>"$TMP/compose-two.err"; then _pass "AC7: second pinned compile succeeds"; else _fail "second compose failed: $(<"$TMP/compose-two.err")"; fi
ENVELOPE1="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1])).envelopePath)" "$TMP/compose-one.json")"
RENDER1="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1])).renderPath)" "$TMP/compose-one.json")"
ENVELOPE2="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1])).envelopePath)" "$TMP/compose-two.json")"

if cmp -s "$ENVELOPE1" "$ENVELOPE2"; then _pass "AC7: identical compiled-at produces byte-identical envelopes"; else _fail "AC7: deterministic envelopes differ"; fi
if json_assert "$ENVELOPE1" 'value.schema_version === "grounded-execution-narrative/v1" && ["manifest_sha256","schema_sha256","config_sha256","compiler_sha256"].every(k => /^[0-9a-f]{64}$/.test(value.provenance[k]))'; then _pass "AC1/AC7: schema and provenance hashes are present"; else _fail "AC1/AC7: envelope provenance is incomplete"; fi
if json_assert "$ENVELOPE1" 'JSON.stringify(value.sections.find(s=>s.authority==="flow-agents").embedded).includes("was observed to fail") && JSON.stringify(value).includes("was retried across 2 attempts") && JSON.stringify(value).includes("30000 ms timeout") && JSON.stringify(value).includes("classified as a no-op") && JSON.stringify(value).includes("created.txt")'; then _pass "AC3: failure, retry, timeout, no-op, and created-file facts survive"; else _fail "AC3: material runtime fact was dropped"; fi
if json_assert "$ENVELOPE1" 'JSON.stringify(value).includes("nested-worker") && [...value.sections.find(s=>s.authority==="flow-agents").embedded.turns.flatMap(t=>t.statements),...value.sections.find(s=>s.authority==="flow-agents").embedded.document_statements].some(s=>s.actor==="unattributed")'; then _pass "AC5: attributed and unattributed multi-agent facts survive"; else _fail "AC5: agent attribution disclosure is incomplete"; fi
if ! grep -q 'AC6_CANARY' "$ENVELOPE1" "$RENDER1" && grep -q 'redacted' "$RENDER1"; then _pass "AC6: canary is absent and typed redaction renders"; else _fail "AC6: canary leaked or redaction reason missing"; fi

# Every reference either resolves hash-verified or is the manifest-declared unavailable source.
if node --input-type=module - "$NARRATIVE_DIR" "$ENVELOPE1" "$ROOT/build/src/index.js" <<'NODE'
import fs from 'node:fs';
const dir=process.argv[2], env=JSON.parse(fs.readFileSync(process.argv[3])), api=await import(`file://${process.argv[4]}`);
const manifest=JSON.parse(fs.readFileSync(`${dir}/source-manifest.json`));
const unavailable=new Set(manifest.sources.filter(s=>s.status==='unavailable').map(s=>s.source_id));
const refs=new Set(JSON.stringify(env).match(/fa1:[A-Za-z0-9%._~:/#-]+/g)??[]);
for (const ref of refs) { const r=api.resolveSource(dir,ref); if (r.status!=='resolved' && !unavailable.has(ref)) process.exit(1); }
NODE
then _pass "AC1: factual references resolve or carry declared unavailability"; else _fail "AC1: unresolved factual reference"; fi

# Removing grounding must fail the public validator.
if node --input-type=module - "$ENVELOPE1" "$ROOT/build/src/index.js" <<'NODE'
import fs from 'node:fs'; const env=JSON.parse(fs.readFileSync(process.argv[2])); delete env.conclusions[0].grounding;
const api=await import(`file://${process.argv[3]}`); process.exit(api.validateGroundedNarrative(env).length ? 0 : 1);
NODE
then _pass "AC4: grounding-less conclusion is rejected"; else _fail "AC4: grounding-less conclusion validated"; fi

# Foreign authority sections equal their parsed frozen blobs and retain raw manifest hashes.
if node - "$NARRATIVE_DIR" "$ENVELOPE1" <<'NODE'
const fs=require('fs'),c=require('crypto'); const dir=process.argv[2],env=JSON.parse(fs.readFileSync(process.argv[3])),m=JSON.parse(fs.readFileSync(`${dir}/source-manifest.json`));
const stable=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
for (const authority of ['flow','surface']) {
  const s=env.sections.find(x=>x.authority===authority), e=m.sources.find(x=>x.source_id===s.source_refs[0]), raw=fs.readFileSync(`${dir}/sources/${e.sha256}`);
  if (stable(s.embedded)!==stable(JSON.parse(raw)) || s.sha256!==e.sha256 || c.createHash('sha256').update(raw).digest('hex')!==e.sha256) {
    console.error(`${authority}: parsed=${stable(s.embedded)===stable(JSON.parse(raw))} section=${s.sha256} manifest=${e.sha256} raw=${c.createHash('sha256').update(raw).digest('hex')}`);
    process.exit(1);
  }
}
NODE
then _pass "AC8: Flow and Surface embeds match frozen authority blobs and hashes"; else _fail "AC8: foreign authority embedding mismatch"; fi

# Mutating a copied blob must be detected, then restored byte-identically.
ENTRY_SHA="$(node -e "const m=JSON.parse(require('fs').readFileSync(process.argv[1]));process.stdout.write(m.sources.find(s=>s.status==='snapshotted').sha256)" "$NARRATIVE_DIR/source-manifest.json")"
BLOB="$NARRATIVE_DIR/sources/$ENTRY_SHA"; cp "$BLOB" "$TMP/blob.backup"; printf 'mutation' >"$BLOB"
if ! node "$ROOT/build/src/cli.js" narrative-sources verify --narrative-dir "$NARRATIVE_DIR" --json >"$TMP/mutated.json" 2>/dev/null; then _pass "AC2: post-compile blob mutation is detected"; else _fail "AC2: mutation passed verification"; fi
cp "$TMP/blob.backup" "$BLOB"
if cmp -s "$TMP/blob.backup" "$BLOB"; then _pass "AC2: mutated blob restored byte-identically"; else _fail "AC2: blob restoration differed"; fi

if node "$ROOT/build/src/cli.js" narrative-sources resolve --narrative-dir "$NARRATIVE_DIR" --source-id "${SOURCES[3]}" --json >/dev/null; then _pass "AC9: offline resolver succeeds"; else _fail "AC9: offline resolver failed"; fi

echo ""
if [[ "$errors" -eq 0 ]]; then echo "narrative grounded envelope tests passed."; exit 0; fi
echo "narrative grounded envelope tests FAILED: $errors issue(s)."
exit 1
