#!/usr/bin/env bash
# test_validate_source_kit_asset_scope.sh — src/tools/validate-source-tree.ts's
# validateLegacyRefs() kit-owned-asset exemption stays EXACT-PATH scoped.
#
# Context (fix pass, issue #303 follow-up): a prior draft of this exemption widened it to
# "any file in the same directory as a registered kit.json asset" (a directory-level
# exemption) to make an eval's reference to a kit skill's own helper script pass
# validate:source. That widening was reverted — the helper is now registered as its own
# kit.json "assets" entry (data-driven, no validator special-casing) — but the REAL risk
# the reviewer flagged deserves a permanent regression lock: a directory-level exemption
# would silence real missing-path detection for every OTHER (bogus, typo'd, deleted) file
# that happens to sit in the same directory as a legitimately registered asset, not just
# the intended one.
#
# This eval proves the negative: a reference to a FILE THAT DOES NOT EXIST, sitting in the
# SAME directory as a real, registered kit.json asset (Builder Kit's plan-work skill
# directory, which legitimately owns a registered SKILL.md), IS STILL FLAGGED by
# validate:source as a missing source path — never
# silently exempted just because it shares a directory with real registered assets.
#
# Mechanism: writes a throwaway eval-shaped fixture file (self-cleaning, removed in the
# trap) under evals/integration/ whose CONTENT (built at runtime, not hardcoded as a
# literal path string in THIS file's own source — see note below) references a bogus
# filename in that real kit skill directory, runs the REAL `npm run validate:source`
# against the REAL repo tree, asserts it fails and names the exact bogus path, then
# removes the throwaway fixture and re-confirms the repo is clean again. Deterministic, no
# model spend.
#
# Self-scan hazard: validate-source-tree's legacy-ref scanner walks EVERY .sh file under
# evals/, including this one. If the bogus path string were written as a literal in this
# file's own source text, this eval would trip its own probe merely by existing. The bogus
# ref/probe-file path strings below are therefore assembled at runtime from parts (never
# written as one contiguous literal anywhere in this file) so this file's own presence
# never becomes a false positive.
#
# Crash-resilience hazard (fix pass, second review round): the probe fixture below MUST
# live in a scanned directory (evals/integration/) for the negative probe to mean anything
# — but a SIGKILL/OOM/CI-timeout landing between the probe's write and this script's EXIT
# trap would leave it behind, permanently failing validate:source repo-wide for every
# future run until someone manually deletes it. Two defenses: (1) a SELF-HEALING
# PRE-FLIGHT, at the very top of this script before anything else runs (including the
# positive control), that deletes any file matching this eval's own narrowly-scoped
# probe-name glob and logs a loud line when it heals one — this is the defense that
# actually matters if the crash window is ever hit; (2) the EXIT trap is kept as the
# normal-path cleanup, and the probe write is placed as late as possible (immediately
# before the validate:source call that depends on it) to narrow the window. The glob is
# deliberately a literal, distinctive prefix this eval alone uses (never a generic
# wildcard) so the self-heal can never match — and therefore never delete — any real,
# non-probe file.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

errors=0
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

# Narrowly-scoped probe-name glob prefix — every probe fixture this eval ever writes
# (negative-probe or self-heal-regression-test fixtures alike) MUST start with this exact
# literal prefix, and nothing else in the repo may. This is what makes the self-heal safe:
# it can only ever match files THIS eval itself creates.
PROBE_GLOB_PREFIX="test__scope_probe_"

# Delete any stale probe fixture(s) matching PROBE_GLOB_PREFIX under evals/integration/,
# logging a loud line per file healed. Called at pre-flight (below) AND directly by the
# self-heal regression assertion later in this file (as a lightweight in-process function
# call, not a recursive re-invocation of this whole script — re-running the full script,
# with its several npm run validate:source calls, is too heavy to use as the mechanism for
# a single targeted assertion).
heal_stale_probes() {
  local stale_probes=("$ROOT"/evals/integration/${PROBE_GLOB_PREFIX}*)
  if [[ -e "${stale_probes[0]}" ]]; then
    for stale in "${stale_probes[@]}"; do
      echo "  ⚠ SELF-HEAL: removing stale probe fixture left behind by an interrupted prior run: $stale"
      rm -f "$stale"
    done
  fi
}

# --pre-flight-only: run ONLY the self-healing pre-flight (heal_stale_probes) and exit,
# skipping every npm run validate:source call in the rest of this script. Exists solely so
# the end-to-end self-heal assertion below can exercise the REAL pre-flight wiring at the
# top of this script (not just heal_stale_probes() called in isolation) as a fresh
# subprocess, WITHOUT paying for a full second run of this eval's several
# npm run validate:source builds — keeps the added runtime bounded to one lightweight
# glob-and-delete pass, not a second full eval run.
if [[ "${1:-}" == "--pre-flight-only" ]]; then
  heal_stale_probes
  exit 0
