#!/usr/bin/env bash
# test_package.sh — Layer 1: Static validation of installed agent package
# Extends validate-package.sh with comprehensive checks
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/evals/lib/node.sh"
AGENTS_DIR="$HOME/.kiro/agents"
TMP_INSTALL_DIR=""
cleanup() {
  [[ -n "$TMP_INSTALL_DIR" ]] && rm -rf "$TMP_INSTALL_DIR"
}
trap cleanup EXIT

# Auto-detect install mode: local (default) or VS-installed packages
# Override: EVAL_MODE=vs bash evals/run.sh static
EVAL_MODE="${EVAL_MODE:-auto}"
if [[ "$EVAL_MODE" == "auto" ]]; then
  if [[ -f "$ROOT_DIR/scripts/build-universal-bundles.js" && -d "$ROOT_DIR/agents" ]]; then
    EVAL_MODE="repo"
  elif ls "$AGENTS_DIR"/*.json &>/dev/null; then
    EVAL_MODE="local"
  else
    EVAL_MODE="vs"
  fi
fi

if [[ "$EVAL_MODE" == "repo" ]]; then
  if [[ ! -d "$ROOT_DIR/dist/kiro/agents" ]]; then
    (cd "$ROOT_DIR" && flow_agents_node scripts/build-universal-bundles.js >/dev/null)
  fi
  TMP_INSTALL_DIR="$(mktemp -d /tmp/kiro-static-package.XXXXXX)"
  (cd "$ROOT_DIR/dist/kiro" && bash install.sh "$TMP_INSTALL_DIR" >/dev/null)
  PACKAGE_DIR="$TMP_INSTALL_DIR"
  AGENT_GLOB="$PACKAGE_DIR/agents/*.json"
elif [[ "$EVAL_MODE" == "local" ]]; then
  PACKAGE_DIR="$HOME/.flow-agents"
  AGENT_GLOB="$AGENTS_DIR/*.json"
else
  PACKAGE_DIR="$HOME/.flow-agents"
  AGENT_GLOB="$AGENTS_DIR/kiro-agents-*.json"
fi
# Collect matching agent files once
AGENT_FILES=()
for _f in $AGENT_GLOB; do [[ -f "$_f" ]] && AGENT_FILES+=("$_f"); done
pass=0; fail=0; skip=0

_pass() { echo "  ✓ $1"; pass=$((pass + 1)); }
_fail() { echo "  ✗ $1"; fail=$((fail + 1)); }
_skip() { echo "  ○ $1"; skip=$((skip + 1)); }

echo "=== Layer 1: Static Package Validation ==="
echo "Mode: ${EVAL_MODE}"
echo ""

if [[ "$EVAL_MODE" == "repo" ]]; then
  echo "--- Source Tree ---"
  if (cd "$ROOT_DIR" && flow_agents_node scripts/validate-source-tree.js >/tmp/source-tree-validation.txt 2>&1); then
    _pass "source tree validation passed"
  else
    _fail "source tree validation failed (see /tmp/source-tree-validation.txt)"
  fi
  if node - "$ROOT_DIR/package.json" <<'NODE'
const fs = require("node:fs");
const pkg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const files = pkg.files;
if (!Array.isArray(files) || files.length === 0) {
  throw new Error("package.json must define an explicit npm files allowlist");
}
const required = [
  "agents/",
  "build/",
  "console.telemetry.json",
  "context/",
  "docs/",
  "evals/",
  "install.sh",
  "kits/",
  "packaging/",
  "scripts/",
  "skills/",
  "src/",
];
for (const entry of required) {
  if (!files.includes(entry)) throw new Error(`package files allowlist missing ${entry}`);
}
const requiredExcludes = [
  "!evals/cases/dev/node_modules/",
  "!**/.flow-agents/",
  "!**/.surface/",
  "!**/.telemetry/",
  "!**/.veritas/",
  "!**/node_modules/",
];
for (const entry of requiredExcludes) {
  if (!files.includes(entry)) throw new Error(`package files allowlist missing exclusion ${entry}`);
}
const forbidden = [
  ".agents/",
  ".codex/",
  ".claude/",
  ".flow-agents/",
  ".surface/",
  ".telemetry/",
  ".veritas/",
  "dist/",
  "node_modules/",
  "_site/",
  "test-results/",
];
for (const entry of files) {
  if (!entry.startsWith("!") && forbidden.includes(entry)) throw new Error(`package files allowlist includes runtime/generated path ${entry}`);
}
NODE
  then
    _pass "package uses explicit npm files allowlist"
  else
    _fail "package npm files allowlist is missing or unsafe"
  fi
  legacy_pattern='[Kk]agents|K''AGENTS|[Kk]agents\.dev'
  if (cd "$ROOT_DIR" && git ls-files -z | xargs -0 rg -n "$legacy_pattern" >/tmp/legacy-product-refs.txt 2>&1); then
    _fail "tracked source contains legacy Flow Agents rename references (see /tmp/legacy-product-refs.txt)"
  else
    _pass "tracked source has no legacy Flow Agents rename references"
  fi
  if (cd "$ROOT_DIR" && FLOW_AGENTS_CONTENT_BOUNDARY_FILES='.flow-agents/example/state.json' node scripts/check-content-boundary.cjs >/tmp/content-boundary-runtime.out 2>&1); then
    _fail "content boundary allows ordinary workflow runtime artifacts"
  elif rg -q 'Flow Agents runtime artifact must not be tracked' /tmp/content-boundary-runtime.out; then
    _pass "content boundary blocks ordinary workflow runtime artifacts"
  else
    _fail "content boundary runtime rejection was not actionable"
  fi
  if (cd "$ROOT_DIR" && FLOW_AGENTS_CONTENT_BOUNDARY_FILES='.flow-agents/nested/example/closeout.md' node scripts/check-content-boundary.cjs >/tmp/content-boundary-nested.out 2>&1); then
    _fail "content boundary allows nested workflow runtime artifacts"
  elif rg -q 'Flow Agents runtime artifact must not be tracked' /tmp/content-boundary-nested.out; then
    _pass "content boundary blocks nested workflow runtime artifacts"
  else
    _fail "content boundary nested runtime rejection was not actionable"
  fi
  current_branch="$(cd "$ROOT_DIR" && git branch --show-current 2>/dev/null || true)"
  tracked_runtime_artifacts="$(cd "$ROOT_DIR" && git ls-files -- '.flow-agents' 2>/dev/null || true)"
  if [[ "$current_branch" == "main" && -n "$tracked_runtime_artifacts" ]]; then
    printf '%s\n' "$tracked_runtime_artifacts" >/tmp/tracked-flow-agent-runtime-artifacts.txt
    _fail "main contains tracked workflow runtime artifacts (see /tmp/tracked-flow-agent-runtime-artifacts.txt)"
  elif [[ "$current_branch" == "main" ]]; then
    _pass "main has no tracked workflow runtime artifacts"
  else
    _skip "tracked workflow runtime artifact main-branch guard skipped off main"
  fi
  echo ""

  echo "--- Flow Kits ---"
  if [[ -f "$PACKAGE_DIR/kits/catalog.json" && -f "$PACKAGE_DIR/kits/builder/kit.json" ]]; then
    _pass "installed bundle includes Kit Catalog and Builder Kit manifest"
  else
    _fail "installed bundle is missing Kit Catalog or Builder Kit manifest"
  fi
  if [[ -f "$PACKAGE_DIR/kits/builder/flows/shape.flow.json" && -f "$PACKAGE_DIR/kits/builder/flows/build.flow.json" ]]; then
    _pass "installed bundle includes Builder Kit Flow Definitions"
  else
    _fail "installed bundle is missing Builder Kit Flow Definitions"
  fi
  if node - "$PACKAGE_DIR/kits/catalog.json" "$PACKAGE_DIR/kits/builder/kit.json" "$PACKAGE_DIR/kits/builder/flows/shape.flow.json" "$PACKAGE_DIR/kits/builder/flows/build.flow.json" <<'NODE'
