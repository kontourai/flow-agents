#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=/dev/null
source "$ROOT_DIR/scripts/telemetry/console-presets.sh"
LOCAL_KONTOUR_CONSOLE_URL="$(flow_agents_local_kontour_console_url)"
KONTOUR_HOSTED_CONSOLE_URL="$(flow_agents_kontour_hosted_console_url)"
TMPDIR_EVAL="$(mktemp -d /tmp/universal-bundle-install.XXXXXX)"
pass=0
fail=0

cleanup() {
  rm -rf "$TMPDIR_EVAL"
}
trap cleanup EXIT

_pass() { echo "  ✓ $1"; pass=$((pass + 1)); }
_fail() { echo "  ✗ $1"; fail=$((fail + 1)); }

echo "=== Layer 2B: Bundle Install Smoke Test ==="
echo ""

echo "--- Rebuild ---"
if (cd "$ROOT_DIR" && npm run build:bundles >/dev/null); then
  _pass "bundle build completed"
else
  _fail "bundle build failed"
fi

KIRO_DEST="$TMPDIR_EVAL/kiro-home"
BASE_DEST="$TMPDIR_EVAL/base-workspace"
CLAUDE_DEST="$TMPDIR_EVAL/claude-workspace"
CODEX_DEST="$TMPDIR_EVAL/codex-workspace"
CODEX_FULL_DEST="$TMPDIR_EVAL/codex-full-workspace"
CODEX_CONSOLE_DEST="$TMPDIR_EVAL/codex-console-workspace"
CODEX_HOSTED_CONSOLE_DEST="$TMPDIR_EVAL/codex-hosted-console-workspace"
CODEX_USER_HOSTED_CONSOLE_DEST="$TMPDIR_EVAL/codex-user-hosted-console-workspace"
CODEX_LEGACY_CONSOLE_DEST="$TMPDIR_EVAL/codex-legacy-console-workspace"
CODEX_BAD_CONSOLE_DEST="$TMPDIR_EVAL/codex-bad-console-workspace"
BASE_INIT_DEST="$TMPDIR_EVAL/base-init-workspace"
CODEX_INIT_DEST="$TMPDIR_EVAL/codex-init-workspace"
OPENCODE_DEST="$TMPDIR_EVAL/opencode-workspace"
OPENCODE_CONSOLE_DEST="$TMPDIR_EVAL/opencode-console-workspace"
OPENCODE_FULL_DEST="$TMPDIR_EVAL/opencode-full-workspace"
PI_DEST="$TMPDIR_EVAL/pi-workspace"
INSTRUCTION_FIXTURES="$TMPDIR_EVAL/instruction-fixtures"
CONSOLE_TOKEN_FILE="$TMPDIR_EVAL/console-token"
printf 'test-token\n' > "$CONSOLE_TOKEN_FILE"
chmod 600 "$CONSOLE_TOKEN_FILE" 2>/dev/null || true

instruction_fixture_key() {
  printf '%s' "$1" | shasum -a 256 | awk '{print $1}'
}

instruction_file_identity() {
  local file="$1"
  printf '%s %s\n' "$(wc -c < "$file" | tr -d ' ')" "$(shasum -a 256 "$file" | awk '{print $1}')"
}

seed_instruction_fixture() {
  local dest="$1"
  local label="$2"
  local key
  key="$(instruction_fixture_key "$dest")"
  mkdir -p "$dest" "$INSTRUCTION_FIXTURES"
  printf '# Repository AGENTS instructions\nfixture=%s\nkind=agents\nliteral=__KIRO_PACKAGE_ROOT__\n' "$label" > "$dest/AGENTS.md"
  printf '# Repository CLAUDE instructions\nfixture=%s\nkind=claude\nliteral=__KIRO_PACKAGE_ROOT__\n' "$label" > "$dest/CLAUDE.md"
  instruction_file_identity "$dest/AGENTS.md" > "$INSTRUCTION_FIXTURES/$key.AGENTS.md.identity"
  instruction_file_identity "$dest/CLAUDE.md" > "$INSTRUCTION_FIXTURES/$key.CLAUDE.md.identity"
}

assert_instruction_fixture_preserved() {
  local dest="$1"
  local label="$2"
  local key filename expected actual
  key="$(instruction_fixture_key "$dest")"
  for filename in AGENTS.md CLAUDE.md; do
    expected="$(cat "$INSTRUCTION_FIXTURES/$key.$filename.identity")"
    if [[ -f "$dest/$filename" ]]; then
      actual="$(instruction_file_identity "$dest/$filename")"
    else
      actual="missing"
    fi
    if [[ "$actual" == "$expected" ]]; then
      _pass "$label preserves existing $filename byte-for-byte"
    else
      _fail "$label changed or deleted existing $filename (expected identity: $expected; actual: $actual)"
    fi
  done
}

# Every install path starts with distinct repository-owned instructions. Kiro's
# fixture is intentionally at the rsync --delete destination root so deletion,
# not only replacement, is covered by this regression test.
seed_instruction_fixture "$KIRO_DEST" "direct-kiro-delete-sync"
seed_instruction_fixture "$BASE_DEST" "direct-base"
seed_instruction_fixture "$CLAUDE_DEST" "direct-claude-code"
seed_instruction_fixture "$CODEX_DEST" "direct-codex"
seed_instruction_fixture "$OPENCODE_DEST" "direct-opencode"
seed_instruction_fixture "$PI_DEST" "direct-pi"
seed_instruction_fixture "$BASE_INIT_DEST" "cli-base"
seed_instruction_fixture "$CODEX_INIT_DEST" "cli-codex"
seed_instruction_fixture "$OPENCODE_FULL_DEST" "cli-opencode"

echo ""
echo "--- Install ---"
if (cd "$ROOT_DIR/dist/kiro" && bash install.sh "$KIRO_DEST/" >/dev/null); then
  _pass "Kiro install succeeded"
else
  _fail "Kiro install failed"
fi
assert_instruction_fixture_preserved "$KIRO_DEST" "Kiro direct install with trailing-slash destination and rsync --delete"

if (cd "$ROOT_DIR/dist/base" && bash install.sh "$BASE_DEST" >/dev/null); then
  _pass "Base install succeeded"
else
  _fail "Base install failed"
fi
assert_instruction_fixture_preserved "$BASE_DEST" "Base direct install"

if (cd "$ROOT_DIR/dist/claude-code" && bash install.sh "$CLAUDE_DEST" >/dev/null); then
  _pass "Claude Code install succeeded"
else
  _fail "Claude Code install failed"
fi
assert_instruction_fixture_preserved "$CLAUDE_DEST" "Claude Code direct install"

if (cd "$ROOT_DIR/dist/codex" && bash install.sh "$CODEX_DEST" >/dev/null); then
  _pass "Codex install succeeded"
else
  _fail "Codex install failed"
fi
assert_instruction_fixture_preserved "$CODEX_DEST" "Codex direct install"

if (cd "$ROOT_DIR/dist/codex" && bash install.sh "$CODEX_CONSOLE_DEST" --telemetry-sink local-kontour-console --console-token-file "$CONSOLE_TOKEN_FILE" --console-tenant tenant-a >/dev/null); then
  _pass "Codex install with Console telemetry config succeeded"
else
  _fail "Codex install with Console telemetry config failed"
fi

if (cd "$ROOT_DIR/dist/codex" && bash install.sh "$CODEX_HOSTED_CONSOLE_DEST" --telemetry-sink kontour-hosted-console --console-token-file "$CONSOLE_TOKEN_FILE" --console-tenant tenant-hosted >/dev/null); then
  _pass "Codex install with Kontour hosted Console telemetry config succeeded"
else
  _fail "Codex install with Kontour hosted Console telemetry config failed"
fi

CODEX_HOSTED_CONSOLE_NO_TENANT_DEST="$TMPDIR_EVAL/codex-hosted-console-no-tenant-workspace"
CODEX_HOSTED_CONSOLE_NO_TENANT_STDERR="$TMPDIR_EVAL/codex-hosted-console-no-tenant-stderr.txt"
if (cd "$ROOT_DIR/dist/codex" && bash install.sh "$CODEX_HOSTED_CONSOLE_NO_TENANT_DEST" --telemetry-sink kontour-hosted-console --console-token-file "$CONSOLE_TOKEN_FILE" >/dev/null 2>"$CODEX_HOSTED_CONSOLE_NO_TENANT_STDERR"); then
  _pass "Codex install with hosted Console sink and no --console-tenant still succeeds"
else
  _fail "Codex install with hosted Console sink and no --console-tenant unexpectedly failed"
fi

if rg -q 'warning: install-console-config.sh: a Console telemetry sink was selected with no --console-tenant' "$CODEX_HOSTED_CONSOLE_NO_TENANT_STDERR"; then
  _pass "Untenanted hosted Console sink install prints DX warning to stderr"
else
  _fail "Untenanted hosted Console sink install did not print DX warning to stderr"
fi

