#!/usr/bin/env bash
# test_trust_reconcile_negatives.sh — WS8 iteration-2 anti-gaming negative regressions.
#
# Every live exploit the reviewer/verifier reproduced against the WS8 reconciler is frozen
# here as a permanent negative fixture. Each asserts the REAL scripts/ci/trust-reconcile.js
# exits NON-ZERO and emits the SPECIFIC divergence string the fix introduced. If any fix is
# ever regressed, the corresponding exploit passes again and this eval (which runs in the
# required runtime-and-kit lane via antigaming-suite.sh) goes red.
#
#   1. no-label-bypass       (finding 1) → not-run: a test_output claim with no
#      manifest-matched execution.label is a divergence, never session-local.
#   2. mcp-degrade           (issue 492) → not-run: an MCP-shaped execution.label is not a
#      manifest command and can never be RECONCILED as a CI-verified command check.
#   3. skip-assumed-bypass   (finding 2) → unwaived-assumed: 'assumed' alone is not a pass.
#   4. status-misassertion   (finding 3) → status-misassertion: CI re-derives status; a
#      self-reported status that does not match the bundle's own evidence is rejected.
#   5. waived-command-check  (finding 4) → waiver-on-command-check: a command-backed
#      (test_output) check cannot be waived.
#   6. ws3-old-style-bundle  (AC6) → old all-test_output bundle FAILS the same way (exit 1,
#      divergences) under the new reconciler as under the old one — no soundness regression.
#   7. fabricated-attestation (iteration-4, converged iteration-3 finding, both gates) → a
#      fully self-consistent, hand-fabricated no-command 'security' claim+evidence+event
#      triple (indistinguishable from a genuine attestation at the reconciler's own
#      re-derivation layer) MUST still pass (exit 0 — blocking attestations at L0 would break
#      every honest human-attestation use) BUT MUST be loudly, distinctly marked
#      'ATTESTED (not independently verifiable at L0)' plus the summary count line — never a
#      quiet SESSION-LOCAL OK indistinguishable from a reconciled check. See ADR 0020 Residuals.
#   8. delivery/DECLARED marker regressions (ADR 0022 §1/§2, section 7 below) — bundle-absent
#      fail-closed default, malformed/empty-array/missing-field diagnostics, and all four
#      matchesScope() forms (ref:, commit: single + range, author:, branch-prefix:) including
#      positive AND near-miss coverage, plus the compound (space-separated AND) scope form a
#      security review added: ref:/branch-prefix: alone match GITHUB_HEAD_REF, which is
#      PUSHER-CONTROLLED on a fork PR, so an identity-binding scope MUST combine author: with
#      a second condition — 7l/7m prove both-match exempts and only-one-match still fails
#      closed.
#
# Fresh-verify (Step 1) is a trivial pass so the proof is focused on the reconcile step; the
# manifest resolves from this repo's live run-baseline.sh registry (--repo-root "$ROOT").
# Deterministic, no model spend, self-cleaning.
# Usage: bash evals/integration/test_trust_reconcile_negatives.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"
RECONCILE="$ROOT/scripts/ci/trust-reconcile.js"
FX="$ROOT/evals/fixtures/trust-reconcile-exploits"
WS3="$ROOT/evals/fixtures/trust-reconcile-ws3/ws3-bundle.json"

errors=0
_pass() { echo "  PASS: $1"; }
_fail() { echo "  FAIL: $1"; errors=$((errors + 1)); }

# run_case <label> <bundle> <needle> [forbidden]
# Asserts: reconciler exits non-zero, stdout/stderr contains <needle>, and optionally does
# NOT contain <forbidden>.
run_case() {
  local label="$1" bundle="$2" needle="$3"
  local forbidden="${4:-}"
  echo "=== $label ==="
  if [[ ! -f "$bundle" ]]; then _fail "$label: fixture not found at $bundle"; return; fi
  local out code
  out="$(TRUST_RECONCILE_COMMANDS="node -e 'process.exit(0)'" \
    node "$RECONCILE" --bundle "$bundle" --repo-root "$ROOT" 2>&1)"
  code=$?
  if [[ $code -ne 0 ]]; then
    _pass "$label: reconciler exits non-zero ($code)"
  else
    _fail "$label: expected non-zero exit, got 0 — output: $out"
  fi
  if echo "$out" | grep -qF "$needle"; then
    _pass "$label: emitted the expected divergence (\"$needle\")"
  else
    _fail "$label: expected divergence \"$needle\" not found — output: $out"
  fi
  if [[ -n "$forbidden" ]]; then
    if echo "$out" | grep -qF "$forbidden"; then
      _fail "$label: must NOT emit \"$forbidden\" — output: $out"
    else
      _pass "$label: does not emit \"$forbidden\""
    fi
  fi
}

# 1. Reviewer's no-label exploit → not-run (test_output must reconcile against the manifest).
run_case "no-label-bypass (finding 1)" "$FX/no-label-bypass.json" \
  "no manifest-matched execution.label"

# 2. Issue #492: MCP-shaped self-reported pass → not-run (not manifest-matched), never
#    RECONCILED as a CI-verified command check.
run_case "mcp-degrade (issue 492)" "$FX/mcp-degrade.json" \
  "command is not in the reconcile manifest" \
  "RECONCILED"

# 3. Verifier's skip->assumed exploit → unwaived-assumed.
run_case "skip-assumed-bypass (finding 2)" "$FX/skip-assumed-bypass.json" \
  "[unwaived-assumed]"

# 4. Status-misassertion exploit → status re-derived CI-side; asserted != derived.
run_case "status-misassertion (finding 3)" "$FX/status-misassertion.json" \
  "[status-misassertion]"

# 5. Waived command-backed check → waiver-on-command-check.
run_case "waived-command-check (finding 4)" "$FX/waived-command-check.json" \
  "[waiver-on-command-check]"

# 6. AC6 backward-compat regression: the real ws3-kit-dependencies-namespacing/trust.bundle
#    (an old-style all-test_output bundle whose commands are not manifest-matched) FAILS the
#    same way under the new reconciler as under the old one — same FAIL verdict, divergences
#    present, no silent pass introduced.
echo "=== ws3 old-style bundle (AC6 backward compat) ==="
if [[ ! -f "$WS3" ]]; then
  _fail "ws3 fixture not found at $WS3"
else
  ws3_out="$(TRUST_RECONCILE_COMMANDS="node -e 'process.exit(0)'" \
    node "$RECONCILE" --bundle "$WS3" --repo-root "$ROOT" 2>&1)"
  ws3_code=$?
  if [[ $ws3_code -ne 0 ]]; then
    _pass "ws3 old-style bundle FAILS (exit $ws3_code) — same verdict as the old reconciler"
  else
    _fail "ws3 old-style bundle expected non-zero exit, got 0 — output: $ws3_out"
  fi
  if echo "$ws3_out" | grep -qF "[not-run]"; then
    _pass "ws3 old-style bundle emits a not-run divergence (its test_output commands are not manifest-matched)"
  else
    _fail "ws3 old-style bundle expected a not-run divergence — output: $ws3_out"
  fi
  if echo "$ws3_out" | grep -qF "trust divergence"; then
    _pass "ws3 old-style bundle emits trust divergence(s)"
  else
    _fail "ws3 old-style bundle expected trust divergence(s) — output: $ws3_out"
  fi
fi

# 7. Fabricated-attestation (iteration-4): passes (exit 0) but MUST carry the loud ATTESTED
#    marker and the summary count line — NOT the old quiet SESSION-LOCAL OK. This is a
#    visibility assertion, not a divergence assertion (unlike run_case above): a fabricated
#    self-consistent attestation bundle is, by construction, indistinguishable from a genuine
#    one at this layer (see ADR 0020 Residuals) — the fix is disclosure, not a block.
echo "=== fabricated-attestation (iteration-4, converged finding) ==="
FAB="$FX/fabricated-attestation.json"
if [[ ! -f "$FAB" ]]; then
  _fail "fabricated-attestation fixture not found at $FAB"
