#!/usr/bin/env bash
# test_critique_supersession_roundtrip.sh — Regression evals for the trust-ledger defects
# fixed under #267 (critique supersession), #268 (lossless, type-stable check/critique
# round-trip), and #282 (first-class superseded_by affordance).
#
# Proves:
#   (a) record-critique twice for the same id (fail → pass, SAME reviewer) supersedes the fail:
#       the effective/live state is the pass, the historical fail is retained (status=superseded,
#       metadata.superseded_by) but excluded from evaluation, no duplicate claim ids, and CI
#       trust-reconcile exits 0.
#   (b) HEADLINE: a --flow-id (builder.build/verify) session — ensure-session → record-evidence
#       (mixed session-local kinds) → record-critique → trust-reconcile — exits 0. This exact flow
#       could never converge before (critique claims were re-absorbed as command-less test_output
#       checks → permanent [not-run] divergence; check kinds collapsed to the declared claimType).
#   (c) record-evidence AFTER a critique preserves the critique history (previously hardcoded []).
#   (d) ANTI-GAMING: a DIFFERENT reviewer cannot supersede a reviewer's fail — the disputed
#       critique stays live and trust-reconcile still exits 1 (worker cannot bury a reviewer finding).
#   (e) VALIDATOR (#282): a top-level pass tolerates a superseded historical fail member, but a
#       LIVE (non-superseded) fail still triggers "required critique must pass".
#
# Deterministic, no model spend, self-cleaning.
# Usage: bash evals/integration/test_critique_supersession_roundtrip.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"
RECON="$ROOT/scripts/ci/trust-reconcile.js"
WRITER="workflow-sidecar"

TMP="$(mktemp -d)"
errors=0
_pass() { echo "  PASS: $1"; }
_fail() { echo "  FAIL: $1"; errors=$((errors + 1)); }
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# seed <aroot> <slug> [flow-args...] — ensure-session + init-plan
seed() {
  local aroot="$1"; local slug="$2"; shift 2
  mkdir -p "$aroot"
  flow_agents_node "$WRITER" ensure-session --artifact-root "$aroot" --task-slug "$slug" \
    --title "T" --summary "S" --timestamp "2026-07-01T00:00:00Z" "$@" >/dev/null 2>&1
  flow_agents_node "$WRITER" init-plan "$aroot/$slug/$slug--deliver.md" \
    --source-request "R" --summary "S" --timestamp "2026-07-01T00:00:00Z" >/dev/null 2>&1
}

# ─── (a) same-reviewer supersession: fail → pass ──────────────────────────────
echo ""
echo "=== (a) record-critique fail→pass (same reviewer) supersedes, history intact, reconcile 0 ==="
A_AROOT="$TMP/a/aroot"; A_SLUG="supersede-same"; A_DIR="$A_AROOT/$A_SLUG"
seed "$A_AROOT" "$A_SLUG"
flow_agents_node "$WRITER" record-evidence "$A_DIR" --verdict pass \
  --check-json '{"id":"c1","kind":"diff","status":"pass","summary":"diff check"}' \
  --timestamp "2026-07-01T00:01:00Z" >/dev/null 2>&1
flow_agents_node "$WRITER" record-critique "$A_DIR" --id rv --reviewer alice --verdict fail \
  --summary "found a bug" --timestamp "2026-07-01T00:02:00Z" >/dev/null 2>&1
flow_agents_node "$WRITER" record-critique "$A_DIR" --id rv --reviewer alice --verdict pass \
  --summary "bug fixed" --timestamp "2026-07-01T00:03:00Z" >/dev/null 2>&1

node - "$A_DIR/trust.bundle" << 'NODE'
const fs = require('fs');
const b = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const crit = (b.claims||[]).filter(c => c.metadata && c.metadata.origin === 'critique');
const live = crit.filter(c => !c.metadata.superseded_by);
const hist = crit.filter(c => c.metadata.superseded_by);
if (crit.length !== 2) throw new Error('expected 2 critique claims (1 live + 1 history), got ' + crit.length);
if (live.length !== 1 || live[0].value !== 'pass') throw new Error('expected exactly 1 LIVE critique with value=pass, got ' + JSON.stringify(live.map(c=>c.value)));
if (hist.length !== 1 || hist[0].value !== 'fail' || hist[0].status !== 'superseded') throw new Error('expected historical fail with status=superseded');
if (!hist[0].metadata.superseded_by) throw new Error('history missing first-class metadata.superseded_by');
const ids = (b.claims||[]).map(c=>c.id); const dup = ids.filter((x,i)=>ids.indexOf(x)!==i);
if (dup.length) throw new Error('duplicate claim ids in bundle: ' + dup.join(','));
console.log('live=pass, history=fail(superseded), no duplicate ids');
NODE
if [[ $? -eq 0 ]]; then _pass "(a) effective state=pass, historical fail retained+superseded, no dup ids"; else _fail "(a) supersession/history assertion failed"; fi