fi

echo "=== validate-source-tree kit-asset exemption stays exact-path scoped (no directory-level exemption) ==="

# --- Self-healing pre-flight (reviewer HIGH: hard-kill/OOM/CI-timeout resilience) -
heal_stale_probes

# Real skill directory + its two REAL registered kit.json assets (assembled from parts —
# see the self-scan hazard note above; these ARE real, existing paths, so splitting them
# is purely to avoid THIS descriptive assertion accidentally reading as a probe target).
KIT_DIR="kits/builder"
REAL_SKILL_DIR="$KIT_DIR/skills""/plan-work"
REAL_SKILL_MD="$REAL_SKILL_DIR/SKILL.md"
# kit.json's own "path" fields are relative to the KIT directory, not the repo root.
KIT_RELATIVE_SKILL_MD="${REAL_SKILL_MD#"$KIT_DIR/"}"

# --- Sanity: the real skill and its kit registration exist -----------------------
if [[ -f "$ROOT/$REAL_SKILL_MD" ]]; then
  pass "real skill file is present (SKILL.md)"
else
  fail "expected real skill file missing — cannot run the negative probe against a real fixture"
fi

if grep -qF "\"path\": \"$KIT_RELATIVE_SKILL_MD\"" "$ROOT/$KIT_DIR/kit.json"; then
  pass "skill file is registered in kit.json"
else
  fail "kit.json does not register the real skill file as expected"
fi

# --- Positive control: validate:source passes on the clean, real tree -----------
if npm run validate:source > /tmp/vskas_positive.out 2>&1; then
  pass "positive control: npm run validate:source passes on the clean tree (no probe fixture present)"
else
  fail "positive control: npm run validate:source unexpectedly failed on the clean tree — cannot trust the negative probe below"; tail -20 /tmp/vskas_positive.out
fi

# --- Negative probe: a BOGUS sibling filename in the SAME real directory is flagged --
# Assembled from parts at runtime (see self-scan hazard note above) — this exact
# contiguous string never appears anywhere else in this file's own source text.
BOGUS_FILENAME_PART1="this-file-does-not"
BOGUS_FILENAME_PART2="-exist-probe.mjs"
# NOTE: legacyRefRe (validate-source-tree.ts) matches starting at recognized top-level
# prefixes (skills / evals / scripts / etc — see the regex in validate-source-tree.ts),
# not at "kits" — so the ref as written in the probe fixture (and as reported in
# validate:source's failure output) is kit-directory-relative, not repo-root-relative. Use
# the kit-relative form here to match what the scanner actually records. Built from parts
# (never one contiguous literal in this file's own comments or code) for the same
# self-scan-hazard reason noted at the top of this file.
BOGUS_REF="skills""/plan-work/$BOGUS_FILENAME_PART1$BOGUS_FILENAME_PART2"
PROBE_FILE_NAME_PART1="${PROBE_GLOB_PREFIX}bogus"
PROBE_FILE_NAME_PART2="_ref.sh"
PROBE_FILE="$ROOT/evals/integration/$PROBE_FILE_NAME_PART1$PROBE_FILE_NAME_PART2"

cleanup() {
  rm -f "$PROBE_FILE"
}
trap cleanup EXIT

# Content-writer for a throwaway probe fixture — factored out so the self-heal regression
# assertion below can plant an equivalent stale fixture without duplicating the heredoc.
write_probe_fixture() {
  local target="$1"
  {
    echo "#!/usr/bin/env bash"
    echo "# Throwaway probe fixture (self-removing) — exists only for the duration of"
    echo "# test_validate_source_kit_asset_scope.sh's negative-probe assertion."
    echo "HELPER=\"\$KIT/$BOGUS_REF\""
  } > "$target"
}

# Write the probe fixture as LATE as possible (immediately before the validate:source call
# that depends on it) to narrow the window a hard-kill could land in between write and
# cleanup — this is the second line of defense; the self-healing pre-flight above is the
# first (and the one that actually matters if this window is ever hit).
write_probe_fixture "$PROBE_FILE"

if npm run validate:source > /tmp/vskas_negative.out 2>&1; then
  fail "negative probe: validate:source PASSED with a bogus sibling-file reference present — the exemption is over-wide (directory-level), not exact-path"
else
  pass "negative probe: validate:source FAILS (exit non-zero) with a bogus sibling-file reference present"
fi

if grep -qF "references missing source path: $BOGUS_REF" /tmp/vskas_negative.out; then
  pass "negative probe: failure output names the exact bogus path ($BOGUS_REF) — real missing-path detection is not silenced by directory proximity to registered assets"