else
  fab_out="$(TRUST_RECONCILE_COMMANDS="node -e 'process.exit(0)'" \
    node "$RECONCILE" --bundle "$FAB" --repo-root "$ROOT" 2>&1)"
  fab_code=$?
  if [[ $fab_code -eq 0 ]]; then
    _pass "fabricated-attestation bundle passes (exit 0) — attestations are not blocked at L0"
  else
    _fail "fabricated-attestation bundle expected exit 0, got $fab_code — output: $fab_out"
  fi
  if echo "$fab_out" | grep -qF "ATTESTED (not independently verifiable at L0): 'c-fabricated-security' (workflow.check.security) evidenceType=attestation"; then
    _pass "fabricated-attestation bundle emits the loud ATTESTED marker (not a quiet SESSION-LOCAL OK)"
  else
    _fail "expected the ATTESTED (not independently verifiable at L0) marker — output: $fab_out"
  fi
  if echo "$fab_out" | grep -qF "1 attested claim(s) accepted without independent verification"; then
    _pass "fabricated-attestation bundle emits the attested-claim summary count line"
  else
    _fail "expected the attested-claim summary count line — output: $fab_out"
  fi
  if echo "$fab_out" | grep -qF "SESSION-LOCAL OK"; then
    _fail "fabricated-attestation bundle must NOT emit the old quiet SESSION-LOCAL OK line"
  else
    _pass "fabricated-attestation bundle does not emit the old quiet SESSION-LOCAL OK line"
  fi
fi

# 7. DECLARED-marker (no-agent-delivery) regressions — ADR 0022 §1/§2.
#    Bundle-required-by-default: when no delivery/trust.bundle is discovered, the reconciler
#    fails closed unless a well-formed, in-scope delivery/DECLARED marker exempts Step 2.
#    Fresh verify (Step 1) is a trivial passing command (TRUST_RECONCILE_COMMANDS) so each
#    case below isolates the new bundle-absence branch. No --bundle argument is used — these
#    are repo-root-only cases (mktemp -d per case, mirroring test_trust_reconcile.sh's
#    pattern since run_case()/_bundle_ style fixtures do not apply without a bundle).
echo ""
echo "=== 7. delivery/DECLARED marker regressions (ADR 0022 §1/§2) ==="

DECLARED_TMPROOT="$(mktemp -d)"
cleanup_declared() { rm -rf "$DECLARED_TMPROOT"; }
trap cleanup_declared EXIT

DECLARED_CMD="node -e 'process.exit(0)'"

# write_declared <dir> <json>
# Writes <json> verbatim to <dir>/delivery/DECLARED (creating delivery/ if needed).
write_declared() {
  local dir="$1" json="$2"
  mkdir -p "$dir/delivery"
  printf '%s' "$json" > "$dir/delivery/DECLARED"
}

# 7a. No bundle, no delivery/DECLARED at all → fail closed, bundle-required-no-declared-marker.
CASE7A="$DECLARED_TMPROOT/no-marker"
mkdir -p "$CASE7A"
out7a="$(TRUST_RECONCILE_COMMANDS="$DECLARED_CMD" \
  node "$RECONCILE" --repo-root "$CASE7A" 2>&1)"
code7a=$?
if [[ $code7a -ne 0 ]]; then
  _pass "no-bundle-no-marker: reconciler exits non-zero ($code7a)"
else
  _fail "no-bundle-no-marker: expected non-zero exit, got 0 — output: $out7a"
fi
if echo "$out7a" | grep -qF "bundle-required-no-declared-marker"; then
  _pass "no-bundle-no-marker: emitted 'bundle-required-no-declared-marker'"
else
  _fail "no-bundle-no-marker: expected 'bundle-required-no-declared-marker' — output: $out7a"
fi
if echo "$out7a" | grep -qF "no delivery/DECLARED marker found"; then
  _pass "no-bundle-no-marker: emitted 'no delivery/DECLARED marker found'"
else
  _fail "no-bundle-no-marker: expected 'no delivery/DECLARED marker found' — output: $out7a"
fi

# 7b. delivery/DECLARED missing approved_by → treated as absent, missing field named.
CASE7B="$DECLARED_TMPROOT/missing-field"
mkdir -p "$CASE7B"
write_declared "$CASE7B" '{"scope":"ref:feature/foo","reason":"human maintainer PR","declared_at":"2026-07-01T00:00:00Z"}'
out7b="$(TRUST_RECONCILE_COMMANDS="$DECLARED_CMD" \
  node "$RECONCILE" --repo-root "$CASE7B" 2>&1)"
code7b=$?
if [[ $code7b -ne 0 ]]; then
  _pass "missing-field: reconciler exits non-zero ($code7b)"
else
  _fail "missing-field: expected non-zero exit, got 0 — output: $out7b"
fi
if echo "$out7b" | grep -qF "approved_by"; then
  _pass "missing-field: output names the missing field 'approved_by'"
else
  _fail "missing-field: expected 'approved_by' in output — output: $out7b"
fi
if echo "$out7b" | grep -qF "missing required field"; then
  _pass "missing-field: output contains 'missing required field'"
else
  _fail "missing-field: expected 'missing required field' — output: $out7b"
fi

# 7c. delivery/DECLARED malformed JSON (truncated) → not valid JSON.
CASE7C="$DECLARED_TMPROOT/malformed-json"
mkdir -p "$CASE7C"
write_declared "$CASE7C" '{"scope":"ref:feature/foo","reason":"human maintainer PR"'
out7c="$(TRUST_RECONCILE_COMMANDS="$DECLARED_CMD" \
  node "$RECONCILE" --repo-root "$CASE7C" 2>&1)"
code7c=$?
if [[ $code7c -ne 0 ]]; then
  _pass "malformed-json: reconciler exits non-zero ($code7c)"
else
  _fail "malformed-json: expected non-zero exit, got 0 — output: $out7c"
fi
if echo "$out7c" | grep -qF "not valid JSON"; then
  _pass "malformed-json: output contains 'not valid JSON'"
else
  _fail "malformed-json: expected 'not valid JSON' — output: $out7c"
fi

# 7d. Well-formed ref: marker matching TRUST_RECONCILE_REF → exempt, exact DECLARED line,
#     and Step 1 (fresh verify) still ran (canonical command string appears in stdout).
CASE7D="$DECLARED_TMPROOT/ref-match"
mkdir -p "$CASE7D"
write_declared "$CASE7D" '{"scope":"ref:feature/foo","reason":"human maintainer PR","approved_by":"alice","declared_at":"2026-07-01T00:00:00Z"}'
out7d="$(TRUST_RECONCILE_REF="feature/foo" TRUST_RECONCILE_COMMANDS="$DECLARED_CMD" \
  node "$RECONCILE" --repo-root "$CASE7D" 2>&1)"
code7d=$?
if [[ $code7d -eq 0 ]]; then
  _pass "ref-match: reconciler exits 0 (in-scope ref: marker exempts Step 2)"
else
  _fail "ref-match: expected exit 0, got $code7d — output: $out7d"
fi
if echo "$out7d" | grep -qF "DECLARED (no-agent-delivery): ref:feature/foo — human maintainer PR (approved by alice, declared 2026-07-01T00:00:00Z)"; then
  _pass "ref-match: emitted the exact DECLARED line"
else
  _fail "ref-match: expected the exact DECLARED line — output: $out7d"
fi
if echo "$out7d" | grep -qF "$DECLARED_CMD"; then
  _pass "ref-match: canonical command still ran (Step 1 not skipped)"
else
  _fail "ref-match: expected the canonical command '$DECLARED_CMD' to appear in output (Step 1 must still run) — output: $out7d"
fi

# 7e. Well-formed author: marker NOT matching TRUST_RECONCILE_ACTOR (near-miss) → out of
#     scope, proves no accidental wildcard match.
CASE7E="$DECLARED_TMPROOT/author-near-miss"
mkdir -p "$CASE7E"
write_declared "$CASE7E" '{"scope":"author:dependabot[bot]","reason":"dependabot dependency updates","approved_by":"alice","declared_at":"2026-07-01T00:00:00Z"}'
out7e="$(TRUST_RECONCILE_ACTOR="not-dependabot" TRUST_RECONCILE_COMMANDS="$DECLARED_CMD" \
  node "$RECONCILE" --repo-root "$CASE7E" 2>&1)"
