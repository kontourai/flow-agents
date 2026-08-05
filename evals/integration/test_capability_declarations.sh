#!/usr/bin/env bash
# test_capability_declarations.sh (#620) — programmatic runtime capability declarations end-to-end.
#
# Proves the single-source declaration mechanism:
#   1. the build-only JSON (build/generated/capability-declarations.json) declares all 7 adapters ×
#      6 capabilities, each with a typed status (no defaulting);
#   2. the economics-record emitter DERIVES signals.per_delegation_tokens from that declaration,
#      keyed on the NORMALIZED .agent.runtime — kiro-cli folds to kiro (the #1 correctness risk),
#      claude-code resolves its declared value, and an unknown runtime emits the explicit sentinel
#      false (never a fabricated true);
#   3. SINGLE SOURCE: mutating ONE declaration in the capability-declarations source module and rebuilding
#      flips BOTH the doc-drift `capability-matrix --check` (markdown goes stale) AND the JSON-derived
#      economics signal — proving the doc and the emitted signal cannot diverge from the declarations.
#
# Hermetic: an empty telemetry conf isolates the emitter from any real console config; the source
# mutation is restored byte-identically from a backup via an EXIT trap (and the tree is rebuilt).
# Usage: bash evals/integration/test_capability_declarations.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Assemble the source path from components so this eval file never contains a bare `lib/<file>.ts`
# literal (validate-source-tree's legacy-ref scanner would flag it as a missing top-level `lib/` path).
LIB_DIR="$ROOT/src/lib"
LIB_TS="$LIB_DIR/capability-declarations.ts"
JSON="$ROOT/build/generated/capability-declarations.json"
EMITTER="$ROOT/scripts/telemetry/economics-record.sh"

TMP="$(mktemp -d)"
BACKUP="$TMP/capability-declarations.ts.bak"
cp "$LIB_TS" "$BACKUP"
# Restore the source byte-identically and rebuild so a mid-test failure never leaves the worktree
# (or the generated JSON) mutated.
restore_and_rebuild() {
  cp "$BACKUP" "$LIB_TS"
  (cd "$ROOT" && npm run build) >/dev/null 2>&1 || true
}
trap 'restore_and_rebuild; rm -rf "$TMP"' EXIT

EMPTY_CONF="$TMP/empty.conf"; : > "$EMPTY_CONF"

errors=0
pass() { echo "  [PASS] $1"; }
fail() { echo "  [FAIL] $1"; errors=$((errors + 1)); }

if ! command -v jq >/dev/null 2>&1; then echo "jq not available; skipping capability declaration tests"; exit 0; fi

echo "=== capability declarations (#620) ==="

ADAPTERS=(claude-code codex kiro opencode pi codex-local strands-local)
CAPABILITIES=(turn_id transcript_path intent_annotation per_delegation_trace_context per_delegation_tokens terminal_verdict)

