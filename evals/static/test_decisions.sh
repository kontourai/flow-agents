#!/usr/bin/env bash
# test_decisions.sh — Decision registry validator + index generator checks.
# Covers: valid pass, each violation class (bad status, missing subject,
# secret-shaped evidence, tombstone -> missing slug), and index idempotency.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/check-decisions.cjs"

errors=0
pass() { echo "  PASS $1"; }
fail() { echo "  FAIL $1"; errors=$((errors + 1)); }

echo "=== Decision Registry Checks ==="

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

run_check() { FLOW_AGENTS_DECISIONS_DIR="$1" node "$SCRIPT" check >"$2" 2>&1; }
gen_index() { FLOW_AGENTS_DECISIONS_DIR="$1" node "$SCRIPT" gen-index >/dev/null 2>&1; }

valid_frontmatter() {
  cat <<'EOF'
---
status: current
subject: Example subject
decided: 2026-07-03
evidence:
  - kind: issue
    ref: https://github.com/kontourai/flow-agents/issues/310
---

# Example subject

The current answer.
EOF
}

# --- Case 1: valid file passes ---
D1="$WORK/valid"; mkdir -p "$D1"
valid_frontmatter >"$D1/example-subject.md"
gen_index "$D1"
if run_check "$D1" "$WORK/c1.log"; then
  pass "valid topic file + fresh index passes"
else
  fail "valid topic file should pass"; cat "$WORK/c1.log"
fi

# --- Case 2: unknown status fails ---
D2="$WORK/badstatus"; mkdir -p "$D2"
valid_frontmatter | sed 's/^status: current/status: accepted/' >"$D2/example-subject.md"
gen_index "$D2"
if run_check "$D2" "$WORK/c2.log"; then
  fail "unknown status should fail validation"
else
  grep -q "unknown status" "$WORK/c2.log" && pass "unknown status fails" || { fail "unknown status wrong error"; cat "$WORK/c2.log"; }
fi

# --- Case 3: missing subject fails ---
D3="$WORK/nosubject"; mkdir -p "$D3"
valid_frontmatter | grep -v '^subject:' >"$D3/example-subject.md"
gen_index "$D3"
if run_check "$D3" "$WORK/c3.log"; then
  fail "missing subject should fail validation"
else
  grep -q "subject" "$WORK/c3.log" && pass "missing subject fails" || { fail "missing subject wrong error"; cat "$WORK/c3.log"; }
fi

# --- Case 4: secret-shaped evidence ref fails ---
# The secret-shaped literal is assembled at runtime so no contiguous
# access-key-shaped token is committed to a tracked file (suite secret-scan gate).
D4="$WORK/secret"; mkdir -p "$D4"
FAKE_KEY="AKIA$(printf 'IOSFODNN7EXAMPLE')"
{
  printf -- '---\n'
  printf 'status: current\n'
  printf 'subject: Example subject\n'
  printf 'decided: 2026-07-03\n'
  printf 'evidence:\n'
  printf '  - kind: url\n'
  printf '    ref: "https://example.com/?token=%s"\n' "$FAKE_KEY"
  printf -- '---\n\n'
  printf '# Example subject\n'
} >"$D4/example-subject.md"
gen_index "$D4"
if run_check "$D4" "$WORK/c4.log"; then
  fail "secret-shaped evidence ref should fail validation"
else
  grep -q "secret-shaped" "$WORK/c4.log" && pass "secret-shaped evidence fails" || { fail "secret-shaped wrong error"; cat "$WORK/c4.log"; }
fi

# --- Case 5: tombstone pointing at missing slug fails ---
D5="$WORK/tombstone"; mkdir -p "$D5"
cat >"$D5/old-topic.md" <<'EOF'
---
status: superseded
subject: Old topic
decided: 2026-07-03
superseded_by: does-not-exist
evidence:
  - kind: issue
    ref: "#310"
---

# Old topic
EOF
gen_index "$D5"
if run_check "$D5" "$WORK/c5.log"; then
  fail "tombstone -> missing slug should fail validation"
else
  grep -q "missing topic slug" "$WORK/c5.log" && pass "tombstone -> missing slug fails" || { fail "tombstone wrong error"; cat "$WORK/c5.log"; }
fi

# --- Case 6: index idempotency (second gen is diff-clean) ---
D6="$WORK/idem"; mkdir -p "$D6"
valid_frontmatter >"$D6/example-subject.md"
gen_index "$D6"
cp "$D6/index.md" "$WORK/index-first.md"
gen_index "$D6"
if diff -q "$WORK/index-first.md" "$D6/index.md" >/dev/null; then
  pass "index regeneration is idempotent (diff-clean)"
else
  fail "index regeneration is not idempotent"; diff "$WORK/index-first.md" "$D6/index.md" || true
fi

# --- Case 7: check flags a stale index ---
D7="$WORK/stale"; mkdir -p "$D7"
valid_frontmatter >"$D7/example-subject.md"
gen_index "$D7"
printf '\nstale line\n' >>"$D7/index.md"
if run_check "$D7" "$WORK/c7.log"; then
  fail "stale index should fail validation"
else
  grep -q "stale" "$WORK/c7.log" && pass "stale index detected" || { fail "stale index wrong error"; cat "$WORK/c7.log"; }
fi

# --- Case 8: repo's own registry passes end-to-end ---
if node "$SCRIPT" check >"$WORK/c8.log" 2>&1; then
  pass "repo docs/decisions registry passes"
else
  fail "repo docs/decisions registry should pass"; cat "$WORK/c8.log"
fi

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "Decision registry checks: all passed."
  exit 0
fi
echo "Decision registry checks: $errors failed."
exit 1
