#!/usr/bin/env bash
# Anti-gaming regression for delivery publication ownership.
#
# Delivery bytes may be copied only by the public workflow after canonical
# Builder lifecycle checks. Legacy sidecar state/release/promote surfaces must
# remain incapable of publishing or overwriting delivery/<slug>.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
errors=0

pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; errors=$((errors + 1)); }

REPO="$TMP/repo"
ARTIFACT_ROOT="$REPO/.kontourai/flow-agents"
SLUG="publication-owner"
SESSION="$ARTIFACT_ROOT/$SLUG"
DESTINATION="$REPO/delivery/$SLUG"
mkdir -p "$REPO/kits"
printf '# marker\n' > "$REPO/kits/.keep"

flow_agents_node workflow-sidecar ensure-session \
  --artifact-root "$ARTIFACT_ROOT" --task-slug "$SLUG" \
  --title "Publication ownership" --summary "Anti-gaming fixture." \
  --criterion "Only public workflow publishes." \
  --timestamp "2026-07-24T00:00:00Z" >/dev/null
flow_agents_node workflow-sidecar init-plan "$SESSION/$SLUG--deliver.md" \
  --source-request "fixture" --summary "fixture" \
  --timestamp "2026-07-24T00:01:00Z" >/dev/null
flow_agents_node workflow-sidecar record-evidence "$SESSION" \
  --verdict pass \
  --check-json '{"id":"build","kind":"build","status":"pass","summary":"ok"}' \
  --timestamp "2026-07-24T00:02:00Z" >/dev/null
echo "=== record-release cannot publish ==="
record_release_output="$(
  cd "$REPO" &&
  flow_agents_node workflow-sidecar record-release "$SESSION" \
    --decision merge \
    --gate-json '{"name":"merge","status":"pass","summary":"ready"}' \
    --summary "release recorded" --repo-root "$REPO" \
    --timestamp "2026-07-24T00:04:00Z" 2>&1
)"
record_release_status=$?
if [[ $record_release_status -eq 0 ]]; then
  pass "record-release preserves its state-recording contract"
else
  fail "record-release unexpectedly failed: $record_release_output"
fi
if grep -q "delivery publication is disabled on the sidecar surface" <<<"$record_release_output"; then
  pass "record-release reports the canonical public publication route"
else
  fail "record-release omitted its publication-boundary diagnostic"
fi
if [[ ! -e "$DESTINATION" ]]; then
  pass "record-release did not create delivery evidence"
else
  fail "record-release bypassed the public workflow and created $DESTINATION"
fi

echo "=== advance-state delivered cannot publish ==="
advance_output="$(
  cd "$REPO" &&
  flow_agents_node workflow-sidecar advance-state "$SESSION" \
    --status delivered --phase release --summary "delivered state" \
    --skip-learning "fixture waiver" --waived-by "fixture" \
    --repo-root "$REPO" --timestamp "2026-07-24T00:05:00Z" 2>&1
)"
advance_status=$?
if [[ $advance_status -eq 0 ]]; then
  pass "advance-state retains its explicit state-transition contract"
else
  fail "advance-state unexpectedly failed: $advance_output"
fi
if grep -q "delivery publication is disabled on the sidecar surface" <<<"$advance_output"; then
  pass "advance-state reports the canonical public publication route"
else
  fail "advance-state omitted its publication-boundary diagnostic"
fi
if [[ ! -e "$DESTINATION" ]]; then
  pass "advance-state did not create delivery evidence"
else
  fail "advance-state bypassed the public workflow and created $DESTINATION"
fi

echo "=== direct sidecar publication is disabled ==="
direct_output="$(cd "$REPO" && flow_agents_node workflow-sidecar publish-delivery "$SESSION" --repo-root "$REPO" 2>&1)"
direct_status=$?
if [[ $direct_status -ne 0 ]] && grep -q "workflow-sidecar publish-delivery is disabled" <<<"$direct_output"; then
  pass "direct sidecar publish-delivery fails closed with public-workflow guidance"
else
  fail "direct sidecar publish-delivery was not closed: status=$direct_status output=$direct_output"
fi
if [[ ! -e "$DESTINATION" ]]; then
  pass "disabled direct publication left delivery absent"
else
  fail "disabled direct publication changed $DESTINATION"
fi

echo "=== promote --publish is disabled ==="
promote_output="$(cd "$REPO" && flow_agents_node workflow-sidecar promote "$SESSION" --publish --repo-root "$REPO" 2>&1)"
promote_status=$?
if [[ $promote_status -ne 0 ]] && grep -q "promote --publish is disabled" <<<"$promote_output"; then
  pass "promote --publish fails closed"
else
  fail "promote --publish was not closed: status=$promote_status output=$promote_output"
fi

echo "=== public workflow still enforces canonical Builder completion ==="
public_output="$(cd "$REPO" && node "$ROOT/build/src/cli.js" workflow publish-delivery --session-dir "$SESSION" 2>&1)"
public_status=$?
if [[ $public_status -ne 0 ]] && grep -Eq "canonical builder\\.build|current session trust\\.bundle|canonical Flow|flow\\.run_location\\.not_found|run .* was not found" <<<"$public_output"; then
  pass "public workflow refuses a noncanonical legacy sidecar session"
else
  fail "public workflow did not enforce canonical Builder completion: status=$public_status output=$public_output"
fi
if [[ ! -e "$DESTINATION" ]]; then
  pass "failed public eligibility left delivery absent"
else
  fail "failed public eligibility changed $DESTINATION"
fi

echo "=== source ownership remains singular ==="
node - "$ROOT" <<'NODE'
const fs = require("fs");
const path = require("path");
const root = process.argv[2];
const sidecar = fs.readFileSync(path.join(root, "src/cli/workflow-sidecar.ts"), "utf8");
const workflow = fs.readFileSync(path.join(root, "src/cli/workflow.ts"), "utf8");
if (!/export async function publishDelivery\(/.test(sidecar)) throw new Error("shared copy primitive is missing");
if (!/if \(p\.flags\.has\("publish"\)\) die\("promote --publish is disabled;/.test(sidecar)) {
  throw new Error("promote does not fail closed before its legacy copy branch");
}
if (!/async function publishDeliveryCmd[\s\S]*?die\("workflow-sidecar publish-delivery is disabled;/.test(sidecar)) {
  throw new Error("direct sidecar publish-delivery does not fail closed");
}
const calls = workflow.match(/await publishDelivery\(/g) ?? [];
if (calls.length !== 1) throw new Error(`public workflow must own exactly one copy invocation; found ${calls.length}`);
console.log("  PASS: public workflow owns the reachable delivery copy path and legacy sidecar branches fail closed");
NODE
if [[ $? -ne 0 ]]; then
  fail "source ownership check failed"
fi

if [[ $errors -ne 0 ]]; then
  echo "test_publish_delivery: $errors check(s) failed"
  exit 1
fi
echo "test_publish_delivery: all checks passed."