const fs = require("node:fs");
for (const file of process.argv.slice(2)) JSON.parse(fs.readFileSync(file, "utf8"));
console.log("ok");
NODE
  then
    _pass "installed kit JSON parses"
  else
    _fail "installed kit JSON parse failed"
  fi
  if node - "$PACKAGE_DIR/kits/builder/flows/build.flow.json" <<'NODE'
const fs = require("node:fs");
const flow = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const steps = Object.fromEntries((flow.steps || []).map((step) => [step.id, step.next]));
if (steps["pull-work"] !== "design-probe") throw new Error("pull-work should route to design-probe");
if (steps["design-probe"] !== "plan") throw new Error("design-probe should route to plan");
const designGate = flow.gates?.["design-probe-gate"] || {};
const expectIds = new Set((designGate.expects || []).map((item) => item.id));
for (const required of ["pickup-probe-readiness", "probe-decisions-or-accepted-gaps"]) if (!expectIds.has(required)) throw new Error(`design-probe-gate missing ${required}`);
const gateText = JSON.stringify(designGate);
for (const term of ["goal fit", "blockers", "dependencies", "dependency freshness", "acceptance criteria quality", "provider state", "stop-short risks", "planning readiness", "accepted gaps"]) {
  if (!gateText.includes(term)) throw new Error(`design-probe-gate missing pickup Probe term: ${term}`);
}
const expected = { missing_evidence: "verify", implementation_defect: "execute", plan_gap: "plan", decision_gap: "design-probe" };
for (const gateId of ["verify-gate", "merge-ready-gate"]) {
  const gate = flow.gates?.[gateId] || {};
  for (const [reason, target] of Object.entries(expected)) if (gate.on_route_back?.[reason] !== target) throw new Error(`${gateId} ${reason} should route to ${target}`);
  if (gate.route_back_policy?.on_exceeded !== "block") throw new Error(`${gateId} route_back_policy should block on exceeded attempts`);
}
const expectations = Object.values(flow.gates || {}).flatMap((gate) => gate.expects || []);
if (!expectations.length) throw new Error("Builder build flow should declare gate expectations");
for (const expectation of expectations) {
  if (expectation.kind !== "surface.claim") throw new Error(`${expectation.id || "<unknown>"} should remain a surface.claim expectation`);
  if (!expectation.claim?.type || !expectation.claim?.accepted_statuses) throw new Error(`${expectation.id || "<unknown>"} should declare claim type and accepted statuses`);
}
const flowText = JSON.stringify(flow).toLowerCase();
for (const term of ["veritas", "trust_provider", "trust-provider", "provider_name", "provider_ref", "veritas_policy", "veritas_readiness"]) {
  if (flowText.includes(term)) throw new Error(`Builder build flow should not name provider-specific trust field: ${term}`);
}
console.log("ok");
NODE
  then
    _pass "installed Builder Kit build flow keeps provider-neutral surface.claim gates"
  else
    _fail "installed Builder Kit build flow route-back or provider-neutral gate policy missing or wrong"
  fi
  echo ""
