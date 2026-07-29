#!/usr/bin/env bash
# shellcheck disable=SC2015
# ^ the `<cond> && pass ... || fail ...` assert idiom is deliberate (pass always returns 0).
# test_telemetry_kit_attribution.sh — Kit-version attribution in telemetry (flow-agents #970).
#
# Every telemetry event and economics record was previously UNATTRIBUTABLE to a Kit version:
# `agent.version` is the RUNTIME's own version (`claude --version`), never the Kit's. Proves
# scripts/telemetry/lib/kit-identity.sh resolves the INSTALLED Kit's own identity (package
# version + git sha/ref/dirty) from the script's own on-disk location, and that both
# telemetry.sh (`.kit` on every event) and economics-record.sh (`kit` sibling of
# `pricing_version`) stamp the SAME resolved identity for a given run.
#
# Coverage -> ACs:
#   AC1  a telemetry event emitted by an installed runtime carries the Kit identity + lineage.
#   AC2  the economics record for a run carries the SAME identity (byte-identical), joinable to
#        that run's events.
#   AC3  chosen design is version+sha+dirty (NOT a content digest — see design-note discussion
#        in kit-identity.sh's header). Asserted here via the dirty-flag alternative: two
#        resolutions at the SAME git sha, one clean and one with an uncommitted local edit,
#        yield DIFFERENT identities (dirty:false vs dirty:true) with an identical git_sha.
#   AC4  an unresolvable identity (no package.json+packaging/ ancestor) yields an explicit
#        {resolution:"incomplete", reason:"..."} marker — never a guess, never a silent
#        omission. A partial resolution (version known, no .git — a packaged install) still
#        carries an explicit reason for the unresolved git fields.
#   AC5  existing consumers parse BOTH the pre-#970 shape (no `.kit`/`kit`) and the post-#970
#        shape (with it) without loss: usage-feedback.js import-telemetry (runtime events) and
#        learning-review-proposals.sh (economics records). retrospective-observation.ts's
#        validateEconomicsRecord is covered by a companion unit-test case in
#        src/cli/retrospective-observation.test.mjs (additive `kit` field, unit-level, since
#        it is TypeScript source, not a shell consumer).
#
# Deterministic, no network, no model spend, self-cleaning (scratch git repos + tmp dirs only).
# Usage: bash evals/integration/test_telemetry_kit_attribution.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TELEMETRY="$ROOT/scripts/telemetry"
KIT_IDENTITY_LIB="$ROOT/scripts/telemetry/lib/kit-identity.sh"
CONTEXT_KIT_IDENTITY_LIB="$ROOT/context/scripts/telemetry/lib/kit-identity.sh"
TELEMETRY_SH="$TELEMETRY/telemetry.sh"
EMITTER="$TELEMETRY/economics-record.sh"
FIX="$ROOT/evals/fixtures/economics"
USAGE_FEEDBACK="$ROOT/scripts/usage-feedback.js"

TMP="$(mktemp -d)"
# Cleanup only removes scratch state -- it must never be able to determine or influence the
# pass/fail verdict, which is computed independently below from the `errors` counter.
cleanup() { rm -rf "$TMP" 2>/dev/null; }
trap cleanup EXIT

errors=0
pass() { echo "  [PASS] $1"; }
fail() { echo "  [FAIL] $1"; errors=$((errors + 1)); }

command -v jq >/dev/null 2>&1 || { echo "jq unavailable; skipping"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "git unavailable; skipping"; exit 0; }

echo "=== telemetry kit attribution (#970) ==="

# ── Existence ────────────────────────────────────────────────────────────────────────────────
echo "--- Existence ---"
[[ -f "$KIT_IDENTITY_LIB" ]] && pass "scripts/telemetry/lib/kit-identity.sh exists" || fail "kit-identity.sh missing"
[[ -f "$CONTEXT_KIT_IDENTITY_LIB" ]] && pass "context/scripts/telemetry/lib/kit-identity.sh mirror exists" || fail "context mirror missing"
if [[ -f "$KIT_IDENTITY_LIB" && -f "$CONTEXT_KIT_IDENTITY_LIB" ]] && cmp -s "$KIT_IDENTITY_LIB" "$CONTEXT_KIT_IDENTITY_LIB"; then
  pass "scripts/ and context/ kit-identity.sh copies are byte-identical"