if (cd "$ROOT_DIR/dist/codex" && bash install.sh "$CODEX_USER_HOSTED_CONSOLE_DEST" --telemetry-sink user-hosted-console --console-url https://console.example.test --console-token-file "$CONSOLE_TOKEN_FILE" >/dev/null); then
  _pass "Codex install with user-hosted Console telemetry config succeeded"
else
  _fail "Codex install with user-hosted Console telemetry config failed"
fi

if (cd "$ROOT_DIR/dist/codex" && bash install.sh "$CODEX_LEGACY_CONSOLE_DEST" --telemetry-sink hosted-kontour-console --console-url https://legacy-console.example.test >/dev/null); then
  _pass "Codex install preserves legacy hosted Console sink alias"
else
  _fail "Codex install rejected legacy hosted Console sink alias"
fi

if (cd "$ROOT_DIR/dist/codex" && bash install.sh "$CODEX_BAD_CONSOLE_DEST" --telemetry-sink user-hosted-console --console-url http://example.com >/dev/null 2>&1); then
  _fail "Codex install accepted unsafe hosted Console http URL"
else
  _pass "Codex install rejects unsafe hosted Console http URL"
fi

if node "$ROOT_DIR/build/src/cli.js" init --runtime base --dest "$BASE_INIT_DEST" --telemetry-sink local-kontour-console --yes >/dev/null; then
  _pass "flow-agents init headless base install succeeded"
else
  _fail "flow-agents init headless base install failed"
fi
assert_instruction_fixture_preserved "$BASE_INIT_DEST" "flow-agents init Base install"

if node "$ROOT_DIR/build/src/cli.js" init --runtime codex --dest "$CODEX_INIT_DEST" --telemetry-sink local-kontour-console --console-tenant tenant-a --activate-kits --yes >/dev/null; then
  _pass "flow-agents init headless Codex install succeeded"
else
  _fail "flow-agents init headless Codex install failed"
fi
assert_instruction_fixture_preserved "$CODEX_INIT_DEST" "flow-agents init Codex install"

echo ""
echo "--- Guided Console-Connect Wizard (G2/G3): headless regression + summary/verify ---"

# New (G3): a plain local-files headless install still prints the structured
# post-install summary block (regardless of the guided wizard, which only
# fires for interactive installs) -- the summary/verify tail is shared by
# both install paths.
BASE_SUMMARY_LOCAL_DEST="$TMPDIR_EVAL/base-summary-local-workspace"
BASE_SUMMARY_LOCAL_STDOUT="$TMPDIR_EVAL/base-summary-local-stdout.txt"
if node "$ROOT_DIR/build/src/cli.js" init --dest "$BASE_SUMMARY_LOCAL_DEST" --telemetry-sink local-files --yes >"$BASE_SUMMARY_LOCAL_STDOUT" 2>&1; then
  _pass "flow-agents init headless local-files install succeeded (G3 summary case)"
else
  _fail "flow-agents init headless local-files install failed (G3 summary case)"
fi

if rg -q 'Console:' "$BASE_SUMMARY_LOCAL_STDOUT"   && rg -q 'local-only' "$BASE_SUMMARY_LOCAL_STDOUT"   && rg -F -q "$BASE_SUMMARY_LOCAL_DEST" "$BASE_SUMMARY_LOCAL_STDOUT"; then
  _pass "flow-agents init prints G3 post-install summary block for a local-files headless install"
else
  _fail "flow-agents init did not print G3 post-install summary block for a local-files headless install"
fi

# New (G2/G3): a kontour-hosted-console headless install auto-verifies via
# telemetry-doctor's buildReport in-process, stays within a bounded wall-clock
# time (never hangs), never prints the raw console token, and prints a
# console status line -- verified or unverified is acceptable in a sandboxed
# CI network, as long as the check happened honestly.
BASE_SUMMARY_HOSTED_DEST="$TMPDIR_EVAL/base-summary-hosted-workspace"
BASE_SUMMARY_HOSTED_STDOUT="$TMPDIR_EVAL/base-summary-hosted-stdout.txt"
SECONDS=0
if node "$ROOT_DIR/build/src/cli.js" init --dest "$BASE_SUMMARY_HOSTED_DEST" --telemetry-sink kontour-hosted-console --console-tenant tenant-x --console-token-file "$CONSOLE_TOKEN_FILE" --yes >"$BASE_SUMMARY_HOSTED_STDOUT" 2>&1; then
  _pass "flow-agents init headless kontour-hosted-console install succeeded (G2/G3 case)"
else
  _fail "flow-agents init headless kontour-hosted-console install failed (G2/G3 case)"
fi
HOSTED_SUMMARY_ELAPSED_SECONDS=$SECONDS

if [[ "$HOSTED_SUMMARY_ELAPSED_SECONDS" -le 20 ]]; then
  _pass "flow-agents init auto-verify (G2) completed within a bounded wall-clock time (${HOSTED_SUMMARY_ELAPSED_SECONDS}s, never hangs)"
else
  _fail "flow-agents init auto-verify (G2) took too long (${HOSTED_SUMMARY_ELAPSED_SECONDS}s) -- may be hanging"
fi

if rg -q 'Console:' "$BASE_SUMMARY_HOSTED_STDOUT" && ! rg -F -q 'test-token' "$BASE_SUMMARY_HOSTED_STDOUT"; then
  _pass "flow-agents init prints a G2/G3 console status line and never prints the raw console token"
else
  _fail "flow-agents init did not print a console status line, or leaked the raw console token"
fi

# New (regression, RESOLVED OWNER DECISION): the self-hosted blank-URL guard
# (fallback to local-files with a warning) applies to the INTERACTIVE wizard
# ONLY. The headless (--yes/--headless) path keeps today's unchanged
# behavior -- install-console-config.sh's existing die-on-blank for
# user-hosted-console with no --console-url/--console-endpoint. This asserts
# the exact same non-zero exit + die message current main() (pre-PR2)
# already produces, proving headless is byte-for-byte untouched. (The
# interactive fallback itself is proven by the console-connect-options.test.mjs
# unit tests on resolveSelfHostedUrlOrFallback + runConsoleConnectWizard.)
BASE_SELF_HOSTED_NO_URL_DEST="$TMPDIR_EVAL/base-self-hosted-no-url-workspace"
BASE_SELF_HOSTED_NO_URL_STDERR="$TMPDIR_EVAL/base-self-hosted-no-url-stderr.txt"
set +e
node "$ROOT_DIR/build/src/cli.js" init --dest "$BASE_SELF_HOSTED_NO_URL_DEST" --telemetry-sink user-hosted-console --yes >/dev/null 2>"$BASE_SELF_HOSTED_NO_URL_STDERR"
BASE_SELF_HOSTED_NO_URL_EXIT=$?
set -e

if [[ "$BASE_SELF_HOSTED_NO_URL_EXIT" -ne 0 ]]   && rg -q 'install-console-config.sh: user-hosted-console requires --console-url or --console-endpoint' "$BASE_SELF_HOSTED_NO_URL_STDERR"; then
  _pass "flow-agents init headless user-hosted-console with no --console-url still dies exactly as before (self-hosted guard is interactive-only)"
else
  _fail "flow-agents init headless user-hosted-console with no --console-url behavior changed (expected unchanged die-on-blank)"
fi

# New (review fix FIX 1): a self-hosted/BYO Console (non-local https, not the
# known hosted host) headless install stays honest -- connected-unverified,
# exit 0, reachability.checked stays false because --allow-network was not
# passed -- but the summary now includes an actionable next-step hint instead
# of leaving the operator with a bare "not checked". Never for local-only.
BASE_SUMMARY_SELFHOSTED_DEST="$TMPDIR_EVAL/base-summary-selfhosted-workspace"
BASE_SUMMARY_SELFHOSTED_STDOUT="$TMPDIR_EVAL/base-summary-selfhosted-stdout.txt"
if node "$ROOT_DIR/build/src/cli.js" init --dest "$BASE_SUMMARY_SELFHOSTED_DEST" --telemetry-sink user-hosted-console --console-url https://console.example.test --console-tenant tenant-selfhosted --console-token-file "$CONSOLE_TOKEN_FILE" --yes >"$BASE_SUMMARY_SELFHOSTED_STDOUT" 2>&1; then
  _pass "flow-agents init headless self-hosted/BYO Console install succeeds (unverified is honest, not a failure)"
else
  _fail "flow-agents init headless self-hosted/BYO Console install unexpectedly failed"
fi

if rg -q 'connected, unverified' "$BASE_SUMMARY_SELFHOSTED_STDOUT" \
  && rg -F -q 'flow-agents telemetry-doctor --allow-network' "$BASE_SUMMARY_SELFHOSTED_STDOUT" \
  && ! rg -F -q 'test-token' "$BASE_SUMMARY_SELFHOSTED_STDOUT"; then
  _pass "flow-agents init summary discloses WHY self-hosted reachability is unverified with an actionable --allow-network hint, and never prints the raw token"
else
  _fail "flow-agents init summary did not disclose the self-hosted not-checked reason with the --allow-network hint"
fi

if rg -F -q 'flow-agents telemetry-doctor --allow-network' "$BASE_SUMMARY_LOCAL_STDOUT"; then
  _fail "flow-agents init printed the self-hosted --allow-network hint for a local-files-only install (should never appear there)"
else
  _pass "flow-agents init does not print the self-hosted --allow-network hint for a local-files-only install"
fi

# New (review fix FIX 4, security): pin the validate-before-persist ordering
# invariant. The TS-side wizard validators (console-telemetry-validate.ts) are
# soft (validate-and-warn, never block); the ONLY reason a malformed value can
# never land in a persisted telemetry.conf is that install-console-config.sh's
# bash validators (validate_tenant et al.) run BEFORE any config key is
# written and `die` (non-zero exit) on failure. A tenant value containing a
# semicolon fails validate_tenant's charset (^[A-Za-z0-9._:-]+$ --
# scripts/telemetry/install-console-config.sh); assert the headless install
# dies non-zero via that exact bash validator, and that the hostile value
# never appears in the persisted telemetry.conf (which already exists at this
# point from the rsync'd template, since install-console-config.sh only
# validates -- and writes nothing -- before dying).
BASE_HOSTILE_TENANT_DEST="$TMPDIR_EVAL/base-hostile-tenant-workspace"
BASE_HOSTILE_TENANT_STDERR="$TMPDIR_EVAL/base-hostile-tenant-stderr.txt"
HOSTILE_TENANT='tenant;rm-rf-evidence'
set +e
node "$ROOT_DIR/build/src/cli.js" init --dest "$BASE_HOSTILE_TENANT_DEST" --telemetry-sink user-hosted-console --console-url https://console.example.test --console-tenant "$HOSTILE_TENANT" --yes >/dev/null 2>"$BASE_HOSTILE_TENANT_STDERR"
BASE_HOSTILE_TENANT_EXIT=$?
set -e

if [[ "$BASE_HOSTILE_TENANT_EXIT" -ne 0 ]] \
  && rg -q 'install-console-config.sh: --console-tenant contains unsupported characters' "$BASE_HOSTILE_TENANT_STDERR"; then
  _pass "flow-agents init headless install with an illegal-character Console tenant dies via the bash validate_tenant gate (non-zero exit)"
else
  _fail "flow-agents init headless install with an illegal-character Console tenant did not die via bash validate_tenant as expected"
fi

if [[ ! -f "$BASE_HOSTILE_TENANT_DEST/scripts/telemetry/telemetry.conf" ]] \
  || ! rg -F -q "$HOSTILE_TENANT" "$BASE_HOSTILE_TENANT_DEST/scripts/telemetry/telemetry.conf"; then
  _pass "hostile Console tenant value never lands in telemetry.conf (validate-before-persist ordering invariant holds)"
else
  _fail "hostile Console tenant value was persisted into telemetry.conf despite failing bash validate_tenant"
fi

if (cd "$ROOT_DIR/dist/opencode" && bash install.sh "$OPENCODE_DEST" >/dev/null); then
  _pass "opencode install succeeded"
else
  _fail "opencode install failed"
fi
assert_instruction_fixture_preserved "$OPENCODE_DEST" "OpenCode direct install"

if (cd "$ROOT_DIR/dist/opencode" && bash install.sh "$OPENCODE_CONSOLE_DEST" --telemetry-sink local-kontour-console --console-token-file "$CONSOLE_TOKEN_FILE" --console-tenant tenant-oc >/dev/null); then
  _pass "opencode install with Console telemetry config succeeded"
else
  _fail "opencode install with Console telemetry config failed"
fi

if node "$ROOT_DIR/build/src/cli.js" init --runtime opencode --dest "$OPENCODE_FULL_DEST" --yes >/dev/null; then
  _pass "flow-agents init headless opencode install succeeded"
else
  _fail "flow-agents init headless opencode install failed"
fi
assert_instruction_fixture_preserved "$OPENCODE_FULL_DEST" "flow-agents init OpenCode install"

if (cd "$ROOT_DIR/dist/pi" && bash install.sh "$PI_DEST" >/dev/null); then
  _pass "pi install succeeded"
else
  _fail "pi install failed"
fi
assert_instruction_fixture_preserved "$PI_DEST" "pi direct install"

USER_SKILLS_DIR="$CODEX_FULL_DEST/.agents/sk""ills/user-skill"
mkdir -p "$CODEX_FULL_DEST/.codex/ag""ents" "$USER_SKILLS_DIR"
printf 'name = "user-agent"\n' > "$CODEX_FULL_DEST/.codex/ag""ents/user-agent.toml"
printf '# user skill\n' > "$USER_SKILLS_DIR/SKILL.md"

# A fresh install ships the full standalone base (no pack filtering). Pre-existing
# unknown user files must be preserved across the rsync install.
if (cd "$ROOT_DIR/dist/codex" && bash install.sh "$CODEX_FULL_DEST" >/dev/null); then
  _pass "Codex full install succeeded"
else
  _fail "Codex full install failed"
fi

echo ""
echo "--- Installed Layout ---"
for dir in \
  "$KIRO_DEST/agents" \
  "$BASE_DEST/.flow-agents" \
  "$BASE_DEST/.kontourai/flow-agents" \
  "$CLAUDE_DEST/.claude/agents" \
  "$CLAUDE_DEST/.claude/skills" \
  "$CLAUDE_DEST/.flow-agents" \
  "$CLAUDE_DEST/.kontourai/flow-agents" \
  "$CODEX_DEST/.codex/agents" \
  "$CODEX_DEST/.agents/skills" \
  "$CODEX_DEST/.flow-agents" \
  "$CODEX_DEST/.kontourai/flow-agents" \
  "$CODEX_FULL_DEST/.flow-agents" \
  "$CODEX_FULL_DEST/.kontourai/flow-agents"; do
  if [[ -d "$dir" ]]; then
    _pass "$dir exists"
  else
    _fail "$dir missing"
  fi
done

echo ""
echo "--- Placeholder Rewriting ---"
if rg -n --glob '!AGENTS.md' --glob '!CLAUDE.md' '__KIRO_PACKAGE_ROOT__' "$KIRO_DEST" >/tmp/kiro-placeholder-leaks.txt 2>/dev/null; then
  _fail "Kiro install left placeholder tokens behind (see /tmp/kiro-placeholder-leaks.txt)"
else
  _pass "Kiro install rewrote package root placeholders"
fi

echo ""
echo "--- Installed Artifact Checks ---"
if rg -F -q "console_telemetry_url=$LOCAL_KONTOUR_CONSOLE_URL" "$CODEX_CONSOLE_DEST/scripts/telemetry/telemetry.conf" \
  && rg -q '^console_telemetry_token=test-token$' "$CODEX_CONSOLE_DEST/scripts/telemetry/telemetry.conf" \
  && rg -q '^console_tenant_id=tenant-a$' "$CODEX_CONSOLE_DEST/scripts/telemetry/telemetry.conf"; then
  _pass "Codex install persists Console telemetry config"
else
  _fail "Codex install did not persist Console telemetry config"
fi

if rg -F -q "console_telemetry_url=$KONTOUR_HOSTED_CONSOLE_URL" "$CODEX_HOSTED_CONSOLE_DEST/scripts/telemetry/telemetry.conf" \
  && rg -q '^console_tenant_id=tenant-hosted$' "$CODEX_HOSTED_CONSOLE_DEST/scripts/telemetry/telemetry.conf"; then
  _pass "Codex install persists Kontour hosted Console telemetry config"
else
  _fail "Codex install did not persist Kontour hosted Console telemetry config"
fi

if rg -q '^console_telemetry_url=https://console.example.test$' "$CODEX_USER_HOSTED_CONSOLE_DEST/scripts/telemetry/telemetry.conf" \
  && rg -q '^console_telemetry_token=test-token$' "$CODEX_USER_HOSTED_CONSOLE_DEST/scripts/telemetry/telemetry.conf"; then
  _pass "Codex install persists user-hosted Console telemetry config"
else
  _fail "Codex install did not persist user-hosted Console telemetry config"
fi

if rg -q '^console_telemetry_url=https://legacy-console.example.test$' "$CODEX_LEGACY_CONSOLE_DEST/scripts/telemetry/telemetry.conf"; then
  _pass "Codex install persists legacy hosted Console sink alias config"
else
  _fail "Codex install did not persist legacy hosted Console sink alias config"
fi

if rg -q '^console_telemetry_url=' "$BASE_DEST/scripts/telemetry/telemetry.conf"; then
  _fail "Base install persisted Console telemetry config without an explicit sink"
else
  _pass "Base install defaults telemetry to local files only"
fi

if rg -F -q "console_telemetry_url=$LOCAL_KONTOUR_CONSOLE_URL" "$CODEX_INIT_DEST/scripts/telemetry/telemetry.conf" \
  && rg -q '^console_tenant_id=tenant-a$' "$CODEX_INIT_DEST/scripts/telemetry/telemetry.conf" \
  && [[ -f "$CODEX_INIT_DEST/.kontourai/flow-agents/projections/codex/activation.json" ]]; then
  _pass "flow-agents init persists Console config and activates Codex kits"
else
  _fail "flow-agents init did not persist Console config or activate Codex kits"
fi

if [[ -f "$BASE_INIT_DEST/README.md" ]] \
  && [[ -d "$BASE_INIT_DEST/.flow-agents" ]] \
  && [[ -d "$BASE_INIT_DEST/.kontourai/flow-agents" ]] \
  && rg -F -q "console_telemetry_url=$LOCAL_KONTOUR_CONSOLE_URL" "$BASE_INIT_DEST/scripts/telemetry/telemetry.conf"; then
  _pass "flow-agents init default installs base documented workspace contract"
else
  _fail "flow-agents init default did not install base documented workspace contract"
fi

if rg -F -q "console_telemetry_url=$LOCAL_KONTOUR_CONSOLE_URL" "$OPENCODE_CONSOLE_DEST/scripts/telemetry/telemetry.conf" \
  && rg -q '^console_telemetry_token=test-token$' "$OPENCODE_CONSOLE_DEST/scripts/telemetry/telemetry.conf" \
  && rg -q '^console_tenant_id=tenant-oc$' "$OPENCODE_CONSOLE_DEST/scripts/telemetry/telemetry.conf"; then
  _pass "opencode install persists Console telemetry config"
else
  _fail "opencode install did not persist Console telemetry config"
fi

for dir in "$KIRO_DEST" "$BASE_DEST" "$CLAUDE_DEST" "$CODEX_DEST"; do
  if [[ -f "$dir/console.telemetry.json" ]] \
    && node - "$dir/console.telemetry.json" <<'NODE'
const fs = require("node:fs");
const descriptor = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const facets = descriptor.facets || [];
const recordSources = descriptor.recordSources || [];
const facetIds = new Set(facets.map((facet) => facet.id));
const sourceIds = new Set((descriptor.recordSources || []).map((source) => source.id));
for (const id of ["skills", "tools", "flows", "repositories", "projects", "runtimes", "agents", "models", "outcomes"]) {
  if (!facetIds.has(id)) throw new Error(`missing descriptor facet: ${id}`);
}
for (const id of ["flow-agents-workflow-state", "flow-agents-evidence", "flow-agents-learning"]) {
  if (!sourceIds.has(id)) throw new Error(`missing descriptor record source: ${id}`);
}
const summaryFields = new Set([
  "agentName",
  "cwd",
  "eventType",
  "hookEventName",
  "model",
  "outcome",
  "project",
  "runtime",
  "sessionId",
  "sourceKind",
  "status",
  "toolName"
]);
const mappedAttributes = new Set(recordSources.flatMap((source) => Object.keys(source.attributes || {})));
for (const facet of facets) {
  if (!summaryFields.has(facet.attribute) && !mappedAttributes.has(facet.attribute)) {
    throw new Error(`facet ${facet.id} uses Console-unreadable attribute: ${facet.attribute}`);
  }
}
console.log("ok");
NODE
  then
    _pass "$dir includes Flow Agents Console telemetry descriptor"
  else
    _fail "$dir is missing or has invalid Flow Agents Console telemetry descriptor"
  fi
  if [[ -f "$dir/kits/catalog.json" && -f "$dir/kits/builder/kit.json" ]]; then
    _pass "$dir includes Kit Catalog and Builder Kit manifest"
  else
    _fail "$dir is missing Kit Catalog or Builder Kit manifest"
  fi
  if [[ -f "$dir/kits/builder/flows/shape.flow.json" && -f "$dir/kits/builder/flows/build.flow.json" && -f "$dir/kits/builder/flows/publish-learn.flow.json" ]]; then
    _pass "$dir includes Builder Kit Flow Definitions"
  else
    _fail "$dir is missing Builder Kit Flow Definitions"
  fi
done

for dir in "$KIRO_DEST" "$BASE_DEST" "$CLAUDE_DEST" "$CODEX_DEST"; do
  if [[ -f "$dir/scripts/kit.js" ]] \
    && node "$dir/scripts/kit.js" list --dest "$dir" >/tmp/kit-list.out 2>&1 \
    && node "$dir/scripts/kit.js" status --dest "$dir" >/tmp/kit-status.out 2>&1 \
    && rg -q 'No local Flow Kits installed' /tmp/kit-list.out \
    && rg -q 'No local Flow Kits installed' /tmp/kit-status.out; then
    _pass "$dir includes local Flow Kit CLI and empty list/status works"
  else
    _fail "$dir local Flow Kit CLI list/status smoke failed"
  fi
done

if [[ -f "$CODEX_DEST/scripts/kit.js" ]] \
  && [[ -f "$CODEX_DEST/build/src/runtime-adapters.js" ]] \
  && node "$CODEX_DEST/scripts/kit.js" activate --dest "$CODEX_DEST" --format json >/tmp/codex-runtime-activation.json 2>&1 \
  && node - "$CODEX_DEST" /tmp/codex-runtime-activation.json <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const dest = process.argv[2];
const data = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
if (data.selected_adapter !== "codex-local") throw new Error("codex-local was not selected");
const ids = new Set((data.generated_runtime_files || []).map((item) => item.asset_id));
for (const expected of ["builder.shape", "builder.build", "builder.publish-learn", "codex-local.activation"]) {
  if (!ids.has(expected)) throw new Error(`missing generated runtime asset: ${expected}`);
}
for (const item of data.generated_runtime_files || []) {
  if (!fs.existsSync(path.join(dest, item.path))) throw new Error(`generated runtime file missing: ${item.path}`);
}
if (!fs.existsSync(path.join(dest, ".kontourai/flow-agents/projections/codex/activation.json"))) throw new Error("runtime activation manifest missing");
console.log("ok");
NODE
then
  _pass "Codex installed bundle activates Builder Kit through codex-local"
else
  _fail "Codex installed bundle runtime activation failed"
fi

if node - "$KIRO_DEST" "$BASE_DEST" "$CLAUDE_DEST" "$CODEX_DEST" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
for (const root of process.argv.slice(2)) {
  for (const rel of ["kits/catalog.json", "kits/builder/kit.json", "kits/builder/flows/shape.flow.json", "kits/builder/flows/build.flow.json", "kits/builder/flows/publish-learn.flow.json"]) {
    JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
  }
}
console.log("ok");
NODE
then
  _pass "installed kit JSON parses across bundles"
else
  _fail "installed kit JSON parse failed"
fi

if node - "$KIRO_DEST/agents" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
for (const name of fs.readdirSync(process.argv[2]).filter((file) => file.endsWith(".json"))) {
  JSON.parse(fs.readFileSync(path.join(process.argv[2], name), "utf8"));
}
console.log("ok");
NODE
then
  _pass "installed Kiro agent JSON parses"
else
  _fail "installed Kiro agent JSON parse failed"
fi

if rg -n '/Users/[^/]+/\.flow-agents|~/\.flow-agents' "$KIRO_DEST" "$BASE_DEST" "$CLAUDE_DEST" "$CODEX_DEST" "$OPENCODE_DEST" "$PI_DEST" --glob '!**/evals/**' >/tmp/installed-bundle-leaks.txt 2>/dev/null; then
  _fail "installed bundles contain machine-local absolute paths (see /tmp/installed-bundle-leaks.txt)"
else
  _pass "installed bundles are free of machine-local absolute paths"
fi

if [[ -f "$CLAUDE_DEST/.kontourai/flow-agents/.gitkeep" ]]; then
  _pass "Claude Code task dir scaffold installed"
else
  _fail "Claude Code task dir scaffold missing"
fi

if [[ -f "$CODEX_DEST/.kontourai/flow-agents/.gitkeep" ]]; then
  _pass "Codex task dir scaffold installed"
else
  _fail "Codex task dir scaffold missing"
fi

if [[ -f "$OPENCODE_DEST/.kontourai/flow-agents/.gitkeep" ]]; then
  _pass "opencode task dir scaffold installed"
else
  _fail "opencode task dir scaffold missing"
fi

if [[ -f "$PI_DEST/.kontourai/flow-agents/.gitkeep" ]]; then
  _pass "pi task dir scaffold installed"
else
  _fail "pi task dir scaffold missing"
fi

if rg -q 'claude-hook-adapter\.js.*stop-goal-fit\.js' "$CLAUDE_DEST/.claude/settings.json" \
  && rg -q 'claude-hook-adapter\.js.*workflow-steering\.js' "$CLAUDE_DEST/.claude/settings.json" \
  && rg -q 'claude-hook-adapter\.js.*quality-gate\.js' "$CLAUDE_DEST/.claude/settings.json" \
  && rg -q 'claude-hook-adapter\.js.*config-protection\.js' "$CLAUDE_DEST/.claude/settings.json"; then
  _pass "Claude Code install wires Flow Agents policy hooks"
else
  _fail "Claude Code install is missing Flow Agents policy hook wiring"
fi

if node - "$CLAUDE_DEST/.claude/settings.json" "$CODEX_DEST/.codex/config.toml" <<'NODE'
const fs = require("node:fs");
const settings = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (settings.permissions?.defaultMode !== "auto") throw new Error("Claude permissions.defaultMode should default to auto");
const statusLine = settings.statusLine || {};
if (statusLine.type !== "command" || !String(statusLine.command || "").includes("flow-agents-statusline.js")) throw new Error("Claude statusLine missing Flow Agents command");
const config = fs.readFileSync(process.argv[3], "utf8");
if (!config.includes("[tui]") || !config.includes("task-progress") || !config.includes("context-remaining")) throw new Error("Codex status_line missing progress items");
if (config.includes("[profiles.") || config.includes("\nprofile = ")) throw new Error("Codex installed base config should not contain legacy profile entries");
console.log("ok");
NODE
then
  _pass "installed Claude Code exposes auto permissions and statusline; Codex exposes profile-v2 progress config"
else
  _fail "installed Claude permissions/statusline or Codex profile-v2 progress config is missing"
fi

if [[ -f "$CODEX_DEST/.codex/builder.config.toml" && -f "$CODEX_DEST/.codex/personal.config.toml" ]] \
  && [[ "$(find "$CODEX_DEST/.codex" -maxdepth 1 -name '*.config.toml' | wc -l | tr -d ' ')" == "2" ]] \
  && rg -q 'Flow Agents Builder mode' "$CODEX_DEST/.codex/builder.config.toml" \
  && rg -q 'knowledge-capture' "$CODEX_DEST/.codex/personal.config.toml"; then
  _pass "Codex install includes profile-v2 config files"
else
  _fail "Codex install is missing profile-v2 config files"
fi

if node - "$CLAUDE_DEST/.claude/settings.json" "$CODEX_DEST/.codex/hooks.json" "$KIRO_DEST/agents/dev.json" <<'NODE'
const fs = require("node:fs");
function eventGroups(file, ...names) {
  const hooks = JSON.parse(fs.readFileSync(file, "utf8")).hooks || {};
  for (const name of names) if (hooks[name]?.length) return hooks[name];
  return [];
}
function hasWorkflowSteering(file, ...eventNames) {
  return eventGroups(file, ...eventNames).some((group) => {
    if ("command" in group) return String(group.command || "").includes("workflow-steering.js") && [undefined, null, "*"].includes(group.matcher);
    const command = (group.hooks || []).map((hook) => String(hook.command || "")).join(" ");
    return command.includes("workflow-steering.js") && [undefined, null, "*"].includes(group.matcher);
  });
}
for (const file of process.argv.slice(2)) {
  if (!hasWorkflowSteering(file, "UserPromptSubmit", "userPromptSubmit")) throw new Error(`missing prompt-submit workflow steering: ${file}`);
  if (hasWorkflowSteering(file, "PreToolUse", "preToolUse")) throw new Error(`workflow bootstrap must not be model-mediated at pre-tool time: ${file}`);
}
console.log("ok");
NODE
then
  _pass "installed bundles keep workflow steering advisory and session bootstrap product-owned"
else
  _fail "installed bundles do not wire prompt-submit workflow steering consistently"
fi

if [[ -f "$OPENCODE_DEST/.opencode/plugins/flow-agents.js" ]]   && node - "$OPENCODE_DEST/.opencode/plugins/flow-agents.js" <<'NODE'
const fs = require("node:fs");
const text = fs.readFileSync(process.argv[2], "utf8");
if (!text.includes("opencode-hook-adapter.js")) throw new Error("opencode plugin missing opencode-hook-adapter.js");
if (!text.includes("opencode-telemetry-hook.js")) throw new Error("opencode plugin missing opencode-telemetry-hook.js");
if (!text.includes("workflow-steering.js")) throw new Error("opencode plugin missing workflow-steering.js");
if (!text.includes("stop-goal-fit.js")) throw new Error("opencode plugin missing stop-goal-fit.js");
if (!text.includes("config-protection.js")) throw new Error("opencode plugin missing config-protection.js");
console.log("ok");
NODE
then
  _pass "opencode install wires Flow Agents plugin with policy hooks"
else
  _fail "opencode install missing or mis-wired Flow Agents plugin"
fi

if [[ -f "$PI_DEST/.pi/extensions/flow-agents.ts" ]]   && node - "$PI_DEST/.pi/extensions/flow-agents.ts" <<'NODE'
const fs = require("node:fs");
const text = fs.readFileSync(process.argv[2], "utf8");
if (!text.includes("pi-hook-adapter.js")) throw new Error("pi extension missing pi-hook-adapter.js");
if (!text.includes("pi-telemetry-hook.js")) throw new Error("pi extension missing pi-telemetry-hook.js");
if (!text.includes("workflow-steering.js")) throw new Error("pi extension missing workflow-steering.js");
if (!text.includes("stop-goal-fit.js")) throw new Error("pi extension missing stop-goal-fit.js");
if (!text.includes("config-protection.js")) throw new Error("pi extension missing config-protection.js");
console.log("ok");
NODE
then
  _pass "pi install wires Flow Agents extension with policy hooks"
else
  _fail "pi install missing or mis-wired Flow Agents extension"
fi

KIRO_WORKSPACE="$TMPDIR_EVAL/kiro-workspace"
mkdir -p "$KIRO_WORKSPACE"
if node - "$CLAUDE_DEST" "$CODEX_DEST" "$KIRO_DEST" "$KIRO_WORKSPACE" "$ROOT_DIR/scripts/hooks/lib/current-pointer.js" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const [claudeDest, codexDest, kiroDest, kiroWorkspace, currentPointerHelperPath] = process.argv.slice(2);
const { writePerActorCurrent } = require(currentPointerHelperPath);
// #440 FIXTURE-GAP: this fixture was written before #440's per-actor ownership scoping and never
// established a per-actor current pointer for the invoking actor -- under a RESOLVED ambient
// actor, workflow-steering.js's actorScopedWorkflowState now scopes to that actor's own
// (nonexistent) pointer and never surfaces the WORKFLOW STATE ATTENTION banner. Give each
// runCommand invocation a stable, explicit actor below (see FLOW_AGENTS_ACTOR in env).
const installedHookActor = "eval-actor-bundle-install-installed-hook";
const state = {
  schema_version: "1.0",
  task_slug: "installed-hook-demo",
  status: "not_verified",
  phase: "verification",
  updated_at: "2026-05-09T00:00:00Z",
  next_action: {
    status: "needs_user",
    summary: "Decide whether to accept the missing installed-hook verification.",
    target_phase: "goal_fit",
  },
};
const trustBundle = { schema_version: "1.0", claims: [] };
function writeFixture(root) {
  const taskDir = path.join(root, ".kontourai/flow-agents/installed-hook-demo");
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, "state.json"), JSON.stringify(state), "utf8");
  fs.writeFileSync(path.join(taskDir, "trust.bundle"), JSON.stringify(trustBundle), "utf8");
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs/context-map.md"), "# Context Map\n", "utf8");
  const flowAgentsDir = path.join(root, ".kontourai/flow-agents");
  const currentPayload = { schema_version: "1.0", active_slug: "installed-hook-demo", artifact_dir: "installed-hook-demo" };
  fs.writeFileSync(path.join(flowAgentsDir, "current.json"), JSON.stringify(currentPayload, null, 2) + "\n");
  writePerActorCurrent(flowAgentsDir, installedHookActor, currentPayload);
}
function eventGroups(file, ...names) {
  const hooks = JSON.parse(fs.readFileSync(file, "utf8")).hooks || {};
  for (const name of names) if (hooks[name]?.length) return hooks[name];
  return [];
}
function workflowCommand(file, ...eventNames) {
  for (const group of eventGroups(file, ...eventNames)) {
    if ("command" in group) {
      const command = String(group.command || "");
      if (command.includes("workflow-steering.js") && [undefined, null, "*"].includes(group.matcher)) return command;
      continue;
    }
    const command = (group.hooks || []).map((hook) => String(hook.command || "")).join(" ");
    if (command.includes("workflow-steering.js") && [undefined, null, "*"].includes(group.matcher) && group.hooks?.[0]) {
      return String(group.hooks[0].command || "");
    }
  }
  throw new Error(`missing workflow-steering command in ${file}`);
}
function runCommand(label, command, cwd, runtimeJson) {
  const payload = JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd, prompt: "continue" });
  const env = { ...process.env, SA_HOOK_PROFILE: "standard", CLAUDE_PROJECT_DIR: cwd, FLOW_AGENTS_ACTOR: installedHookActor };
  if (label === "Codex") env.CODEX_HOME = cwd;
  const result = spawnSync(command, { input: payload, cwd, env, shell: true, encoding: "utf8", timeout: 30000 });
  if (result.status !== 0) throw new Error(`${label} installed hook failed: rc=${result.status} stdout=${result.stdout} stderr=${result.stderr}`);
  const ctx = runtimeJson ? (JSON.parse(result.stdout).hookSpecificOutput?.additionalContext || "") : result.stdout;
  if (!ctx.includes("WORKFLOW STATE ATTENTION")) throw new Error(`${label} installed hook did not emit workflow attention: ${result.stdout} ${result.stderr}`);
  if (!ctx.includes("STATE: installed-hook-demo is status:not_verified phase:verification")) throw new Error(`${label} installed hook missed state guidance: ${ctx}`);
  if (ctx.includes("CRITIQUE:")) throw new Error(`${label} installed hook read retired critique sidecar guidance: ${ctx}`);
}
writeFixture(claudeDest);
writeFixture(codexDest);
writeFixture(kiroWorkspace);
runCommand("Claude Code", workflowCommand(path.join(claudeDest, ".claude/settings.json"), "UserPromptSubmit", "userPromptSubmit"), claudeDest, true);
runCommand("Codex", workflowCommand(path.join(codexDest, ".codex/hooks.json"), "UserPromptSubmit", "userPromptSubmit"), codexDest, true);
runCommand("Kiro", workflowCommand(path.join(kiroDest, "agents/dev.json"), "UserPromptSubmit", "userPromptSubmit"), kiroWorkspace, false);
console.log("ok");
NODE
then
  _pass "installed prompt-submit workflow-steering commands execute across Claude Code, Codex, and Kiro"