code7e=$?
if [[ $code7e -ne 0 ]]; then
  _pass "author-near-miss: reconciler exits non-zero ($code7e) — near-miss actor does not match"
else
  _fail "author-near-miss: expected non-zero exit (out of scope), got 0 — output: $out7e"
fi
if echo "$out7e" | grep -qF "out of scope"; then
  _pass "author-near-miss: output contains 'out of scope'"
else
  _fail "author-near-miss: expected 'out of scope' — output: $out7e"
fi

# 7f. Well-formed branch-prefix:dependabot/ marker matching TRUST_RECONCILE_REF → exempt.
CASE7F="$DECLARED_TMPROOT/branch-prefix-match"
mkdir -p "$CASE7F"
write_declared "$CASE7F" '{"scope":"branch-prefix:dependabot/","reason":"dependabot dependency updates","approved_by":"alice","declared_at":"2026-07-01T00:00:00Z"}'
out7f="$(TRUST_RECONCILE_REF="dependabot/npm_and_yarn/foo" TRUST_RECONCILE_COMMANDS="$DECLARED_CMD" \
  node "$RECONCILE" --repo-root "$CASE7F" 2>&1)"
code7f=$?
if [[ $code7f -eq 0 ]]; then
  _pass "branch-prefix-match: reconciler exits 0 (in-scope branch-prefix: marker exempts Step 2)"
else
  _fail "branch-prefix-match: expected exit 0, got $code7f — output: $out7f"
fi
if echo "$out7f" | grep -qF "DECLARED (no-agent-delivery):"; then
  _pass "branch-prefix-match: DECLARED line present"
else
  _fail "branch-prefix-match: expected a DECLARED line — output: $out7f"
fi

# 7g. Array-form delivery/DECLARED with context matching only the second entry → exempt,
#     DECLARED line names the second entry's scope; first entry's non-match is not a failure.
CASE7G="$DECLARED_TMPROOT/array-form"
mkdir -p "$CASE7G"
write_declared "$CASE7G" '[
  {"scope":"author:dependabot[bot]","reason":"dependabot dependency updates","approved_by":"alice","declared_at":"2026-07-01T00:00:00Z"},
  {"scope":"ref:release-please--branches--main","reason":"release-please automation PR","approved_by":"alice","declared_at":"2026-07-01T00:00:00Z"}
]'
out7g="$(TRUST_RECONCILE_REF="release-please--branches--main" TRUST_RECONCILE_ACTOR="not-dependabot" TRUST_RECONCILE_COMMANDS="$DECLARED_CMD" \
  node "$RECONCILE" --repo-root "$CASE7G" 2>&1)"
code7g=$?
if [[ $code7g -eq 0 ]]; then
  _pass "array-form: reconciler exits 0 (second array entry matches by ref:)"
else
  _fail "array-form: expected exit 0, got $code7g — output: $out7g"
fi
if echo "$out7g" | grep -qF "DECLARED (no-agent-delivery): ref:release-please--branches--main"; then
  _pass "array-form: DECLARED line names the second entry's scope"
else
  _fail "array-form: expected DECLARED line naming 'ref:release-please--branches--main' — output: $out7g"
fi

# 7h. Empty-array delivery/DECLARED ([]) → distinct diagnostic, fail closed (MEDIUM-1).
CASE7H="$DECLARED_TMPROOT/empty-array"
mkdir -p "$CASE7H"
write_declared "$CASE7H" '[]'
out7h="$(TRUST_RECONCILE_COMMANDS="$DECLARED_CMD" \
  node "$RECONCILE" --repo-root "$CASE7H" 2>&1)"
code7h=$?
if [[ $code7h -ne 0 ]]; then
  _pass "empty-array: reconciler exits non-zero ($code7h)"
else
  _fail "empty-array: expected non-zero exit, got 0 — output: $out7h"
fi
if echo "$out7h" | grep -qF "array contains zero entries"; then
  _pass "empty-array: emitted the distinct 'array contains zero entries' diagnostic"
else
  _fail "empty-array: expected 'array contains zero entries' — output: $out7h"
fi

# 7i. commit:<sha> single-sha exact match (positive coverage, MEDIUM-2).
CASE7I="$DECLARED_TMPROOT/commit-sha-match"
mkdir -p "$CASE7I"
write_declared "$CASE7I" '{"scope":"commit:deadbeef1234","reason":"pinned single commit","approved_by":"alice","declared_at":"2026-07-01T00:00:00Z"}'
out7i="$(TRUST_RECONCILE_SHA="deadbeef1234" TRUST_RECONCILE_COMMANDS="$DECLARED_CMD" \
  node "$RECONCILE" --repo-root "$CASE7I" 2>&1)"
code7i=$?
if [[ $code7i -eq 0 ]]; then
  _pass "commit-sha-match: reconciler exits 0 (exact commit: sha match exempts Step 2)"
else
  _fail "commit-sha-match: expected exit 0, got $code7i — output: $out7i"
fi
if echo "$out7i" | grep -qF "DECLARED (no-agent-delivery): commit:deadbeef1234"; then
  _pass "commit-sha-match: DECLARED line present"
else
  _fail "commit-sha-match: expected a DECLARED line — output: $out7i"
fi

# 7j. commit:<from>..<to> range, unresolvable (repo-root is not a git repo git merge-base
#     can resolve against) → isShaInRange() is best-effort and MUST fail closed, never throw.
CASE7J="$DECLARED_TMPROOT/commit-range-unresolvable"
mkdir -p "$CASE7J"
write_declared "$CASE7J" '{"scope":"commit:aaaaaaaa..bbbbbbbb","reason":"release window","approved_by":"alice","declared_at":"2026-07-01T00:00:00Z"}'
out7j="$(TRUST_RECONCILE_SHA="cccccccc" TRUST_RECONCILE_COMMANDS="$DECLARED_CMD" \
  node "$RECONCILE" --repo-root "$CASE7J" 2>&1)"
code7j=$?
if [[ $code7j -ne 0 ]]; then
  _pass "commit-range-unresolvable: reconciler exits non-zero ($code7j) — underivable range never matches"
else
  _fail "commit-range-unresolvable: expected non-zero exit (fail closed), got 0 — output: $out7j"
fi
if echo "$out7j" | grep -qF "out of scope"; then
  _pass "commit-range-unresolvable: output contains 'out of scope'"
else
  _fail "commit-range-unresolvable: expected 'out of scope' — output: $out7j"
fi

# 7k. author: positive match (in-scope, standalone — 7e above only covers the near-miss).
CASE7K="$DECLARED_TMPROOT/author-positive-match"
mkdir -p "$CASE7K"
write_declared "$CASE7K" '{"scope":"author:dependabot[bot]","reason":"dependabot dependency updates","approved_by":"alice","declared_at":"2026-07-01T00:00:00Z"}'
out7k="$(TRUST_RECONCILE_ACTOR="dependabot[bot]" TRUST_RECONCILE_COMMANDS="$DECLARED_CMD" \
  node "$RECONCILE" --repo-root "$CASE7K" 2>&1)"
code7k=$?
if [[ $code7k -eq 0 ]]; then
  _pass "author-positive-match: reconciler exits 0 (exact author: match exempts Step 2)"
else
  _fail "author-positive-match: expected exit 0, got $code7k — output: $out7k"
fi
if echo "$out7k" | grep -qF "DECLARED (no-agent-delivery): author:dependabot[bot]"; then
  _pass "author-positive-match: DECLARED line present"
else
  _fail "author-positive-match: expected a DECLARED line — output: $out7k"
fi