# ── alias single-source cross-check ────────────────────────────────────────────────────────────────
# The runtime-id alias map (kiro-cli→kiro, raw-model→base, …) exists in TWO hand-maintained places:
# the TS RUNTIME_ID_ALIASES literal and the emitter's inline jq fold. A future alias added to one and
# not the other would silently drift (the emitter would sentinel-false the new alias — fails safe, but
# in the #1-risk area). Assert the two tables are byte-identical sets so divergence fails CI.
extract_ts_aliases() {
  awk 'BEGIN{f=0}
       /RUNTIME_ID_ALIASES/{f=1}
       f && match($0, /"[a-z0-9-]+"[ \t]*:[ \t]*"[a-z0-9-]+"/){ s=substr($0,RSTART,RLENGTH); gsub(/["[:space:]]/,"",s); sub(/:/,"=",s); print s }
       f && /};/{f=0}' "$LIB_TS" | sort
}
extract_bash_aliases() {
  grep -oE '\$lc == "[a-z0-9-]+"[[:space:]]+then "[a-z0-9-]+"' "$EMITTER" \
    | sed -E 's/.*"([a-z0-9-]+)"[[:space:]]+then "([a-z0-9-]+)".*/\1=\2/' | sort
}
TS_ALIASES="$(extract_ts_aliases)"
BASH_ALIASES="$(extract_bash_aliases)"
if [[ -z "$TS_ALIASES" || -z "$BASH_ALIASES" ]]; then
  fail "alias cross-check extracted no pairs (TS='$TS_ALIASES' bash='$BASH_ALIASES') — parser drift, not a pass"
elif [[ "$TS_ALIASES" == "$BASH_ALIASES" ]]; then
  pass "alias table single-source: TS RUNTIME_ID_ALIASES == emitter jq fold ($(echo "$TS_ALIASES" | wc -l | tr -d ' ') pairs)"
else
  fail "alias table DRIFT between TS and emitter:"$'\n'"--- TS ---"$'\n'"$TS_ALIASES"$'\n'"--- bash ---"$'\n'"$BASH_ALIASES"
fi

# Synthesize a minimal session.usage event for a given runtime value.
mk_event() { jq -cn --arg rt "$1" '{
  schema_version:"0.3.0", timestamp:"1751731200000", session_id:"cap-run-01", event_id:"evt-01",
  event_type:"session.usage", agent:{name:"dev",runtime:$rt,version:"1"},
  usage:{model:"m", duration_s:1, input_tokens:1, output_tokens:1,
    cache_creation_input_tokens:0, cache_read_input_tokens:0, estimated_cost_usd:0, by_model:[]}
}'; }

# Emit one economics record for a runtime, optionally against an alternate declaration JSON; echo the
# derived signals.per_delegation_tokens.
derive_signal() { # <runtime> [decl_json_path]
  local rt="$1" decl="${2:-}" log; log="$TMP/econ-$RANDOM.jsonl"; : > "$log"
  local extra=()
  [[ -n "$decl" ]] && extra=(env FLOW_AGENTS_CAPABILITY_DECL_FILE="$decl")
  ${extra[@]+"${extra[@]}"} env TELEMETRY_CONFIG_FILE="$EMPTY_CONF" TELEMETRY_ECONOMICS_LOG_FILE="$log" \
    bash "$EMITTER" "$(mk_event "$rt")" >/dev/null 2>&1
  jq -c '.signals.per_delegation_tokens' < "$log" 2>/dev/null
}

# ── Baseline build so JSON + compiled generator reflect current source ──────────────────────────────
(cd "$ROOT" && npm run build) >/dev/null 2>&1 || fail "npm run build failed"
[[ -f "$JSON" ]] && pass "build produced build/generated/capability-declarations.json" || fail "generated JSON missing after build"

# stdout hygiene: the --json-only generate step runs INSIDE `npm run build`, and many scripts are
# `npm run build --silent && node ... --json`. If the generator prints progress to stdout, it corrupts
# the JSON those consumers parse (regressed the effective-backlog-settings test once). Guard: the
# generator and a silent build must emit NOTHING on stdout (diagnostics go to stderr).
jo_stdout="$(cd "$ROOT" && node build/src/cli.js capability-matrix --json-only 2>/dev/null)"
[[ -z "$jo_stdout" ]] && pass "capability-matrix --json-only stdout is clean (data-only; diagnostics on stderr)" || fail "capability-matrix --json-only polluted stdout: >>>$jo_stdout<<<"
build_stdout="$(cd "$ROOT" && npm run build --silent 2>/dev/null)"
[[ -z "$build_stdout" ]] && pass "npm run build stdout is clean (downstream --json consumers unpolluted)" || fail "npm run build polluted stdout: >>>$build_stdout<<<"

# ── (1) conformance: 7 adapters × 6 capabilities, each a typed status ───────────────────────────────
missing=0
for a in "${ADAPTERS[@]}"; do
  if [[ "$(jq -r --arg a "$a" 'has($a)' < "$JSON")" != "true" ]]; then fail "JSON missing adapter '$a'"; missing=1; continue; fi
  for c in "${CAPABILITIES[@]}"; do
    st="$(jq -r --arg a "$a" --arg c "$c" '.[$a][$c].status // "MISSING"' < "$JSON")"
    case "$st" in
      supported|partial|unsupported) ;;
      *) fail "JSON $a.$c has no valid status (got '$st')"; missing=1 ;;
    esac
  done
done
[[ "$missing" -eq 0 ]] && pass "all 7 adapters declare all 6 capabilities with a valid typed status"

# ── (2) doc-drift check passes on the committed markdown ────────────────────────────────────────────
if (cd "$ROOT" && npm run capability-matrix -- --check) >"$TMP/check.out" 2>&1; then
  pass "capability-matrix --check passes on the committed matrix doc"
else
  fail "capability-matrix --check reports the committed doc stale: $(cat "$TMP/check.out")"
fi

# ── (3) economics derivation — declared value, kiro-cli alias fold, unknown sentinel ────────────────
[[ "$(derive_signal kiro-cli)" == "false" ]] && pass "kiro-cli record derives declared per_delegation_tokens=false (alias fold to kiro)" || fail "kiro-cli derivation wrong (expected false)"
[[ "$(derive_signal claude-code)" == "false" ]] && pass "claude-code record derives declared per_delegation_tokens=false" || fail "claude-code derivation wrong (expected false)"
[[ "$(derive_signal totally-unknown-runtime)" == "false" ]] && pass "unknown runtime emits the explicit sentinel false (never fabricated true)" || fail "unknown-runtime sentinel wrong (expected false)"

