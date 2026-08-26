#!/usr/bin/env bash
# test_console_declared_projection.sh - Accepted-gap (delivery/DECLARED) projection contract (#1267)
#
# Proves the transport-agnostic fold of delivery/DECLARED structured gaps[] entries:
#   - one aging record per declared gap, carrying declared_at / approved_by / scope verbatim;
#   - NO prose scraping: legacy entries are never projected, and their count is disclosed in
#     the projection's own summary (absence visible, not silent);
#   - invalid gaps[] shapes and ADR-0022-malformed entries are warned and skipped, never
#     silently degraded to legacy;
#   - per-scope upsert: rerunning replaces the same destination file byte-stably (fixed
#     --generated-at), and a shrunk marker shrinks the projection (fold of current state);
#   - fail-visible on corruption: a JSON-invalid marker exits 1 and writes nothing (an empty
#     projection over a corrupt marker would silently erase every standing gap);
#   - source marker is never mutated.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

FIXTURE="$ROOT/evals/fixtures/console-declared-projection/DECLARED"
TMPDIR_EVAL="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/eval-console-declared-projection.XXXXXX")" && pwd -P)"
KONTOUR_ROOT="$TMPDIR_EVAL/.kontourai/console"
GENERATED_AT="2026-08-17T00:00:00Z"
PROJECTION="$KONTOUR_ROOT/projections/flow-agents-declared/repo-fixture-repo.json"
pass=0
fail=0

cleanup() {
  rm -rf "$TMPDIR_EVAL"
}
trap cleanup EXIT

_pass() { echo "  ✓ $1"; pass=$((pass + 1)); }
_fail() { echo "  ✗ $1"; fail=$((fail + 1)); }

echo "=== Layer 2: Console Declared (accepted-gap) Projection ==="
echo ""

mkdir -p "$TMPDIR_EVAL/delivery"
cp "$FIXTURE" "$TMPDIR_EVAL/delivery/DECLARED"
shasum -a 256 "$TMPDIR_EVAL/delivery/DECLARED" >"$TMPDIR_EVAL/before.sha"

if flow_agents_build_ts 2>"$TMPDIR_EVAL/build.err"; then
  _pass "TypeScript CLI build is available"
else
  _fail "TypeScript CLI build failed: $(cat "$TMPDIR_EVAL/build.err" 2>/dev/null)"
fi

if node "$ROOT/build/src/cli.js" console-declared-projection \
  --declared "$TMPDIR_EVAL/delivery/DECLARED" \
  --kontour-root "$KONTOUR_ROOT" \
  --scope fixture-repo \
  --scope-kind repo \
  --producer flow-agents-declared \
  --generated-at "$GENERATED_AT" \
  --json >"$TMPDIR_EVAL/run.json" 2>"$TMPDIR_EVAL/run.err"; then
  _pass "CLI writes projection from fixture DECLARED marker"
else
  _fail "CLI failed: $(cat "$TMPDIR_EVAL/run.err" 2>/dev/null)"
fi

if [[ -f "$PROJECTION" ]]; then
  _pass "projection file exists at expected producer and scope path (per-scope upsert destination)"
else
  _fail "projection file missing at $PROJECTION"
fi

if jq -e --arg path "$PROJECTION" '
  .scanned_entry_count == 6 and
  .structured_gap_entry_count == 2 and
  .legacy_entries_not_projected == 2 and
  .invalid_entries_not_projected == 2 and
  .emitted_gap_count == 2 and
  .destination == $path and
  .producer == "flow-agents-declared" and
  .scope == {"kind":"repo","id":"fixture-repo"} and
  .dry_run == false
' "$TMPDIR_EVAL/run.json" >/dev/null 2>&1; then
  _pass "JSON summary discloses legacy-not-projected and invalid-not-projected counts (absence visible)"
else
  _fail "JSON summary missing expected counts: $(cat "$TMPDIR_EVAL/run.json" 2>/dev/null)"
fi

if jq -e '(.warnings | length) == 2 and (.warnings | map(test("not projected")) | all)' "$TMPDIR_EVAL/run.json" >/dev/null 2>&1; then
  _pass "invalid gaps[] shape and malformed entry each produce a named warning"
else
  _fail "expected two 'not projected' warnings: $(cat "$TMPDIR_EVAL/run.json" 2>/dev/null)"
fi

echo ""
echo "--- Projection Contract ---"

if jq -e --arg generated "$GENERATED_AT" '
  .schema == "kontour.console.projection" and
  .version == "0.1" and
  .generatedAt == $generated and
  .scope == {"kind":"repo","id":"fixture-repo"} and
  .producer == {"id":"flow-agents-declared","product":"flow-agents"} and
  .derivedFrom.mode == "direct_snapshot" and
  .derivedFrom.eventHistory == "unavailable" and
  .derivedFrom.directSnapshot.emittedAt == $generated and
  .derivedFrom.directSnapshot.sourceRef == {"product":"flow-agents","kind":"delivery-declared","id":"delivery/DECLARED","label":"Committed no-agent-delivery exemption marker (ADR 0022 §2)"} and
  (.gaps | length) == 2
' "$PROJECTION" >/dev/null 2>&1; then
  _pass "projection envelope includes Console schema, scope, producer, and direct snapshot provenance"
else
  _fail "projection envelope is missing required Console contract fields"
fi

