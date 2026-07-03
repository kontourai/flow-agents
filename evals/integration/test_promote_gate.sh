#!/usr/bin/env bash
# test_promote_gate.sh - promote-then-archive gate (issue #312).
#
# Durable-residue extraction is the archival act. Covers:
#   1. promote writes a well-formed, session-local promotion claim referencing
#      existing durable doc paths (metadata.promotion + policy_rule evidence, no
#      execution.label) and an auditable promotion.json.
#   2. promote REJECTS a nonexistent --evidence-path (fail loud).
#   3. promote --none --reason records an explicit no-residue claim; --none without
#      --reason is refused.
#   4. cleanup-audit classification: a delivered/accepted session WITHOUT a promotion
#      claim is a cleanup_candidate (blocked from archive) with a remedy naming the
#      promote step; WITH a real claim OR a --none claim it stays terminal_done (AC1-3).
#   5. CRITICAL: trust-reconcile stays exit 0 on a bundle carrying a promotion claim -
#      the claim classifies session-local (ATTESTED), never an unbacked/not-run command
#      divergence (proves R1 reconcile-safety, no new manifest entry required).
#
# Deterministic, no model spend, self-cleaning.
# Usage: bash evals/integration/test_promote_gate.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
unset FORCE_COLOR  # known local artifact that can perturb child-process output

errors=0
pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; errors=$((errors + 1)); }

echo "=== Promote-then-archive gate (#312) ==="

# JSON reader helpers (dedicated files; no inline interpreter flags).
cat > "$TMP/inspect.cjs" <<'JS'
const fs = require("fs");
const b = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const claim = (b.claims || []).find((c) => c.metadata && c.metadata.promotion);
const ev = claim && (b.evidence || []).find((e) => e.claimId === claim.id);
const out = {
  found: String(!!claim),
  status: (claim && claim.status) || "",
  targets: (claim && claim.metadata.promotion.targets) || [],
  none: String(claim ? claim.metadata.promotion.none : ""),
  evidenceType: (ev && ev.evidenceType) || "",
  hasExecutionLabel: String(!!(ev && ev.execution && ev.execution.label)),
};
fs.writeFileSync(process.argv[3], JSON.stringify(out));
JS
cat > "$TMP/field.cjs" <<'JS'
const fs = require("fs");
const o = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
let v = o;
for (const k of process.argv[3].split(".")) v = v[k];
console.log(Array.isArray(v) ? v.join(",") : v);
JS
cat > "$TMP/bucketof.cjs" <<'JS'
const fs = require("fs");
const d = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
for (const [b, arr] of Object.entries(d.buckets)) {
  for (const it of arr) if (it.slug === process.argv[3]) { console.log(b + "|" + (it.reasons[0] || "")); process.exit(0); }
}
console.log("MISSING|");
JS

REPO="$TMP/repo"
mkdir -p "$REPO/kits" "$REPO/docs/decisions" "$REPO/docs/learnings"
printf 'x\n' > "$REPO/docs/decisions/promotion-gate.md"
printf 'y\n' > "$REPO/docs/learnings/note.md"
SESSION_ROOT="$REPO/.kontourai/flow-agents"

ensure() {
  flow_agents_node workflow-sidecar ensure-session \
    --artifact-root "$SESSION_ROOT" --task-slug "$1" \
    --source-request "r" --title "T" --summary "s" \
    --criterion "c1" --next-action "n" --timestamp "2026-07-02T00:00:00Z" \
    >/dev/null 2>"$TMP/$1.ensure.err"
}
seed_evidence() {
  flow_agents_node workflow-sidecar record-evidence "$1" --verdict pass \
    --check-json '{"id":"docs-check","kind":"policy","status":"pass","summary":"docs reviewed"}' \
    --timestamp "2026-07-02T00:01:00Z" >/dev/null 2>"$TMP/ev.err"
}
term_state() {
  printf '{"schema_version":"1.0","task_slug":"%s","status":"accepted","phase":"done","updated_at":"2026-07-02T00:00:00Z","next_action":{"status":"done","summary":"done"}}' "$2" > "$1/state.json"
}
field() { node "$TMP/field.cjs" "$1" "$2"; }

# --- 1. promote writes a well-formed session-local claim ---------------------
ensure promoted
PDIR="$SESSION_ROOT/promoted"
seed_evidence "$PDIR"
if flow_agents_node workflow-sidecar promote "$PDIR" --repo-root "$REPO" \
     --evidence-path docs/decisions/promotion-gate.md \
     --evidence-path docs/learnings/note.md \
     --timestamp "2026-07-02T00:02:00Z" >"$TMP/promote.out" 2>"$TMP/promote.err"; then
  pass "promote with existing paths exits 0"
else
  fail "promote with existing paths should exit 0: $(cat "$TMP/promote.err")"
fi
[[ -f "$PDIR/promotion.json" ]] && pass "promote writes auditable promotion.json" || fail "promote writes auditable promotion.json"