else
  fail "scripts/ and context/ kit-identity.sh copies drifted"
fi

# ── AC1: this repo's own resolution — resolved, version/sha/ref real, no reason ────────────────
echo "--- AC1: resolution against this repo's own checkout ---"
REAL_KIT_JSON="$(bash -c "source '$KIT_IDENTITY_LIB'; kit_identity_json")"
EXPECTED_VERSION="$(jq -r '.version' "$ROOT/package.json")"
EXPECTED_SHA="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)"

GOT_RESOLUTION="$(printf '%s' "$REAL_KIT_JSON" | jq -r '.resolution')"
[[ "$GOT_RESOLUTION" == "resolved" ]] && pass "resolution == resolved" || fail "resolution: expected resolved got $GOT_RESOLUTION"

GOT_VERSION="$(printf '%s' "$REAL_KIT_JSON" | jq -r '.version')"
[[ "$GOT_VERSION" == "$EXPECTED_VERSION" ]] && pass "version == package.json .version ($GOT_VERSION)" || fail "version: expected $EXPECTED_VERSION got $GOT_VERSION"

GOT_SHA="$(printf '%s' "$REAL_KIT_JSON" | jq -r '.git_sha')"
[[ "$GOT_SHA" == "$EXPECTED_SHA" ]] && pass "git_sha == git rev-parse HEAD ($GOT_SHA)" || fail "git_sha: expected $EXPECTED_SHA got $GOT_SHA"

GOT_DIRTY_TYPE="$(printf '%s' "$REAL_KIT_JSON" | jq -r '.dirty | type')"
[[ "$GOT_DIRTY_TYPE" == "boolean" ]] && pass "dirty resolved to a real boolean (not null) in a real checkout" || fail "dirty: expected boolean got $GOT_DIRTY_TYPE"

# ── AC1: never resolved from cwd/process ancestry -- cd elsewhere still resolves the SAME kit ──
echo "--- AC1: identity is resolved from the script's OWN location, never \$PWD ---"
OTHER_CWD_JSON="$(cd /tmp && bash -c "source '$KIT_IDENTITY_LIB'; kit_identity_json")"
[[ "$(printf '%s' "$OTHER_CWD_JSON" | jq -c '{version,git_sha}')" == "$(printf '%s' "$REAL_KIT_JSON" | jq -c '{version,git_sha}')" ]] \
  && pass "resolution is identical regardless of \$PWD at call time" \
  || fail "resolution changed when \$PWD changed -- contract violation (#912 forbids cwd-derived identity)"

# ── AC4: unresolvable identity -- no package.json+packaging/ ancestor -> explicit incomplete ───
echo "--- AC4: unresolvable identity yields an explicit incomplete marker ---"
NOROOT="$TMP/no-kit-root/deeply/nested/scripts/telemetry/lib"
mkdir -p "$NOROOT"
cp "$KIT_IDENTITY_LIB" "$NOROOT/kit-identity.sh"
NOROOT_JSON="$(bash -c "source '$NOROOT/kit-identity.sh'; kit_identity_json")"
GOT_RES="$(printf '%s' "$NOROOT_JSON" | jq -r '.resolution')"
[[ "$GOT_RES" == "incomplete" ]] && pass "resolution == incomplete with no package.json+packaging/ ancestor" || fail "resolution: expected incomplete got $GOT_RES"
GOT_REASON="$(printf '%s' "$NOROOT_JSON" | jq -r '.reason')"
[[ -n "$GOT_REASON" && "$GOT_REASON" != "null" ]] && pass "reason is a non-empty explicit string ($GOT_REASON)" || fail "reason: expected a non-empty explanation, got '$GOT_REASON'"
ALL_NULL="$(printf '%s' "$NOROOT_JSON" | jq -e '.version==null and .git_sha==null and .git_ref==null and .dirty==null' >/dev/null 2>&1 && echo yes || echo no)"
[[ "$ALL_NULL" == "yes" ]] && pass "every identity field is explicit null, never a guessed value" || fail "an unresolvable identity fabricated a non-null field"

