#!/usr/bin/env bash
# test_evidence_command_serialization.sh — kontourai/flow-agents#974
#
# The canonical writer must reject an invalid claim before executing any supplied evidence
# command. Sequential execution for a valid multi-command tests-evidence claim is covered by
# test_workflow_sidecar_writer.sh, which has the complete review and acceptance fixture.
#
# Proves behaviourally against the real writer that repeatable --command on a non-test gate
# is rejected without running either command.
#
# Deterministic, no model spend, no network, self-cleaning.
# Usage: bash evals/integration/test_evidence_command_serialization.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WRITER="$ROOT/build/src/cli/workflow-sidecar.js"
TMP="$(mktemp -d /tmp/evidence-serialization.XXXXXX)"
pass=0
fail=0

_pass() { echo "  ✓ $1"; pass=$((pass + 1)); }
_fail() { echo "  ✗ $1"; fail=$((fail + 1)); }

cleanup() {
  # Never let cleanup decide the verdict.
  rm -rf "$TMP" 2>/dev/null || true
}
trap cleanup EXIT

if [[ ! -f "$WRITER" ]]; then
  echo "  ✗ writer not built at $WRITER (run npm run build)"
  echo "Results: 0/1 passed, 1 failed"
  exit 1
fi

export MARK="$TMP/order.log"
: > "$MARK"

for name in a b; do
  cat > "$TMP/probe_${name}.sh" <<PROBE
#!/usr/bin/env bash
echo "START ${name}" >> "\$MARK"
sleep 1
echo "END ${name}" >> "\$MARK"
exit 0
PROBE
  chmod +x "$TMP/probe_${name}.sh"
done

ARTIFACT_ROOT="$TMP/.kontourai/flow-agents"
mkdir -p "$ARTIFACT_ROOT"

echo ""
echo "--- writer rejects invalid evidence-command shape before execution ---"

node "$WRITER" ensure-session --artifact-root "$ARTIFACT_ROOT" --task-slug probe-serialize \
  --summary "evidence command serialization probe" --criterion "c1" --flow-id builder.build \
  > "$TMP/ensure.log" 2>&1

if [[ -d "$ARTIFACT_ROOT/probe-serialize" ]]; then
  _pass "probe session created"
else
  _fail "probe session was not created"
  tail -3 "$TMP/ensure.log"
fi

# This is intentionally invalid at the first builder.build gate: repeatable --command is
# available only to a passing tests-evidence expectation.
node "$WRITER" record-gate-claim "$ARTIFACT_ROOT/probe-serialize" \
  --status pass --summary "serialization probe" \
  --command "bash $TMP/probe_a.sh" --command "bash $TMP/probe_b.sh" \
  > "$TMP/claim.log" 2>&1 || true

if [[ ! -s "$MARK" ]]; then
  _pass "writer did not execute commands from the rejected claim"
else
  _fail "writer executed commands before rejecting the claim"
  tail -3 "$TMP/claim.log"
fi

if grep -q "repeatable --command only for passing tests-evidence claims" "$TMP/claim.log"; then
  _pass "writer reports the preflight shape rejection"
else
  _fail "writer did not report the expected preflight rejection"
  tail -3 "$TMP/claim.log"
fi

echo ""
echo "==========================="
total=$((pass + fail))
echo "Results: ${pass}/${total} passed, ${fail} failed"
[[ "$fail" -gt 0 ]] && exit 1
exit 0
