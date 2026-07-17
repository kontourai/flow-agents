#!/usr/bin/env bash
# test_veritas_governance_kit.sh — Veritas Governance Kit slice 1 gate demo (agentless).
#
# Proves the kit's readiness-check flow gates a REAL `veritas readiness` verdict, projected
# into a Hachure trust.bundle by the kit adapter (kits/veritas-governance/adapter/
# readiness-to-trust-bundle.mjs):
#   POSITIVE: a ready readiness report -> verified software-readiness-verdict claim ->
#             flow evaluate exits 0 (gate passes).
#   NEGATIVE: a not-ready readiness report (injected Repo Standards violation) -> disputed
#             claim -> flow evaluate --exit-code exits 1 (gate BLOCKS, not silently passed).
#
# The two committed fixtures under kits/veritas-governance/fixtures/readiness/ are REAL,
# captured `veritas readiness --check evidence --working-tree` evidence reports (ready = a
# clean checkout of kontourai/veritas; not-ready = the same tree with a required CLI artifact
# deleted, a Require-enforcement violation). When a Veritas binary is resolvable (VERITAS_BIN,
# or `veritas` on PATH) AND VERITAS_GOVERNED_REPO points at a Veritas-governed repo, the eval
# ALSO runs Veritas live and re-derives both paths; otherwise it prints SKIP for the live leg
# and relies on the captured real-output fixtures (deterministic in CI).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

errors=0
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

KIT="$ROOT/kits/veritas-governance"
ADAPTER="$KIT/adapter/readiness-to-trust-bundle.mjs"
FLOWDEF="$KIT/flows/readiness-check.flow.json"
FLOW_CLI="$ROOT/node_modules/@kontourai/flow/dist/cli.js"

echo "=== Veritas Governance Kit — slice 1 gate demo ==="

# --- Kit container is K0-valid --------------------------------------------------
if node "$FLOW_CLI" kit validate "$KIT" >"$TMP_DIR/kitval.out" 2>&1; then
  pass "kit container validates (flow kit validate)"
else
  fail "kit container failed validation"; sed -n '1,40p' "$TMP_DIR/kitval.out"
fi

# --- No-fork: kit does not vendor/reimplement Veritas rule/claim evaluation ------
# Scope to kit SOURCE (adapter + flows), not fixtures/ — the fixtures are real Veritas
# OUTPUT and legitimately embed Veritas rule ids and check labels.
if rg -q -i 'evaluateRepoStandards|evidence-check-runner\.mjs|class +[A-Za-z]*RuleEngine|repo-standards/default\.repo-standards\.json' "$KIT/adapter" "$KIT/flows" 2>/dev/null; then
  fail "kit source appears to vendor/reimplement Veritas evaluation logic (no-fork violated)"
else
  pass "no-fork: kit source references Veritas recorded output only (no vendored rule/claim engine)"
fi

# --- Gate one readiness fixture; assert the expected evaluate exit code ----------
# $1 fixture path, $2 label, $3 expected exit (0=pass, 1=block)
gate_case() {
  local fixture="$1" label="$2" expect="$3"
  local work="$TMP_DIR/$label"; mkdir -p "$work"; ( cd "$work" && node "$FLOW_CLI" init >/dev/null 2>&1 )
  local bundle="$work/readiness.bundle"
  if ! node "$ADAPTER" --report "$fixture" --out "$bundle" >"$work/adapter.out" 2>&1; then
    fail "[$label] adapter failed to project readiness report"; sed -n '1,20p' "$work/adapter.out"; return
  fi
  ( cd "$work" && node "$FLOW_CLI" start "$FLOWDEF" --run-id "$label" >/dev/null 2>&1 )
  ( cd "$work" && node "$FLOW_CLI" attach-evidence "$label" --gate gate-check-gate --file "$bundle" --bundle >"$work/attach.out" 2>&1 )
  if ! rg -q 'kind: trust.bundle' "$work/attach.out"; then
    fail "[$label] evidence did not attach as kind: trust.bundle"; sed -n '1,20p' "$work/attach.out"; return
  fi
  ( cd "$work" && node "$FLOW_CLI" evaluate "$label" --gate gate-check-gate --exit-code >"$work/eval.out" 2>&1 )
  local got=$?
  if [[ "$got" == "$expect" ]]; then
    pass "[$label] gate evaluate exit $got as expected ($(rg -o '^(pass|block|route-back) gate-check-gate.*' "$work/eval.out" | head -1))"
  else
    fail "[$label] gate evaluate exit $got, expected $expect"; sed -n '1,20p' "$work/eval.out"
  fi
}