# ── AC4 (partial): version known, no .git (packaged install) -> resolved, git fields null+reason ─
echo "--- AC4: partial resolution (packaged install, no .git) still discloses the git gap ---"
PKGROOT="$TMP/packaged-install"
mkdir -p "$PKGROOT/packaging" "$PKGROOT/scripts/telemetry/lib"
echo '{"version":"9.9.9-packaged"}' > "$PKGROOT/package.json"
cp "$KIT_IDENTITY_LIB" "$PKGROOT/scripts/telemetry/lib/kit-identity.sh"
PKG_JSON="$(bash -c "source '$PKGROOT/scripts/telemetry/lib/kit-identity.sh'; kit_identity_json")"
GOT_RES2="$(printf '%s' "$PKG_JSON" | jq -r '.resolution')"
[[ "$GOT_RES2" == "resolved" ]] && pass "resolution == resolved on version alone (no .git present)" || fail "resolution: expected resolved got $GOT_RES2"
GOT_VER2="$(printf '%s' "$PKG_JSON" | jq -r '.version')"
[[ "$GOT_VER2" == "9.9.9-packaged" ]] && pass "version read from the packaged install's own package.json" || fail "version: expected 9.9.9-packaged got $GOT_VER2"
GOT_SHA2="$(printf '%s' "$PKG_JSON" | jq -r '.git_sha')"
[[ "$GOT_SHA2" == "null" ]] && pass "git_sha explicitly null (no .git at kit root)" || fail "git_sha: expected null got $GOT_SHA2"
GOT_REASON2="$(printf '%s' "$PKG_JSON" | jq -r '.reason')"
[[ -n "$GOT_REASON2" && "$GOT_REASON2" != "null" ]] && pass "reason discloses the missing git lineage ($GOT_REASON2)" || fail "reason: expected a non-empty explanation for the missing .git"

# ── AC4: parent repo is never mistaken for the kit's own lineage ───────────────────────────────
echo "--- AC4: an ambient PARENT .git is never attributed as the kit's own lineage ---"
PARENTGIT="$TMP/parent-has-git"
mkdir -p "$PARENTGIT/kit/packaging" "$PARENTGIT/kit/scripts/telemetry/lib"
( cd "$PARENTGIT" && git init -q && git config user.email t@example.com && git config user.name t && \
  echo x > outer.txt && git add outer.txt && git commit -qm outer )
echo '{"version":"1.2.3-nested"}' > "$PARENTGIT/kit/package.json"
cp "$KIT_IDENTITY_LIB" "$PARENTGIT/kit/scripts/telemetry/lib/kit-identity.sh"
NESTED_JSON="$(bash -c "source '$PARENTGIT/kit/scripts/telemetry/lib/kit-identity.sh'; kit_identity_json")"
NESTED_SHA="$(printf '%s' "$NESTED_JSON" | jq -r '.git_sha')"
[[ "$NESTED_SHA" == "null" ]] && pass "no .git directly at the kit root -> git_sha stays null, never the parent's sha" || fail "git_sha leaked the ambient parent repo's sha: $NESTED_SHA"

# ── AC3: dirty-flag alternative to a content digest -- same sha, different identity ────────────
echo "--- AC3: two resolutions at the SAME git sha with different local content -> different identity ---"
DIRTYROOT="$TMP/dirty-check"
mkdir -p "$DIRTYROOT/packaging" "$DIRTYROOT/scripts/telemetry/lib"
echo '{"version":"1.0.0-dirty-check"}' > "$DIRTYROOT/package.json"
echo tracked > "$DIRTYROOT/tracked.txt"
cp "$KIT_IDENTITY_LIB" "$DIRTYROOT/scripts/telemetry/lib/kit-identity.sh"
( cd "$DIRTYROOT" && git init -q && git config user.email t@example.com && git config user.name t && \
  git add package.json packaging tracked.txt scripts && git commit -qm init )

