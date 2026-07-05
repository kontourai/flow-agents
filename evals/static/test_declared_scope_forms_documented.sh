#!/usr/bin/env bash
# test_declared_scope_forms_documented.sh — AC8 (issue #303/#304 residue): delivery/README.md
# documents all four DECLARED scope forms, the compound (space-separated AND) form, and the
# author:/branch-prefix: combining requirement for identity exemptions.
#
# Sourced from scripts/ci/trust-reconcile.js's matchesScopeCondition()/matchesScope() (the
# actual implemented semantics — string equality/prefix only, never RegExp) and ADR 0022 §2 +
# the 2026-07-03 addendum. This is a documentation-coverage lock: if delivery/README.md's
# scope-forms section is ever removed or one of the four forms silently drops out, this eval
# fails loudly, naming what's missing.
#
# Deterministic, no model spend, no fixtures.
# Usage: bash evals/static/test_declared_scope_forms_documented.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DOC="$ROOT/delivery/README.md"

errors=0
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

echo "=== delivery/README.md DECLARED scope-forms documentation coverage (AC8) ==="

if [[ -f "$DOC" ]]; then
  pass "delivery/README.md exists"
else
  fail "delivery/README.md is missing — cannot check scope-forms documentation"
  echo ""
  echo "FAIL: 1 check(s) failed"
  exit 1
fi

# --- The four single-condition scope forms --------------------------------------
if grep -qF 'ref:' "$DOC"; then
  pass "documents the ref: scope form"
else
  fail "delivery/README.md does not mention the ref: scope form"
fi

if grep -qF 'commit:' "$DOC"; then
  pass "documents the commit: scope form"
else
  fail "delivery/README.md does not mention the commit: scope form"
fi

if grep -qF 'author:' "$DOC"; then
  pass "documents the author: scope form"
else
  fail "delivery/README.md does not mention the author: scope form"
fi

if grep -qF 'branch-prefix:' "$DOC"; then
  pass "documents the branch-prefix: scope form"
else
  fail "delivery/README.md does not mention the branch-prefix: scope form"
fi

# --- commit: range form (commit:a..b), not just the bare single-sha form --------
if grep -qE 'commit:[^[:space:]]*\.\.' "$DOC"; then
  pass "documents the commit:<from>..<to> RANGE form, not just a bare single-sha example"
else
  fail "delivery/README.md does not show a commit:<from>..<to> range example"
fi

# --- Compound (space-separated AND) scope form -----------------------------------
if grep -qiE 'compound|space-separated' "$DOC"; then
  pass "documents the compound (space-separated) scope form"
else
  fail "delivery/README.md does not mention a compound/space-separated scope form"
fi

if grep -qiE '\bAND\b|ANDed' "$DOC"; then
  pass "documents that compound conditions are ANDed (all must match)"
else
  fail "delivery/README.md does not state that compound scope conditions are ANDed"
fi

# --- author:/branch-prefix: combining requirement for identity exemptions -------
if grep -qiE 'pusher-controlled|pusher-chosen' "$DOC"; then
  pass "documents the fork-PR pusher-controlled ref/branch-prefix weakness motivating the combining requirement"
else
  fail "delivery/README.md does not explain why ref:/branch-prefix: alone are insufficient for identity exemptions (pusher-controlled branch names)"
fi

if grep -qiE 'MUST combine|combine.*author:|author:.*combine' "$DOC"; then
  pass "documents that an identity-binding scope MUST combine author: with a second condition"
else
  fail "delivery/README.md does not state the author:+branch-prefix:/ref: combining requirement"
fi

# --- The real worked example (release-please compound scope) --------------------
if grep -qF 'author:github-actions[bot] branch-prefix:release-please--' "$DOC"; then
  pass "shows the real worked compound-scope example (release-please: author: + branch-prefix:)"
else
  fail "delivery/README.md does not show the real release-please compound-scope worked example"
fi

# --- Matching semantics: string equality/prefix only, never RegExp --------------
if grep -qiE 'no.*RegExp|never.*RegExp' "$DOC"; then
  pass "documents that matching is string equality/prefix only — no RegExp is ever constructed from marker content"
else
  fail "delivery/README.md does not state the no-RegExp matching-semantics note"
fi

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "PASS: delivery/README.md documents all four DECLARED scope forms, compound-AND, and the identity-combining requirement"
  exit 0
else
  echo "FAIL: $errors check(s) failed"
  exit 1
fi