echo "--- captured real-veritas-output fixtures ---"
gate_case "$KIT/fixtures/readiness/ready.readiness-report.json"     "positive" 0
gate_case "$KIT/fixtures/readiness/not-ready.readiness-report.json" "negative" 1

# --- exemption-issuance flow: registration/K0 validity ---------------------------
EXEMPTION_FLOWDEF="$KIT/flows/exemption-issuance.flow.json"
if node -e "const f=require('$EXEMPTION_FLOWDEF'); if(f.id!=='veritas-governance.exemption-issuance') process.exit(1);" 2>/dev/null; then
  pass "exemption-issuance flow file has id veritas-governance.exemption-issuance"
else
  fail "exemption-issuance flow file missing or has unexpected id"
fi
if rg -q '"id": *"veritas-governance\.exemption-issuance"' "$KIT/kit.json" && rg -q '"path": *"flows/exemption-issuance\.flow\.json"' "$KIT/kit.json"; then
  pass "exemption-issuance flow is registered in kit.json flows[]"
else
  fail "exemption-issuance flow is NOT registered in kit.json flows[]"
fi
# Re-run the whole-kit container validation (already covers the new flow file too, since
# `flow kit validate` walks every flows[] entry) — a second explicit assertion, scoped to
# this flow's own gate shape, per AC2.
if node -e "
const f=require('$EXEMPTION_FLOWDEF');
const g=Object.values(f.gates)[0];
const bc=g.expects[0].bundle_claim;
if (g.expects[0].kind!=='trust.bundle') process.exit(1);
if (bc.claimType!=='no-agent-delivery-exemption-approval') process.exit(1);
if (bc.subjectType!=='delivery-scope') process.exit(1);
if (JSON.stringify(bc.accepted_statuses)!=='[\"verified\"]') process.exit(1);
" 2>/dev/null; then
  pass "exemption-issuance gate expects[] kind is trust.bundle and pins claimType/subjectType/accepted_statuses exactly"
else
  fail "exemption-issuance gate expects[] shape does not match the pinned claim selector"
fi

# --- exemption-issuance flow: positive/negative gate cases (AC3) -----------------
# gate_case() above is readiness-check-specific (drives the readiness adapter + fixed gate
# id gate-check-gate). The exemption-issuance flow has no adapter (issue's Files list does
# not add one — the approval bundle is hand-authored/fixture-authored) and a different gate
# id, so it gets its own small helper.
# $1 bundle fixture path, $2 label, $3 expected exit (0=pass, 1=block)
exemption_gate_case() {
  local bundle="$1" label="$2" expect="$3"
  local work="$TMP_DIR/$label"; mkdir -p "$work"; ( cd "$work" && node "$FLOW_CLI" init >/dev/null 2>&1 )
  ( cd "$work" && node "$FLOW_CLI" start "$EXEMPTION_FLOWDEF" --run-id "$label" >/dev/null 2>&1 )
  ( cd "$work" && node "$FLOW_CLI" attach-evidence "$label" --gate human-approval-gate --file "$bundle" --bundle >"$work/attach.out" 2>&1 )
  if ! rg -q 'kind: trust.bundle' "$work/attach.out"; then
    fail "[$label] evidence did not attach as kind: trust.bundle"; sed -n '1,20p' "$work/attach.out"; return
  fi
  ( cd "$work" && node "$FLOW_CLI" evaluate "$label" --gate human-approval-gate --exit-code >"$work/eval.out" 2>&1 )
  local got=$?
  if [[ "$got" == "$expect" ]]; then
    pass "[$label] exemption-issuance gate evaluate exit $got as expected ($(rg -o '^(pass|block|route-back) human-approval-gate.*' "$work/eval.out" | head -1))"
  else
    fail "[$label] exemption-issuance gate evaluate exit $got, expected $expect"; sed -n '1,20p' "$work/eval.out"
  fi
}