TRUST_RECONCILE_COMMANDS="true" node "$RECON" --bundle "$A_DIR/trust.bundle" --repo-root "$TMP/a" >"$TMP/a-recon.log" 2>&1
if [[ $? -eq 0 ]]; then _pass "(a) trust-reconcile exits 0 (resolved session converges)"; else _fail "(a) trust-reconcile did NOT converge: $(cat "$TMP/a-recon.log")"; fi

# ─── (b) HEADLINE: --flow-id session converges ────────────────────────────────
echo ""
echo "=== (b) HEADLINE --flow-id builder.build/verify: mixed evidence + critique → reconcile 0 ==="
B_AROOT="$TMP/b/aroot"; B_SLUG="flowid-converge"; B_DIR="$B_AROOT/$B_SLUG"
seed "$B_AROOT" "$B_SLUG" --flow-id builder.build --step-id verify
flow_agents_node "$WRITER" record-evidence "$B_DIR" --verdict pass \
  --check-json '{"id":"k-diff","kind":"diff","status":"pass","summary":"diff excerpt"}' \
  --check-json '{"id":"k-policy","kind":"policy","status":"pass","summary":"policy rule"}' \
  --check-json '{"id":"k-ext","kind":"external","status":"pass","summary":"attested"}' \
  --timestamp "2026-07-01T00:01:00Z" >/dev/null 2>&1
flow_agents_node "$WRITER" record-critique "$B_DIR" --id code-review --reviewer alice --verdict pass \
  --summary "looks good" --timestamp "2026-07-01T00:02:00Z" >/dev/null 2>&1

node - "$B_DIR/trust.bundle" << 'NODE'
const fs = require('fs');
const b = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
// Type stability: no critique claim may be re-absorbed as a check, and check kinds/evidenceTypes
// must survive the round-trip (a session-local kind must NOT flip to test_output).
const checks = (b.claims||[]).filter(c => c.metadata && c.metadata.origin === 'check');
const crit = (b.claims||[]).filter(c => c.metadata && c.metadata.origin === 'critique');
if (crit.length !== 1) throw new Error('expected exactly 1 critique claim (no re-absorption/duplication), got ' + crit.length);
const evByClaim = {}; for (const e of (b.evidence||[])) (evByClaim[e.claimId] ||= []).push(e);
for (const c of checks) {
  const ets = (evByClaim[c.id]||[]).map(e=>e.evidenceType);
  if (ets.includes('test_output')) throw new Error('session-local check ' + c.id + ' flipped to test_output evidence (round-trip kind instability)');
}
console.log(checks.length + ' check claims, ' + crit.length + ' critique claim; no test_output flip');
NODE
if [[ $? -eq 0 ]]; then _pass "(b) round-trip type-stable under --flow-id (no critique→check absorption, no evidenceType flip)"; else _fail "(b) round-trip type instability under --flow-id"; fi

TRUST_RECONCILE_COMMANDS="true" node "$RECON" --bundle "$B_DIR/trust.bundle" --repo-root "$TMP/b" >"$TMP/b-recon.log" 2>&1
if [[ $? -eq 0 ]]; then _pass "(b) HEADLINE: --flow-id session trust-reconcile exits 0 (converges)"; else _fail "(b) HEADLINE --flow-id session did NOT converge: $(cat "$TMP/b-recon.log")"; fi

# ─── (c) record-evidence after critiques preserves history ────────────────────
echo ""
echo "=== (c) record-evidence AFTER a critique preserves critique history (#268) ==="
flow_agents_node "$WRITER" record-evidence "$B_DIR" --verdict pass \
  --check-json '{"id":"k-diff2","kind":"diff","status":"pass","summary":"another diff"}' \
  --timestamp "2026-07-01T00:04:00Z" >/dev/null 2>&1
