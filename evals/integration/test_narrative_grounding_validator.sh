#!/usr/bin/env bash
# Deterministic grounding publication gate, adversarial corpus, and scorer-teeth proof (#623).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURES="$ROOT/evals/fixtures/narrative-grounding-validator"
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

echo "Narrative grounding validator integration"
if npm run build --silent; then _pass "TypeScript build completed"; else _fail "TypeScript build failed"; fi
cp "$COMPILED" "$BACKUP"

if node "$FIXTURES/scorer.mjs" all >"$TMP/scorer.out" 2>"$TMP/scorer.err"; then
  _pass "AC1-AC4/AC6: adversarial corpus meets expected accept/reject verdicts"
else
  _fail "adversarial corpus failed: $(cat "$TMP/scorer.out" "$TMP/scorer.err")"
fi
if grep -q 'scorer counts: accept=2 reject=7 total=9' "$TMP/scorer.out" \
  && grep -q 'unsupported observed-claim rate=0' "$TMP/scorer.out" \
  && grep -q 'citation-resolver failures for published observed statements=0' "$TMP/scorer.out" \
  && grep -q 'fixture provenance: kontourai/flow-agents#623' "$TMP/scorer.out"; then
  _pass "AC6: scorer prints fixture provenance, counts, and enforces both zero thresholds"
else
  _fail "AC6 scorer report is incomplete: $(cat "$TMP/scorer.out")"
fi
if grep -q 'prompt-injection-inert: expected=accept actual=accept' "$TMP/scorer.out" \
  && ! grep -q 'NGV_CANARY_623' "$TMP/scorer.out" "$TMP/scorer.err"; then
  _pass "AC4: cited prompt injection leaves verdict/classes/source_refs byte-identical and canary-free"
else
  _fail "AC4 prompt-injection fixture changed grounded output or leaked its canary"
fi

# Build one publishable narrative and one automatically projected unavailable
# citation. Both are composed through the real built CLI below.
node --input-type=module - "$ROOT" "$TMP" <<'NODE'
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root=process.argv[2], tmp=process.argv[3];
const api=await import(pathToFileURL(path.join(root,'build/src/index.js')));
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const compiler={name:'grounding-validator-integration',version:'1',policy_hash:'fixture'};
const captureCompleteness={channels:{},known_gaps:[]};
const repo=path.join(tmp,'repo'); fs.mkdirSync(repo,{recursive:true});
const bytes=Buffer.from('{"kind":"created-file-fixture","status":"created"}\n');
fs.writeFileSync(path.join(repo,'created.json'),bytes);
api.snapshotNarrative({
  narrativeDir:path.join(tmp,'valid-narrative'),narrativeId:'valid-cli',redactionFields:[],compiler,captureCompleteness,
  requests:[{source:api.parseSourceId(`fa1:file:created.json:${sha256(bytes)}`),roots:{repoRoot:repo}}],
},{now:()=> '2026-07-14T15:00:00.000Z'});
api.snapshotNarrative({
  narrativeDir:path.join(tmp,'unresolved-narrative'),narrativeId:'unresolved-cli',redactionFields:[],compiler,captureCompleteness,
  requests:[{source:api.parseSourceId(`fa1:file:missing.json:${'0'.repeat(64)}`),roots:{repoRoot:repo}}],
},{now:()=> '2026-07-14T15:00:00.000Z'});
NODE

if node "$ROOT/build/src/cli.js" narrative-sources compose \
  --narrative-dir "$TMP/valid-narrative" --compiled-at "2026-07-14T16:00:00.000Z" \
  --out-dir "$TMP/valid-out" >"$TMP/valid-compose.out" 2>"$TMP/valid-compose.err"; then
  _pass "R1/R4: built CLI publishes a fully grounded narrative"
else
  _fail "valid built-CLI compose failed: $(cat "$TMP/valid-compose.err")"
fi

if node "$ROOT/build/src/cli.js" narrative-sources compose \
  --narrative-dir "$TMP/unresolved-narrative" --compiled-at "2026-07-14T16:00:00.000Z" \
  --out-dir "$TMP/unresolved-out" >"$TMP/unresolved-compose.out" 2>"$TMP/unresolved-compose.err"; then
  _pass "completeness disclosure: manifest-declared unavailable source remains publishable"
else
  _fail "typed unavailable-source disclosure was incorrectly rejected: $(cat "$TMP/unresolved-compose.err")"
fi