# 7l/7m. Compound (space-separated AND) scope — HIGH-1 fix + its regression proof.
#   author:<exact> alone (or branch-prefix:<prefix> alone) matches GITHUB_HEAD_REF/GITHUB_ACTOR,
#   but GITHUB_HEAD_REF is PUSHER-CONTROLLED on a fork PR — a ref:/branch-prefix:-only scope
#   can be satisfied by anyone who can name a branch. A compound scope requires ALL
#   space-separated conditions to match before it exempts Step 2.
CASE7L="$DECLARED_TMPROOT/compound-both-match"
mkdir -p "$CASE7L"
write_declared "$CASE7L" '{"scope":"author:github-actions[bot] branch-prefix:release-please--","reason":"release-please automation PR","approved_by":"alice","declared_at":"2026-07-01T00:00:00Z"}'
out7l="$(TRUST_RECONCILE_ACTOR="github-actions[bot]" TRUST_RECONCILE_REF="release-please--branches--main" TRUST_RECONCILE_COMMANDS="$DECLARED_CMD" \
  node "$RECONCILE" --repo-root "$CASE7L" 2>&1)"
code7l=$?
if [[ $code7l -eq 0 ]]; then
  _pass "compound-both-match: reconciler exits 0 (both AND conditions match)"
else
  _fail "compound-both-match: expected exit 0, got $code7l — output: $out7l"
fi
if echo "$out7l" | grep -qF "DECLARED (no-agent-delivery): author:github-actions[bot] branch-prefix:release-please--"; then
  _pass "compound-both-match: DECLARED line names the full compound scope"
else
  _fail "compound-both-match: expected the compound-scope DECLARED line — output: $out7l"
fi

CASE7M="$DECLARED_TMPROOT/compound-only-one-matches"
mkdir -p "$CASE7M"
write_declared "$CASE7M" '{"scope":"author:github-actions[bot] branch-prefix:release-please--","reason":"release-please automation PR","approved_by":"alice","declared_at":"2026-07-01T00:00:00Z"}'
out7m="$(TRUST_RECONCILE_REF="release-please--branches--main" TRUST_RECONCILE_COMMANDS="$DECLARED_CMD" \
  node "$RECONCILE" --repo-root "$CASE7M" 2>&1)"
code7m=$?
if [[ $code7m -ne 0 ]]; then
  _pass "compound-only-one-matches: reconciler exits non-zero ($code7m) — branch-prefix: alone (no author:) is pusher-controlled and must not exempt"
else
  _fail "compound-only-one-matches: expected non-zero exit (fail closed — ref alone is insufficient), got 0 — output: $out7m"
fi
if echo "$out7m" | grep -qF "out of scope"; then
  _pass "compound-only-one-matches: output contains 'out of scope'"
else
  _fail "compound-only-one-matches: expected 'out of scope' — output: $out7m"
fi

# 7n/7o/7p. Bundle-ownership staleness check (ADR 0022 addendum, part 2) — live incident PR
#   #278: an AUTO-DISCOVERED bundle must attest THIS change (checkpoint commit_sha equal-to
#   or a git-ancestor-of this change's own sha), or it is treated as ABSENT, not present.
#   Applies only to auto-discovery (no --bundle flag is used in 7n/7o/7p below — that is
#   exactly the point: these are --repo-root-only cases, matching real CI's own invocation
#   shape, which never passes --bundle).

STALE_SHA="deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
OURS_SHA="cafebabecafebabecafebabecafebabecafebabe"

# write_stale_checkpoint <dir> <sha>
# Writes a minimal, well-formed delivery/trust.checkpoint.json envelope naming <sha> as
# commit_sha -- auto-discovered by trust-reconcile.js the same way a real sealed checkpoint
# is (discoverBundle() checks the full bundle first, then this file).
write_stale_checkpoint() {
  local dir="$1" sha="$2"
  mkdir -p "$dir/delivery"
  printf '{"schema_version":"1.0","slug":"stale-fixture","work_item":null,"status":"delivered","phase":"release","sealed_at":"2026-01-01T00:00:00Z","commit_sha":"%s","checkpoint":{"asOf":"2026-01-01T00:00:00.000Z","statusByClaimId":{}}}' \
    "$sha" > "$dir/delivery/trust.checkpoint.json"
}

# write_fresh_bundle <dir> <label>
# Writes a minimal, well-formed delivery/trust.bundle with ONE claimed-pass command
# (<label>) so Step 2's RECONCILED path has something real to reconcile.
write_fresh_bundle() {
  local dir="$1" label="$2"
  mkdir -p "$dir/delivery"
  cat > "$dir/delivery/trust.bundle" << EOF
{
  "schemaVersion": 5,
  "source": "test-fixture:fresh-matching-bundle",
  "claims": [
    {
      "id": "c1", "claimType": "workflow.check.build", "value": "pass", "status": "verified",
      "subjectId": "test-slug/build", "facet": "flow-agents.workflow", "subjectType": "workflow-check",
      "fieldOrBehavior": "build", "createdAt": "2026-07-01T00:00:00Z", "updatedAt": "2026-07-01T00:00:00Z",
      "impactLevel": "high", "verificationPolicyId": "policy:workflow.check.build"
    }
  ],
  "evidence": [
    {
      "id": "ev1", "claimId": "c1", "evidenceType": "test_output", "method": "validation",
      "sourceRef": "test-slug/command-log.jsonl", "excerptOrSummary": "build",
      "observedAt": "2026-07-01T00:00:00Z", "collectedBy": "flow-agents/evidence-capture",
      "passing": true,
      "execution": { "runner": "bash", "label": "$label", "isError": false, "exitCode": 0 }
    }
  ],
  "policies": [], "events": []
}
EOF
}

# 7n. Stale bundle (checkpoint attesting a DIFFERENT sha) + a valid, in-scope DECLARED
#     marker -> the DECLARED path is taken (not a stale-bundle-triggered fail), and the
#     loud stale-bundle line is still printed for audit.
CASE7N="$DECLARED_TMPROOT/stale-bundle-with-marker"
mkdir -p "$CASE7N"
write_stale_checkpoint "$CASE7N" "$STALE_SHA"
write_declared "$CASE7N" '{"scope":"ref:feature/y","reason":"human maintainer PR","approved_by":"alice","declared_at":"2026-07-01T00:00:00Z"}'
out7n="$(TRUST_RECONCILE_SHA="$OURS_SHA" TRUST_RECONCILE_REF="feature/y" TRUST_RECONCILE_COMMANDS="$DECLARED_CMD" \
  node "$RECONCILE" --repo-root "$CASE7N" 2>&1)"
code7n=$?
if [[ $code7n -eq 0 ]]; then
  _pass "stale-bundle-with-marker: reconciler exits 0 (DECLARED exempts Step 2 after the stale bundle is discarded)"
else
  _fail "stale-bundle-with-marker: expected exit 0, got $code7n -- output: $out7n"
fi
if echo "$out7n" | grep -qF "stale bundle ignored — attests $STALE_SHA, this change is $OURS_SHA"; then
  _pass "stale-bundle-with-marker: emitted the exact stale-bundle line naming both shas"
else
  _fail "stale-bundle-with-marker: expected the stale-bundle line -- output: $out7n"
fi
if echo "$out7n" | grep -qF "DECLARED (no-agent-delivery): ref:feature/y"; then
  _pass "stale-bundle-with-marker: DECLARED line present (marker path taken, not the stale bundle)"
else
  _fail "stale-bundle-with-marker: expected the DECLARED line -- output: $out7n"
fi

# 7o. Stale bundle + NO delivery/DECLARED marker -> fail closed exactly as bundle-absence.
CASE7O="$DECLARED_TMPROOT/stale-bundle-no-marker"
mkdir -p "$CASE7O"
write_stale_checkpoint "$CASE7O" "$STALE_SHA"
out7o="$(TRUST_RECONCILE_SHA="$OURS_SHA" TRUST_RECONCILE_COMMANDS="$DECLARED_CMD" \
  node "$RECONCILE" --repo-root "$CASE7O" 2>&1)"
code7o=$?
if [[ $code7o -ne 0 ]]; then
  _pass "stale-bundle-no-marker: reconciler exits non-zero ($code7o) -- stale bundle treated as absent, no marker to exempt it"