node - "$B_DIR/trust.bundle" << 'NODE'
const fs = require('fs');
const b = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const crit = (b.claims||[]).filter(c => c.metadata && c.metadata.origin === 'critique');
if (crit.length !== 1) throw new Error('critique history dropped by record-evidence — expected 1, got ' + crit.length);
if (crit[0].value !== 'pass') throw new Error('critique value changed');
console.log('critique survived record-evidence');
NODE
if [[ $? -eq 0 ]]; then _pass "(c) critique history survives a later record-evidence call"; else _fail "(c) record-evidence dropped critique history"; fi

# ─── (d) ANTI-GAMING: cross-reviewer cannot supersede a reviewer fail ─────────
echo ""
echo "=== (d) ANTI-GAMING: a different reviewer cannot supersede a reviewer's fail ==="
D_AROOT="$TMP/d/aroot"; D_SLUG="supersede-cross"; D_DIR="$D_AROOT/$D_SLUG"
seed "$D_AROOT" "$D_SLUG"
flow_agents_node "$WRITER" record-evidence "$D_DIR" --verdict pass \
  --check-json '{"id":"c1","kind":"diff","status":"pass","summary":"diff check"}' \
  --timestamp "2026-07-01T00:01:00Z" >/dev/null 2>&1
flow_agents_node "$WRITER" record-critique "$D_DIR" --id rv --reviewer reviewer-bob --verdict fail \
  --summary "reviewer found a real bug" --timestamp "2026-07-01T00:02:00Z" >/dev/null 2>&1
flow_agents_node "$WRITER" record-critique "$D_DIR" --id rv --reviewer worker-mallory --verdict pass \
  --summary "worker claims fixed" --timestamp "2026-07-01T00:03:00Z" >/dev/null 2>&1
node - "$D_DIR/trust.bundle" << 'NODE'
const fs = require('fs');
const b = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const crit = (b.claims||[]).filter(c => c.metadata && c.metadata.origin === 'critique');
const live = crit.filter(c => !c.metadata.superseded_by);
const liveFail = live.filter(c => c.value === 'fail' || c.status === 'disputed');
if (!liveFail.length) throw new Error('ANTI-GAMING VIOLATION: reviewer fail was superseded by a different reviewer');
if (crit.some(c => c.metadata.superseded_by)) throw new Error('unexpected supersession across reviewers');
console.log('reviewer fail stays LIVE (' + liveFail.length + '); cross-reviewer supersession refused');
NODE
if [[ $? -eq 0 ]]; then _pass "(d) reviewer's fail is NOT superseded by a different reviewer (stays live)"; else _fail "(d) ANTI-GAMING regression: cross-reviewer supersession occurred"; fi
TRUST_RECONCILE_COMMANDS="true" node "$RECON" --bundle "$D_DIR/trust.bundle" --repo-root "$TMP/d" >"$TMP/d-recon.log" 2>&1
if [[ $? -ne 0 ]] && grep -q "session-local-failed" "$TMP/d-recon.log"; then _pass "(d) trust-reconcile still exits 1 (live disputed critique blocks)"; else _fail "(d) reconcile should have blocked on the live reviewer fail"; fi

# ─── (e) VALIDATOR (#282): superseded fail tolerated, live fail blocks ────────
echo ""
echo "=== (e) VALIDATOR: superseded historical fail tolerated; live fail blocks (#282) ==="
# Reuse (a)'s superseded bundle: pass top-level with a superseded fail member.
va_out="$(flow_agents_node validate-workflow-artifacts "$A_AROOT" --require-sidecars --require-critique 2>&1)"
if echo "$va_out" | grep -q "required critique must pass"; then
  _fail "(e) validator wrongly rejected a superseded historical fail"
else
  _pass "(e) validator tolerates a superseded historical fail member (no 'required critique must pass')"
fi
# Live fail (d's cross-reviewer bundle has a live disputed critique) must still be rejected.
vd_out="$(flow_agents_node validate-workflow-artifacts "$D_AROOT" --require-sidecars --require-critique 2>&1)"
if echo "$vd_out" | grep -q "required critique must pass"; then
  _pass "(e) validator still rejects a LIVE (non-superseded) fail critique"
else
  _fail "(e) validator failed to reject a live fail critique"
fi

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "────────────────────────────────────────────"
if [[ $errors -eq 0 ]]; then
  echo "test_critique_supersession_roundtrip: all checks passed."
  exit 0
else
  echo "test_critique_supersession_roundtrip: $errors check(s) failed."
  exit 1
fi
