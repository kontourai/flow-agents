#!/usr/bin/env bash
# Grounded narrative faithfulness eval suite: one-command frozen corpus replay,
# schema-valid result emission, and the R3 scorer-teeth mutation battery (#612).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURES="$ROOT/evals/fixtures/narrative-evals"
SCORER="$FIXTURES/scorer.mjs"
TMP="$(mktemp -d)"
BACKUP="$TMP/scorer.mjs.original"
errors=0

_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }
restore_scorer() { if [[ -f "$BACKUP" ]]; then cp "$BACKUP" "$SCORER"; fi; }
cleanup() { restore_scorer; rm -rf "$TMP"; }
trap cleanup EXIT

echo "Narrative grounded evals integration"
if npm run build --silent; then _pass "TypeScript build completed"; else _fail "TypeScript build failed"; fi
cp "$SCORER" "$BACKUP"

# AC1: one command replays the whole frozen corpus and emits a schema-valid result.
if NARRATIVE_EVAL_RESULT_OUT="$TMP/result.json" node "$SCORER" all >"$TMP/scorer.out" 2>"$TMP/scorer.err"; then
  _pass "AC1/AC2: frozen corpus meets every answer-key verdict"
else
  _fail "corpus replay failed: $(cat "$TMP/scorer.out" "$TMP/scorer.err")"
fi

if grep -q 'fixture provenance: kontourai/flow-agents#612 narrative-evals-corpus/v1' "$TMP/scorer.out" \
  && grep -q 'scorer counts: accept=9 reject=5 known_gap=1 total=15' "$TMP/scorer.out" \
  && grep -q 'unsupported observed-claim rate=0' "$TMP/scorer.out" \
  && grep -q 'citation resolvability=1' "$TMP/scorer.out" \
  && grep -q 'material-claim coverage=1' "$TMP/scorer.out" \
  && grep -q 'epistemic classification accuracy=1' "$TMP/scorer.out"; then
  _pass "R7/AC5: deterministic provenance, counts, and threshold lines present"
else
  _fail "deterministic report is incomplete: $(cat "$TMP/scorer.out")"
fi

# D8: the contradictory case is disclosed as a known_gap, never faked as detection.
if grep -q 'contradictory: expected=known_gap actual=known_gap' "$TMP/scorer.out"; then
  _pass "D8: contradictory fixture recorded as a documented known_gap"
else
  _fail "D8 contradictory fixture was not scored as a known_gap"
fi

# AC3/R7: capability parity is DECLARED (queryCapability), not behavior-probed, for >=2 runtimes.
if grep -q 'capability parity: claude-code/intent_annotation=unsupported' "$TMP/scorer.out" \
  && grep -q 'capability parity: claude-code/per_delegation_trace_context=unsupported' "$TMP/scorer.out" \
  && grep -q 'capability parity: codex/intent_annotation=unsupported' "$TMP/scorer.out" \
  && grep -q 'capability parity: codex/per_delegation_trace_context=unsupported' "$TMP/scorer.out"; then
  _pass "AC3/R7: declared capability parity emitted for claude-code and codex"
else
  _fail "AC3 capability parity block is incomplete: $(cat "$TMP/scorer.out")"
fi

# R2/R6/AC6: the emitted result validates against the shipped schema in CI too.
if [[ -f "$TMP/result.json" ]] && node --input-type=module - "$ROOT" "$TMP/result.json" >"$TMP/schema.out" 2>&1 <<'NODE'
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
const [root, file] = process.argv.slice(2);
const api = await import(pathToFileURL(path.join(root, 'build/src/index.js')));
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
if (value.schema_version !== 'narrative-eval-result/v1') { console.error('unexpected schema_version'); process.exit(1); }
const issues = api.validateNarrativeEvalResult(value);
if (issues.length > 0) { console.error(JSON.stringify(issues)); process.exit(1); }
// Negative control: a broken result must be rejected, proving the validator has teeth.
const broken = structuredClone(value); broken.metrics.unsupported_claim_rate = 2; broken.injected = true;
if (api.validateNarrativeEvalResult(broken).length === 0) { console.error('schema validator accepted a malformed result'); process.exit(1); }
NODE
then
  _pass "R2/R6/AC6: emitted result validates against narrative-eval-result/v1 in-process and in CI"
else
  _fail "emitted result failed schema validation: $(cat "$TMP/schema.out" 2>/dev/null || echo 'result.json missing')"
fi

# R2 determinism: the emitted artifact must be byte-identical across runs (content-
# addressed fa1 ids must not leak the random temp path). Guards review finding HIGH-2.
NARRATIVE_EVAL_RESULT_OUT="$TMP/result-a.json" node "$SCORER" all >/dev/null 2>&1 || true
NARRATIVE_EVAL_RESULT_OUT="$TMP/result-b.json" node "$SCORER" all >/dev/null 2>&1 || true
if cmp -s "$TMP/result-a.json" "$TMP/result-b.json"; then
  _pass "R2: emitted result is byte-identical across runs (deterministic artifact)"
else
  _fail "emitted result is non-deterministic across runs: $(diff "$TMP/result-a.json" "$TMP/result-b.json" | head -5)"
fi

