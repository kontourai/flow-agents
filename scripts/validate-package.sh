#!/usr/bin/env bash
# validate-package.sh — Validate an installed Flow Agents bundle
# Usage: bash validate-package.sh <package-prefix> [--local]
set -uo pipefail

PREFIX="${1:?Usage: validate-package.sh <package-prefix> [--local]}"
[[ "${2:-}" == "--local" ]] && PREFIX="local-${PREFIX}"

AGENTS_DIR="$HOME/.kiro/agents"
errors=0

echo "Package: ${PREFIX}"
echo ""

# Find agents
count=$(ls "$AGENTS_DIR/${PREFIX}-"*.json 2>/dev/null | wc -l | tr -d ' ')
echo "Agents: ${count} found"
[[ "$count" -eq 0 ]] && echo "✗ No agents found" && exit 1
echo ""

# 1. Well-formedness
spec_ok=0; spec_fail=0
for f in "$AGENTS_DIR/${PREFIX}-"*.json; do
  name=$(jq -r '.name // empty' "$f")
  has_all=$(jq -r 'if .name and .prompt and .model and .description then "yes" else "no" end' "$f")
  if [[ "$has_all" != "yes" ]]; then
    echo "  ✗ $(basename $f): missing required field(s)"
    spec_fail=$((spec_fail + 1))
  elif ! echo "$name" | grep -qE '^[a-z][a-z0-9-]*$'; then
    echo "  ✗ $name: invalid name format"
    spec_fail=$((spec_fail + 1))
  else
    spec_ok=$((spec_ok + 1))
  fi
done
echo "$([ $spec_fail -eq 0 ] && echo ✓ || echo ✗) Agent specs: ${spec_ok}/${count} well-formed"
errors=$((errors + spec_fail))

# 2. Hook scripts
hook_total=0; hook_fail=0
for f in "$AGENTS_DIR/${PREFIX}-"*.json; do
  name=$(jq -r '.name' "$f")
  for cmd in $(jq -r '.hooks // {} | .[] | .[] | .command // empty' "$f" 2>/dev/null); do
    : # jq gives full command, need line-by-line
  done
  jq -r '.hooks // {} | to_entries[] | .key as $t | .value[] | "\($t)|\(.command // empty)"' "$f" 2>/dev/null | while IFS='|' read -r htype cmd; do
    [[ -z "$cmd" ]] && continue
    script=$(echo "$cmd" | sed 's/^bash //' | awk '{print $1}')
    script="${script/#\~/$HOME}"
    if [[ ! -f "$script" ]]; then
      echo "  ✗ $name → $htype: $(basename $script) (not found)"
    fi
  done
done
hook_total=$(for f in "$AGENTS_DIR/${PREFIX}-"*.json; do jq '[.hooks // {} | .[] | .[]] | length' "$f" 2>/dev/null; done | awk '{s+=$1}END{print s}')
hook_fail=$(for f in "$AGENTS_DIR/${PREFIX}-"*.json; do
  jq -r '.hooks // {} | .[] | .[] | .command // empty' "$f" 2>/dev/null | while read cmd; do
    [[ -z "$cmd" ]] && continue
    script=$(echo "$cmd" | sed 's/^bash //' | awk '{print $1}')
    script="${script/#\~/$HOME}"
    [[ ! -f "$script" ]] && echo "x"
  done
done | wc -l | tr -d ' ')
hook_ok=$((hook_total - hook_fail))
echo "$([ $hook_fail -eq 0 ] && echo ✓ || echo ✗) Hook scripts: ${hook_ok}/${hook_total} resolved"
errors=$((errors + hook_fail))

# 3. Absolute resource paths
res_fail=0
for f in "$AGENTS_DIR/${PREFIX}-"*.json; do
  name=$(jq -r '.name' "$f")
  jq -r '.resources // [] | .[] | select(startswith("file://"))' "$f" 2>/dev/null | while read res; do
    path="${res#file://}"
    path="${path/#\~/$HOME}"
    [[ "$path" == *"*"* || "$path" != /* ]] && continue
    if [[ ! -f "$path" && ! -d "$path" ]]; then
      echo "  ✗ $name: missing $path"
    fi
  done
done
echo "✓ Resources: checked"

# 4. Summary
echo ""
if [[ $errors -eq 0 ]]; then
  echo "Result: PASS"
else
  echo "Result: FAIL ($errors error(s))"
fi
