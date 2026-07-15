#!/usr/bin/env bash
# Model-assisted prose renderer: fail-closed publication gate, adversarial corpus,
# scorer-teeth proof, provider gating, and value-canary redaction (#614).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURES="$ROOT/evals/fixtures/narrative-prose-renderer"
TMP="$(mktemp -d)"
COMPILED="$ROOT/build/src/narrative/grounding-validator.js"
BACKUP="$TMP/grounding-validator.js.original"
errors=0

_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }
restore_compiled() {
  if [[ -f "$BACKUP" ]]; then cp "$BACKUP" "$COMPILED"; fi
}
cleanup() { restore_compiled; rm -rf "$TMP"; }
trap cleanup EXIT

echo "Narrative prose renderer integration"
if npm run build --silent; then _pass "TypeScript build completed"; else _fail "TypeScript build failed"; fi
cp "$COMPILED" "$BACKUP"

if node "$FIXTURES/scorer.mjs" all >"$TMP/scorer.out" 2>"$TMP/scorer.err"; then
  _pass "AC1-AC4/AC7: adversarial corpus meets expected accept/reject verdicts"
else
  _fail "adversarial corpus failed: $(cat "$TMP/scorer.out" "$TMP/scorer.err")"
fi
if grep -q 'fixture provenance: kontourai/flow-agents#614' "$TMP/scorer.out" \
  && grep -q 'scorer counts: accept=4 reject=2 total=6' "$TMP/scorer.out" \
  && grep -q 'unsupported published-sentence rate=0' "$TMP/scorer.out"; then
  _pass "scorer prints fixture provenance and enforces the zero unsupported-sentence threshold"
else
  _fail "scorer report is incomplete: $(cat "$TMP/scorer.out")"
fi
if grep -q 'no-op-loop: expected=accept actual=accept' "$TMP/scorer.out"; then
  _pass "AC7: an idle/no-op turn is rendered as lack-of-progress, never success wording"
else
  _fail "AC7: no-op-loop fixture did not confirm lack-of-progress wording"
fi
if grep -q 'prompt-injection-control: expected=accept actual=accept' "$TMP/scorer.out" \
  && grep -q 'prompt-injection-adversarial: expected=accept actual=accept' "$TMP/scorer.out"; then
  _pass "AC4: cited prompt injection leaves coverage/citations intact (failure still reported)"
else
  _fail "AC4 prompt-injection fixtures did not confirm coverage was preserved"
fi

# scorer teeth: disabling the new D3 provenance-subset check (grounding-check:summary)
# must flip the ONE fixture that depends exclusively on it (a resolvable-but-uncited
# flow-report citation, which the citation resolver alone would happily accept).
node - "$COMPILED" <<'NODE'
const fs=require('fs'); const file=process.argv[2]; let text=fs.readFileSync(file,'utf8');
const anchor='/* grounding-check:summary */';
const needle=`${anchor}\n    violations.push(...summaryViolations(statements));`;
if (!text.includes(needle)) throw new Error('summary mutation anchor missing');
text=text.replace(needle, `${anchor}\n    // mutation: check deliberately disabled`);
fs.writeFileSync(file,text);
NODE
if ! node --check "$COMPILED" >/dev/null; then
  _fail "summary-check mutation produced invalid JavaScript"
elif node "$FIXTURES/scorer.mjs" summary >"$TMP/mutation-summary.out" 2>"$TMP/mutation-summary.err"; then
  _fail "summary corpus still passed after its validator branch was disabled"
elif grep -q 'unsupported-summary-foreign-citation: expected=reject actual=accept' "$TMP/mutation-summary.out"; then
  _pass "scorer teeth: disabling grounding-check:summary flips the foreign-citation fixture from reject to accept"
else
  _fail "summary-check mutation failed for an unrelated reason: $(cat "$TMP/mutation-summary.out" "$TMP/mutation-summary.err")"
fi
restore_compiled
if cmp -s "$BACKUP" "$COMPILED" && node "$FIXTURES/scorer.mjs" summary >/dev/null; then
  _pass "summary-check compiled branch restored byte-for-byte and corpus rejects again"