else
  fail "negative probe: expected failure output to name the bogus path — output: $(tail -20 /tmp/vskas_negative.out)"
fi

# --- Cleanup verification: removing the probe restores a clean, passing tree ----
rm -f "$PROBE_FILE"
if npm run validate:source > /tmp/vskas_cleanup.out 2>&1; then
  pass "cleanup: npm run validate:source passes again once the throwaway probe fixture is removed"
else
  fail "cleanup: npm run validate:source did not pass again after removing the probe fixture"; tail -20 /tmp/vskas_cleanup.out
fi

# --- Self-heal regression lock: a STALE probe left by a simulated hard-kill is healed ---
# Simulates exactly the failure mode this fix pass addresses: a probe fixture left behind
# by an interrupted prior run (no EXIT trap ever ran for it, since this write below is
# deliberately NOT wrapped in this script's own trap/cleanup — it models "the process died
# before its trap could fire"). Exercises heal_stale_probes() DIRECTLY (a lightweight
# in-process function call — NOT a recursive re-invocation of this whole script, which
# would be several redundant npm run validate:source builds just to prove one glob-delete
# works) and confirms it heals: the file is removed and a loud line names it.
STALE_PROBE_FILE_PART1="${PROBE_GLOB_PREFIX}stale"
STALE_PROBE_FILE_PART2="_simulated.sh"
STALE_PROBE_FILE="$ROOT/evals/integration/$STALE_PROBE_FILE_PART1$STALE_PROBE_FILE_PART2"
write_probe_fixture "$STALE_PROBE_FILE"
if [[ -f "$STALE_PROBE_FILE" ]]; then
  pass "self-heal setup: pre-planted a stale probe fixture (simulating an interrupted prior run with no trap-driven cleanup)"
else
  fail "self-heal setup: failed to pre-plant the stale probe fixture — cannot exercise the self-heal assertion below"
fi

HEAL_OUT="$(heal_stale_probes 2>&1)"

if echo "$HEAL_OUT" | grep -qF "SELF-HEAL: removing stale probe fixture left behind by an interrupted prior run: $STALE_PROBE_FILE"; then
  pass "self-heal: heal_stale_probes() logged a loud SELF-HEAL line naming the exact stale probe path it removed"
else
  fail "self-heal: expected a loud SELF-HEAL line naming the stale probe path — output: $HEAL_OUT"
fi

if [[ ! -e "$STALE_PROBE_FILE" ]]; then
  pass "self-heal: the stale probe fixture no longer exists after heal_stale_probes() ran (healed, not just logged)"
else
  fail "self-heal: the stale probe fixture STILL EXISTS after heal_stale_probes() ran — self-heal did not actually delete it"
  rm -f "$STALE_PROBE_FILE"
fi

# End-to-end confirmation: a FRESH invocation of this eval (its own pre-flight, not a
# hand-called function) also heals a pre-planted stale probe and still passes overall —
# proves the pre-flight wiring at the top of this script, not just the helper function in
# isolation. This is the one genuinely-recursive re-invocation in this file; kept to
# exactly one (not three, as an earlier draft did) to bound the added runtime.
write_probe_fixture "$STALE_PROBE_FILE"
FRESH_RUN_OUT="$(bash "$ROOT/evals/static/test_validate_source_kit_asset_scope.sh" --pre-flight-only 2>&1)"
FRESH_RUN_CODE=$?

if echo "$FRESH_RUN_OUT" | grep -qF "SELF-HEAL: removing stale probe fixture left behind by an interrupted prior run: $STALE_PROBE_FILE"; then
  pass "self-heal (end-to-end): a fresh --pre-flight-only invocation of this eval's own pre-flight healed the pre-planted stale probe"
else
  fail "self-heal (end-to-end): expected the fresh invocation to log a loud SELF-HEAL line naming the stale probe — output: $(echo "$FRESH_RUN_OUT" | head -10)"
fi

if [[ ! -e "$STALE_PROBE_FILE" ]]; then
  pass "self-heal (end-to-end): the stale probe fixture no longer exists after the fresh --pre-flight-only invocation"
else
  fail "self-heal (end-to-end): the stale probe fixture STILL EXISTS after the fresh invocation"
  rm -f "$STALE_PROBE_FILE"
fi

if [[ "$FRESH_RUN_CODE" -eq 0 ]]; then
  pass "self-heal (end-to-end): the fresh --pre-flight-only invocation exits 0"
else
  fail "self-heal (end-to-end): the fresh --pre-flight-only invocation exited $FRESH_RUN_CODE (expected 0) — output: $(echo "$FRESH_RUN_OUT" | tail -10)"
fi

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "PASS: validate-source-tree kit-asset exemption is exact-path scoped (no directory-level widening)"
  exit 0
else
  echo "FAIL: $errors check(s) failed"
  exit 1
fi