else
  _fail "stale-bundle-no-marker: expected non-zero exit, got 0 -- output: $out7o"
fi
if echo "$out7o" | grep -qF "stale bundle ignored — attests $STALE_SHA, this change is $OURS_SHA"; then
  _pass "stale-bundle-no-marker: emitted the exact stale-bundle line"
else
  _fail "stale-bundle-no-marker: expected the stale-bundle line -- output: $out7o"
fi
if echo "$out7o" | grep -qF "bundle-required-no-declared-marker"; then
  _pass "stale-bundle-no-marker: emitted 'bundle-required-no-declared-marker' (same fail-closed path as no-bundle-at-all)"
else
  _fail "stale-bundle-no-marker: expected 'bundle-required-no-declared-marker' -- output: $out7o"
fi

# 7p. REGRESSION GUARD: a fresh/matching auto-discovered bundle (checkpoint commit_sha ==
#     this change's own sha) is NOT treated as stale -- Step 2 reconciles it exactly as
#     before (no behavior change for owned bundles).
CASE7P="$DECLARED_TMPROOT/fresh-matching-bundle"
mkdir -p "$CASE7P"
FRESH_LABEL="node -e 'process.exit(0)'"
write_fresh_bundle "$CASE7P" "$FRESH_LABEL"
write_stale_checkpoint "$CASE7P" "$OURS_SHA"
out7p="$(TRUST_RECONCILE_SHA="$OURS_SHA" TRUST_RECONCILE_COMMANDS="$FRESH_LABEL" \
  node "$RECONCILE" --repo-root "$CASE7P" 2>&1)"
code7p=$?
if [[ $code7p -eq 0 ]]; then
  _pass "fresh-matching-bundle: reconciler exits 0 (matching commit_sha -- not treated as stale)"
else
  _fail "fresh-matching-bundle: expected exit 0, got $code7p -- output: $out7p"
fi
if echo "$out7p" | grep -qF "stale bundle ignored"; then
  _fail "fresh-matching-bundle: must NOT emit the stale-bundle line for a matching commit_sha"
else
  _pass "fresh-matching-bundle: does not emit the stale-bundle line"
fi
if echo "$out7p" | grep -qF "RECONCILED"; then
  _pass "fresh-matching-bundle: Step 2 reconciled the claimed-pass command (RECONCILED shown) -- no behavior change for owned bundles"
else
  _fail "fresh-matching-bundle: expected 'RECONCILED' in output -- output: $out7p"
fi

# 7q/7r. REAL-GIT-REPO coverage for the ancestor branch of bundleAttestsThisChange()
#   (iteration-4 MEDIUM finding: the ancestor path had zero coverage -- 7i/7p above only
#   exercise exact-sha equality, never a real `git merge-base --is-ancestor` resolution).
#   Both cases below use an ACTUAL git repo (not synthetic sha strings) with a real
#   parent -> child commit pair.

GIT_ORIGIN="$DECLARED_TMPROOT/git-origin"
mkdir -p "$GIT_ORIGIN"
git -C "$GIT_ORIGIN" init -q
git -C "$GIT_ORIGIN" config user.email "test@example.com"
git -C "$GIT_ORIGIN" config user.name "Test"
echo "parent" > "$GIT_ORIGIN/file.txt"
git -C "$GIT_ORIGIN" add file.txt
git -C "$GIT_ORIGIN" commit -q -m "parent commit"
PARENT_SHA="$(git -C "$GIT_ORIGIN" rev-parse HEAD)"
echo "child" >> "$GIT_ORIGIN/file.txt"
git -C "$GIT_ORIGIN" add file.txt
git -C "$GIT_ORIGIN" commit -q -m "child commit"
CHILD_SHA="$(git -C "$GIT_ORIGIN" rev-parse HEAD)"

# 7q. TRUE-POSITIVE ancestor coverage: checkpoint sealed at the PARENT commit (not equal
#     to this change's own sha), full-history repo, change sha = the CHILD commit ->
#     the ancestor branch of bundleAttestsThisChange() (real `git merge-base
#     --is-ancestor`, not the exact-equality shortcut) resolves FRESH; Step 2 still
#     reconciles the claimed-pass command normally.
CASE7Q="$GIT_ORIGIN"
FRESH_LABEL_Q="node -e 'process.exit(0)'"
write_fresh_bundle "$CASE7Q" "$FRESH_LABEL_Q"
write_stale_checkpoint "$CASE7Q" "$PARENT_SHA"
out7q="$(TRUST_RECONCILE_SHA="$CHILD_SHA" TRUST_RECONCILE_COMMANDS="$FRESH_LABEL_Q" \
  node "$RECONCILE" --repo-root "$CASE7Q" 2>&1)"
code7q=$?
if [[ $code7q -eq 0 ]]; then
  _pass "git-ancestor-fresh: reconciler exits 0 (parent-sha checkpoint resolves as an ancestor of the child change sha)"
else
  _fail "git-ancestor-fresh: expected exit 0, got $code7q -- output: $out7q"
fi
if echo "$out7q" | grep -qF "stale bundle ignored"; then
  _fail "git-ancestor-fresh: must NOT emit the stale-bundle line -- the parent IS a real ancestor of the child"
else
  _pass "git-ancestor-fresh: does not emit the stale-bundle line (true ancestor resolution, not equality)"
fi
if echo "$out7q" | grep -qF "RECONCILED"; then
  _pass "git-ancestor-fresh: Step 2 reconciled the claimed-pass command (RECONCILED shown)"
else
  _fail "git-ancestor-fresh: expected 'RECONCILED' in output -- output: $out7q"
fi

# 7r. DEGRADED-BUT-SAFE shallow-clone coverage: a `git clone --depth 1` of the SAME repo
#     (so the checked-out change sha is the same CHILD commit) lacks the PARENT commit
#     object entirely -- `git merge-base --is-ancestor` cannot resolve it (exits 128) and
#     isAncestorCommit() fails toward false, so this documents (not silently accepts) the
#     current degraded mode: a real, legitimately-fresh bundle is treated as stale under a
#     misconfigured shallow checkout, loudly, with the stale line naming both shas -- a
#     future checkout-depth improvement would flip this assertion, not remove it.
CASE7R="$DECLARED_TMPROOT/git-shallow-clone"
git clone -q --depth 1 "file://$GIT_ORIGIN" "$CASE7R" 2>/dev/null
mkdir -p "$CASE7R/delivery"
cp "$GIT_ORIGIN/delivery/trust.bundle" "$CASE7R/delivery/trust.bundle"
write_stale_checkpoint "$CASE7R" "$PARENT_SHA"
out7r="$(TRUST_RECONCILE_SHA="$CHILD_SHA" TRUST_RECONCILE_COMMANDS="$FRESH_LABEL_Q" \
  node "$RECONCILE" --repo-root "$CASE7R" 2>&1)"
code7r=$?
if [[ $code7r -ne 0 ]]; then
  _pass "git-shallow-clone: reconciler exits non-zero ($code7r) -- shallow clone cannot resolve the ancestor check, fails toward stale"
else
  _fail "git-shallow-clone: expected non-zero exit (degraded-but-safe), got 0 -- output: $out7r"
fi

# 7s/7t/7u. Event-scoped enforcement (ADR 0022 addendum, part 4) -- HIGH launch-blocker
#   reproduction: after a squash-merge onto main, the squash commit has NO git ancestry to
#   the feature-branch commit a checkpoint was sealed at (`git merge --squash` discards the
#   original commit graph) -- on a push event this must be a loud no-op, not a failure; on
#   pull_request the exact same shape must still fail closed (scoping did not weaken
#   PR-time gating); and the absent-event default must still enforce.

