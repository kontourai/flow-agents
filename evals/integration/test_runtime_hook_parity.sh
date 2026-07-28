#!/usr/bin/env bash
# test_runtime_hook_parity.sh — #1024: every shipped runtime carries every canonical policy hook,
# or declares the gap with a reason.
#
# The defect this exists to prevent: `exportClaudeSettings` and `exportCodexHooks` were
# hand-maintained parallel lists, and codex's copy omitted `config-protection` (the gate that
# refuses interpreter writes to protected gate files) and `quality-gate`. Nothing failed, nothing
# warned, and nothing declared the gap — a codex session simply ran unprotected. That is the
# "absence of signal reads as success" shape, in the one layer whose whole job is enforcement.
#
# Asserts against the GENERATED BUNDLES, not the table, so a table that says the right thing while
# the emitter does something else still fails.
#
# Usage: bash evals/integration/test_runtime_hook_parity.sh

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1

errors=0
_pass() { echo "  PASS: $1"; }
_fail() { echo "  FAIL: $1"; errors=$((errors + 1)); }

# Canonical policies every runtime must run unless it declares otherwise.
UNIVERSAL_HOOKS=(config-protection quality-gate evidence-capture stop-goal-fit workflow-steering)

echo ""
echo "=== bundles are present (regenerate with 'npm run build:bundles' if this fails) ==="
if [[ -f dist/claude-code/.claude/settings.json && -f dist/codex/.codex/hooks.json \
   && -f dist/opencode/.opencode/plugins/flow-agents.js && -f dist/pi/.pi/extensions/flow-agents.ts ]]; then
  _pass "all four runtime bundles exist"
else
  echo "  SKIP: bundles not built; run 'npm run build:bundles' first." >&2
  echo "  ACCEPTED GAP: recording as an explicit skip, not a pass." >&2
  exit 1
fi

check_runtime() {
  local label="$1" file="$2"
  echo ""
  echo "=== $label ==="
  for hook in "${UNIVERSAL_HOOKS[@]}"; do
    if grep -q "$hook" "$file"; then
      _pass "$label wires $hook"
    else
      _fail "$label is MISSING $hook — wire it, or declare it in RUNTIME_POLICY_EVENTS with a RUNTIME_HOOK_NOTES reason"
    fi
  done
}

check_runtime "claude-code" dist/claude-code/.claude/settings.json
check_runtime "codex"       dist/codex/.codex/hooks.json
check_runtime "opencode"    dist/opencode/.opencode/plugins/flow-agents.js
check_runtime "pi"          dist/pi/.pi/extensions/flow-agents.ts

# Regression pin for the specific defect: codex must carry the two hooks it silently lacked.
echo ""
echo "=== #1024 regression pin: codex parity on the two hooks it silently lacked ==="
for hook in config-protection quality-gate; do
  if grep -q "$hook" dist/codex/.codex/hooks.json; then
    _pass "codex carries $hook (was absent before #1024)"
  else
    _fail "codex lost $hook again — the shared POLICY_HOOKS table is no longer load-bearing"
  fi
done

# The build-time assertions must actually refuse an undeclared gap.
echo ""
echo "=== build-time coverage assertion refuses an undeclared gap ==="
if node -e '
  const m = require("./build/src/tools/build-universal-bundles.js");
  if (typeof m.assertGeneratedPolicyCoverage !== "function") { console.error("assertGeneratedPolicyCoverage not exported"); process.exit(2); }
  try {
    // opencode maps config-protection; a source that omits it must be refused.
    m.assertGeneratedPolicyCoverage("opencode", "// a plugin that wires nothing at all");
    process.exit(1); // did NOT throw -> the guard is inert
  } catch { process.exit(0); }
' 2>/dev/null; then
  _pass "assertGeneratedPolicyCoverage throws when a mapped hook is missing from generated source"
else
  _fail "assertGeneratedPolicyCoverage did not refuse a source missing a mapped hook — the guard is inert"
fi

# The bypass an independent review reproduced: enforcement removed, the script name left behind in
# a dead comment. A whole-file substring check passed this, so a runtime shipped enforcing nothing
# behind a fully green evidence trail. Mention is not wiring.
if node -e '
  const m = require("./build/src/tools/build-universal-bundles.js");
  const mentionOnly = "// mentions config-protection.js quality-gate.js evidence-capture.js stop-goal-fit.js workflow-steering.js\nexport default function(){ return {}; }";
  try { m.assertGeneratedPolicyCoverage("opencode", mentionOnly); process.exit(1); } catch { process.exit(0); }
' 2>/dev/null; then
  _pass "a source that only MENTIONS the hook scripts in a comment is refused (mention is not wiring)"
else
  _fail "a comment-only mention satisfied the coverage guard — a runtime can ship enforcing nothing"
fi

# Wiring is bound to the mapped event, so a hook silently relocated to the wrong lifecycle point is
# refused too. This is also what separates workflow-steering-session from workflow-steering-prompt,
# which share one script but map to different events.
if node -e '
  const m = require("./build/src/tools/build-universal-bundles.js");
  // Every hook wired, but config-protection moved off tool.execute.before onto the wrong event.
  const wrongEvent = [
    "runAdapter(a, \"session.created\", d, \"workflow-steering\", \"workflow-steering.js\");",
    "runAdapter(a, \"session.idle\", d, \"config-protection\", \"config-protection.js\");",
    "runAdapter(a, \"tool.execute.after\", d, \"quality-gate\", \"quality-gate.js\");",
    "runAdapter(a, \"tool.execute.after\", d, \"evidence-capture\", \"evidence-capture.js\");",
    "runAdapter(a, \"session.idle\", d, \"stop-goal-fit\", \"stop-goal-fit.js\");",
  ].join("\n");
  try { m.assertGeneratedPolicyCoverage("opencode", wrongEvent); process.exit(1); } catch { process.exit(0); }
' 2>/dev/null; then
  _pass "a hook wired to the WRONG lifecycle event is refused, not counted as covered"
else
  _fail "a hook wired to the wrong event satisfied the coverage guard"
fi

echo ""
echo "----------------------------------------------"
if [[ $errors -eq 0 ]]; then
  echo "test_runtime_hook_parity: all checks passed."
  exit 0
else
  echo "test_runtime_hook_parity: $errors check(s) failed."
  exit 1
fi