fi

# --- 1. Agent count ---
count=${#AGENT_FILES[@]}
echo "Agents found: ${count}"
[[ "$count" -eq 0 ]] && echo "✗ No agents found" && exit 1

# --- 2. Schema validation ---
echo ""
echo "--- Schema ---"
for f in "${AGENT_FILES[@]}"; do
  name=$(jq -r '.name // empty' "$f" 2>/dev/null)
  [[ -z "$name" ]] && { _fail "$(basename "$f"): missing .name"; continue; }

  has_all=$(jq -r 'if .name and .prompt and .model and .description then "yes" else "no" end' "$f" 2>/dev/null)
  if [[ "$has_all" != "yes" ]]; then
    _fail "$name: missing required field (name/prompt/model/description)"
  elif ! echo "$name" | grep -qE '^[a-z][a-z0-9-]*$'; then
    _fail "$name: invalid name format (must match ^[a-z][a-z0-9-]*$)"
  else
    _pass "$name: schema valid"
  fi
done

# --- 3. No unresolved templates ---
echo ""
echo "--- Templates ---"
for f in "${AGENT_FILES[@]}"; do
  name=$(jq -r '.name' "$f" 2>/dev/null)
  if grep -q '{{aim:' "$f" 2>/dev/null; then
    _fail "$name: unresolved {{aim:}} template"
  else
    _pass "$name: templates resolved"
  fi
done

# --- 4. Hook scripts exist ---
echo ""
echo "--- Hooks ---"
for f in "${AGENT_FILES[@]}"; do
  name=$(jq -r '.name' "$f" 2>/dev/null)
  hook_fail=0
  while read -r cmd; do
    [[ -z "$cmd" ]] && continue
    script=$(echo "$cmd" | sed 's/^bash //' | awk '{print $1}')
    if [[ -f "$script" ]] || command -v "$script" >/dev/null 2>&1; then
      :
    else
      _fail "$name: hook script missing: $(basename "$script")"
      hook_fail=1
    fi
  done < <(jq -r '.hooks // {} | to_entries[] | .value[] | .command // empty' "$f" 2>/dev/null)
  hcount=$(jq '[.hooks // {} | .[] | .[]] | length' "$f" 2>/dev/null)
  [[ "$hcount" -gt 0 && "$hook_fail" -eq 0 ]] && _pass "$name: $hcount hooks, scripts exist"
done

# --- 5. Resource paths resolve ---
echo ""
echo "--- Resources ---"
for f in "${AGENT_FILES[@]}"; do
  name=$(jq -r '.name' "$f" 2>/dev/null)
  rfail=0
  while read -r res; do
    rpath="${res#file://}"
    rpath="${rpath/#\~/$HOME}"
    [[ "$rpath" == *"*"* || "$rpath" != /* ]] && continue
    if [[ ! -f "$rpath" && ! -d "$rpath" ]]; then
      _fail "$name: resource missing: $rpath"
      rfail=1
    fi
  done < <(jq -r '.resources // [] | .[] | select(type == "string") | select(startswith("file://"))' "$f" 2>/dev/null)
  [[ "$rfail" -eq 0 ]] && _pass "$name: file:// resources resolve"
done

# --- 6. Subagent routing ---
echo ""
echo "--- Subagent Routing ---"
all_agents=$(for f in "${AGENT_FILES[@]}"; do jq -r '.name' "$f" 2>/dev/null; done)
for f in "${AGENT_FILES[@]}"; do
  name=$(jq -r '.name' "$f" 2>/dev/null)
  patterns=$(jq -r '.toolsSettings.subagent.availableAgents // [] | .[]' "$f" 2>/dev/null)
  [[ -z "$patterns" ]] && continue
  for pat in $patterns; do
    # Convert glob to regex
    regex=$(echo "$pat" | sed 's/\*/.*/')
    matched=$(echo "$all_agents" | grep -cE "^${regex}$")
    if [[ "$matched" -gt 0 ]]; then
      _pass "$name: pattern '$pat' matches $matched agent(s)"
    else
      _fail "$name: pattern '$pat' matches no installed agents"
    fi
  done
done

# --- 7. MCP servers on PATH ---
echo ""
echo "--- MCP Servers ---"
for f in "${AGENT_FILES[@]}"; do
  name=$(jq -r '.name' "$f" 2>/dev/null)
  jq -r '.mcpServers // {} | to_entries[] | .value.command' "$f" 2>/dev/null | while read -r cmd; do
    [[ -z "$cmd" ]] && continue
    if command -v "$cmd" >/dev/null 2>&1; then
      _pass "$name: MCP '$cmd' on PATH"
    else
      _fail "$name: MCP '$cmd' not on PATH"
    fi
  done
done

# --- 8. Knowledge base sources ---
echo ""
echo "--- Knowledge Bases ---"
for f in "${AGENT_FILES[@]}"; do
  name=$(jq -r '.name' "$f" 2>/dev/null)
  while read -r src; do
    spath="${src#file://}"
    spath="${spath/#\~/$HOME}"
    if [[ -d "$spath" ]]; then
      fcount=$(find "$spath" -type f 2>/dev/null | head -100 | wc -l | tr -d ' ')
      _pass "$name: KB source '$spath' exists ($fcount files)"
    else
      _fail "$name: KB source missing: $spath"
    fi
  done < <(jq -r '.resources // [] | .[] | select(type == "object") | select(.type == "knowledgeBase") | .source' "$f" 2>/dev/null)
done

# --- 9. tool-* agents should not have write tools ---
echo ""
echo "--- Write Tool Invariant ---"
WRITE_TOOLS='write files|write'
for f in "${AGENT_FILES[@]}"; do
  name=$(jq -r '.name' "$f" 2>/dev/null)
  [[ "$name" != tool-* ]] && continue
  allowed=$(jq -r '.allowedTools // [] | .[]' "$f" 2>/dev/null)
  if echo "$allowed" | grep -qE "^(${WRITE_TOOLS})$"; then
    # Allow write if scoped via toolsSettings.write.allowedPaths
    scoped=$(jq -r '.toolsSettings.write.allowedPaths // [] | length' "$f" 2>/dev/null)
    if [[ "$scoped" -gt 0 ]]; then
      paths=$(jq -r '.toolsSettings.write.allowedPaths | join(", ")' "$f" 2>/dev/null)
      _pass "$name: write scoped to [$paths]"
    else
      _fail "$name: has write tools in allowedTools"
    fi
  else
    _pass "$name: no write tools (read-only)"
  fi
done

# --- 10. Agent cards match installed agents ---
echo ""
echo "--- Agent Cards ---"
card_globs=()
if [[ "$EVAL_MODE" == "repo" ]]; then
  _skip "repo mode installs a temp bundle; agent-card matching is not applicable"
elif [[ "$EVAL_MODE" == "local" ]]; then
  card_globs=("$PACKAGE_DIR"/../*/agent-card.json "$PACKAGE_DIR"/../../*/agent-card.json)
else
  card_globs=("$PACKAGE_DIR"/agent-card.json)
fi
if [[ "${#card_globs[@]}" -gt 0 ]]; then
  for card in "${card_globs[@]}"; do
    [[ -f "$card" ]] || continue
    agent=$(node -e 'const fs=require("node:fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).agent || "")' "$card" 2>/dev/null)
    [[ -z "$agent" ]] && continue
    if ls "$AGENTS_DIR"/*-"${agent}.json" &>/dev/null; then
      _pass "Agent card '$agent' has matching installed agent"
    else
      _fail "Agent card '$agent' has no matching installed agent"
    fi
  done
fi

# --- Summary ---
echo ""
echo "==========================="
total=$((pass + fail))
echo "Results: ${pass}/${total} passed, ${fail} failed, ${skip} skipped"
[[ "$fail" -gt 0 ]] && exit 1
exit 0
