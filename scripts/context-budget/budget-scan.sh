#!/usr/bin/env bash
# budget-scan.sh — Scan Flow Agents bundles for token overhead estimation
# Usage: bash budget-scan.sh [--verbose]
set -euo pipefail

BUNDLE_DIR="${FLOW_AGENTS_BUNDLE_DIR:-${HOME}/.flow-agents}"
VERBOSE=false
[[ "${1:-}" == "--verbose" ]] && VERBOSE=true

# Handle missing bundle dir gracefully
if [[ ! -d "$BUNDLE_DIR" ]]; then
  echo '{"packages":[],"issues":[],"totals":{"context":0,"skills":0,"agents":0,"total":0}}'
  exit 0
fi

# Collect all bundle directories (top-level + local/)
_pkg_dirs=()
for d in "${BUNDLE_DIR}"/*/; do
  [[ ! -d "$d" ]] && continue
  base=$(basename "$d")
  if [[ "$base" == "local" ]]; then
    for ld in "${d}"*/; do
      [[ -d "$ld" ]] && _pkg_dirs+=("$ld")
    done
  else
    _pkg_dirs+=("$d")
  fi
done

estimate_tokens() {
  local file="$1"
  [[ ! -f "$file" ]] && echo 0 && return
  local words chars
  words=$(wc -w < "$file" 2>/dev/null | tr -d ' ')
  chars=$(wc -c < "$file" 2>/dev/null | tr -d ' ')
  case "$file" in
    *.sh|*.json) echo $(( chars / 4 )) ;;
    *) echo $(( (words * 13 + 9) / 10 )) ;;
  esac
}

count_lines() {
  local file="$1"
  [[ ! -f "$file" ]] && echo 0 && return
  wc -l < "$file" 2>/dev/null | tr -d ' '
}

skill_desc_words() {
  local file="$1"
  [[ ! -f "$file" ]] && echo 0 && return
  sed -n '/^---$/,/^---$/p' "$file" | grep -i 'description' | head -1 | wc -w | tr -d ' '
}

count_mcp_servers() {
  local file="$1"
  jq '[.mcpServers // {} | keys | length] | add // 0' "$file" 2>/dev/null || echo 0
}

count_tools() {
  local file="$1"
  jq '[.tools // [] | length] | add // 0' "$file" 2>/dev/null || echo 0
}

prompt_lines() {
  local file="$1"
  case "$file" in
    *.json)
      jq -r '.systemPrompt // .prompt // .developer_instructions // ""' "$file" 2>/dev/null | wc -l | tr -d ' '
      ;;
    *.toml)
      # Codex agent TOML stores instructions as escaped newlines in one string.
      awk -F' = ' '/^(developer_instructions|instructions|prompt) = / {print $2}' "$file" \
        | sed 's/^"//; s/"$//' \
        | perl -pe 's/\\n/\n/g' \
        | wc -l | tr -d ' '
      ;;
    *)
      echo 0
      ;;
  esac
}

packages_json='[]'
issues_json='[]'