else
  _fail "summary-check compiled branch did not restore cleanly"
fi

# ── Build one real frozen narrative directory via the built CLI, for the CLI-level checks below. ──
node --input-type=module - "$ROOT" "$TMP" <<'NODE'
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const root=process.argv[2], tmp=process.argv[3];
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const sha8=bytes=>sha256(bytes).slice(0,8);
const sessionDir=path.join(tmp,'cli-fixture','session'); fs.mkdirSync(sessionDir,{recursive:true});
const commandLine=JSON.stringify({command:'npm test',result:'fail',exitCode:1});
fs.writeFileSync(path.join(sessionDir,'command-log.jsonl'), commandLine+'\n');
fs.writeFileSync(path.join(tmp,'cli-fixture-cmd-source.txt'), `fa1:cmdlog:session:line-1/${sha8(Buffer.from(commandLine))}\n`);
NODE
CLI_SESSION="$TMP/cli-fixture/session"
CLI_CMD_SOURCE="$(cat "$TMP/cli-fixture-cmd-source.txt")"
CLI_NARRATIVE_DIR="$TMP/cli-narrative"
if node "$ROOT/build/src/cli.js" narrative-sources snapshot \
  --artifact-root "$TMP/cli-artifact-root" --narrative-id cli-fixture \
  --source "$CLI_CMD_SOURCE" --session-root "$CLI_SESSION" \
  >"$TMP/cli-snapshot.out" 2>"$TMP/cli-snapshot.err"; then
  CLI_NARRATIVE_DIR="$TMP/cli-artifact-root/.kontourai/narrative/cli-fixture"
  _pass "R1/R4: real narrative snapshot built for the CLI-level fail-closed proofs"
else
  _fail "CLI snapshot for the render fixture failed: $(cat "$TMP/cli-snapshot.err")"
fi

# AC8/LB7: hosted generator WITHOUT opt-in must refuse a non-local endpoint with NO
# socket attempt (fast rejection), not a graceful network failure (slow).
START_NS="$(date +%s%N)"
node "$ROOT/build/src/cli.js" narrative-render render \
  --narrative-dir "$CLI_NARRATIVE_DIR" --compiled-at "2026-07-14T16:00:00.000Z" \
  --out-dir "$TMP/hosted-no-opt-in-out" --generator hosted --model test-model --provider test-provider \
  --endpoint "https://model-provider.example/v1/generate" --timeout-ms 8000 \
  >"$TMP/hosted-no-opt-in.out" 2>"$TMP/hosted-no-opt-in.err"
hosted_exit=$?
END_NS="$(date +%s%N)"
ELAPSED_MS=$(( (END_NS - START_NS) / 1000000 ))
if [[ "$hosted_exit" -eq 0 ]] && grep -q '"outcome": "deterministic_only"' "$TMP/hosted-no-opt-in.out" \
  && grep -qi 'not allowed' "$TMP/hosted-no-opt-in.out" \
  && [[ ! -d "$TMP/hosted-no-opt-in-out" || -z "$(find "$TMP/hosted-no-opt-in-out" -name '*.prose.json' 2>/dev/null)" ]] \
  && [[ "$ELAPSED_MS" -lt 3000 ]]; then
  _pass "AC8/LB7: hosted generator without opt-in refused a non-local endpoint in ${ELAPSED_MS}ms with zero prose artifacts (no socket attempt)"
else
  _fail "AC8 hosted-without-opt-in did not fail closed fast enough or wrote a prose artifact (exit=$hosted_exit elapsed=${ELAPSED_MS}ms): $(cat "$TMP/hosted-no-opt-in.out" "$TMP/hosted-no-opt-in.err")"
fi

# Opt-in missing a required field (data_residency/payload_policy) must still refuse.
node "$ROOT/build/src/cli.js" narrative-render render \
  --narrative-dir "$CLI_NARRATIVE_DIR" --compiled-at "2026-07-14T16:00:00.000Z" \
  --out-dir "$TMP/hosted-partial-opt-in-out" --generator hosted --model test-model --provider test-provider \
  --endpoint "https://model-provider.example/v1/generate" --timeout-ms 2000 \
  --opt-in-tenant acme \
  >"$TMP/hosted-partial-opt-in.out" 2>"$TMP/hosted-partial-opt-in.err"