echo "--- exemption-issuance: gate blocks without a verified approval, passes with one ---"
exemption_gate_case "$KIT/fixtures/exemption/approved.trust-bundle.json"     "exemption-positive" 0
exemption_gate_case "$KIT/fixtures/exemption/not-approved.trust-bundle.json" "exemption-negative" 1

# --- standards-authoring flow (Slice 2 PR3): registration, gate shape, gate cases ---
# Agentless propose -> apply flow whose human-approval-gate blocks the `veritas init --apply`
# write until a human-authored standards-authoring-approval claim is verified. The kit only
# gates the sign-off; Veritas does the derivation and the write (no evaluation reimplemented).
AUTHORING_FLOWDEF="$KIT/flows/standards-authoring.flow.json"
if node -e "const f=require('$AUTHORING_FLOWDEF'); if(f.id!=='veritas-governance.standards-authoring') process.exit(1);" 2>/dev/null; then
  pass "standards-authoring flow file has id veritas-governance.standards-authoring"
else
  fail "standards-authoring flow file missing or has unexpected id"
fi
if rg -q '"id": *"veritas-governance\.standards-authoring"' "$KIT/kit.json" && rg -q '"path": *"flows/standards-authoring\.flow\.json"' "$KIT/kit.json"; then
  pass "standards-authoring flow is registered in kit.json flows[]"
else
  fail "standards-authoring flow is NOT registered in kit.json flows[]"
fi
if rg -q '"id": *"veritas-governance\.standards-authoring"' "$KIT/kit.json" && rg -q '"path": *"skills/standards-authoring/SKILL.md"' "$KIT/kit.json"; then
  pass "standards-authoring skill is registered in kit.json skills[]"
else
  fail "standards-authoring skill is NOT registered in kit.json skills[]"
fi
# Agentless invariant: the kit declares no flow_step_actions (would opt into Builder's
# producer-ownership contract and break the agentless gate flows).
if rg -q 'flow_step_actions' "$KIT/kit.json"; then
  fail "kit.json declares flow_step_actions — veritas-governance flows are agentless"
else
  pass "kit stays agentless (no flow_step_actions)"
fi
if node -e "
const f=require('$AUTHORING_FLOWDEF');
const g=f.gates['human-approval-gate'];
const bc=g.expects[0].bundle_claim;
if (g.expects[0].kind!=='trust.bundle') process.exit(1);
if (bc.claimType!=='standards-authoring-approval') process.exit(1);
if (bc.subjectType!=='repo-governance-change') process.exit(1);
if (JSON.stringify(bc.accepted_statuses)!=='[\"verified\"]') process.exit(1);
" 2>/dev/null; then
  pass "standards-authoring gate expects[] kind is trust.bundle and pins claimType/subjectType/accepted_statuses exactly"
else
  fail "standards-authoring gate expects[] shape does not match the pinned claim selector"
fi
# Positive/negative gate cases against the committed fixtures. $1 bundle, $2 label, $3 expect.
authoring_gate_case() {
  local bundle="$1" label="$2" expect="$3"
  local work="$TMP_DIR/$label"; mkdir -p "$work"; ( cd "$work" && node "$FLOW_CLI" init >/dev/null 2>&1 )
  ( cd "$work" && node "$FLOW_CLI" start "$AUTHORING_FLOWDEF" --run-id "$label" >/dev/null 2>&1 )
  ( cd "$work" && node "$FLOW_CLI" attach-evidence "$label" --gate human-approval-gate --file "$bundle" --bundle >"$work/attach.out" 2>&1 )
  if ! rg -q 'kind: trust.bundle' "$work/attach.out"; then
    fail "[$label] evidence did not attach as kind: trust.bundle"; sed -n '1,20p' "$work/attach.out"; return
  fi
  ( cd "$work" && node "$FLOW_CLI" evaluate "$label" --gate human-approval-gate --exit-code >"$work/eval.out" 2>&1 )
  local got=$?
  if [[ "$got" == "$expect" ]]; then
    pass "[$label] standards-authoring gate evaluate exit $got as expected"
  else
    fail "[$label] standards-authoring gate evaluate exit $got, expected $expect"; sed -n '1,20p' "$work/eval.out"
  fi
}
authoring_gate_case "$KIT/fixtures/standards-authoring/approved.trust-bundle.json"     "authoring-positive" 0
authoring_gate_case "$KIT/fixtures/standards-authoring/not-approved.trust-bundle.json" "authoring-negative" 1
# No-fork: the authoring skill wraps the veritas CLI; it must not vendor rule/claim evaluation.
if rg -q -i 'evaluateRepoStandards|evidence-check-runner\.mjs|class +[A-Za-z]*RuleEngine|repo-standards/default\.repo-standards\.json' "$KIT/skills/standards-authoring" "$KIT/flows/standards-authoring.flow.json" 2>/dev/null; then
  fail "standards-authoring skill/flow appears to vendor Veritas evaluation logic (no-fork violated)"