CLEAN_JSON="$(bash -c "source '$DIRTYROOT/scripts/telemetry/lib/kit-identity.sh'; kit_identity_json")"
CLEAN_DIRTY="$(printf '%s' "$CLEAN_JSON" | jq -r '.dirty')"
CLEAN_SHA="$(printf '%s' "$CLEAN_JSON" | jq -r '.git_sha')"
[[ "$CLEAN_DIRTY" == "false" ]] && pass "clean working tree resolves dirty:false" || fail "dirty: expected false on a clean tree, got $CLEAN_DIRTY"

echo modified >> "$DIRTYROOT/tracked.txt"
DIRTY_JSON="$(bash -c "source '$DIRTYROOT/scripts/telemetry/lib/kit-identity.sh'; kit_identity_json")"
DIRTY_DIRTY="$(printf '%s' "$DIRTY_JSON" | jq -r '.dirty')"
DIRTY_SHA="$(printf '%s' "$DIRTY_JSON" | jq -r '.git_sha')"
[[ "$DIRTY_DIRTY" == "true" ]] && pass "uncommitted local edit resolves dirty:true" || fail "dirty: expected true after an uncommitted edit, got $DIRTY_DIRTY"
[[ "$DIRTY_SHA" == "$CLEAN_SHA" ]] && pass "git_sha unchanged across the edit (same commit, same sha)" || fail "git_sha changed unexpectedly: $CLEAN_SHA -> $DIRTY_SHA"
[[ "$CLEAN_JSON" != "$DIRTY_JSON" ]] && pass "same-sha identities differ (dirty flag) -- disclosed digest-alternative behavior" || fail "identities were identical despite a local content change"

# untracked new files also count as dirty (a genuinely uncommitted change to the tree)
( cd "$DIRTYROOT" && git checkout -q -- tracked.txt && echo new > untracked.txt )
UNTRACKED_JSON="$(bash -c "source '$DIRTYROOT/scripts/telemetry/lib/kit-identity.sh'; kit_identity_json")"
UNTRACKED_DIRTY="$(printf '%s' "$UNTRACKED_JSON" | jq -r '.dirty')"
[[ "$UNTRACKED_DIRTY" == "true" ]] && pass "an untracked file also resolves dirty:true" || fail "dirty: expected true with an untracked file present, got $UNTRACKED_DIRTY"
rm -f "$DIRTYROOT/untracked.txt"

# ── AC1: telemetry.sh stamps .kit on a real event, schema_version bumped to 0.4.0 ───────────────
echo "--- AC1: telemetry.sh base event carries .kit ---"
TELLOG="$TMP/telemetry-full.jsonl"; : > "$TELLOG"
mkdir -p "$TMP/sessions"
echo '{"session_id":"kit-attr-test-session"}' | env \
  TELEMETRY_ENABLED=true TELEMETRY_CHANNELS=full TELEMETRY_CHANNEL_FULL_LOG_FILE="$TELLOG" \
  FLOW_AGENTS_TELEMETRY_FOREGROUND=true TELEMETRY_CONFIG_FILE="$TMP/telemetry.conf" \
  TELEMETRY_DATA_DIR="$TMP" TELEMETRY_SESSION_DIR="$TMP/sessions" \
  bash "$TELEMETRY_SH" agentSpawn dev >/dev/null 2>&1