else
  _fail "installed prompt-submit workflow-steering commands did not execute consistently"
fi

# Execute the opencode plugin's workflow-steering command path directly
OPENCODE_WORKSPACE="$TMPDIR_EVAL/opencode-exec-workspace"
mkdir -p "$OPENCODE_WORKSPACE"
if node - "$OPENCODE_DEST" "$OPENCODE_WORKSPACE" "$ROOT_DIR/scripts/hooks/lib/current-pointer.js" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const [opencodeDest, opencodeWorkspace, currentPointerHelperPath] = process.argv.slice(2);
const { writePerActorCurrent } = require(currentPointerHelperPath);
// #440 FIXTURE-GAP: see the installed-prompt-submit block above for the full rationale.
const opencodeHookActor = "eval-actor-bundle-install-opencode-hook";
const state = {
  schema_version: "1.0",
  task_slug: "opencode-hook-demo",
  status: "not_verified",
  phase: "verification",
  updated_at: "2026-06-01T00:00:00Z",
  next_action: { status: "needs_user", summary: "Opencode hook test.", target_phase: "goal_fit" },
};
const trustBundle = { schema_version: "1.0", claims: [] };
function writeFixture(root) {
  const taskDir = path.join(root, ".kontourai/flow-agents/opencode-hook-demo");
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, "state.json"), JSON.stringify(state), "utf8");
  fs.writeFileSync(path.join(taskDir, "trust.bundle"), JSON.stringify(trustBundle), "utf8");
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs/context-map.md"), "# Context Map\n", "utf8");
  const flowAgentsDir = path.join(root, ".kontourai/flow-agents");
  const currentPayload = { schema_version: "1.0", active_slug: "opencode-hook-demo", artifact_dir: "opencode-hook-demo" };
  fs.writeFileSync(path.join(flowAgentsDir, "current.json"), JSON.stringify(currentPayload, null, 2) + "\n");
  writePerActorCurrent(flowAgentsDir, opencodeHookActor, currentPayload);
}
function runOpencodeAdapter(bundleDest, cwd) {
  const adapterPath = path.join(bundleDest, "scripts", "hooks", "opencode-hook-adapter.js");
  const payload = JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd });
  const result = spawnSync(process.execPath, [adapterPath, "UserPromptSubmit", "workflow-steering", "workflow-steering.js", "default"], {
    input: payload,
    cwd,
    env: { ...process.env, SA_HOOK_PROFILE: "standard", FLOW_AGENTS_HOOK_RUNTIME: "opencode", FLOW_AGENTS_ACTOR: opencodeHookActor },
    encoding: "utf8",
    timeout: 30000,
  });
  if (result.status !== 0) throw new Error("opencode adapter failed: rc=" + result.status + " stderr=" + result.stderr);
  const out = JSON.parse(result.stdout || "{}");
  const ctx = out.context || "";
  if (!ctx.includes("WORKFLOW STATE ATTENTION")) throw new Error("opencode adapter did not emit workflow attention: stdout=" + result.stdout + " stderr=" + result.stderr);
  if (!ctx.includes("STATE: opencode-hook-demo is status:not_verified phase:verification")) throw new Error("opencode adapter missed state guidance: " + ctx);
  if (ctx.includes("CRITIQUE:")) throw new Error("opencode adapter read retired critique sidecar guidance: " + ctx);
}
writeFixture(opencodeWorkspace);
runOpencodeAdapter(opencodeDest, opencodeWorkspace);
console.log("ok");
NODE
then
  _pass "opencode installed hook adapter executes workflow-steering commands correctly"