# Couple the real AC1 scorer verdict to the real CLI publication boundary by
# forcing that typed verdict at the stable branch anchor. The scorer above
# proves the production citation branch creates this violation; this proves
# compose refuses the same verdict before writeEnvelope.
node - "$COMPILED" <<'NODE'
const fs=require('fs'); const file=process.argv[2]; let text=fs.readFileSync(file,'utf8');
const anchor='/* grounding-check:citation */';
if (!text.includes(anchor)) throw new Error('citation mutation anchor missing');
text=text.replace(anchor, `${anchor}\n    violations.push({ code: "unresolved_citation", statement_id: "forced", source_ref: "fa1:flow-state:absent:state/00000000", reason: "not_captured", detail: "forced integration verdict" });`);
fs.writeFileSync(file,text);
NODE
if node --check "$COMPILED" >/dev/null \
  && ! node "$ROOT/build/src/cli.js" narrative-sources compose \
    --narrative-dir "$TMP/valid-narrative" --compiled-at "2026-07-14T16:00:00.000Z" \
    --out-dir "$TMP/forced-violation-out" >"$TMP/forced-violation.out" 2>"$TMP/forced-violation.err" \
  && grep -q 'narrative grounding gate failed: unresolved_citation' "$TMP/forced-violation.err" \
  && [[ ! -e "$TMP/forced-violation-out" ]]; then
  _pass "AC1/R4: typed grounding violation crosses the built CLI gate and writes no envelope"
else
  _fail "AC1 typed verdict did not fail closed at the CLI boundary: $(cat "$TMP/forced-violation.err" 2>/dev/null || true)"
fi
restore_compiled

# A validator exception must remain upstream of writeEnvelope.
node - "$COMPILED" <<'NODE'
const fs=require('fs'); const file=process.argv[2]; let text=fs.readFileSync(file,'utf8');
const anchor='/* grounding-check:citation */';
if (!text.includes(anchor)) throw new Error('citation mutation anchor missing');
text=text.replace(anchor, `${anchor}\n    throw new Error("AC5 injected validator failure");`);
fs.writeFileSync(file,text);
NODE
if node --check "$COMPILED" >/dev/null \
  && ! node "$ROOT/build/src/cli.js" narrative-sources compose \
    --narrative-dir "$TMP/valid-narrative" --compiled-at "2026-07-14T16:00:00.000Z" \
    --out-dir "$TMP/throw-out" >"$TMP/throw.out" 2>"$TMP/throw.err" \
  && grep -q 'AC5 injected validator failure' "$TMP/throw.err" \
  && [[ ! -e "$TMP/throw-out" ]]; then
  _pass "AC5/R4: validator-internal exception fails closed before content-addressed write"
else
  _fail "AC5 validator exception did not fail closed: $(cat "$TMP/throw.err" 2>/dev/null || true)"
fi
restore_compiled
cmp -s "$BACKUP" "$COMPILED" || _fail "compiled validator was not restored after AC5 mutation"

mutation_test() {
  local check="$1" anchor="$2" call="$3"
  restore_compiled
  node - "$COMPILED" "$anchor" "$call" <<'NODE'
const fs=require('fs'); const [file,anchor,call]=process.argv.slice(2); let text=fs.readFileSync(file,'utf8');
const needle=`${anchor}\n    ${call}`;
if (!text.includes(needle)) throw new Error(`mutation target missing: ${needle}`);
text=text.replace(needle, `${anchor}\n    // mutation: check deliberately disabled`);
fs.writeFileSync(file,text);
NODE
  if ! node --check "$COMPILED" >/dev/null; then
    _fail "${check} mutation produced invalid JavaScript"
  elif node "$FIXTURES/scorer.mjs" "$check" >"$TMP/mutation-$check.out" 2>"$TMP/mutation-$check.err"; then
    _fail "${check} scorer still passed after its validator branch was disabled"
  elif grep -q 'expected=reject actual=accept' "$TMP/mutation-$check.out"; then
    _pass "scorer teeth: disabling ${check} check flips reject to accept"
  else
    _fail "${check} mutation failed for an unrelated reason: $(cat "$TMP/mutation-$check.out" "$TMP/mutation-$check.err")"
  fi
  restore_compiled
  if cmp -s "$BACKUP" "$COMPILED" && node "$FIXTURES/scorer.mjs" "$check" >/dev/null; then
    _pass "${check} compiled branch restored byte-for-byte and corpus rejects again"
  else
    _fail "${check} compiled branch did not restore cleanly"
  fi
}

mutation_test citation '/* grounding-check:citation */' 'violations.push(...citationViolations(statements, narrativeDir, resolver, declaredUnavailable));'
mutation_test material '/* grounding-check:material */' 'violations.push(...materialViolations(deriveMaterialEvents(manifest, resolved), statements));'
mutation_test epistemic '/* grounding-check:epistemic */' 'violations.push(...epistemicViolations(statements));'

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "narrative grounding validator tests passed: 14/14."
  exit 0
fi
echo "narrative grounding validator tests FAILED: $errors issue(s)."
exit 1