EVT="$(tail -1 "$TELLOG" 2>/dev/null)"
[[ -n "$EVT" ]] && pass "telemetry.sh emitted an event" || fail "telemetry.sh produced no event"
GOT_SV="$(printf '%s' "$EVT" | jq -r '.schema_version' 2>/dev/null)"
[[ "$GOT_SV" == "0.4.0" ]] && pass "schema_version bumped to 0.4.0" || fail "schema_version: expected 0.4.0 got $GOT_SV"
EVT_KIT_RES="$(printf '%s' "$EVT" | jq -r '.kit.resolution' 2>/dev/null)"
[[ "$EVT_KIT_RES" == "resolved" ]] && pass "event .kit.resolution == resolved" || fail ".kit.resolution: expected resolved got $EVT_KIT_RES"
EVT_KIT_VERSION="$(printf '%s' "$EVT" | jq -r '.kit.version' 2>/dev/null)"
[[ "$EVT_KIT_VERSION" == "$EXPECTED_VERSION" ]] && pass "event .kit.version == this checkout's package.json version" || fail ".kit.version: expected $EXPECTED_VERSION got $EVT_KIT_VERSION"
# .agent.version (the RUNTIME's version) stays a DISTINCT field from .kit.version (the KIT's) --
# they must never be conflated even when they happen to differ in shape.
AGENT_VERSION_KEY_PRESENT="$(printf '%s' "$EVT" | jq -e 'has("agent") and (.agent|has("version"))' >/dev/null 2>&1 && echo yes || echo no)"
[[ "$AGENT_VERSION_KEY_PRESENT" == "yes" ]] && pass ".agent.version (runtime identity) is untouched and still present alongside .kit" || fail ".agent.version was removed or renamed"

# ── AC2: economics-record.sh stamps the SAME identity, byte-identical, as a sibling of pricing_version
echo "--- AC2: economics record carries the SAME kit identity, joinable to this run's events ---"
export FLOW_AGENTS_ECONOMICS_FIXTURE_MODE=true
EMPTY_CONF="$TMP/empty-telemetry.conf"; : > "$EMPTY_CONF"
export TELEMETRY_CONFIG_FILE="$EMPTY_CONF"
# shellcheck source=/dev/null
source "$ROOT/scripts/telemetry/lib/usage.sh"
TU="$(usage_parse_transcript "$FIX/transcript.jsonl")"
RUN_CORRELATION="$(jq -c '.run_correlation' "$FIX/state.json")"
USAGE_EVENT="$(jq -cn --argjson tu "$TU" --argjson correlation "$RUN_CORRELATION" --arg model "claude-opus-4-8" '{
  schema_version:"0.4.0", timestamp:"1751731200000",
  session_id:"kontourai-flow-agents-970-run-01", event_id:"evt-01-usage",
  event_type:"session.usage", agent:{name:"dev",runtime:"claude-code",version:"1"},
  context:{cwd:"/workspace/flow-agents"},
  task_slug:"kontourai-flow-agents-349",
  run_correlation:$correlation,
  usage:{ model:$model, duration_s:420, tool_invocations:12, delegations:3,
    input_tokens:$tu.input_tokens, output_tokens:$tu.output_tokens,
    cache_creation_input_tokens:$tu.cache_creation_input_tokens,
    cache_read_input_tokens:$tu.cache_read_input_tokens,
    estimated_cost_usd:$tu.estimated_cost_usd, pricing_version:$tu.pricing_version,
    by_model:$tu.by_model }
}')"
ECON_LOG="$TMP/econ.jsonl"; : > "$ECON_LOG"
TELEMETRY_ECONOMICS_LOG_FILE="$ECON_LOG" bash "$EMITTER" "$USAGE_EVENT" --state "$FIX/state.json" >/dev/null 2>&1
ECON_REC="$(cat "$ECON_LOG" 2>/dev/null)"
[[ -n "$ECON_REC" ]] && pass "economics-record.sh wrote a record" || fail "economics-record.sh wrote no record"
ECON_KIT="$(printf '%s' "$ECON_REC" | jq -c '.kit' 2>/dev/null)"
FRESH_KIT="$(bash -c "source '$KIT_IDENTITY_LIB'; kit_identity_json")"
[[ "$ECON_KIT" == "$FRESH_KIT" ]] && pass "economics record .kit is byte-identical to kit_identity_json() -- joinable per run" || fail ".kit mismatch: economics=$ECON_KIT fresh=$FRESH_KIT"
ECON_KIT_IS_SIBLING="$(printf '%s' "$ECON_REC" | jq -e '(.pricing_version|type=="string" or type=="null") and (has("kit"))' >/dev/null 2>&1 && echo yes || echo no)"
[[ "$ECON_KIT_IS_SIBLING" == "yes" ]] && pass "kit is a top-level sibling of pricing_version on the record" || fail "kit is not a top-level sibling of pricing_version"