else
  _fail "opencode installed hook adapter did not execute workflow-steering commands correctly"
fi

# Execute the pi extension's hook adapter command path directly
PI_WORKSPACE="$TMPDIR_EVAL/pi-exec-workspace"
mkdir -p "$PI_WORKSPACE"
if node - "$PI_DEST" "$PI_WORKSPACE" "$ROOT_DIR/scripts/hooks/lib/current-pointer.js" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const [piDest, piWorkspace, currentPointerHelperPath] = process.argv.slice(2);
const { writePerActorCurrent } = require(currentPointerHelperPath);
// #440 FIXTURE-GAP: see the installed-prompt-submit block above for the full rationale.
const piHookActor = "eval-actor-bundle-install-pi-hook";
const state = {
  schema_version: "1.0",
  task_slug: "pi-hook-demo",
  status: "not_verified",
  phase: "verification",
  updated_at: "2026-06-01T00:00:00Z",
  next_action: { status: "needs_user", summary: "Pi hook test.", target_phase: "goal_fit" },
};
const trustBundle = { schema_version: "1.0", claims: [] };
function writeFixture(root) {
  const taskDir = path.join(root, ".kontourai/flow-agents/pi-hook-demo");
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, "state.json"), JSON.stringify(state), "utf8");
  fs.writeFileSync(path.join(taskDir, "trust.bundle"), JSON.stringify(trustBundle), "utf8");
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs/context-map.md"), "# Context Map\n", "utf8");
  const flowAgentsDir = path.join(root, ".kontourai/flow-agents");
  const currentPayload = { schema_version: "1.0", active_slug: "pi-hook-demo", artifact_dir: "pi-hook-demo" };
  fs.writeFileSync(path.join(flowAgentsDir, "current.json"), JSON.stringify(currentPayload, null, 2) + "\n");
  writePerActorCurrent(flowAgentsDir, piHookActor, currentPayload);
}
function runPiAdapter(bundleDest, cwd) {
  const adapterPath = path.join(bundleDest, "scripts", "hooks", "pi-hook-adapter.js");
  const payload = JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd });
  const result = spawnSync(process.execPath, [adapterPath, "UserPromptSubmit", "workflow-steering", "workflow-steering.js", "default"], {
    input: payload,
    cwd,
    env: { ...process.env, SA_HOOK_PROFILE: "standard", FLOW_AGENTS_HOOK_RUNTIME: "pi", FLOW_AGENTS_ACTOR: piHookActor },
    encoding: "utf8",
    timeout: 30000,
  });
  if (result.status !== 0) throw new Error("pi adapter failed: rc=" + result.status + " stderr=" + result.stderr);
  const out = JSON.parse(result.stdout || "{}");
  const ctx = out.context || "";
  if (!ctx.includes("WORKFLOW STATE ATTENTION")) throw new Error("pi adapter did not emit workflow attention: stdout=" + result.stdout + " stderr=" + result.stderr);
  if (!ctx.includes("STATE: pi-hook-demo is status:not_verified phase:verification")) throw new Error("pi adapter missed state guidance: " + ctx);
  if (ctx.includes("CRITIQUE:")) throw new Error("pi adapter read retired critique sidecar guidance: " + ctx);
}
writeFixture(piWorkspace);
runPiAdapter(piDest, piWorkspace);
console.log("ok");
NODE
then
  _pass "pi installed hook adapter executes workflow-steering commands correctly"
