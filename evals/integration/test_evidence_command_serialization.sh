#!/usr/bin/env bash
# test_evidence_command_serialization.sh — kontourai/flow-agents#974
#
# The canonical writer executes every evidence --command it is given. It must run them
# SEQUENTIALLY, never concurrently: evidence commands are test runs against one working
# tree, so any two that build shared artifacts (every integration eval here starts with
# `npm run build:bundles`) race and one fails — turning a green tree into an unrecordable
# claim, which blocks the verify gate and publish.
#
# Proves this behaviourally against the REAL writer (not a reimplementation of its loop):
# two probe commands each append START/END markers to a shared log with a delay between.
# Concurrent execution interleaves them (START a, START b, ...); sequential execution
# completes one before starting the next.
#
# Note on the invocation: the writer executes the supplied commands inside
# normalizeObservedCommands BEFORE it validates the claim shape, so the marker log is
# written even though this probe's claim is subsequently rejected (repeatable --command is
# accepted only for tests-evidence claims). The rejection is expected and irrelevant here —
# the code path under test is the observation loop, which has already run.
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
echo "--- writer executes evidence commands sequentially, not concurrently ---"

node "$WRITER" ensure-session --artifact-root "$ARTIFACT_ROOT" --task-slug probe-serialize \
  --summary "evidence command serialization probe" --criterion "c1" --flow-id builder.build \
  > "$TMP/ensure.log" 2>&1

if [[ -d "$ARTIFACT_ROOT/probe-serialize" ]]; then
  _pass "probe session created"
else
  _fail "probe session was not created"
  tail -3 "$TMP/ensure.log"
fi

# Drives the real writer. Its observation loop runs both commands before any claim-shape
# validation, so the marker log reflects the writer's own execution ordering.
node "$WRITER" record-gate-claim "$ARTIFACT_ROOT/probe-serialize" \
  --status pass --summary "serialization probe" \
  --command "bash $TMP/probe_a.sh" --command "bash $TMP/probe_b.sh" \
  > "$TMP/claim.log" 2>&1 || true

if [[ -s "$MARK" ]]; then
  _pass "writer executed the supplied evidence commands"
else
  _fail "writer did not execute the supplied commands (no markers recorded)"
  tail -3 "$TMP/claim.log"
fi

ORDER="$(tr '\n' ' ' < "$MARK" | sed 's/  */ /g; s/ *$//')"

if [[ "$ORDER" == "START a END a START b END b" || "$ORDER" == "START b END b START a END a" ]]; then
  _pass "execution did not overlap (observed order: $ORDER)"
else
  _fail "evidence commands overlapped — the writer ran them concurrently (observed order: $ORDER)"
fi

# The regression signature, independent of which probe happens to run first: a fan-out shows
# up as two STARTs before either END.
FIRST_TWO="$(head -2 "$MARK" | tr '\n' ' ' | sed 's/ *$//')"
case "$FIRST_TWO" in
  START*START*) _fail "two commands started before either finished — concurrent execution" ;;
  *)            _pass "no second command started before the first finished" ;;
esac

echo ""
echo "==========================="
total=$((pass + fail))
echo "Results: ${pass}/${total} passed, ${fail} failed"
[[ "$fail" -gt 0 ]] && exit 1
exit 0