if jq -e '
  all(.gaps[]; .family == "delivery" and .nonAuthority == true and .source == "delivery/DECLARED"
    and (.id | test("^gap\\.declared\\.[0-9a-f]{16}$"))
    and .scope == "branch-prefix:feat/fixture-structured"
    and .declared_at == "2026-07-10T12:00:00Z"
    and .approved_by == "fixture-approver") and
  (.gaps | map(.id) | unique | length) == 2 and
  (.gaps | map(.gap)) == ["trend readings have no automatic reader", "hosted CI does not run the process-heavy suite"]
' "$PROJECTION" >/dev/null 2>&1; then
  _pass "each gap record is one aging row: gap text + declared_at timestamp + scope + approver, stable content-derived id"
else
  _fail "gap records do not match the #1267 record contract"
fi

if jq -e '
  ([.gaps[].gap] | map(test("automatic reader for trend data")) | any) == false and
  ([.gaps[].scope] | map(. == "author:fixture-bot[bot]") | any) == false
' "$PROJECTION" >/dev/null 2>&1; then
  _pass "legacy entry prose is never scraped into gap records"
else
  _fail "a legacy entry's prose leaked into the projection"
fi

# --- Upsert semantics: byte-stable rerun, then a shrunk marker shrinks the projection ---
cp "$PROJECTION" "$TMPDIR_EVAL/projection-first.json"
if node "$ROOT/build/src/cli.js" console-declared-projection \
  --declared "$TMPDIR_EVAL/delivery/DECLARED" \
  --kontour-root "$KONTOUR_ROOT" \
  --scope fixture-repo \
  --scope-kind repo \
  --producer flow-agents-declared \
  --generated-at "$GENERATED_AT" \
  --json >"$TMPDIR_EVAL/run-second.json" 2>/dev/null; then
  if cmp -s "$TMPDIR_EVAL/projection-first.json" "$PROJECTION"; then
    _pass "projection output is byte-stable with fixed generated-at (idempotent upsert)"
  else
    _fail "projection output changed across fixed-timestamp runs"
  fi
else
  _fail "second deterministic run failed"
fi

jq '[.[] | select(.scope != "branch-prefix:feat/fixture-structured")]' "$TMPDIR_EVAL/delivery/DECLARED" >"$TMPDIR_EVAL/delivery/DECLARED.shrunk"
if node "$ROOT/build/src/cli.js" console-declared-projection \
  --declared "$TMPDIR_EVAL/delivery/DECLARED.shrunk" \
  --kontour-root "$KONTOUR_ROOT" \
  --scope fixture-repo \
  --scope-kind repo \
  --producer flow-agents-declared \
  --generated-at "$GENERATED_AT" \
  --json >"$TMPDIR_EVAL/run-shrunk.json" 2>/dev/null \
  && jq -e '(.gaps | length) == 0' "$PROJECTION" >/dev/null 2>&1; then
  _pass "per-scope upsert replaces state wholesale: a withdrawn entry's gaps leave the projection"
else
  _fail "shrunk marker did not shrink the upserted projection"
fi

# --- Fail-visible on corruption: invalid JSON exits 1 and does not clobber the projection ---
node "$ROOT/build/src/cli.js" console-declared-projection \
  --declared "$TMPDIR_EVAL/delivery/DECLARED" \
  --kontour-root "$KONTOUR_ROOT" \
  --scope fixture-repo \
  --generated-at "$GENERATED_AT" >/dev/null 2>&1
printf '{"scope":"truncated' >"$TMPDIR_EVAL/delivery/DECLARED.corrupt"
if node "$ROOT/build/src/cli.js" console-declared-projection \
  --declared "$TMPDIR_EVAL/delivery/DECLARED.corrupt" \
  --kontour-root "$KONTOUR_ROOT" \
  --scope fixture-repo \
  --generated-at "$GENERATED_AT" >"$TMPDIR_EVAL/corrupt.out" 2>"$TMPDIR_EVAL/corrupt.err"; then
  _fail "corrupt marker was folded instead of failing visibly"
else
  if grep -q "not valid JSON" "$TMPDIR_EVAL/corrupt.err" && jq -e '(.gaps | length) == 2' "$PROJECTION" >/dev/null 2>&1; then
    _pass "corrupt marker exits non-zero and leaves the previous projection intact (never erases standing gaps)"
  else
    _fail "corrupt-marker failure did not preserve the previous projection or name the parse error"
  fi
fi

# --- Missing marker is a real zero-gap state (not an error) ---
if node "$ROOT/build/src/cli.js" console-declared-projection \
  --declared "$TMPDIR_EVAL/delivery/DOES_NOT_EXIST" \
  --kontour-root "$KONTOUR_ROOT" \
  --scope fixture-repo \
  --generated-at "$GENERATED_AT" \
  --json >"$TMPDIR_EVAL/run-missing.json" 2>/dev/null \
  && jq -e '.scanned_entry_count == 0 and .emitted_gap_count == 0 and ((.warnings | map(test("not found")) | any))' "$TMPDIR_EVAL/run-missing.json" >/dev/null 2>&1; then
  _pass "absent marker projects zero gaps with a disclosed warning (real empty state, not corruption)"
else
  _fail "absent marker handling incorrect: $(cat "$TMPDIR_EVAL/run-missing.json" 2>/dev/null)"
fi

shasum -a 256 "$TMPDIR_EVAL/delivery/DECLARED" >"$TMPDIR_EVAL/after.sha"
if cmp -s "$TMPDIR_EVAL/before.sha" "$TMPDIR_EVAL/after.sha"; then
  _pass "source DECLARED marker is byte-for-byte unchanged"
else
  _fail "source DECLARED marker changed after projection command"
fi

echo ""
echo "Result: $pass passed, $fail failed"
if [[ "$fail" -gt 0 ]]; then
  exit 1
fi