else
  _fail "pi installed hook adapter did not execute workflow-steering commands correctly"
fi


echo ""
echo "--- Full Standalone Base Install ---"
# There is no pack layer: a fresh install ships the complete standalone base.
# Both the neutral toolbox agents (tool-planner) and the deeper agents (dev) are
# present, and kit-owned skills (plan-work, deliver) plus standalone skills
# (agentic-engineering) all install together.
# Codex excludes the dev orchestrator agent (manifest.codex.excluded_agents), so
# assert the neutral toolbox agent plus a deeper agent that codex does ship.
CODEX_AGENTS_DIR="$CODEX_FULL_DEST/.codex/ag""ents"
if [[ -f "$CODEX_AGENTS_DIR/tool-planner.toml" && -f "$CODEX_AGENTS_DIR/tool-security-reviewer.toml" ]]; then
  _pass "Codex full install ships the complete agent base"
else
  _fail "Codex full install is missing base agents"
fi

if node - "$CODEX_AGENTS_DIR" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
function stringAssignment(text, key, name) {
  const matches = [...text.matchAll(new RegExp(`^${key}\\s*=\\s*"([^"]*)"\\s*$`, "gm"))];
  if (matches.length !== 1) throw new Error(`${name}: expected exactly one ${key} assignment, found ${matches.length}`);
  return matches[0][1];
}
const expected = {
  "tool-planner.toml": ["gpt-5.6-sol", "high"],
  "tool-worker.toml": ["gpt-5.6-terra", "high"],
  "tool-code-reviewer.toml": ["gpt-5.6-sol", "high"],
  "tool-security-reviewer.toml": ["gpt-5.6-sol", "high"],
  "tool-verifier.toml": ["gpt-5.6-sol", "high"],
};
for (const [name, [model, effort]] of Object.entries(expected)) {
  const text = fs.readFileSync(path.join(process.argv[2], name), "utf8");
  if (stringAssignment(text, "model", name) !== model) throw new Error(`${name}: expected model ${model}`);
  if (stringAssignment(text, "model_reasoning_effort", name) !== effort) throw new Error(`${name}: expected reasoning ${effort}`);
}
NODE
then
  _pass "Codex full install preserves Builder specialist 5.6 role routing"
