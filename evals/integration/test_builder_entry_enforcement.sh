#!/usr/bin/env bash
# Proves first-step workflow entry and provider-neutral local work-item anchoring (#438).

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

TMP="$(mktemp -d)"
errors=0
trap 'rm -rf "$TMP"' EXIT

pass() { printf '  PASS %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; errors=$((errors + 1)); }

WRITER="workflow-sidecar"

echo "=== Builder workflow entry enforcement ==="

REFUSED_ROOT="$TMP/refused/.kontourai/flow-agents"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$REFUSED_ROOT" \
  --task-slug refused-plan \
  --title "Refused plan entry" \
  --summary "Must enter through the declared prefix." \
  --flow-id builder.build \
  --step-id plan >"$TMP/refused.out" 2>&1; then
  fail "fresh later-step entry is rejected"
elif [[ ! -e "$REFUSED_ROOT" ]] && grep -q 'must start at first step "pull-work"' "$TMP/refused.out"; then
  pass "fresh later-step entry is rejected before artifact-root creation"
else
  fail "later-step refusal wrote files or returned the wrong diagnostic: $(cat "$TMP/refused.out")"
fi

AD_HOC_ROOT="$TMP/ad-hoc/.kontourai/flow-agents"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$AD_HOC_ROOT" \
  --task-slug refused-ad-hoc \
  --title "Refused ad-hoc entry" \
  --summary "A reason is not workflow authority." \
  --flow-id builder.build \
  --step-id plan \
  --ad-hoc-reason "skip the prefix" >"$TMP/ad-hoc.out" 2>&1; then
  fail "ad-hoc reason cannot authorize later-step entry"
elif [[ ! -e "$AD_HOC_ROOT" ]] && grep -q 'cannot authorize workflow entry' "$TMP/ad-hoc.out"; then
  pass "ad-hoc reason cannot authorize later-step entry or write artifacts"
else
  fail "ad-hoc refusal wrote files or returned the wrong diagnostic: $(cat "$TMP/ad-hoc.out")"
fi

LOCAL_ROOT="$TMP/local/.kontourai/flow-agents"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$LOCAL_ROOT" \
  --task-slug local-request \
  --title "Local request" \
  --summary "Providerless work still needs an anchor." \
  --flow-id builder.build \
  --timestamp "2026-07-10T00:00:00Z" >"$TMP/local.out" 2>&1; then
  if node - "$LOCAL_ROOT" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const current = JSON.parse(fs.readFileSync(path.join(root, 'current.json'), 'utf8'));
const state = JSON.parse(fs.readFileSync(path.join(root, 'local-request', 'state.json'), 'utf8'));
const workItem = JSON.parse(fs.readFileSync(path.join(root, 'local-request', 'work-item.json'), 'utf8'));
if (current.active_flow_id !== 'builder.build' || current.active_step_id !== 'pull-work') process.exit(1);
if (state.status !== 'new' || state.phase !== 'pickup') process.exit(1);
if (JSON.stringify(state.work_item_refs) !== JSON.stringify(['local:local-request'])) process.exit(1);
if (workItem.id !== 'local-request' || workItem.title !== 'Local request') process.exit(1);
if (workItem.source_provider?.kind !== 'local' || workItem.source_provider?.path !== 'work-item.json') process.exit(1);
if (!state.next_action?.summary?.includes('Flow step "pull-work"')) process.exit(1);
NODE
  then
    pass "providerless request creates a local Work Item and starts at pull-work"
  else
    fail "local Work Item or first-step state is invalid"
  fi
else
  fail "providerless Builder entry failed: $(cat "$TMP/local.out")"
fi

PROVIDER_ROOT="$TMP/provider/.kontourai/flow-agents"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$PROVIDER_ROOT" \
  --work-item "kontourai/flow-agents#438" \
  --title "Provider work item" \
  --summary "Keep the provider reference." \
  --flow-id builder.build \
  --timestamp "2026-07-10T00:01:00Z" >/dev/null 2>&1 \
  && node - "$PROVIDER_ROOT/kontourai-flow-agents-438/state.json" <<'NODE'
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (JSON.stringify(state.work_item_refs) !== JSON.stringify(['kontourai/flow-agents#438'])) process.exit(1);
NODE
then
  pass "provider-backed request preserves its neutral work-item ref"
else
  fail "provider-backed work-item ref was not persisted"
fi

# A direct primitive remains usable without claiming Builder prefix completion.
STANDALONE_ROOT="$TMP/standalone/.kontourai/flow-agents"
if flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$STANDALONE_ROOT" \
  --task-slug standalone-plan \
  --title "Standalone plan" \
  --summary "Direct primitive session." \
  --timestamp "2026-07-10T00:02:00Z" >/dev/null 2>&1 \
  && node - "$STANDALONE_ROOT" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const current = JSON.parse(fs.readFileSync(path.join(root, 'current.json'), 'utf8'));
const state = JSON.parse(fs.readFileSync(path.join(root, 'standalone-plan', 'state.json'), 'utf8'));
if ('active_flow_id' in current || 'active_step_id' in current) process.exit(1);
if (state.status !== 'planned' || state.phase !== 'planning') process.exit(1);
if (JSON.stringify(state.work_item_refs) !== JSON.stringify(['local:standalone-plan'])) process.exit(1);
NODE
then
  pass "standalone primitive session remains available without a Builder stamp"
else
  fail "standalone primitive session was incorrectly stamped as Builder"
fi

if [[ "$errors" -gt 0 ]]; then
  printf 'test_builder_entry_enforcement: %d failure(s)\n' "$errors" >&2
  exit 1
fi

echo "test_builder_entry_enforcement: all checks passed"