node "$TMP/inspect.cjs" "$PDIR/trust.bundle" "$TMP/shape.json"
[[ "$(field "$TMP/shape.json" found)" == "true" ]] && pass "bundle carries a promotion claim (metadata.promotion)" || fail "bundle carries a promotion claim"
[[ "$(field "$TMP/shape.json" status)" == "verified" ]] && pass "promotion claim derives status verified" || fail "promotion claim derives status verified (got $(field "$TMP/shape.json" status))"
[[ "$(field "$TMP/shape.json" evidenceType)" == "policy_rule" ]] && pass "promotion evidence is session-local policy_rule" || fail "promotion evidence is session-local policy_rule (got $(field "$TMP/shape.json" evidenceType))"
[[ "$(field "$TMP/shape.json" hasExecutionLabel)" == "false" ]] && pass "promotion claim carries no execution.label (never a manifest command)" || fail "promotion claim must not carry an execution.label"
[[ "$(field "$TMP/shape.json" targets)" == "docs/decisions/promotion-gate.md,docs/learnings/note.md" ]] && pass "promotion evidence refs = the durable doc paths written" || fail "promotion targets wrong: $(field "$TMP/shape.json" targets)"

# --- 2. promote rejects a nonexistent path -----------------------------------
if flow_agents_node workflow-sidecar promote "$PDIR" --repo-root "$REPO" \
     --evidence-path docs/decisions/does-not-exist.md \
     --timestamp "2026-07-02T00:03:00Z" >"$TMP/bad.out" 2>"$TMP/bad.err"; then
  fail "promote should reject a nonexistent evidence path"
else
  grep -q "does not exist on disk" "$TMP/bad.err" && pass "promote rejects a nonexistent evidence path (fail loud)" || fail "promote rejection message unclear: $(cat "$TMP/bad.err")"
fi

# --- 3. explicit no-residue promotion ----------------------------------------
ensure none-promoted
NDIR="$SESSION_ROOT/none-promoted"
seed_evidence "$NDIR"
if flow_agents_node workflow-sidecar promote "$NDIR" --repo-root "$REPO" \
     --none --reason "no durable residue: pure refactor" \
     --timestamp "2026-07-02T00:04:00Z" >"$TMP/none.out" 2>"$TMP/none.err"; then
  pass "promote --none --reason exits 0"
else
  fail "promote --none --reason should exit 0: $(cat "$TMP/none.err")"
fi
node "$TMP/inspect.cjs" "$NDIR/trust.bundle" "$TMP/noneshape.json"
[[ "$(field "$TMP/noneshape.json" none)" == "true" ]] && pass "no-residue claim records none=true" || fail "no-residue claim should record none=true"

if flow_agents_node workflow-sidecar promote "$NDIR" --none \
     --timestamp "2026-07-02T00:05:00Z" >"$TMP/none2.out" 2>"$TMP/none2.err"; then
  fail "promote --none without --reason should be refused"
else
  grep -q "requires --reason" "$TMP/none2.err" && pass "promote --none without --reason is refused" || fail "promote --none reason-required message unclear"
fi

# --- 4. cleanup-audit classification with/without the claim ------------------
AUDIT_ROOT="$TMP/audit-root"
mkdir -p "$AUDIT_ROOT/promoted" "$AUDIT_ROOT/none-promoted" "$AUDIT_ROOT/unpromoted"
term_state "$AUDIT_ROOT/promoted" promoted
term_state "$AUDIT_ROOT/none-promoted" none-promoted
term_state "$AUDIT_ROOT/unpromoted" unpromoted
cp "$PDIR/trust.bundle" "$AUDIT_ROOT/promoted/trust.bundle"
cp "$NDIR/trust.bundle" "$AUDIT_ROOT/none-promoted/trust.bundle"
# unpromoted: deliberately no trust.bundle

flow_agents_node workflow-artifact-cleanup-audit --artifact-root "$AUDIT_ROOT" --json > "$TMP/audit.json" 2>&1
bucketof() { node "$TMP/bucketof.cjs" "$TMP/audit.json" "$1"; }
[[ "$(bucketof promoted | cut -d'|' -f1)" == "terminal_done" ]] && pass "promoted session stays terminal_done" || fail "promoted session should be terminal_done (got $(bucketof promoted))"
[[ "$(bucketof none-promoted | cut -d'|' -f1)" == "terminal_done" ]] && pass "no-residue promoted session stays terminal_done" || fail "no-residue session should be terminal_done (got $(bucketof none-promoted))"
[[ "$(bucketof unpromoted | cut -d'|' -f1)" == "cleanup_candidate" ]] && pass "unpromoted delivered session is a cleanup_candidate (archive blocked)" || fail "unpromoted session should be cleanup_candidate (got $(bucketof unpromoted))"
bucketof unpromoted | grep -q "promote" && pass "cleanup_candidate reason names the promote remedy" || fail "cleanup_candidate reason should name the promote step"

# --- 5. CRITICAL: trust-reconcile exit 0 on a bundle with a promotion claim --
if node "$ROOT/scripts/ci/trust-reconcile.js" --bundle "$PDIR/trust.bundle" \
     --commands "true" --repo-root "$REPO" >"$TMP/reconcile.out" 2>&1; then
  pass "trust-reconcile exits 0 on a bundle carrying a promotion claim"
else
  fail "trust-reconcile should exit 0 on a promotion-claim bundle: $(tail -5 "$TMP/reconcile.out")"
fi
if grep -q "ATTESTED" "$TMP/reconcile.out" && ! grep -q "trust divergence" "$TMP/reconcile.out"; then
  pass "promotion claim classifies session-local (ATTESTED), never an unbacked/not-run command"
else
  fail "promotion claim must classify session-local, not as a command divergence"
  grep -iE "classified|ATTESTED|trust divergence" "$TMP/reconcile.out"
fi

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "Promote-then-archive gate checks passed"
else
  echo "Promote-then-archive gate checks failed: $errors"
  exit 1
fi