else
  _fail "Codex full install lost Builder specialist role routing"
fi

echo ""
echo "--- Packed Package Builder Entry ---"
PACKAGE_CONSUMER="$TMPDIR_EVAL/package-consumer"
PACKAGE_PROJECT="$TMPDIR_EVAL/package-project"
PACKAGE_AMBIENT="$TMPDIR_EVAL/package-ambient"
mkdir -p "$PACKAGE_CONSUMER" "$PACKAGE_PROJECT/.kontourai/flow-agents" "$PACKAGE_PROJECT/checks" "$PACKAGE_AMBIENT/kits/builder/flows"
printf '#!/usr/bin/env bash\nset -eu\ntest -f "$1"\nprintf "1..1\\nok 1 - session exists\\n"\n' > "$PACKAGE_PROJECT/checks/check-packed-workflow.sh"
chmod +x "$PACKAGE_PROJECT/checks/check-packed-workflow.sh"
cat >"$PACKAGE_AMBIENT/kits/builder/flows/build.flow.json" <<'JSON'
{
  "id": "builder.build",
  "version": "poison-ambient-cwd",
  "steps": [{ "id": "ambient-poison", "next": null }],
  "gates": {}
}
JSON
PACKAGE_PACK_LOG="$TMPDIR_EVAL/package-pack.log"
PACKAGE_CLI="$PACKAGE_CONSUMER/node_modules/@kontourai/flow-agents/build/src/cli.js"
PACKAGE_SESSION="$PACKAGE_PROJECT/.kontourai/flow-agents/acme-builder-901"
PACKAGE_LIFECYCLE_SESSION="$PACKAGE_PROJECT/.kontourai/flow-agents/acme-builder-902"
PACKAGE_TEST_COMMAND="bash checks/check-packed-workflow.sh .kontourai/flow-agents/acme-builder-901/state.json"
PACKAGE_CRITERION_JSON="$(node - "$PACKAGE_TEST_COMMAND" <<'NODE'
const command = process.argv[2];
process.stdout.write(JSON.stringify({
  id: 'AC-1',
  status: 'pass',
  evidence_refs: [{ kind: 'command', excerpt: command, summary: 'The packed public workflow fixture executed this exact assertion for AC-1.' }],
}));
NODE
)"
PACKAGE_COMMAND_REF="$(node - "$PACKAGE_TEST_COMMAND" <<'NODE'
const command = process.argv[2];
process.stdout.write(JSON.stringify({ kind: 'command', excerpt: command, summary: 'Runs the packed consumer workflow assertion.' }));
NODE
)"

package_flow() {
  (cd "$PACKAGE_PROJECT" && env -u CODEX_THREAD_ID CODEX_SESSION_ID=packed-package-consumer node "$PACKAGE_CLI" workflow "$@")
}

package_review() {
  (cd "$PACKAGE_PROJECT" && env -u CODEX_THREAD_ID CODEX_SESSION_ID=packed-package-reviewer node "$PACKAGE_CLI" workflow "$@")
}

if (cd "$ROOT_DIR" && npm pack --silent --pack-destination "$TMPDIR_EVAL" >"$PACKAGE_PACK_LOG") \
  && PACKAGE_TARBALL="$(find "$TMPDIR_EVAL" -maxdepth 1 -type f -name 'kontourai-flow-agents-*.tgz' -print -quit)" \
  && [[ -n "$PACKAGE_TARBALL" ]] \
  && npm install --silent --no-audit --no-fund --ignore-scripts --prefix "$PACKAGE_CONSUMER" "$PACKAGE_TARBALL" \
  && mkdir -p "$PACKAGE_SESSION" "$PACKAGE_LIFECYCLE_SESSION" \
  && printf 'Selected Work Item: acme/builder#901\n' > "$PACKAGE_SESSION/acme-builder-901--pull-work.md" \
  && package_flow start --artifact-root "$PACKAGE_PROJECT/.kontourai/flow-agents" \
    --flow builder.build --work-item acme/builder#901 --assignment-provider local-file --summary "Packed public workflow contract fixture." >/dev/null \
  && node - "$PACKAGE_SESSION" <<'NODE' &&
const fs = require('node:fs');
const path = require('node:path');
const session = process.argv[2];
const slug = path.basename(session);
const write = (name, body) => fs.writeFileSync(path.join(session, name), body, 'utf8');
write(`${slug}--pull-work.md`, '# Pull And Probe Report\n\nSelected Work Item: acme/builder#901\n\nPickup readiness and recorded decisions are reviewable here.\n');
write(`${slug}--plan-work.md`, '# Plan\n\n## Definition Of Done\n\n- AC-1: The packed workflow fixture records criterion-backed command evidence.\n');
write(`${slug}--deliver.md`, '# Execute\n\nThe packed fixture changed only its declared fixture artifacts.\n');
write(`${slug}--evidence-gate.md`, '# Evidence Gate\n\nScope and acceptance coverage are reviewable here.\n');
write('acceptance.json', JSON.stringify({ schema_version: '1.0', task_slug: slug, criteria: [{ id: 'AC-1', description: 'The packed workflow fixture records criterion-backed command evidence.', status: 'pending', evidence_refs: [] }], goal_fit: { status: 'pending', summary: 'Fixture has not completed Goal Fit review.' } }, null, 2));
write('release.json', JSON.stringify({ schema_version: '1.0', task_slug: slug, decision: 'hold', updated_at: '2026-07-11T00:00:00Z', scope: 'packed fixture', evidence_ref: `${slug}--evidence-gate.md`, gates: [{ name: 'merge', status: 'hold', summary: 'Fixture never publishes.' }], rollback_plan: { status: 'not_required', summary: 'No release.', owner: 'fixture' }, observability_plan: { status: 'not_required', summary: 'No release.' }, post_deploy_checks: [], docs: { status: 'not_needed', summary: 'Fixture.' } }, null, 2));
write('learning.json', JSON.stringify({ schema_version: '1.0', task_slug: slug, status: 'learned', updated_at: '2026-07-11T00:00:00Z', records: [{ id: 'packed-fixture-learning', recorded_at: '2026-07-11T00:00:00Z', source_refs: [`${slug}--evidence-gate.md`], outcome: 'success', facts: ['Packed consumer produced declared durable artifacts.'], interpretation: 'The public workflow contract remained usable after npm install.', routing: [{ target: 'none', action: 'No follow-up required.', status: 'completed' }], correction: { needed: false, evidence: 'Fixture contract passes.' } }] }, null, 2));
NODE
  node - "$PACKAGE_PROJECT" <<'NODE' &&
const fs = require('node:fs');
const path = require('node:path');
const project = process.argv[2];
const state = JSON.parse(fs.readFileSync(path.join(project, '.kontourai', 'flow-agents', 'acme-builder-901', 'state.json'), 'utf8'));
const flow = JSON.parse(fs.readFileSync(path.join(project, '.kontourai', 'flow', 'runs', 'acme-builder-901', 'state.json'), 'utf8'));
const bundle = JSON.parse(fs.readFileSync(path.join(project, '.kontourai', 'flow-agents', 'acme-builder-901', 'trust.bundle'), 'utf8'));
if (flow.current_step !== 'design-probe' || state.flow_run?.current_step !== 'design-probe') process.exit(1);
if (JSON.stringify(state.next_action?.skills) !== JSON.stringify(['pickup-probe'])) process.exit(1);
if (!(bundle.claims || []).some((claim) => claim.claimType === 'builder.pull-work.selected' && claim.status === 'verified')) process.exit(1);
NODE
  package_flow evidence --session-dir "$PACKAGE_SESSION" --expectation pickup-probe-readiness --status pass \
    --summary "Packed fixture records the declared pickup readiness artifact." \
    --evidence-ref-json "{\"kind\":\"artifact\",\"file\":\"$PACKAGE_SESSION/acme-builder-901--pull-work.md\",\"summary\":\"Durable pickup readiness artifact.\"}" >/dev/null \
  && package_flow evidence --session-dir "$PACKAGE_SESSION" --expectation probe-decisions-or-accepted-gaps --status pass \
    --summary "Packed fixture records the declared probe decisions artifact." \
    --evidence-ref-json "{\"kind\":\"artifact\",\"file\":\"$PACKAGE_SESSION/acme-builder-901--pull-work.md\",\"summary\":\"Durable probe decisions artifact.\"}" >/dev/null \
  && package_flow evidence --session-dir "$PACKAGE_SESSION" --expectation implementation-plan --status pass \
    --summary "Packed fixture records the declared implementation plan artifact." \
    --evidence-ref-json "{\"kind\":\"artifact\",\"file\":\"$PACKAGE_SESSION/acme-builder-901--plan-work.md\",\"summary\":\"Durable implementation plan artifact.\"}" >/dev/null \
  && package_flow evidence --session-dir "$PACKAGE_SESSION" --expectation implementation-scope --status pass \
    --summary "Packed fixture records the declared execution scope artifact." \
    --evidence-ref-json "{\"kind\":\"artifact\",\"file\":\"$PACKAGE_SESSION/acme-builder-901--deliver.md\",\"summary\":\"Durable execution scope artifact.\"}" >/dev/null \
  && ! package_flow evidence --session-dir "$PACKAGE_SESSION" --expectation tests-evidence --status pass \
    --command "$PACKAGE_TEST_COMMAND" --criterion-json "$PACKAGE_CRITERION_JSON" \
    --summary "This must reject tests evidence before a clean review." \
    --evidence-ref-json "$PACKAGE_COMMAND_REF" >/dev/null 2>&1 \
  && package_review critique --session-dir "$PACKAGE_SESSION" --verdict pass \
    --summary "Authenticated packed review found no blocking fixture findings." \
    --artifact-ref "$PACKAGE_SESSION/acme-builder-901--deliver.md" \
    --lane-json "{\"id\":\"code-review\",\"status\":\"pass\",\"summary\":\"Reviewed the packed consumer delivery.\",\"evidence_refs\":[{\"kind\":\"artifact\",\"file\":\"$PACKAGE_SESSION/acme-builder-901--deliver.md\",\"summary\":\"Reviewed packed delivery artifact.\"}]}" >/dev/null \
  && package_flow evidence --session-dir "$PACKAGE_SESSION" --expectation tests-evidence --status pass \
    --command "$PACKAGE_TEST_COMMAND" --criterion-json "$PACKAGE_CRITERION_JSON" \
    --summary "Packed fixture records criterion-backed command evidence after review." \
    --evidence-ref-json "$PACKAGE_COMMAND_REF" >/dev/null \
  && node - "$PACKAGE_SESSION" <<'NODE' &&