# ── AC5a: usage-feedback.js import-telemetry tolerates BOTH pre-#970 and post-#970 event shapes ─
echo "--- AC5: usage-feedback.js import-telemetry parses old (no .kit) and new (with .kit) shapes ---"
if [[ -f "$USAGE_FEEDBACK" ]]; then
  source "$ROOT/evals/lib/node.sh"

  OLD_SRC="$TMP/old-shape-src"; mkdir -p "$OLD_SRC"
  cat > "$OLD_SRC/full.jsonl" <<JSONL
{"schema_version":"0.3.0","timestamp":"2026-05-04T12:00:00Z","session_id":"old-shape-session","event_id":"evt-1","event_type":"turn.user","agent":{"name":"dev","runtime":"claude-code"},"turn":{"prompt_text":"hello","prompt_length":5}}
{"schema_version":"0.3.0","timestamp":"2026-05-04T12:01:00Z","session_id":"old-shape-session","event_id":"evt-2","event_type":"session.usage","agent":{"name":"dev","runtime":"claude-code"},"usage":{"model":"opus","duration_s":60,"tool_invocations":1,"delegations":0,"input_tokens":null,"output_tokens":null,"estimated_cost_usd":null}}
JSONL
  NEW_SRC="$TMP/new-shape-src"; mkdir -p "$NEW_SRC"
  cat > "$NEW_SRC/full.jsonl" <<JSONL
{"schema_version":"0.4.0","timestamp":"2026-05-04T12:00:00Z","session_id":"new-shape-session","event_id":"evt-1","event_type":"turn.user","agent":{"name":"dev","runtime":"claude-code","version":"1"},"kit":{"resolution":"resolved","reason":null,"version":"5.5.0","git_sha":"$EXPECTED_SHA","git_ref":"main","dirty":false},"turn":{"prompt_text":"hello","prompt_length":5}}
{"schema_version":"0.4.0","timestamp":"2026-05-04T12:01:00Z","session_id":"new-shape-session","event_id":"evt-2","event_type":"session.usage","agent":{"name":"dev","runtime":"claude-code","version":"1"},"kit":{"resolution":"resolved","reason":null,"version":"5.5.0","git_sha":"$EXPECTED_SHA","git_ref":"main","dirty":false},"usage":{"model":"opus","duration_s":60,"tool_invocations":1,"delegations":0,"input_tokens":null,"output_tokens":null,"estimated_cost_usd":null}}
JSONL

  OLD_DST="$TMP/old-shape-dst"; mkdir -p "$OLD_DST"
  OLD_IMPORT_ERR="$TMP/old-import.err"
  if flow_agents_node "$USAGE_FEEDBACK" import-telemetry --runtime claude-code \
    --input-telemetry-dir "$OLD_SRC" --telemetry-dir "$OLD_DST" >/dev/null 2>"$OLD_IMPORT_ERR"; then
    pass "import-telemetry accepts the pre-#970 shape (no .kit)"
  else
    fail "import-telemetry rejected the pre-#970 shape: $(cat "$OLD_IMPORT_ERR")"
  fi
  OLD_SESSIONS="$OLD_DST/normalized-sessions.jsonl"
  OLD_COUNT="$(jq -s 'length' "$OLD_SESSIONS" 2>/dev/null)"
  [[ "$OLD_COUNT" == "1" ]] && pass "pre-#970 shape produces exactly one normalized session" || fail "pre-#970 shape: expected 1 normalized session, got $OLD_COUNT"

  NEW_DST="$TMP/new-shape-dst"; mkdir -p "$NEW_DST"
  NEW_IMPORT_ERR="$TMP/new-import.err"
  if flow_agents_node "$USAGE_FEEDBACK" import-telemetry --runtime claude-code \
    --input-telemetry-dir "$NEW_SRC" --telemetry-dir "$NEW_DST" >/dev/null 2>"$NEW_IMPORT_ERR"; then
    pass "import-telemetry accepts the post-#970 shape (with .kit)"
  else
    fail "import-telemetry rejected the post-#970 shape: $(cat "$NEW_IMPORT_ERR")"
  fi
  NEW_SESSIONS="$NEW_DST/normalized-sessions.jsonl"
  NEW_COUNT="$(jq -s 'length' "$NEW_SESSIONS" 2>/dev/null)"
  [[ "$NEW_COUNT" == "1" ]] && pass "post-#970 shape produces exactly one normalized session (no loss)" || fail "post-#970 shape: expected 1 normalized session, got $NEW_COUNT"

  OLD_TURNS="$(jq -r '.turns' "$OLD_SESSIONS" 2>/dev/null)"
  NEW_TURNS="$(jq -r '.turns' "$NEW_SESSIONS" 2>/dev/null)"
  [[ "$OLD_TURNS" == "$NEW_TURNS" ]] && pass "core normalized fields (.turns) identical between shapes ($OLD_TURNS)" || fail "core normalized fields diverged: old=$OLD_TURNS new=$NEW_TURNS"