else
  pass "no-fork: standards-authoring wraps the veritas CLI, no vendored rule/claim engine"
fi

# --- exemption-issuance: issue-step DECLARED append semantics (AC4) --------------
# Seed a scratch delivery/DECLARED with main's real 2-entry array (inlined here, not read
# live from the repo, so this eval is not coupled to that file's future contents), then
# simulate the issue step's write: append a third, well-formed entry. Assert append, not
# clobber: length 3, and the first two entries byte-identical pre/post.
echo "--- exemption-issuance: issue step appends to delivery/DECLARED, does not clobber ---"
DECLARED_WORK="$TMP_DIR/declared-append"
mkdir -p "$DECLARED_WORK/delivery"
SEEDED_DECLARED='[
  {
    "scope": "author:dependabot[bot]",
    "reason": "dependabot dependency-update PRs; no agent delivery involved",
    "approved_by": "brian.anderson1222 (AC8 option-a decision, ADR 0022 approval 2026-07-02)",
    "declared_at": "2026-07-03T16:27:21Z"
  },
  {
    "scope": "author:github-actions[bot] branch-prefix:release-please--",
    "reason": "release-please automation PR; no agent delivery involved",
    "approved_by": "brian.anderson1222 (AC8 option-a decision, ADR 0022 approval 2026-07-02)",
    "declared_at": "2026-07-03T16:27:21Z"
  }
]'
printf '%s' "$SEEDED_DECLARED" > "$DECLARED_WORK/delivery/DECLARED.seed"

NEW_ENTRY_SCOPE="author:exemption-eval-bot[bot]"
NEW_ENTRY_ACTOR="exemption-eval-bot[bot]"
NEW_ENTRY_REASON="exemption-issuance eval: no-agent-delivery exemption for a test bot scope"
NEW_ENTRY_APPROVED_BY="eval-fixture-approver (exemption-issuance flow)"
NEW_ENTRY_DECLARED_AT="2026-07-01T00:00:00Z"

# Simulate the issue step: read-modify-write (parse the existing array, append one entry).
node -e "
const fs = require('fs');
const seedPath = '$DECLARED_WORK/delivery/DECLARED.seed';
const outPath = '$DECLARED_WORK/delivery/DECLARED';
const existing = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
const appended = existing.concat([{
  scope: '$NEW_ENTRY_SCOPE',
  reason: '$NEW_ENTRY_REASON',
  approved_by: '$NEW_ENTRY_APPROVED_BY',
  declared_at: '$NEW_ENTRY_DECLARED_AT'
}]);
fs.writeFileSync(outPath, JSON.stringify(appended, null, 2) + '\n');
"

if node -e "
const fs = require('fs');
const seeded = JSON.parse(fs.readFileSync('$DECLARED_WORK/delivery/DECLARED.seed', 'utf8'));
const appended = JSON.parse(fs.readFileSync('$DECLARED_WORK/delivery/DECLARED', 'utf8'));
if (!Array.isArray(appended) || appended.length !== 3) process.exit(1);
if (JSON.stringify(appended[0]) !== JSON.stringify(seeded[0])) process.exit(1);
if (JSON.stringify(appended[1]) !== JSON.stringify(seeded[1])) process.exit(1);
"; then
  pass "issue-step append: 3 entries present, first two byte-identical to the seeded 2-entry array (append, not clobber)"
else
  fail "issue-step append: entry count or pre-existing entries diverged from the seeded array"
fi