SQUASH_REPO="$DECLARED_TMPROOT/git-squash-repo"
mkdir -p "$SQUASH_REPO"
git -C "$SQUASH_REPO" init -q
git -C "$SQUASH_REPO" config user.email "test@example.com"
git -C "$SQUASH_REPO" config user.name "Test"
echo "main" > "$SQUASH_REPO/file.txt"
git -C "$SQUASH_REPO" add file.txt
git -C "$SQUASH_REPO" commit -q -m "main tip"
git -C "$SQUASH_REPO" checkout -q -b feature
echo "feature work" >> "$SQUASH_REPO/file.txt"
git -C "$SQUASH_REPO" add file.txt
git -C "$SQUASH_REPO" commit -q -m "feature work"
FEATURE_TIP_SHA="$(git -C "$SQUASH_REPO" rev-parse HEAD)"
git -C "$SQUASH_REPO" checkout -q -
git -C "$SQUASH_REPO" merge -q --squash feature
git -C "$SQUASH_REPO" commit -q -m "squash-merge feature"
SQUASH_SHA="$(git -C "$SQUASH_REPO" rev-parse HEAD)"

# Sanity: confirm the fixture actually reproduces the reviewer's shape -- the feature tip
# must NOT be an ancestor of the squash commit (if it were, this fixture would not exercise
# the bug at all).
if git -C "$SQUASH_REPO" merge-base --is-ancestor "$FEATURE_TIP_SHA" "$SQUASH_SHA" 2>/dev/null; then
  _fail "git-squash fixture sanity: feature tip unexpectedly IS an ancestor of the squash commit -- fixture does not reproduce the reviewer's shape"
else
  _pass "git-squash fixture sanity: feature tip is NOT an ancestor of the squash commit (reproduces the reviewer's shape)"
fi

write_stale_checkpoint "$SQUASH_REPO" "$FEATURE_TIP_SHA"

# 7s. push event -> loud no-op, exit 0 (the reviewer's exact reproduction, now locked).
out7s="$(TRUST_RECONCILE_EVENT="push" TRUST_RECONCILE_SHA="$SQUASH_SHA" TRUST_RECONCILE_COMMANDS="$DECLARED_CMD" \
  node "$RECONCILE" --repo-root "$SQUASH_REPO" 2>&1)"
code7s=$?
if [[ $code7s -eq 0 ]]; then
  _pass "git-squash-push: reconciler exits 0 (post-merge push run is a no-op, not a failure)"
else
  _fail "git-squash-push: expected exit 0, got $code7s -- output: $out7s"
fi
if echo "$out7s" | grep -qF "push event: inherited bundle does not attest this commit — skipping Step 2 (gating happened on the PR run)"; then
  _pass "git-squash-push: emitted the exact push-event no-op line"
else
  _fail "git-squash-push: expected the push-event no-op line -- output: $out7s"
fi
if echo "$out7s" | grep -qF "bundle-required-no-declared-marker"; then
  _fail "git-squash-push: must NOT emit bundle-required-no-declared-marker on a push event"
else
  _pass "git-squash-push: does not emit bundle-required-no-declared-marker (enforcement does not apply on push)"
fi

# 7t. SAME shape, event=pull_request -> still fails/stales as before (scoping did not
#     weaken PR-time gating).
out7t="$(TRUST_RECONCILE_EVENT="pull_request" TRUST_RECONCILE_SHA="$SQUASH_SHA" TRUST_RECONCILE_COMMANDS="$DECLARED_CMD" \
  node "$RECONCILE" --repo-root "$SQUASH_REPO" 2>&1)"
code7t=$?
if [[ $code7t -ne 0 ]]; then
  _pass "git-squash-pull-request: reconciler exits non-zero ($code7t) -- same squash shape still fails closed when gating a PR"
else
  _fail "git-squash-pull-request: expected non-zero exit, got 0 -- output: $out7t"
fi
if echo "$out7t" | grep -qF "stale bundle ignored — attests $FEATURE_TIP_SHA, this change is $SQUASH_SHA"; then
  _pass "git-squash-pull-request: emitted the exact stale-bundle line"
else
  _fail "git-squash-pull-request: expected the stale-bundle line -- output: $out7t"
fi
if echo "$out7t" | grep -qF "bundle-required-no-declared-marker"; then
  _pass "git-squash-pull-request: emitted bundle-required-no-declared-marker (PR-time gating unweakened)"
else
  _fail "git-squash-pull-request: expected bundle-required-no-declared-marker -- output: $out7t"
fi

# 7u. Absent-event default explicitly asserted to enforce (7a already covers this
#     implicitly for the no-marker case -- this makes the default assertion explicit).
CASE7U="$DECLARED_TMPROOT/absent-event-default-enforces"
mkdir -p "$CASE7U"
out7u="$(TRUST_RECONCILE_COMMANDS="$DECLARED_CMD" \
  node "$RECONCILE" --repo-root "$CASE7U" 2>&1)"
code7u=$?
if [[ $code7u -ne 0 ]]; then
  _pass "absent-event-default-enforces: reconciler exits non-zero ($code7u) -- no TRUST_RECONCILE_EVENT defaults to enforce"
else
  _fail "absent-event-default-enforces: expected non-zero exit, got 0 -- output: $out7u"
fi
if echo "$out7u" | grep -qF "bundle-required-no-declared-marker"; then
  _pass "absent-event-default-enforces: emitted bundle-required-no-declared-marker (conservative default confirmed)"
else
  _fail "absent-event-default-enforces: expected bundle-required-no-declared-marker -- output: $out7u"
fi

# 7v. [MEDIUM, doc-residual follow-up] push event + a deliberately FAILING
#     trust-reconcile-verify -> exit 1. Proves event-scoped bundle-required relaxation on
#     push does NOT also relax Step 1 -- a red push run must never look green just because
#     Step 2/delivery-DECLARED enforcement does not apply on push.
CASE7V="$DECLARED_TMPROOT/push-event-failing-verify"
mkdir -p "$CASE7V"
out7v="$(TRUST_RECONCILE_EVENT="push" TRUST_RECONCILE_COMMANDS="node -e 'process.exit(1)'" \
  node "$RECONCILE" --repo-root "$CASE7V" 2>&1)"
code7v=$?
if [[ $code7v -ne 0 ]]; then
  _pass "push-event-failing-verify: reconciler exits non-zero ($code7v) -- a failing Step 1 still fails on push, event scoping never masks a red run"
else
  _fail "push-event-failing-verify: expected non-zero exit, got 0 -- output: $out7v"
fi
if echo "$out7v" | grep -qF "verification failed in CI"; then
  _pass "push-event-failing-verify: emitted 'verification failed in CI' (Step 1 failure, unaffected by event scoping)"
else
  _fail "push-event-failing-verify: expected 'verification failed in CI' -- output: $out7v"
fi
if echo "$out7v" | grep -qF "push event:"; then
  _pass "push-event-failing-verify: still emits the push-event Step-2 no-op line even though the overall run fails on Step 1 (the two are independent)"
else
  _fail "push-event-failing-verify: expected the push-event no-op line -- output: $out7v"
fi

# 8. #379 per-session delivery paths — concurrent-delivery collision resolution.
#   resolveDeliveryCandidates() now discovers delivery/<slug>/trust.bundle per-session dirs
#   in addition to the flat path; discoverBundle() selects the candidate whose checkpoint
#   attests THIS change (ancestor-or-equal, same bundleAttestsThisChange() semantics the flat
#   staleness gate uses), ignoring stale siblings from OTHER concurrent sessions. A shared
#   flat path guaranteed a git conflict between any two concurrent deliveries → a DIRTY PR →
#   NO pull_request workflows → the required check silently never ran (field #330/#358/#378).
echo ""
echo "=== 8. #379 per-session delivery paths (concurrent-delivery collision) ==="

PERSESSION_TMPROOT="$(mktemp -d)"
# Chain per-session cleanup onto the existing DECLARED cleanup without clobbering the trap.
trap 'cleanup_declared; rm -rf "$PERSESSION_TMPROOT"' EXIT

