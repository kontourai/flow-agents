#!/usr/bin/env bash
# test_trust_reconcile_manifest.sh — WS8 (ADR 0020) manifest anti-gaming self-check.
#
# The reconcile manifest is evals/ci/run-baseline.sh's LANE_* registry (emitted via
# `--manifest-json`). This test proves the anti-gaming property design question 1 asked
# for — "a command in the manifest must actually run in a required lane" — holds by
# construction, and STAYS holding: it asserts the manifest id set and the set of checks
# invoked by .github/workflows/ci.yml's REQUIRED jobs are IDENTICAL. The advisory
# usage-feedback lane (continue-on-error, non-blocking) is excluded from BOTH the manifest and
# this required-set comparison (ADR 0020 iteration 2).
#
#   1. Every ci.yml `run-baseline.sh --check <slug>` invocation is a manifest entry.
#      → fails when a CHECKS entry is removed from EVERY LANE_* array (it drops out of
#        --manifest-json but ci.yml still invokes it): the anti-gaming coverage regresses.
#   2. Every manifest entry is invoked by a required ci.yml job.
#      → fails when a manifest/lane command is not wired into any required lane.
#
# Mirrors evals/ci/antigaming-suite.sh's own rationale (a protection with no required-lane
# coverage is not a real protection) applied reflexively to the manifest itself.
#
# Deterministic, no model spend, self-cleaning.
# Usage: bash evals/integration/test_trust_reconcile_manifest.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_BASELINE="$ROOT/evals/ci/run-baseline.sh"
CI_YML="$ROOT/.github/workflows/ci.yml"

errors=0
_pass() { echo "  PASS: $1"; }
_fail() { echo "  FAIL: $1"; errors=$((errors + 1)); }

echo "=== WS8 manifest self-check: manifest (run-baseline.sh LANE_*) == ci.yml required --check set ==="

if [[ ! -f "$RUN_BASELINE" ]]; then _fail "run-baseline.sh not found at $RUN_BASELINE"; fi
if [[ ! -f "$CI_YML" ]]; then _fail "ci.yml not found at $CI_YML"; fi

# Manifest ids (only lane-covered checks are emitted).
MANIFEST_JSON="$(bash "$RUN_BASELINE" --manifest-json 2>/dev/null)"
MANIFEST_IDS="$(printf '%s' "$MANIFEST_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const a=JSON.parse(d);for(const e of a){if(!e.lanes||!e.lanes.length){process.stderr.write("manifest entry with no lanes: "+e.id+"\n");process.exit(3);}console.log(e.id);}})' | sort -u)"
if [[ -z "$MANIFEST_IDS" ]]; then _fail "manifest is empty"; fi

# ci.yml required --check slugs. WS8 (ADR 0020, iteration 2): the usage-feedback lane is
# advisory (continue-on-error, non-blocking) and is intentionally EXCLUDED from the reconcile
# manifest, so its --check invocations are filtered out here too — the manifest is compared
# against the REQUIRED-lane --check set only. (All five usage-feedback checks slugify to the
# `usage-feedback-*` prefix and no required-lane check does, so the filter is exact.)
CI_SLUGS="$(grep -oE 'run-baseline\.sh --check [a-z0-9-]+' "$CI_YML" | awk '{print $NF}' | grep -v '^usage-feedback-' | sort -u)"
if [[ -z "$CI_SLUGS" ]]; then _fail "no required-lane run-baseline.sh --check invocations found in ci.yml"; fi

manifest_count="$(printf '%s\n' "$MANIFEST_IDS" | grep -c . )"
ci_count="$(printf '%s\n' "$CI_SLUGS" | grep -c . )"
echo "  manifest entries: $manifest_count ; ci.yml --check invocations: $ci_count"

# Direction 1: every ci.yml --check slug must be a manifest entry.
missing_in_manifest="$(comm -23 <(printf '%s\n' "$CI_SLUGS") <(printf '%s\n' "$MANIFEST_IDS"))"
if [[ -z "$missing_in_manifest" ]]; then
  _pass "every ci.yml required --check invocation is a manifest (lane-covered) entry"
else
  _fail "ci.yml invokes checks that are NOT in the manifest (removed from every LANE_* array?): $(echo "$missing_in_manifest" | tr '\n' ' ')"
fi

# Direction 2: every manifest entry must be invoked by a required ci.yml job.
missing_in_ci="$(comm -23 <(printf '%s\n' "$MANIFEST_IDS") <(printf '%s\n' "$CI_SLUGS"))"
if [[ -z "$missing_in_ci" ]]; then
  _pass "every manifest entry is invoked by a required ci.yml job (required-lane coverage by construction)"
else
  _fail "manifest entries NOT wired into any required ci.yml job: $(echo "$missing_in_ci" | tr '\n' ' ')"
fi

echo ""
if [[ $errors -eq 0 ]]; then
  echo "test_trust_reconcile_manifest: all checks passed."
  exit 0
else
  echo "test_trust_reconcile_manifest: $errors check(s) failed."
  exit 1
fi