# HIGH-1 guard: material_claim_coverage must be COMPUTED from the canonical extraction,
# not a lockstep counter — removing a covering statement must drop covered below total.
if node --input-type=module - "$ROOT" >"$TMP/covteeth.out" 2>&1 <<'NODE'
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
const [root] = process.argv.slice(2);
const api = await import(pathToFileURL(path.join(root, 'build/src/index.js')));
const sha8 = (b) => createHash('sha256').update(b).digest('hex').slice(0, 8);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-teeth-'));
const sessionDir = path.join(temp, 'session'); const narrativeDir = path.join(temp, 'narrative');
fs.mkdirSync(sessionDir, { recursive: true });
const line = JSON.stringify({ command: 'npm test', result: 'fail', exitCode: 1 });
fs.writeFileSync(path.join(sessionDir, 'command-log.jsonl'), `${line}\n`);
const ref = `fa1:cmdlog:session:line-1/${sha8(Buffer.from(line))}`;
const at = '2026-01-01T00:00:00.000Z';
api.snapshotNarrative({ narrativeDir, narrativeId: 'cov', requests: [{ source: api.parseSourceId(ref), roots: { sessionDir } }], redactionFields: [], compiler: { name: 'cov', version: '1', policy_hash: 'fixture' }, captureCompleteness: { channels: { full: 'active' }, known_gaps: [] } }, { now: () => at });
const full = api.composeGroundedNarrative(narrativeDir, { compiledAt: at });
const covFull = api.materialEventCoverage(full, narrativeDir);
const stripped = JSON.parse(JSON.stringify(full));
const rt = stripped.sections.find((s) => s.authority === 'flow-agents' && s.kind === 'runtime-projection');
rt.embedded.turns = rt.embedded.turns.map((t) => ({ ...t, statements: t.statements.filter((s) => !/was observed to fail/.test(s.proposition)) }));
rt.embedded.document_statements = rt.embedded.document_statements.filter((s) => !/was observed to fail/.test(s.proposition));
const covStripped = api.materialEventCoverage(stripped, narrativeDir);
fs.rmSync(temp, { recursive: true, force: true });
if (!(covFull.total >= 1 && covFull.covered === covFull.total && covStripped.total === covFull.total && covStripped.covered < covStripped.total)) {
  console.error(`coverage metric has no teeth: full=${covFull.covered}/${covFull.total} stripped=${covStripped.covered}/${covStripped.total}`); process.exit(1);
}
NODE
then
  _pass "HIGH-1: material_claim_coverage is computed from the canonical extraction (drops when coverage is removed)"
else
  _fail "material_claim_coverage does not react to removed coverage: $(cat "$TMP/covteeth.out")"
fi

# R3/AC2: the mutation battery. For EACH corruption class, disable the scorer's
# detection at its named /* eval-check:<name> */ anchor, confirm the compiled
# scorer still parses, confirm the matching reject fixture flips to accept
# (teeth), then restore byte-for-byte and confirm the corpus rejects it again.
mutation_test() {
  local check="$1" anchor="$2" call="$3" fixture="$4"
  restore_scorer
  node - "$SCORER" "$anchor" "$call" <<'NODE'
const fs = require('fs');
const [file, anchor, call] = process.argv.slice(2);
let text = fs.readFileSync(file, 'utf8');
const needle = `${anchor}\n  ${call}`;
if (!text.includes(needle)) throw new Error(`mutation target missing: ${needle}`);
text = text.replace(needle, `${anchor}\n  // mutation: check deliberately disabled`);
fs.writeFileSync(file, text);
NODE
  if ! node --check "$SCORER" >/dev/null; then
    _fail "${check} mutation produced invalid JavaScript"
  elif node "$SCORER" "$check" >"$TMP/mutation-$check.out" 2>"$TMP/mutation-$check.err"; then
    _fail "${check} scorer still passed after its detection was disabled"
  elif grep -q "${fixture}: expected=reject actual=accept" "$TMP/mutation-$check.out"; then
    _pass "scorer teeth: disabling ${check} flips ${fixture} reject to accept"
  else
    _fail "${check} mutation failed for an unrelated reason: $(cat "$TMP/mutation-$check.out" "$TMP/mutation-$check.err")"
  fi
  restore_scorer
  if cmp -s "$BACKUP" "$SCORER" && node "$SCORER" "$check" >/dev/null 2>&1; then
    _pass "${check} detection restored byte-for-byte and the corpus rejects again"
  else
    _fail "${check} detection did not restore cleanly"
  fi
}

mutation_test support   '/* eval-check:support */'   'supportCheck(state, statements);'   hallucinated-statement
mutation_test citation  '/* eval-check:citation */'  'citationCheck(state, verdict);'     dangling-citation
mutation_test coverage  '/* eval-check:coverage */'  'coverageCheck(state, verdict);'     omitted-failure
mutation_test epistemic '/* eval-check:epistemic */' 'epistemicCheck(state, verdict);'    mislabeled-inference
mutation_test injection '/* eval-check:injection */' 'injectionCheck(state, injection);'  injection-followed

restore_scorer
cmp -s "$BACKUP" "$SCORER" || _fail "scorer was not restored after the mutation battery"

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "narrative grounded evals tests passed: 15/15."
  exit 0
fi
echo "narrative grounded evals tests FAILED: $errors issue(s)."
exit 1