if grep -q '"outcome": "deterministic_only"' "$TMP/hosted-partial-opt-in.out" \
  && [[ ! -d "$TMP/hosted-partial-opt-in-out" || -z "$(find "$TMP/hosted-partial-opt-in-out" -name '*.prose.json' 2>/dev/null)" ]]; then
  _pass "AC8: opt-in missing data_residency/payload_policy still refuses the hosted endpoint"
else
  _fail "AC8: partial opt-in incorrectly allowed the hosted endpoint"
fi

# AC2/LB1: a generator error (nothing listening on the configured local endpoint) still
# writes the deterministic narrative and ZERO prose artifacts through the real CLI binary.
node "$ROOT/build/src/cli.js" narrative-render render \
  --narrative-dir "$CLI_NARRATIVE_DIR" --compiled-at "2026-07-14T16:00:00.000Z" \
  --out-dir "$TMP/local-error-out" --generator local --model test-model --provider local \
  --endpoint "http://127.0.0.1:1" --timeout-ms 3000 \
  >"$TMP/local-error.out" 2>"$TMP/local-error.err"
local_exit=$?
if [[ "$local_exit" -eq 0 ]] && grep -q '"outcome": "deterministic_only"' "$TMP/local-error.out" \
  && [[ -n "$(find "$TMP/local-error-out" -name '*.json' -not -name '*.prose.json' 2>/dev/null)" ]] \
  && [[ -z "$(find "$TMP/local-error-out" -name '*.prose.json' 2>/dev/null)" ]]; then
  _pass "AC2/LB1: a real generator connection failure still writes the deterministic narrative and zero prose artifacts"
else
  _fail "AC2 local-generator-error did not fail closed as expected (exit=$local_exit): $(cat "$TMP/local-error.out" "$TMP/local-error.err")"
fi

# R8/AC5/D7: a value-based secret canary planted in a redacted field must never surface
# in prose, the generator's own request/response view (sourceViews), the economics sink,
# or stderr -- even against a generator that deliberately echoes everything it was given.
node --input-type=module - "$ROOT" "$TMP" <<'NODE' >"$TMP/canary.out" 2>"$TMP/canary.err"
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root=process.argv[2], tmp=process.argv[3];
const api=await import(pathToFileURL(path.join(root,'build/src/index.js')));
const sha256=b=>createHash('sha256').update(b).digest('hex');
const sha8=b=>sha256(b).slice(0,8);
const CANARY='NPR614_SECRET_CANARY_9f2c';
const fixtureRoot=path.join(tmp,'canary-fixture');
const sessionDir=path.join(fixtureRoot,'session'), telemetryDir=path.join(fixtureRoot,'telemetry'), repoRoot=path.join(fixtureRoot,'repo'), narrativeDir=path.join(fixtureRoot,'narrative');
fs.mkdirSync(sessionDir,{recursive:true}); fs.mkdirSync(telemetryDir,{recursive:true}); fs.mkdirSync(repoRoot,{recursive:true});
const commandLine=JSON.stringify({command:'npm test',result:'fail',exitCode:1});
fs.writeFileSync(path.join(sessionDir,'command-log.jsonl'), commandLine+'\n');
const canaryRecord={session_id:'canary-session',event_id:'canary-evt',event_type:'tool.result',tool:{name:'execute_bash',input:{command:'printenv',secret:CANARY}},exit_code:1};
const canaryLine=JSON.stringify(canaryRecord);
fs.writeFileSync(path.join(telemetryDir,'full.jsonl'), canaryLine+'\n');
const fileBytes=Buffer.from('{"kind":"created-file-fixture","status":"created"}\n');
fs.writeFileSync(path.join(repoRoot,'created.json'), fileBytes);
api.snapshotNarrative({
  narrativeDir, narrativeId:'canary', redactionFields:['tool.input'],
  compiler:{name:'canary-check',version:'1',policy_hash:'fixture'}, captureCompleteness:{channels:{full:'active'},known_gaps:[]},
  requests:[
    {source:api.parseSourceId(`fa1:cmdlog:session:line-1/${sha8(Buffer.from(commandLine))}`),roots:{sessionDir}},
    {source:api.parseSourceId(`fa1:telemetry:full/canary-session:canary-evt/${sha8(Buffer.from(canaryLine))}`),roots:{telemetryDir}},
    {source:api.parseSourceId(`fa1:file:created.json:${sha256(fileBytes)}`),roots:{repoRoot}},
  ],
},{now:()=>'2026-07-14T15:00:00.000Z'});