if node -e "
const fs = require('fs');
const appended = JSON.parse(fs.readFileSync('$DECLARED_WORK/delivery/DECLARED', 'utf8'));
const entry = appended[2];
const required = ['scope', 'reason', 'approved_by', 'declared_at'];
for (const f of required) {
  if (typeof entry[f] !== 'string' || entry[f].trim() === '') process.exit(1);
}
"; then
  pass "issue-step append: appended entry is well-formed (scope/reason/approved_by/declared_at all present, non-empty)"
else
  fail "issue-step append: appended entry is missing/empty a required field"
fi

# --- exemption-issuance: REAL trust-reconcile.js reads the appended marker (AC5) -
# Reuse test_trust_reconcile_negatives.sh section 7's write_declared/env-override pattern:
# TRUST_RECONCILE_COMMANDS is a trivial pass so Step 1 always succeeds; TRUST_RECONCILE_ACTOR
# is set to match the appended entry's author: scope exactly (the bare actor name, without
# the "author:" prefix, matching matchesScope()'s author: condition contract).
echo "--- exemption-issuance: REAL trust-reconcile.js reads the appended marker as well-formed and in-scope ---"
RECONCILE="$ROOT/scripts/ci/trust-reconcile.js"
RECONCILE_CMD="node -e 'process.exit(0)'"

reconcile_out="$(TRUST_RECONCILE_ACTOR="$NEW_ENTRY_ACTOR" TRUST_RECONCILE_COMMANDS="$RECONCILE_CMD" \
  node "$RECONCILE" --repo-root "$DECLARED_WORK" 2>&1)"
reconcile_code=$?
if [[ "$reconcile_code" -eq 0 ]]; then
  pass "trust-reconcile.js exits 0 against the appended 3-entry delivery/DECLARED (in-scope match)"
else
  fail "trust-reconcile.js expected exit 0, got $reconcile_code — output: $reconcile_out"
fi
if echo "$reconcile_out" | grep -qF "DECLARED (no-agent-delivery): $NEW_ENTRY_SCOPE — $NEW_ENTRY_REASON (approved by $NEW_ENTRY_APPROVED_BY, declared $NEW_ENTRY_DECLARED_AT)"; then
  pass "trust-reconcile.js emits the exact DECLARED (no-agent-delivery) line for the appended entry"
else
  fail "trust-reconcile.js did not emit the expected DECLARED (no-agent-delivery) line — output: $reconcile_out"
fi

# --- exemption-issuance: negative — malformed/out-of-scope append still fails closed (AC6) --
# This case's DECLARED file has the two pre-existing WELL-FORMED entries (dependabot,
# release-please) plus a malformed appended (third) entry (missing approved_by). The
# malformed entry is excluded from parseDeclaredMarker()'s wellFormed[] bucket entirely (its
# "missing required field(s)" line is only a non-fatal stderr warning, logged so one bad
# entry cannot silently mask a good one -- see resolveDeclaredExemption()); scope-matching
# then proceeds against the two remaining well-formed entries, neither of which matches this
# case's TRUST_RECONCILE_ACTOR context, so the FATAL diagnostic that actually fires is the
# scope-mismatch path, not the missing-field path. This proves: a malformed appended entry
# is ignored as an entry (does not itself exempt Step 2), and with no other in-scope
# well-formed entry present, the reconciler still fails closed overall.
echo "--- exemption-issuance: malformed appended entry is ignored; no in-scope entry remains -> fails closed ---"
DECLARED_NEG_WORK="$TMP_DIR/declared-append-negative"
mkdir -p "$DECLARED_NEG_WORK/delivery"
# Same seed, but the appended (third) entry is missing approved_by — malformed.
SEEDED_DECLARED_JSON="$SEEDED_DECLARED" NEW_ENTRY_SCOPE="$NEW_ENTRY_SCOPE" NEW_ENTRY_REASON="$NEW_ENTRY_REASON" NEW_ENTRY_DECLARED_AT="$NEW_ENTRY_DECLARED_AT" OUT_PATH="$DECLARED_NEG_WORK/delivery/DECLARED" node -e "
const fs = require('fs');
const existing = JSON.parse(process.env.SEEDED_DECLARED_JSON);
const appended = existing.concat([{
  scope: process.env.NEW_ENTRY_SCOPE,
  reason: process.env.NEW_ENTRY_REASON,
  declared_at: process.env.NEW_ENTRY_DECLARED_AT
}]);
fs.writeFileSync(process.env.OUT_PATH, JSON.stringify(appended, null, 2) + '\n');
"
neg_out="$(TRUST_RECONCILE_ACTOR="$NEW_ENTRY_ACTOR" TRUST_RECONCILE_COMMANDS="$RECONCILE_CMD" \
  node "$RECONCILE" --repo-root "$DECLARED_NEG_WORK" 2>&1)"