const fs = require('node:fs');
const path = require('node:path');
const session = process.argv[2];
const bundle = JSON.parse(fs.readFileSync(path.join(session, 'trust.bundle'), 'utf8'));
const criterionClaim = (bundle.claims || []).find((claim) =>
  claim.metadata?.origin === 'acceptance'
  && claim.metadata?.criterion?.id === 'AC-1'
  && claim.metadata.criterion.status === 'pass'
  && claim.metadata.criterion.evidence_refs?.some((ref) => ref.kind === 'command'));
if (!criterionClaim) {
  console.error('AC-1 is missing criterion-backed command evidence');
  process.exit(1);
}
NODE
  package_flow evidence --session-dir "$PACKAGE_SESSION" --expectation merge-readiness --status pass \
    --summary "Packed fixture records the declared merge-readiness artifact." \
    --evidence-ref-json "{\"kind\":\"artifact\",\"file\":\"$PACKAGE_SESSION/acme-builder-901--evidence-gate.md\",\"summary\":\"Durable merge-readiness artifact.\"}" >/dev/null \
  && node - "$PACKAGE_SESSION" <<'NODE' &&
const fs = require('node:fs');
const path = require('node:path');
const session = process.argv[2];
const bundle = JSON.parse(fs.readFileSync(path.join(session, 'trust.bundle'), 'utf8'));
const types = new Set((bundle.claims || []).filter((claim) => claim.status === 'verified').map((claim) => claim.claimType));
const requiredTypes = [
  'builder.pull-work.selected',
  'builder.design-probe.pickup-readiness',
  'builder.design-probe.decisions',
  'builder.plan.implementation',
  'builder.execute.scope',
  'builder.verify.tests',
  'builder.merge-ready.readiness',
];
const missingTypes = requiredTypes.filter((type) => !types.has(type));
if (missingTypes.length > 0) {
  console.error(`missing verified pre-operation workflow claims: ${missingTypes.join(', ')}`);
  process.exit(1);
}
fs.writeFileSync(path.join(session, 'publish-change.result.json'), JSON.stringify({ provider: 'fixture', repository: 'acme/builder', number: 901, url: 'https://example.test/acme/builder/pull/901', head_ref: 'fixture', base_ref: 'main' }));
NODE
  ! package_flow evidence --session-dir "$PACKAGE_SESSION" --expectation pull-request-opened --status pass \
    --summary "Locally authored publish-change result must not self-complete." \
    --evidence-ref-json "{\"kind\":\"artifact\",\"file\":\"$PACKAGE_SESSION/publish-change.result.json\",\"summary\":\"Locally authored provider-shaped result.\"}" >/dev/null 2>&1 \
  && node - "$PACKAGE_SESSION" "$PACKAGE_PROJECT" <<'NODE' &&
const fs = require('node:fs');
const path = require('node:path');
const [session, project] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(path.join(session, 'state.json'), 'utf8'));
const flow = JSON.parse(fs.readFileSync(path.join(project, '.kontourai', 'flow', 'runs', path.basename(session), 'state.json'), 'utf8'));
const bundle = JSON.parse(fs.readFileSync(path.join(session, 'trust.bundle'), 'utf8'));
if (state.flow_run?.current_step !== 'pr-open' || flow.current_step !== 'pr-open' || state.next_action?.status !== 'blocked') process.exit(1);
if ((bundle.claims || []).some((claim) => claim.claimType === 'builder.pr-open.pull-request')) process.exit(2);
NODE
  printf 'Selected Work Item: acme/builder#902\n' > "$PACKAGE_LIFECYCLE_SESSION/acme-builder-902--pull-work.md" \
  && package_flow start --artifact-root "$PACKAGE_PROJECT/.kontourai/flow-agents" \
    --flow builder.build --work-item acme/builder#902 --assignment-provider local-file --summary "Packed public lifecycle fixture." >/dev/null \
  && node --input-type=module - "$PACKAGE_PROJECT" "$PACKAGE_LIFECYCLE_SESSION" "$PACKAGE_CONSUMER" <<'NODE' &&
import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [project, session, consumer] = process.argv.slice(2);
const slug = path.basename(session);
const assignment = JSON.parse(fs.readFileSync(path.join(project, '.kontourai', 'flow-agents', 'assignment', `${slug}.json`), 'utf8'));
const state = JSON.parse(fs.readFileSync(path.join(project, '.kontourai', 'flow-agents', slug, 'state.json'), 'utf8'));
const packageEntry = path.join(consumer, 'node_modules', '@kontourai', 'flow-agents', 'build', 'src', 'index.js');
const { builderLifecycleAuthorizationPayload } = await import(pathToFileURL(packageEntry).href);
const keys = generateKeyPairSync('ed25519');
const keyId = 'packed-consumer';
fs.mkdirSync(path.join(project, '.flow-agents'), { recursive: true });
fs.writeFileSync(path.join(project, '.flow-agents', 'lifecycle-authority-keys.json'), JSON.stringify({
  schema_version: '1.0',
  keys: [{ id: keyId, algorithm: 'ed25519', public_key_pem: keys.publicKey.export({ type: 'spki', format: 'pem' }) }],
}, null, 2));
for (const operation of ['cancel', 'archive']) {
  const requestedAt = new Date();
  const unsigned = {
    schema_version: '1.0',
    operation,
    run_id: slug,
    subject: state.work_item_refs[0],
    assignment_actor_key: assignment.actor_key,
    assignment_actor: { ...assignment.actor, human: assignment.actor.human ?? null },
    nonce: `packed-${operation}`,
    expires_at: new Date(requestedAt.getTime() + 60 * 60_000).toISOString(),
    request: {
      reason: `packed consumer ${operation}`,
      authority: { kind: 'user_request', actor: 'packed-fixture', request_ref: `fixture://packed/${operation}`, requested_at: requestedAt.toISOString() },
    },
  };
  const authorization = { ...unsigned, signature: { algorithm: 'ed25519', key_id: keyId, value: sign(null, Buffer.from(builderLifecycleAuthorizationPayload(unsigned)), keys.privateKey).toString('base64') } };
  fs.writeFileSync(path.join(project, `${operation}.authorization.json`), JSON.stringify(authorization, null, 2));
}
NODE
  git -C "$PACKAGE_PROJECT" init -q -b main \
  && git -C "$PACKAGE_PROJECT" config user.email packed-fixture@example.invalid \
  && git -C "$PACKAGE_PROJECT" config user.name "Packed Fixture" \
  && git -C "$PACKAGE_PROJECT" add .flow-agents/lifecycle-authority-keys.json \
  && git -C "$PACKAGE_PROJECT" commit -q -m "protect lifecycle authority registry" \
  && git -C "$PACKAGE_PROJECT" update-ref refs/remotes/origin/main HEAD \
  && package_flow pause --session-dir "$PACKAGE_LIFECYCLE_SESSION" --reason "packed pause" >/dev/null \
  && package_flow resume --session-dir "$PACKAGE_LIFECYCLE_SESSION" --reason "packed resume" >/dev/null \
  && package_flow cancel --session-dir "$PACKAGE_LIFECYCLE_SESSION" --authorization-file "$PACKAGE_PROJECT/cancel.authorization.json" >/dev/null \
  && package_flow archive --session-dir "$PACKAGE_LIFECYCLE_SESSION" --authorization-file "$PACKAGE_PROJECT/archive.authorization.json" >/dev/null \
  && node - "$PACKAGE_PROJECT" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const project = process.argv[2];
const slug = 'acme-builder-902';
const archived = JSON.parse(fs.readFileSync(path.join(project, '.kontourai', 'flow-agents', 'archive', slug, 'state.json'), 'utf8'));
const flow = JSON.parse(fs.readFileSync(path.join(project, '.kontourai', 'flow', 'runs', slug, 'state.json'), 'utf8'));
const consumed = fs.readdirSync(path.join(project, '.kontourai', 'flow-agents', 'lifecycle-authority', 'consumed'));
if (archived.status !== 'archived' || flow.status !== 'canceled' || consumed.length !== 2) process.exit(1);
if (fs.existsSync(path.join(project, '.kontourai', 'flow-agents', slug))) process.exit(1);
NODE
then
  _pass "packed npm consumer follows the public Builder workflow contract and lifecycle commands"
else
  _fail "packed npm consumer did not complete the public Builder workflow contract and lifecycle commands"
fi

if node - "$CODEX_FULL_DEST/.agents/skills" "$CODEX_FULL_DEST" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [root, installRoot] = process.argv.slice(2);
const builder = [
  'builder-shape', 'continue-work', 'deliver', 'design-probe', 'evidence-gate',
  'execute-plan', 'fix-bug', 'gate-review', 'idea-to-backlog', 'learning-review',
  'pickup-probe', 'plan-work', 'pull-work', 'release-readiness', 'review-work',
  'tdd-workflow', 'verify-work',
];
for (const skill of [...builder, 'agentic-engineering']) {
  const file = path.join(root, skill, 'SKILL.md');
  if (!fs.existsSync(file)) throw new Error(`missing installed skill ${skill}`);
  if (builder.includes(skill)) {
    const text = fs.readFileSync(file, 'utf8');
    if (/npm run workflow:sidecar|flow-agents-workflow-sidecar|flow-agents builder-run/.test(text)) {
      throw new Error(`${skill} exposes a private workflow command`);
    }
    if (/--reviewer/.test(text)) {
      throw new Error(`${skill} exposes a caller-selected review identity`);
    }
    if (skill === 'verify-work' && (!/--criterion-json/.test(text) || /--command\s+"(?:true|node --version)"/.test(text))) {
      throw new Error('verify-work must ship criterion-backed substantive verification evidence guidance');
    }
    const refs = [...text.matchAll(/\b(?:context|docs|kits)\/[A-Za-z0-9_./-]+\.(?:md|json)\b/g)].map((match) => match[0]);
    for (const ref of refs) {
      const skillLocal = path.join(path.dirname(file), ref);
      if (!fs.existsSync(skillLocal) && !fs.existsSync(path.join(installRoot, ref))) {
        throw new Error(`${skill} has unresolved installed resource ${ref}`);
      }
    }
  }
}
NODE
then
  _pass "Codex full install ships all 17 coherent Builder skills and standalone skills"
else
  _fail "Codex full install is missing skills"
fi

if [[ -f "$CODEX_AGENTS_DIR/user-agent.toml" && -d "$USER_SKILLS_DIR" ]]; then
  _pass "Codex full install preserves unknown user files"
else
  _fail "Codex full install removed unknown user files"
fi