# runtime string is carried verbatim (kiro-cli is NOT rewritten to kiro in the emitted signal)
UNK_LOG="$TMP/unk.jsonl"; : > "$UNK_LOG"
env TELEMETRY_CONFIG_FILE="$EMPTY_CONF" TELEMETRY_ECONOMICS_LOG_FILE="$UNK_LOG" bash "$EMITTER" "$(mk_event kiro-cli)" >/dev/null 2>&1
[[ "$(jq -r '.signals.runtime' < "$UNK_LOG")" == "kiro-cli" ]] && pass "signals.runtime carries the raw runtime value verbatim (kiro-cli)" || fail "signals.runtime not carried verbatim"

# alias fold + declaration-derivation isolation: with a declaration JSON where kiro is flipped to
# supported, a kiro-cli record derives TRUE (proves the fold resolves kiro) while an unknown stays false.
MUT_JSON="$TMP/mutated-decl.json"
jq '."kiro".per_delegation_tokens={status:"supported"}' < "$JSON" > "$MUT_JSON"
[[ "$(derive_signal kiro-cli "$MUT_JSON")" == "true" ]] && pass "kiro-cli resolves kiro's declaration (flipped→supported yields true): alias fold proven" || fail "kiro-cli did NOT resolve kiro's flipped declaration"
[[ "$(derive_signal totally-unknown-runtime "$MUT_JSON")" == "false" ]] && pass "unresolved runtime stays sentinel false even against a mutated JSON (no fabricated true)" || fail "unknown runtime leaked a non-sentinel value"

# ── (4) SINGLE SOURCE teeth: mutate one declaration in the TS source, rebuild, and confirm BOTH the
#        doc-drift check AND the JSON-derived economics signal flip together ──────────────────────────
perl -0pi -e 's/const NO_PER_DELEGATION_TOKENS = unsupported\(\s*"[^"]*",\s*\);/const NO_PER_DELEGATION_TOKENS = supported();/s' "$LIB_TS"
if grep -q 'const NO_PER_DELEGATION_TOKENS = supported();' "$LIB_TS"; then
  (cd "$ROOT" && npm run build) >/dev/null 2>&1 || fail "rebuild after mutation failed"
  # (a) doc-drift check now FAILS (committed markdown still shows ✗ for per_delegation_tokens)
  if (cd "$ROOT" && npm run capability-matrix -- --check) >"$TMP/check2.out" 2>&1; then
    fail "capability-matrix --check did NOT catch the planted declaration mutation (no teeth)"
  else
    pass "capability-matrix --check CATCHES the planted declaration mutation (doc-drift teeth)"
  fi
  # (b) the JSON-derived economics signal flips for a DECLARED runtime (kiro-cli + claude-code)
  [[ "$(derive_signal kiro-cli)" == "true" ]] && pass "mutation flips the JSON-derived kiro-cli economics signal to true (single source)" || fail "kiro-cli economics signal did not flip after declaration mutation"
  [[ "$(derive_signal claude-code)" == "true" ]] && pass "mutation flips the JSON-derived claude-code economics signal to true (single source)" || fail "claude-code economics signal did not flip after declaration mutation"
  # (c) an unknown runtime STILL emits the sentinel false — the mutation never fabricates support it lacks
  [[ "$(derive_signal totally-unknown-runtime)" == "false" ]] && pass "unknown runtime stays sentinel false even under the mutation (fabrication impossible one layer down)" || fail "unknown runtime fabricated a signal under mutation"
else
  fail "source mutation did not apply (test setup error)"
fi

# ── restore + rebuild, confirm the check passes and the signal returns to false ─────────────────────
restore_and_rebuild
if (cd "$ROOT" && npm run capability-matrix -- --check) >"$TMP/check3.out" 2>&1; then
  pass "after restore, capability-matrix --check passes again (byte-identical source restore)"
else
  fail "after restore, capability-matrix --check still stale: $(cat "$TMP/check3.out")"
fi
[[ "$(derive_signal kiro-cli)" == "false" ]] && pass "after restore, kiro-cli economics signal returns to declared false" || fail "kiro-cli signal did not return to false after restore"

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "test_capability_declarations: all checks passed."
  exit 0
else
  echo "test_capability_declarations: $errors check(s) failed."
  exit 1
fi