# write_session_seal <repo_root> <slug> <label> <commit_sha>
# Writes delivery/<slug>/trust.bundle (a well-formed schemaVersion-5 bundle whose only
# claimed-pass command is <label>) + delivery/<slug>/trust.checkpoint.json (naming
# <commit_sha>) — the per-session analogue of write_fresh_bundle + write_stale_checkpoint.
write_session_seal() {
  local repo_root="$1" slug="$2" label="$3" sha="$4"
  local sdir="$repo_root/delivery/$slug"
  mkdir -p "$sdir"
  cat > "$sdir/trust.bundle" << EOF
{
  "schemaVersion": 5,
  "source": "test-fixture:per-session:$slug",
  "claims": [
    {
      "id": "c1", "claimType": "workflow.check.build", "value": "pass", "status": "verified",
      "subjectId": "$slug/build", "facet": "flow-agents.workflow", "subjectType": "workflow-check",
      "fieldOrBehavior": "build", "createdAt": "2026-07-01T00:00:00Z", "updatedAt": "2026-07-01T00:00:00Z",
      "impactLevel": "high", "verificationPolicyId": "policy:workflow.check.build"
    }
  ],
  "evidence": [
    {
      "id": "ev1", "claimId": "c1", "evidenceType": "test_output", "method": "validation",
      "sourceRef": "$slug/command-log.jsonl", "excerptOrSummary": "build",
      "observedAt": "2026-07-01T00:00:00Z", "collectedBy": "flow-agents/evidence-capture",
      "passing": true,
      "execution": { "runner": "bash", "label": "$label", "isError": false, "exitCode": 0 }
    }
  ],
  "policies": [], "events": []
}
EOF
  printf '{"schema_version":"1.0","slug":"%s","work_item":null,"status":"delivered","phase":"release","sealed_at":"2026-01-01T00:00:00Z","commit_sha":"%s","checkpoint":{"asOf":"2026-01-01T00:00:00.000Z","statusByClaimId":{}}}' \
    "$slug" "$sha" > "$sdir/trust.checkpoint.json"
}

FRESH_LABEL_8="node -e 'process.exit(0)'"

# 8a. OWNER WINS: two sibling session dirs — one OWNING (checkpoint commit_sha == this
#     change's sha), one STALE (a different sha). The reconciler MUST pick the owner and
#     reconcile it; the stale sibling is ignored, NOT a failure.
CASE8A="$PERSESSION_TMPROOT/collision-owner-wins"
write_session_seal "$CASE8A" "owning-session" "$FRESH_LABEL_8" "$OURS_SHA"
write_session_seal "$CASE8A" "stale-sibling" "echo stale-should-never-be-reconciled" "$STALE_SHA"
out8a="$(TRUST_RECONCILE_SHA="$OURS_SHA" TRUST_RECONCILE_COMMANDS="$FRESH_LABEL_8" \
  node "$RECONCILE" --repo-root "$CASE8A" 2>&1)"
code8a=$?
if [[ $code8a -eq 0 ]]; then
  _pass "persession-owner-wins: reconciler exits 0 (owning per-session candidate selected, stale sibling ignored)"
else
  _fail "persession-owner-wins: expected exit 0, got $code8a -- output: $out8a"
fi
if echo "$out8a" | grep -qF "selected delivery candidate delivery/owning-session/trust.bundle"; then
  _pass "persession-owner-wins: emitted the #379 selection line naming the owning session dir"
else
  _fail "persession-owner-wins: expected the #379 selection line for delivery/owning-session/trust.bundle -- output: $out8a"
fi
if echo "$out8a" | grep -qF "RECONCILED"; then
  _pass "persession-owner-wins: Step 2 reconciled the owning candidate's claimed-pass command"
else
  _fail "persession-owner-wins: expected RECONCILED -- output: $out8a"
fi
if echo "$out8a" | grep -qF "bundle-required-no-declared-marker"; then
  _fail "persession-owner-wins: must NOT fail closed — an owning candidate exists"
else
  _pass "persession-owner-wins: does not fail closed (owning candidate found)"
fi

# 8b. NO OWNER: two sibling session dirs, BOTH stale (neither attests this change), no
#     DECLARED marker -> fail closed EXACTLY as bundle-absence, plus the #379 concurrency
#     hint so the next agent can diagnose a collision rather than a plain stale bundle.
CASE8B="$PERSESSION_TMPROOT/collision-no-owner"
OTHER_STALE_SHA="1111111111111111111111111111111111111111"
write_session_seal "$CASE8B" "session-a" "echo a" "$STALE_SHA"
write_session_seal "$CASE8B" "session-b" "echo b" "$OTHER_STALE_SHA"
out8b="$(TRUST_RECONCILE_SHA="$OURS_SHA" TRUST_RECONCILE_COMMANDS="$FRESH_LABEL_8" \
  node "$RECONCILE" --repo-root "$CASE8B" 2>&1)"
code8b=$?
if [[ $code8b -ne 0 ]]; then
  _pass "persession-no-owner: reconciler exits non-zero ($code8b) -- no candidate attests this change, fail closed"
else
  _fail "persession-no-owner: expected non-zero exit, got 0 -- output: $out8b"
fi
if echo "$out8b" | grep -qF "none attests this change $OURS_SHA"; then
  _pass "persession-no-owner: emitted the #379 concurrency hint (none attests this change)"
else
  _fail "persession-no-owner: expected the #379 'none attests this change' hint -- output: $out8b"
fi
if echo "$out8b" | grep -qF "bundle-required-no-declared-marker"; then
  _pass "persession-no-owner: emitted 'bundle-required-no-declared-marker' (same fail-closed path as bundle-absence)"
else
  _fail "persession-no-owner: expected 'bundle-required-no-declared-marker' -- output: $out8b"
fi

# 8c. BACK-COMPAT COEXISTENCE: a flat legacy owner (delivery/trust.bundle) alongside a stale
#     per-session sibling -> the flat owner is still selected and reconciled (the flat path
#     stays supported; per-session discovery does not break it).
CASE8C="$PERSESSION_TMPROOT/flat-owner-persession-stale"
write_fresh_bundle "$CASE8C" "$FRESH_LABEL_8"          # flat delivery/trust.bundle
write_stale_checkpoint "$CASE8C" "$OURS_SHA"           # flat delivery/trust.checkpoint.json (owns)
write_session_seal "$CASE8C" "stale-session" "echo ignored" "$STALE_SHA"  # per-session stale sibling
out8c="$(TRUST_RECONCILE_SHA="$OURS_SHA" TRUST_RECONCILE_COMMANDS="$FRESH_LABEL_8" \
  node "$RECONCILE" --repo-root "$CASE8C" 2>&1)"
code8c=$?
if [[ $code8c -eq 0 ]]; then
  _pass "flat-owner-coexist: reconciler exits 0 (flat legacy owner selected despite a stale per-session sibling)"
else
  _fail "flat-owner-coexist: expected exit 0, got $code8c -- output: $out8c"
fi
if echo "$out8c" | grep -qF "RECONCILED"; then
  _pass "flat-owner-coexist: Step 2 reconciled the flat owner (back-compat preserved)"
else
  _fail "flat-owner-coexist: expected RECONCILED -- output: $out8c"
fi