echo ""
echo "--- Dedicated Codex Home Universal Skills ---"
GLOBAL_HOME="$TMPDIR_EVAL/global-home"
GLOBAL_CODEX="$TMPDIR_EVAL/global-codex"
GLOBAL_SKILLS="$TMPDIR_EVAL/global-agents/skills"
mkdir -p "$GLOBAL_SKILLS/user-skill"
printf '# user skill\n' > "$GLOBAL_SKILLS/user-skill/SKILL.md"
GLOBAL_OUTPUT="$TMPDIR_EVAL/global-install.out"
if HOME="$GLOBAL_HOME" CODEX_REAL_HOME="$GLOBAL_CODEX" bash "$ROOT_DIR/scripts/install-codex-home.sh" "$GLOBAL_CODEX" --skills-dir "$GLOBAL_SKILLS" >"$GLOBAL_OUTPUT"; then
  _pass "dedicated Codex installer accepts independent hermetic runtime and skill roots"
else
  _fail "dedicated Codex installer failed with independent hermetic roots"
fi
if [[ -f "$GLOBAL_SKILLS/plan-work/SKILL.md" && -f "$GLOBAL_SKILLS/plan-work/context/contracts/planning-contract.md" && -f "$GLOBAL_SKILLS/user-skill/SKILL.md" && ! -e "$GLOBAL_CODEX/skills/plan-work" ]]; then
  _pass "global install uses self-contained universal skills and preserves user skills"
else
  _fail "global universal skill layout, resource closure, or user preservation is wrong"
fi
if rg -q 'Installed Flow Agents into Codex home at .+/global-codex$' "$GLOBAL_OUTPUT" && rg -q 'Installed portable skills at .+/global-agents/skills$' "$GLOBAL_OUTPUT"; then
  _pass "installer reports both runtime and portable skill destinations"
else
  _fail "installer output does not report both destinations"
fi
if HOME="$GLOBAL_HOME" CODEX_REAL_HOME="$GLOBAL_CODEX" bash "$ROOT_DIR/scripts/install-codex-home.sh" "$GLOBAL_CODEX" --skills-dir "$GLOBAL_SKILLS" >/dev/null; then
  _pass "split-root reinstall is idempotent"
else
  _fail "split-root reinstall is not idempotent"
fi

CONFLICT_CODEX="$TMPDIR_EVAL/conflict-codex"
CONFLICT_SKILLS="$TMPDIR_EVAL/conflict-agents/skills"
mkdir -p "$CONFLICT_SKILLS/plan-work" "$CONFLICT_CODEX/skills/plan-work" "$CONFLICT_CODEX/.flow-agents"
printf '# user collision\n' > "$CONFLICT_SKILLS/plan-work/SKILL.md"
cp "$ROOT_DIR/dist/codex/.agents/skills/plan-work/SKILL.md" "$CONFLICT_CODEX/skills/plan-work/SKILL.md"
printf 'runtime sentinel\n' > "$CONFLICT_CODEX/runtime-sentinel"
node - "$CONFLICT_CODEX" <<'NODE'
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto'); const root=process.argv[2];
const rel='skills' + '/plan-work/SKILL.md'; const sha256=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,rel))).digest('hex');
fs.writeFileSync(path.join(root,'.flow-agents/codex-install-manifest.json'), JSON.stringify({schema_version:'1.0',files:[{path:rel,sha256}]},null,2)+'\n');
NODE
CONFLICT_RUNTIME_BEFORE="$(shasum -a 256 "$CONFLICT_CODEX/skills/plan-work/SKILL.md" "$CONFLICT_CODEX/.flow-agents/codex-install-manifest.json" "$CONFLICT_CODEX/runtime-sentinel")"
if HOME="$GLOBAL_HOME" CODEX_REAL_HOME="$CONFLICT_CODEX" bash "$ROOT_DIR/scripts/install-codex-home.sh" "$CONFLICT_CODEX" --skills-dir "$CONFLICT_SKILLS" >/dev/null 2>&1; then
  _fail "global installer overwrote a user-owned skill collision"
else
  CONFLICT_RUNTIME_AFTER="$(shasum -a 256 "$CONFLICT_CODEX/skills/plan-work/SKILL.md" "$CONFLICT_CODEX/.flow-agents/codex-install-manifest.json" "$CONFLICT_CODEX/runtime-sentinel")"
  if [[ "$(cat "$CONFLICT_SKILLS/plan-work/SKILL.md")" == "# user collision" && "$CONFLICT_RUNTIME_BEFORE" == "$CONFLICT_RUNTIME_AFTER" && ! -e "$CONFLICT_SKILLS/.flow-agents" ]]; then
    _pass "cross-root collision preflight preserves universal content, legacy skill, runtime sentinel, and manifests"
  else
    _fail "cross-root collision failure partially mutated an install root"
  fi
fi

SYMLINK_TARGET="$TMPDIR_EVAL/symlink-target"
SYMLINK_PARENT="$TMPDIR_EVAL/symlink-parent"
mkdir -p "$SYMLINK_TARGET" "$SYMLINK_PARENT"
ln -s "$SYMLINK_TARGET" "$SYMLINK_PARENT/catalog"
if HOME="$GLOBAL_HOME" CODEX_REAL_HOME="$TMPDIR_EVAL/symlink-codex" bash "$ROOT_DIR/scripts/install-codex-home.sh" "$TMPDIR_EVAL/symlink-codex" --skills-dir "$SYMLINK_PARENT/catalog/skills" >/dev/null 2>&1; then
  _fail "global installer followed a symlinked skill destination component"
else
  [[ ! -e "$SYMLINK_TARGET/skills" ]] && _pass "global installer refuses symlinked skill destination components without mutation" || _fail "symlink rejection mutated its target"
fi

SOURCE_ANCESTOR="$(dirname "$ROOT_DIR")"
SOURCE_DESCENDANT="$ROOT_DIR/.fa-550-forbidden-skills"
for unsafe in / "$SOURCE_ANCESTOR" "$SOURCE_DESCENDANT"; do
  rm -rf "$SOURCE_DESCENDANT"
  if HOME="$GLOBAL_HOME" CODEX_REAL_HOME="$TMPDIR_EVAL/unsafe-codex" bash "$ROOT_DIR/scripts/install-codex-home.sh" "$TMPDIR_EVAL/unsafe-codex" --skills-dir "$unsafe" >/dev/null 2>&1; then
    _fail "global installer accepted unsafe skill namespace root: $unsafe"
  elif [[ ! -e "$SOURCE_DESCENDANT" && ! -e "$TMPDIR_EVAL/unsafe-codex" ]]; then
    _pass "unsafe root/overlap rejection occurs before destination mutation: $unsafe"
  else
    _fail "unsafe root/overlap rejection left destination mutations: $unsafe"
  fi
done

MIGRATE_CODEX="$TMPDIR_EVAL/migrate-codex"
MIGRATE_SKILLS="$TMPDIR_EVAL/migrate-agents/skills"
LEGACY_SKILLS_SEGMENT="skills"
LEGACY_USER_DIR="$MIGRATE_CODEX/$LEGACY_SKILLS_SEGMENT/user-legacy"
mkdir -p "$MIGRATE_CODEX/skills/plan-work" "$LEGACY_USER_DIR" "$MIGRATE_CODEX/.flow-agents"
cp "$ROOT_DIR/dist/codex/.agents/skills/plan-work/SKILL.md" "$MIGRATE_CODEX/skills/plan-work/SKILL.md"
printf '# modified legacy user content\n' > "$LEGACY_USER_DIR/SKILL.md"
node - "$MIGRATE_CODEX" <<'NODE'
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const root = process.argv[2];
const rels = ['skills' + '/plan-work/SKILL.md', 'skills' + '/user-legacy/SKILL.md'];
const files = rels.map(p => ({path:p, sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex')}));
fs.writeFileSync(path.join(root,'.flow-agents/codex-install-manifest.json'), JSON.stringify({schema_version:'1.0',files},null,2)+'\n');
fs.appendFileSync(path.join(root,'skills' + '/user-legacy/SKILL.md'), 'kept modification\n');
NODE
if HOME="$GLOBAL_HOME" CODEX_REAL_HOME="$MIGRATE_CODEX" bash "$ROOT_DIR/scripts/install-codex-home.sh" "$MIGRATE_CODEX" --skills-dir "$MIGRATE_SKILLS" >/dev/null 2>"$TMPDIR_EVAL/migrate.err" \
  && [[ ! -e "$MIGRATE_CODEX/skills/plan-work/SKILL.md" ]] \
  && rg -q 'kept modification' "$LEGACY_USER_DIR/SKILL.md" \
  && [[ -f "$MIGRATE_SKILLS/plan-work/SKILL.md" ]]; then
  _pass "legacy migration removes unchanged owned skills and preserves modified legacy content"
else
  _fail "legacy Flow Agents skill migration was destructive or incomplete"
fi

OPENCODE_AGENTS_DIR="$OPENCODE_FULL_DEST/.opencode/agents"
if [[ -f "$OPENCODE_AGENTS_DIR/tool-planner.md" && -f "$OPENCODE_AGENTS_DIR/dev.md" ]]; then
  _pass "opencode full install ships the complete agent base"
else
  _fail "opencode full install is missing base agents"
fi

if node - "$OPENCODE_FULL_DEST/.opencode/skills" "$OPENCODE_FULL_DEST" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [root, installRoot] = process.argv.slice(2);
const builder = [
  'builder-shape', 'continue-work', 'deliver', 'design-probe', 'evidence-gate',
  'execute-plan', 'fix-bug', 'gate-review', 'idea-to-backlog', 'learning-review',
  'pickup-probe', 'plan-work', 'pull-work', 'release-readiness', 'review-work',
  'tdd-workflow', 'verify-work',
];
for (const skill of [...builder, 'agentic-engineering']) {
  const file = path.join(root, skill, 'SKILL.md');
  if (!fs.existsSync(file)) throw new Error(`missing installed skill ${skill}`);
  if (builder.includes(skill)) {
    const text = fs.readFileSync(file, 'utf8');
    if (/npm run workflow:sidecar|flow-agents-workflow-sidecar|flow-agents builder-run/.test(text)) {
      throw new Error(`${skill} exposes a private workflow command`);
    }
    if (/--reviewer/.test(text)) {
      throw new Error(`${skill} exposes a caller-selected review identity`);
    }
    if (skill === 'verify-work' && (!/--criterion-json/.test(text) || /--command\s+"(?:true|node --version)"/.test(text))) {
      throw new Error('verify-work must ship criterion-backed substantive verification evidence guidance');
    }
    const refs = [...text.matchAll(/\b(?:context|docs|kits)\/[A-Za-z0-9_./-]+\.(?:md|json)\b/g)].map((match) => match[0]);
    for (const ref of refs) if (!fs.existsSync(path.join(installRoot, ref))) throw new Error(`${skill} has unresolved installed resource ${ref}`);
  }
}
NODE
then
  _pass "opencode full install ships all 17 coherent Builder skills and standalone skills"
else
  _fail "opencode full install is missing skills"
fi

echo ""
echo "==========================="
total=$((pass + fail))
echo "Results: ${pass}/${total} passed, ${fail} failed"
[[ "$fail" -gt 0 ]] && exit 1
exit 0