neg_code=$?
if [[ "$neg_code" -ne 0 ]]; then
  pass "trust-reconcile.js fails closed ($neg_code): malformed appended entry ignored, no in-scope well-formed entry remains"
else
  fail "trust-reconcile.js expected non-zero exit on a malformed appended entry, got 0 — output: $neg_out"
fi
if echo "$neg_out" | grep -qF "[bundle-required-no-declared-marker] delivery/DECLARED marker present but out of scope for this change"; then
  pass "trust-reconcile.js's FATAL diagnostic is the out-of-scope path (the malformed entry itself never satisfies the gate)"
else
  fail "trust-reconcile.js did not emit the expected out-of-scope FATAL diagnostic — output: $neg_out"
fi

# Companion variant (true missing-field proof): a DECLARED file whose ONLY entry is the
# malformed one (no other well-formed entry to fall through to) — here the FATAL diagnostic
# IS the malformed/missing-field path itself, naming approved_by, per the merged reconciler's
# exact string (resolveDeclaredExemption(), wellFormed.length === 0 branch).
echo "--- exemption-issuance: DECLARED file with ONLY a malformed entry -> the missing-field diagnostic itself is fatal ---"
DECLARED_ONLY_MALFORMED_WORK="$TMP_DIR/declared-only-malformed"
mkdir -p "$DECLARED_ONLY_MALFORMED_WORK/delivery"
NEW_ENTRY_SCOPE="$NEW_ENTRY_SCOPE" NEW_ENTRY_REASON="$NEW_ENTRY_REASON" NEW_ENTRY_DECLARED_AT="$NEW_ENTRY_DECLARED_AT" OUT_PATH="$DECLARED_ONLY_MALFORMED_WORK/delivery/DECLARED" node -e "
const fs = require('fs');
const onlyEntry = [{
  scope: process.env.NEW_ENTRY_SCOPE,
  reason: process.env.NEW_ENTRY_REASON,
  declared_at: process.env.NEW_ENTRY_DECLARED_AT
}];
fs.writeFileSync(process.env.OUT_PATH, JSON.stringify(onlyEntry, null, 2) + '\n');
"
only_malformed_out="$(TRUST_RECONCILE_ACTOR="$NEW_ENTRY_ACTOR" TRUST_RECONCILE_COMMANDS="$RECONCILE_CMD" \
  node "$RECONCILE" --repo-root "$DECLARED_ONLY_MALFORMED_WORK" 2>&1)"
only_malformed_code=$?
if [[ "$only_malformed_code" -ne 0 ]]; then
  pass "trust-reconcile.js fails closed ($only_malformed_code) when DECLARED's only entry is malformed"
else
  fail "trust-reconcile.js expected non-zero exit when DECLARED's only entry is malformed, got 0 — output: $only_malformed_out"
fi
if echo "$only_malformed_out" | grep -qF "[bundle-required-no-declared-marker] delivery/DECLARED marker is malformed: missing required field(s) [approved_by]"; then
  pass "trust-reconcile.js's FATAL diagnostic IS the missing-field path, naming approved_by (true missing-field proof)"
else
  fail "trust-reconcile.js did not emit the expected FATAL missing-field diagnostic naming approved_by — output: $only_malformed_out"
fi