else
  fail "scripts/usage-feedback.js not found -- cannot verify AC5a"
fi

# ── AC5b: learning-review-proposals.sh tolerates BOTH pre-#970 and post-#970 economics shapes ──
echo "--- AC5: learning-review-proposals.sh parses old (no kit) and new (with kit) economics records ---"
LRP="$TELEMETRY/learning-review-proposals.sh"
if [[ -f "$LRP" ]]; then
  MIXED_LOG="$TMP/mixed-economics.jsonl"
  OLD_REC="$(jq -c 'del(.kit)' <<<"$ECON_REC")"
  printf '%s\n%s\n' "$OLD_REC" "$ECON_REC" > "$MIXED_LOG"
  LRP_LEDGER="$TMP/lrp-ledger.jsonl"
  LRP_OUT="$(LR_MIN_WINDOW_SAMPLE=1 bash "$LRP" --ledger "$LRP_LEDGER" "$MIXED_LOG" 2>"$TMP/lrp.err")"
  LRP_RC=$?
  [[ $LRP_RC -eq 0 ]] && pass "learning-review-proposals.sh exits 0 over a mix of old and new economics shapes" || fail "learning-review-proposals.sh exited $LRP_RC: $(cat "$TMP/lrp.err")"
  LRP_CONSIDERED="$(printf '%s' "$LRP_OUT" | jq -r '.records_considered' 2>/dev/null)"
  [[ "$LRP_CONSIDERED" == "2" ]] && pass "both the kit-less and kit-bearing records were considered (records_considered==2)" || fail "records_considered: expected 2 got $LRP_CONSIDERED"
else
  fail "scripts/telemetry/learning-review-proposals.sh not found -- cannot verify AC5b"
fi

# ── validate-source-tree registration: kit-identity.sh is a strictly-mirrored source file ──────
echo "--- Source-tree mirror registration ---"
if grep -q 'scripts/telemetry/lib/kit-identity.sh' "$ROOT/src/tools/validate-source-tree.ts" 2>/dev/null; then
  pass "kit-identity.sh is registered in validate-source-tree.ts's mirroredFiles"
else
  fail "kit-identity.sh is NOT registered for byte-identical mirror enforcement"
fi

echo ""
if [[ "$errors" -eq 0 ]]; then
  echo "test_telemetry_kit_attribution: all checks passed."
  exit 0
else
  echo "test_telemetry_kit_attribution: $errors check(s) failed."
  exit 1
fi
