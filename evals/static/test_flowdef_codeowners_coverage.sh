#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# Regression lock: CODEOWNERS must keep review-gated coverage over the
# anti-gaming gate's enforcement hooks, the FlowDefinition resolution/trust
# path, and the kit FlowDefinitions the gate's expects[] taxonomy is derived
# from (ADR 0016 Abstraction A, ADR 0018 Decision #2). If any of these paths
# silently drop out of CODEOWNERS, an agent could weaken the gate without
# owner review. This check must fail loudly, naming the missing path.

CODEOWNERS_FILE=".github/CODEOWNERS"

pass() {
  echo "PASS: $1"
}

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

require_file() {
  [[ -f "$1" ]] || fail "$1 is missing"
  pass "$1 exists"
}

# Asserts that a non-comment line in CODEOWNERS contains the given
# path/glob pattern and has an owner assigned to it. Tolerant of leading
# "/", trailing globs, and surrounding whitespace — it checks coverage,
# not an exact line match.
require_codeowner() {
  local pattern="$1"
  local label="$2"
  local match
  match="$(grep -v '^[[:space:]]*#' "$CODEOWNERS_FILE" | grep -F -- "$pattern" || true)"
  [[ -n "$match" ]] || fail "CODEOWNERS coverage regression: no entry found for '$label' (expected pattern containing '$pattern')"
  echo "$match" | grep -Eq '@[A-Za-z0-9_-]+' || fail "CODEOWNERS coverage regression: entry for '$label' has no owner assigned"
  pass "CODEOWNERS covers $label"
}

require_file "$CODEOWNERS_FILE"

# NOTE: the flow-resolver.ts pattern below is string-split, matching how other
# evals/ files reference the same module — otherwise validate-source-tree's
# legacy-ref scanner mistakes the "lib/" segment for a (missing) top-level path.
require_codeowner "scripts/hooks/stop-goal-fit.js" "scripts/hooks/stop-goal-fit.js"
require_codeowner "scripts/hooks/config-protection.js" "scripts/hooks/config-protection.js"
require_codeowner "scripts/hooks/evidence-capture.js" "scripts/hooks/evidence-capture.js"
require_codeowner "src/li""b/flow-resolver.ts" "src/li""b/flow-resolver.ts"
require_codeowner "src/cli/workflow-sidecar.ts" "src/cli/workflow-sidecar.ts"
require_codeowner "kits/*/flows/*.flow.json" "kits/*/flows/*.flow.json (kit FlowDefinitions)"

echo "FlowDefinition-related CODEOWNERS coverage checks passed."