# 8d. PREFER-NEWEST among multiple OWNING candidates (the merge-commit-repo / concurrent-PR
#   coexistence case). An inherited FLAT bundle can attest a REAL ANCESTOR of this change
#   (committed on the trunk before this branch), AND this session's per-session bundle attests
#   a NEWER ancestor. "First-fresh-wins" would wrongly pick the stale flat bundle because it
#   sorts first; the reconciler must instead pick the NEWEST-owning candidate (the per-session
#   one). Uses a REAL git repo so `git merge-base --is-ancestor` resolves the parent→child
#   relationship (synthetic shas cannot exercise the ancestor comparison).
NEWEST_REPO="$PERSESSION_TMPROOT/prefer-newest-git"
mkdir -p "$NEWEST_REPO"
git -C "$NEWEST_REPO" init -q
git -C "$NEWEST_REPO" config user.email "test@example.com"
git -C "$NEWEST_REPO" config user.name "Test"
echo "base" > "$NEWEST_REPO/f.txt"; git -C "$NEWEST_REPO" add f.txt; git -C "$NEWEST_REPO" commit -q -m "base (inherited flat seal sealed here)"
FLAT_ANCESTOR_SHA="$(git -C "$NEWEST_REPO" rev-parse HEAD)"
echo "delivery" >> "$NEWEST_REPO/f.txt"; git -C "$NEWEST_REPO" add f.txt; git -C "$NEWEST_REPO" commit -q -m "this session's delivery commit"
PERSESSION_OWNER_SHA="$(git -C "$NEWEST_REPO" rev-parse HEAD)"
echo "head" >> "$NEWEST_REPO/f.txt"; git -C "$NEWEST_REPO" add f.txt; git -C "$NEWEST_REPO" commit -q -m "seal commit (HEAD)"
NEWEST_HEAD_SHA="$(git -C "$NEWEST_REPO" rev-parse HEAD)"
# Flat owner attesting the OLD ancestor; per-session owner attesting the NEWER ancestor.
write_fresh_bundle "$NEWEST_REPO" "$FRESH_LABEL_8"                 # flat delivery/trust.bundle
write_stale_checkpoint "$NEWEST_REPO" "$FLAT_ANCESTOR_SHA"          # flat checkpoint -> OLD ancestor
write_session_seal "$NEWEST_REPO" "this-session" "$FRESH_LABEL_8" "$PERSESSION_OWNER_SHA"  # per-session -> NEWER ancestor
out8d="$(TRUST_RECONCILE_SHA="$NEWEST_HEAD_SHA" TRUST_RECONCILE_COMMANDS="$FRESH_LABEL_8" \
  node "$RECONCILE" --repo-root "$NEWEST_REPO" 2>&1)"
code8d=$?
if [[ $code8d -eq 0 ]]; then
  _pass "prefer-newest: reconciler exits 0 (both flat and per-session own; newest selected)"
else
  _fail "prefer-newest: expected exit 0, got $code8d -- output: $out8d"
fi
if echo "$out8d" | grep -qF "selected delivery candidate delivery/this-session/trust.bundle"; then
  _pass "prefer-newest: selected the NEWER per-session bundle over the older inherited flat bundle"
else
  _fail "prefer-newest: expected the per-session bundle to be selected (newest-owning) -- output: $out8d"
fi
if echo "$out8d" | grep -qF "owning, newest wins"; then
  _pass "prefer-newest: emitted the 'owning, newest wins' selection detail"
else
  _fail "prefer-newest: expected 'owning, newest wins' in the selection line -- output: $out8d"
fi

# 9. [iteration-1 F1 CRITICAL regression guard] CI trust-reconcile.js MUST stay fail-closed
#   when scripts/ci/derive-claim-status.mjs is unavailable (Surface unresolvable, spawn
#   failure, malformed bundle, etc.) -- deriveClaimStatuses() returns null in that case, and
#   BEFORE #356's extraction the inline session-local loop turned every session-local
#   pass-asserting claim into a `status-underivable` divergence (hard FAIL). The extraction's
#   shared sessionLocalShapeIssues() briefly made that a caller-controlled `onUnderivable` mode
#   (see reconcile-shape.js) -- this section proves CI still defaults/forces the safe 'fail'
#   mode, and (paired) that the LOCAL reconcile-preflight intentionally diverges into the
#   'reduce' mode on the exact same bundle. Without the fix, case 9a below FAILS (exits 0
#   instead of 1) -- this is the single regression eval that let the CRITICAL through
#   code-review-356 iteration 0.
echo ""
echo "=== 9. derive-claim-status.mjs unavailable: CI fail-closed vs local-preflight reduced-coverage (iteration-1 F1) ==="

DERIVE_HELPER="$ROOT/scripts/ci/derive-claim-status.mjs"
DERIVE_HELPER_HIDDEN="$DERIVE_HELPER.hidden-by-test-9"

# hide_derive_helper / restore_derive_helper: rename the real ESM helper out of the way so
# scripts/ci/trust-reconcile.js's deriveClaimStatuses() -- which does fs.existsSync(helper)
# before ever spawning it -- returns null exactly as it would if Surface could not resolve.
# Always restored via trap, including on a hard failure of this script.
hide_derive_helper() {
  if [[ -f "$DERIVE_HELPER" ]]; then
    mv "$DERIVE_HELPER" "$DERIVE_HELPER_HIDDEN"
  fi
}
restore_derive_helper() {
  if [[ -f "$DERIVE_HELPER_HIDDEN" ]]; then
    mv "$DERIVE_HELPER_HIDDEN" "$DERIVE_HELPER"
  fi
}
trap 'cleanup_declared; rm -rf "$PERSESSION_TMPROOT"; restore_derive_helper' EXIT

# A one-claim, session-local, pass-asserting bundle (reuses the finding-3 exploit fixture --
# a human_attestation-backed claim asserting status "verified"; any session-local
# pass-asserting claim exercises this path since the whole derivedStatus map is null, not a
# single claim's lookup).
CASE9_BUNDLE="$FX/status-misassertion.json"

hide_derive_helper

# 9a. CI (real scripts/ci/trust-reconcile.js): derive-claim-status.mjs unavailable -> MUST
#     still exit non-zero (status-underivable, fail-closed) -- the pre-#356 guarantee.
out9a="$(TRUST_RECONCILE_COMMANDS="node -e 'process.exit(0)'" \
  node "$RECONCILE" --bundle "$CASE9_BUNDLE" --repo-root "$ROOT" 2>&1)"
code9a=$?
if [[ $code9a -ne 0 ]]; then
  _pass "derive-unavailable-ci: reconciler exits non-zero ($code9a) -- fail-closed preserved when re-derivation is unavailable"
else
  _fail "derive-unavailable-ci: expected non-zero exit (fail-closed), got 0 -- output: $out9a"
fi
if echo "$out9a" | grep -qF "[status-underivable]"; then
  _pass "derive-unavailable-ci: emitted the status-underivable divergence"
else
  _fail "derive-unavailable-ci: expected a [status-underivable] divergence -- output: $out9a"
fi
if echo "$out9a" | grep -qF "refusing to trust a self-reported status (fail-closed)"; then
  _pass "derive-unavailable-ci: emitted the verbatim fail-closed message"
else
  _fail "derive-unavailable-ci: expected the verbatim fail-closed message -- output: $out9a"
fi

# 9b. Paired proof the modes diverge intentionally: the LOCAL reconcile-preflight, on the
#     SAME bundle with the SAME helper hidden, DEGRADES -- it does not hard-fail on the
#     underivable-status dimension (it opts into reduce mode explicitly; see
#     src/cli/workflow-sidecar.ts's runReconcilePreflight).
# Nested under a subdirectory (not the raw mktemp -d path) -- mktemp -d's own
# "tmp.XXXXXXXXXX" basename contains a dot that path.extname()/artifactDirFrom() would
# misparse as a file extension, incorrectly stripping the directory segment.
CASE9_TMPROOT="$(mktemp -d)"
CASE9_SESSION="$CASE9_TMPROOT/session"
mkdir -p "$CASE9_SESSION"
cp "$CASE9_BUNDLE" "$CASE9_SESSION/trust.bundle"
out9b="$(flow_agents_node workflow-sidecar reconcile-preflight "$CASE9_SESSION" --repo-root "$ROOT" 2>&1)"
code9b=$?
rm -rf "$CASE9_TMPROOT"
if [[ $code9b -eq 0 ]]; then
  _pass "derive-unavailable-local-preflight: reconcile-preflight exits 0 (reduced-coverage degrade, not a hard fail) -- proves the CI/local modes diverge intentionally"
else
  _fail "derive-unavailable-local-preflight: expected exit 0 (reduced-coverage degrade), got $code9b -- output: $out9b"
fi
if echo "$out9b" | grep -qF "status-underivable"; then
  _fail "derive-unavailable-local-preflight: must NOT emit status-underivable in reduced-coverage mode -- output: $out9b"
else
  _pass "derive-unavailable-local-preflight: does not emit status-underivable (reduced-coverage checks only)"
fi

restore_derive_helper


echo ""
if [[ $errors -eq 0 ]]; then
  echo "test_trust_reconcile_negatives: all checks passed."
  exit 0
else
  echo "test_trust_reconcile_negatives: $errors check(s) failed."
  exit 1
fi