# Second negative variant: well-formed but out-of-scope append (resolved context does not
# match the new entry's scope) — proves scope-mismatch also fails closed, not just malformed
# fields.
DECLARED_NEG_SCOPE_WORK="$TMP_DIR/declared-append-out-of-scope"
mkdir -p "$DECLARED_NEG_SCOPE_WORK/delivery"
SEEDED_DECLARED_JSON="$SEEDED_DECLARED" NEW_ENTRY_SCOPE="$NEW_ENTRY_SCOPE" NEW_ENTRY_REASON="$NEW_ENTRY_REASON" NEW_ENTRY_APPROVED_BY="$NEW_ENTRY_APPROVED_BY" NEW_ENTRY_DECLARED_AT="$NEW_ENTRY_DECLARED_AT" OUT_PATH="$DECLARED_NEG_SCOPE_WORK/delivery/DECLARED" node -e "
const fs = require('fs');
const existing = JSON.parse(process.env.SEEDED_DECLARED_JSON);
const appended = existing.concat([{
  scope: process.env.NEW_ENTRY_SCOPE,
  reason: process.env.NEW_ENTRY_REASON,
  approved_by: process.env.NEW_ENTRY_APPROVED_BY,
  declared_at: process.env.NEW_ENTRY_DECLARED_AT
}]);
fs.writeFileSync(process.env.OUT_PATH, JSON.stringify(appended, null, 2) + '\n');
"
neg_scope_out="$(TRUST_RECONCILE_ACTOR="not-the-right-actor[bot]" TRUST_RECONCILE_COMMANDS="$RECONCILE_CMD" \
  node "$RECONCILE" --repo-root "$DECLARED_NEG_SCOPE_WORK" 2>&1)"
neg_scope_code=$?
if [[ "$neg_scope_code" -ne 0 ]]; then
  pass "trust-reconcile.js fails closed ($neg_scope_code) when the resolved context does not match the appended entry's scope"
else
  fail "trust-reconcile.js expected non-zero exit for an out-of-scope append, got 0 — output: $neg_scope_out"
fi
if echo "$neg_scope_out" | grep -qF "out of scope" || echo "$neg_scope_out" | grep -qF "bundle-required-no-declared-marker"; then
  pass "trust-reconcile.js emits 'out of scope' or 'bundle-required-no-declared-marker' for the out-of-scope append"
else
  fail "trust-reconcile.js did not emit the expected out-of-scope diagnostic — output: $neg_scope_out"
fi

# --- exemption-issuance: no-fork check, specific to this task's new assets (AC8) -
if grep -rn "veritas-governance" "$ROOT/scripts/ci/trust-reconcile.js" >/dev/null 2>&1; then
  fail "scripts/ci/trust-reconcile.js references kits/veritas-governance (no-fork/layering violated)"
else
  pass "no-fork: scripts/ci/trust-reconcile.js has zero references to veritas-governance (anchor stays kit-agnostic)"
fi

# --- Optional live Veritas leg --------------------------------------------------
VBIN="${VERITAS_BIN:-veritas}"
if command -v "$VBIN" >/dev/null 2>&1 && [[ -n "${VERITAS_GOVERNED_REPO:-}" && -d "${VERITAS_GOVERNED_REPO:-}/.veritas" ]]; then
  echo "--- live Veritas leg (VERITAS_GOVERNED_REPO=$VERITAS_GOVERNED_REPO) ---"
  live="$TMP_DIR/live"; mkdir -p "$live"
  rsync -a --exclude .git --exclude node_modules --exclude .kontourai "$VERITAS_GOVERNED_REPO/" "$live/repo/" >/dev/null 2>&1
  ln -s "$VERITAS_GOVERNED_REPO/node_modules" "$live/repo/node_modules" 2>/dev/null || true
  # `veritas readiness --working-tree` diffs against git; the copy needs its own git repo.
  ( cd "$live/repo" && git init -q && git add -A && git -c user.email=eval@local -c user.name=eval commit -qm baseline ) >/dev/null 2>&1
  # live-positive: clean tree
  ( cd "$live/repo" && "$VBIN" readiness --check evidence --working-tree >/dev/null 2>&1 )
  live_rep="$(ls -t "$live/repo/.kontourai/veritas/evidence/"*.json 2>/dev/null | head -1)"
  if [[ -n "$live_rep" ]]; then
    gate_case "$live_rep" "live-positive" 0
  else
    fail "live Veritas clean run produced no evidence report"
  fi
  # live-negative: inject a Require-enforcement violation (delete a required CLI artifact)
  rm -f "$live/repo/bin/veritas-report.mjs"
  ( cd "$live/repo" && "$VBIN" readiness --check evidence --working-tree >/dev/null 2>&1 )
  live_neg="$(ls -t "$live/repo/.kontourai/veritas/evidence/"*.json 2>/dev/null | head -1)"
  if [[ -n "$live_neg" && "$live_neg" != "$live_rep" ]]; then
    gate_case "$live_neg" "live-negative" 1
  else
    fail "live Veritas injected-violation run produced no fresh evidence report"
  fi