for pkg_dir in "${_pkg_dirs[@]}"; do
  [[ ! -d "$pkg_dir" ]] && continue
  pkg_name=$(basename "$pkg_dir")

  context_tokens=0
  skill_tokens=0
  agent_tokens=0
  files_json='[]'

  # Scan context files
  while IFS= read -r -d '' f; do
    tokens=$(estimate_tokens "$f")
    lines=$(count_lines "$f")
    context_tokens=$((context_tokens + tokens))
    rel="${f#"$pkg_dir"}"
    if $VERBOSE; then
      files_json=$(echo "$files_json" | jq -c --arg p "$rel" --argjson t "$tokens" --argjson l "$lines" '. + [{path:$p,tokens:$t,lines:$l,type:"context"}]')
    fi
    if [[ "$lines" -gt 100 ]]; then
      issues_json=$(echo "$issues_json" | jq -c --arg p "${pkg_name}/${rel}" --argjson l "$lines" '. + [{type:"context_bloat",path:$p,lines:$l,suggestion:"Consider moving to context/deferred/ or splitting"}]')
    fi
  done < <(find "${pkg_dir}context" -name '*.md' -print0 2>/dev/null || true)

  # Scan skills
  while IFS= read -r -d '' f; do
    tokens=$(estimate_tokens "$f")
    desc_words=$(skill_desc_words "$f")
    skill_tokens=$((skill_tokens + tokens))
    rel="${f#"$pkg_dir"}"
    if $VERBOSE; then
      files_json=$(echo "$files_json" | jq -c --arg p "$rel" --argjson t "$tokens" --argjson dw "$desc_words" '. + [{path:$p,tokens:$t,desc_words:$dw,type:"skill"}]')
    fi
    if [[ "$desc_words" -gt 30 ]]; then
      issues_json=$(echo "$issues_json" | jq -c --arg p "${pkg_name}/${rel}" --argjson w "$desc_words" '. + [{type:"bloated_skill_desc",path:$p,words:$w,suggestion:"Trim description to under 30 words"}]')
    fi
  done < <(find "${pkg_dir}skills" -name 'SKILL.md' -print0 2>/dev/null || true)

  # Scan agent specs
  while IFS= read -r -d '' f; do
    tokens=$(estimate_tokens "$f")
    pl=$(prompt_lines "$f")
    mcp=$(count_mcp_servers "$f")
    tools=$(count_tools "$f")
    agent_tokens=$((agent_tokens + tokens))
    rel="${f#"$pkg_dir"}"
    if $VERBOSE; then
      files_json=$(echo "$files_json" | jq -c --arg p "$rel" --argjson t "$tokens" --argjson pl "$pl" --argjson mcp "$mcp" --argjson tools "$tools" '. + [{path:$p,tokens:$t,prompt_lines:$pl,mcp_servers:$mcp,tools:$tools,type:"agent"}]')
    fi
    if [[ "$pl" -gt 200 ]]; then
      issues_json=$(echo "$issues_json" | jq -c --arg p "${pkg_name}/${rel}" --argjson l "$pl" '. + [{type:"heavy_agent_spec",path:$p,prompt_lines:$l,suggestion:"Reduce systemPrompt or move to context file"}]')
    fi
    if [[ "$mcp" -gt 10 ]] || [[ "$tools" -gt 50 ]]; then
      issues_json=$(echo "$issues_json" | jq -c --arg p "${pkg_name}/${rel}" --argjson m "$mcp" --argjson t "$tools" '. + [{type:"mcp_oversubscription",path:$p,mcp_servers:$m,tools:$t,suggestion:"Reduce MCP servers or tools per agent"}]')
    fi
  done < <(find "${pkg_dir}agents" \( -name '*agent-spec.json' -o -name '*.json' -o -name '*.toml' \) -print0 2>/dev/null || true)

  total=$((context_tokens + skill_tokens + agent_tokens))
  pkg_entry=$(jq -nc \
    --arg name "$pkg_name" \
    --argjson context "$context_tokens" \
    --argjson skills "$skill_tokens" \
    --argjson agents "$agent_tokens" \
    --argjson total "$total" \
    --argjson files "$files_json" \
    '{name:$name,tokens:{context:$context,skills:$skills,agents:$agents,total:$total},files:$files}')
  packages_json=$(echo "$packages_json" | jq -c --argjson p "$pkg_entry" '. + [$p]')
done

total_context=$(echo "$packages_json" | jq '[.[].tokens.context] | add // 0')
total_skills=$(echo "$packages_json" | jq '[.[].tokens.skills] | add // 0')
total_agents=$(echo "$packages_json" | jq '[.[].tokens.agents] | add // 0')
total_all=$(echo "$packages_json" | jq '[.[].tokens.total] | add // 0')

jq -nc \
  --argjson packages "$packages_json" \
  --argjson issues "$issues_json" \
  --argjson tc "$total_context" \
  --argjson ts "$total_skills" \
  --argjson ta "$total_agents" \
  --argjson tt "$total_all" \
  '{packages:$packages,issues:$issues,totals:{context:$tc,skills:$ts,agents:$ta,total:$tt}}'