// Deliberately adversarial: echoes every source view's raw content into one summary
// sentence citing every atomic statement's refs (a maximally leak-seeking generator).
const echoEverythingGenerator = {
  identity:{model:'echo-everything',provider:'test',config_hash:'x'},
  async generate(input) {
    const allRefs=[...new Set(input.statements.flatMap(s=>s.source_refs))];
    const dump=input.sourceViews.map(v=>v.content).join(' ').replace(/[\r\n`]/g,' ').replace(/;\s/g,', ');
    return { sentences:[{ text:`Evidence dump: ${dump || 'no evidence'}`, statement_refs: allRefs }], usage:{input_tokens:10,output_tokens:10} };
  },
};
const outDir=path.join(tmp,'canary-out');
let result;
try {
  result = await api.renderProse(narrativeDir, { compiledAt:'2026-07-14T16:00:00.000Z', outDir, generator: echoEverythingGenerator });
} catch (error) {
  console.error('renderProse threw:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
if (result) {
  console.log('outcome:', result.outcome, result.reason ?? '');
  console.log('economics file:', fs.readFileSync(path.join(narrativeDir, api.PROSE_ECONOMICS_FILE), 'utf8'));
  if (result.outcome === 'prose_published') console.log('prose:', fs.readFileSync(result.prose.path, 'utf8'));
  if (result.written.renderPath) console.log('deterministic markdown:', fs.readFileSync(result.written.renderPath, 'utf8'));
}

// PUBLISH-PATH canary: run the benign stub generator over the SAME redacted-canary
// fixture into a fresh out-dir. The stub produces publishable prose (it never restates
// banned outcome verbs), so this exercises the prose_published path -- proving the
// redacted secret is absent from PUBLISHED prose + economics, not merely on the reject
// path. (The generator only ever sees the frozen, policy-filtered resolveSource view,
// in which tool.input -- where the canary lives -- is nulled.)
const pubOutDir=path.join(tmp,'canary-pub-out');
const pub = await api.renderProse(narrativeDir, { compiledAt:'2026-07-14T16:00:00.000Z', outDir: pubOutDir, generator: api.stubGenerator });
console.log('publish outcome:', pub.outcome, pub.reason ?? '');
console.log('publish economics:', fs.readFileSync(path.join(narrativeDir, api.PROSE_ECONOMICS_FILE), 'utf8'));
if (pub.outcome === 'prose_published') console.log('published prose:', fs.readFileSync(pub.prose.path, 'utf8'));
NODE
if grep -q -- 'NPR614_SECRET_CANARY_9f2c' "$TMP/canary.out" "$TMP/canary.err"; then
  _fail "R8/AC5: value-based canary leaked into prose, economics, or generator diagnostics"
else
  _pass "R8/AC5/D7: redacted value-based canary never surfaces in prose, economics, or stderr, even against an echo-everything generator"
fi
if grep -q 'publish outcome: prose_published' "$TMP/canary.out"; then
  _pass "R8/AC5/D7 (publish path): benign generator over the redacted-canary fixture actually publishes prose"
else
  _fail "R8/AC5/D7 publish-path canary did not exercise the prose_published path: $(grep 'publish outcome' "$TMP/canary.out")"
fi

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "narrative prose renderer tests passed: 12/12."
  exit 0
fi
echo "narrative prose renderer tests FAILED: $errors issue(s)."
exit 1