else
  echo "  - SKIP live Veritas leg (set VERITAS_BIN + VERITAS_GOVERNED_REPO to enable); fixtures are captured real output"
fi

# --- Starter-standards provisioning (Slice 2 PR2): the kit scaffolds a runnable .veritas/ ---
# The kit declares its starter Repo Standards as provisions[]; `kit provision` copies them into
# a consumer repo. This asserts the scaffold lands and is well-formed; when a Veritas binary is
# available it further asserts `veritas readiness` runs end-to-end against the scaffolded repo.
echo "--- starter-standards provisioning ---"
FA_CLI="$ROOT/build/src/cli.js"
if [[ ! -f "$FA_CLI" ]]; then
  fail "flow-agents CLI not built at build/src/cli.js (run npm run build)"
else
  prov="$TMP_DIR/provisioned-repo"; mkdir -p "$prov"
  if node "$FA_CLI" kit provision "$KIT" --target "$prov" >"$TMP_DIR/provision.out" 2>&1; then
    pass "kit provision scaffolds starter standards into a consumer repo"
  else
    fail "kit provision failed"; sed -n '1,20p' "$TMP_DIR/provision.out"
  fi
  # Every declared provision target must land and (for JSON) parse.
  starter_targets=(
    ".veritas/repo-map.json"
    ".veritas/repo-standards/default.repo-standards.json"
    ".veritas/authority/default.authority-settings.json"
    ".veritas/GOVERNANCE.md"
    ".veritas/README.md"
    "veritas.claims.json"
  )
  for rel in "${starter_targets[@]}"; do
    if [[ -f "$prov/$rel" ]]; then
      if [[ "$rel" == *.json ]]; then
        if node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$prov/$rel" >/dev/null 2>&1; then
          pass "scaffolded $rel is present and valid JSON"
        else
          fail "scaffolded $rel is not valid JSON"
        fi
      else
        pass "scaffolded $rel is present"
      fi
    else
      fail "expected scaffolded file missing: $rel"
    fi
  done
  # The scaffold must reference the Veritas engine's OWN starter output, not reimplement it:
  # every provision source lives under assets/, never in adapter/ or flows/ (no-fork already
  # scopes there). Assert the declared sources exist inside the kit's assets tree.
  if node -e "
    const fs=require('fs'),path=require('path');
    const kit=JSON.parse(fs.readFileSync(process.argv[1]+'/kit.json','utf8'));
    const bad=(kit.provisions||[]).filter(p=>!p.path.startsWith('assets/')||!fs.existsSync(path.join(process.argv[1],p.path)));
    if(bad.length){console.error('bad provisions:',bad.map(p=>p.id).join(','));process.exit(1)}
  " "$KIT" >/dev/null 2>&1; then
    pass "all starter provisions source from the kit's assets/ tree"
  else
    fail "a starter provision points outside assets/ or at a missing file"
  fi
  # Live: a Veritas binary must be able to run readiness against the scaffolded repo.
  VBIN2="${VERITAS_BIN:-veritas}"
  if command -v "$VBIN2" >/dev/null 2>&1 || [[ -x "$VBIN2" ]]; then
    ( cd "$prov" && git init -q && printf '{"name":"scaffold-eval","scripts":{"test":"node -e \"process.exit(0)\""}}\n' > package.json \
        && git add -A && git -c user.email=eval@local -c user.name=eval commit -qm scaffold ) >/dev/null 2>&1
    if ( cd "$prov" && "$VBIN2" readiness --working-tree >/dev/null 2>&1 ); then :; fi
    if ls "$prov/.kontourai/veritas/evidence/"*.json >/dev/null 2>&1; then
      pass "veritas readiness runs end-to-end on the kit-scaffolded repo (evidence report produced)"
    else
      fail "veritas readiness produced no evidence report on the scaffolded repo"
    fi
  else
    echo "  - SKIP scaffold readiness leg (no Veritas binary; set VERITAS_BIN to enable)"
  fi
fi

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "PASS: veritas-governance kit gate demo (positive passes, negative blocks)"
  exit 0
else
  echo "FAIL: $errors check(s) failed"
  exit 1
fi
