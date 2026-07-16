#!/usr/bin/env bash
# telemetry.sh — Kiro adapter for generic agent telemetry schema v0.3.0
# Usage: echo '<hook_event_json>' | bash telemetry.sh <event_type> <agent_name>
set -o pipefail

TELEMETRY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

source "${TELEMETRY_DIR}/lib/config.sh"
source "${TELEMETRY_DIR}/lib/session.sh"
source "${TELEMETRY_DIR}/lib/enrich.sh"
source "${TELEMETRY_DIR}/lib/transport.sh"
source "${TELEMETRY_DIR}/lib/usage.sh"

normalize_tool_name() {
  case "$1" in
    Bash|bash|shell|execute_bash) echo "execute_bash" ;;
    apply_patch|Edit|Write|fs_write|write|code) echo "fs_write" ;;
    spawn_agent|use_subagent|InvokeSubagents|Task|Agent|"delegate to a specialist agent") echo "use_subagent" ;;
    Read|read|fs_read) echo "fs_read" ;;
    *) echo "$1" ;;
  esac
}

telemetry_session_id() {
  local event_type="$1" agent_name="$2"
  local session_id=""
  case "$event_type" in
    agentSpawn)
      session_id=$(session_start "$agent_name")
      session_cleanup
      ;;
    stop)
      session_id=$(session_get)
      session_end
      ;;
    *)
      session_id=$(session_get)
      # Touch session file so mtime reflects last activity
      local _sf="${TELEMETRY_SESSION_DIR}/telemetry-${PPID}"
      [[ -f "$_sf" ]] && touch "$_sf" 2>/dev/null
      ;;
  esac
  echo "${session_id:-no-session}"
}

schema_event_type() {
  local event_type="$1"
  case "$event_type" in
    agentSpawn|SessionStart) echo "session.start" ;;
    stop|Stop|SessionEnd) echo "session.end" ;;
    userPromptSubmit|UserPromptSubmit) echo "turn.user" ;;
    preToolUse|PreToolUse) echo "tool.invoke" ;;
    permissionRequest|PermissionRequest) echo "tool.permission_request" ;;
    postToolUse|PostToolUse|PostToolUseFailure) echo "tool.result" ;;
    *) echo "unknown" ;;
  esac
}

runtime_version() {
  local runtime_name runtime_binary runtime_version
  runtime_name="$1"
  case "$runtime_name" in
    codex) runtime_binary="codex" ;;
    claude|claude-code) runtime_binary="claude"; runtime_name="claude-code" ;;
    kiro|kiro-cli) runtime_binary="kiro-cli"; runtime_name="kiro-cli" ;;
    *) runtime_binary="$runtime_name" ;;
  esac
  runtime_version=$(
    "$runtime_binary" --version 2>/dev/null &
    _pid=$!; ( sleep 2; kill $_pid 2>/dev/null ) &
    _guard=$!; wait $_pid 2>/dev/null; kill $_guard 2>/dev/null
    wait $_pid 2>/dev/null
  ) 2>/dev/null
  runtime_version=$(echo "$runtime_version" | head -n1)
  echo "${runtime_version:-unknown}"
}

build_base_event() {
  local session_id="$1" schema_event_type="$2" agent_name="$3"
  local runtime_name="${FLOW_AGENTS_TELEMETRY_RUNTIME:-kiro-cli}"
  case "$runtime_name" in
    claude|claude-code) runtime_name="claude-code" ;;
    kiro|kiro-cli) runtime_name="kiro-cli" ;;
  esac
  jq -nc \
    --arg sv "0.3.0" \
    --arg ts "$(date +%s)000" \
    --arg sid "$session_id" \
    --arg eid "$(uuidgen 2>/dev/null || echo "e-$(date +%s)-$$")" \
    --arg et "$schema_event_type" \
    --arg an "$agent_name" \
    --arg rv "$(runtime_version "$runtime_name")" \
    --arg rn "$runtime_name" \
    '{
      schema_version: $sv,
      timestamp: $ts,
      session_id: $sid,
      event_id: $eid,
      event_type: $et,
      agent: {
        name: $an,
        runtime: $rn,
        version: $rv
      }
    }'
}

add_hook_context() {
  local event="$1" event_type="$2" stdin_json="$3"
  local cwd tty_name pid runtime_session_id runtime_turn_id transcript_path hook_event_name model_name source stop_hook_active last_assistant_message raw_hook_input task_slug
  cwd=$(echo "$stdin_json" | jq -r '.cwd // ""')
  # Work-item attribution: stamp the active Builder run's slug (from the same
  # current.json .active_slug the economics relay reads) so tool/turn events can
  # be grouped per work item downstream. Absent for non-Builder sessions — never
  # fabricated. Only the slug string is stored; no prompt/args/file content.
  task_slug=""
  if [[ -n "$cwd" ]]; then
    if [[ -f "$cwd/.kontourai/flow-agents/current.json" ]]; then
      task_slug=$(jq -r '.active_slug // .artifact_dir // empty' "$cwd/.kontourai/flow-agents/current.json" 2>/dev/null)
    elif [[ -f "$cwd/.flow-agents/current.json" ]]; then
      task_slug=$(jq -r '.active_slug // .artifact_dir // empty' "$cwd/.flow-agents/current.json" 2>/dev/null)
    fi
  fi
  runtime_session_id=$(echo "$stdin_json" | jq -r '.session_id // ""')
  runtime_turn_id=$(echo "$stdin_json" | jq -r '.turn_id // ""')
  transcript_path=$(echo "$stdin_json" | jq -r '.transcript_path // ""')
  hook_event_name=$(echo "$stdin_json" | jq -r '.hook_event_name // ""')
  model_name=$(echo "$stdin_json" | jq -r '.model // ""')
  source=$(echo "$stdin_json" | jq -r '.source // ""')
  stop_hook_active=$(echo "$stdin_json" | jq -r '.stop_hook_active // empty')
  last_assistant_message=$(echo "$stdin_json" | jq -r '.last_assistant_message // ""')
  if [[ "$FLOW_AGENTS_TELEMETRY_CAPTURE_RAW_HOOK_INPUT" == "true" ]]; then
    raw_hook_input="$stdin_json"
  else
    raw_hook_input="null"
  fi
  tty_name=$(session_get_tty)
  pid=$(cat "${TELEMETRY_SESSION_DIR}/${session_id}.session" 2>/dev/null | jq -r '.pid // empty')
  echo "$event" | jq -c \
    --arg event_name "${hook_event_name:-$event_type}" \
    --arg runtime_session_id "$runtime_session_id" \
    --arg turn_id "$runtime_turn_id" \
    --arg transcript_path "$transcript_path" \
    --arg model "$model_name" \
    --arg source "$source" \
    --arg stop_hook_active "$stop_hook_active" \
    --arg last_assistant_message "$last_assistant_message" \
    --arg task_slug "$task_slug" \
    --argjson raw "$raw_hook_input" \
    '. + {
      hook: {
        event_name: $event_name,
        runtime_session_id: $runtime_session_id,
        turn_id: $turn_id,
        transcript_path: $transcript_path,
        model: $model,
        source: $source,
        stop_hook_active: (if $stop_hook_active == "" then null else ($stop_hook_active == "true") end),
        last_assistant_message: $last_assistant_message,
        raw_input: $raw
      }
    }
    + (if $task_slug == "" then {} else {task_slug: $task_slug} end)'
}

add_runtime_context() {
  local event="$1" event_type="$2" stdin_json="$3"
  local cwd tty_name pid
  cwd=$(echo "$stdin_json" | jq -r '.cwd // ""')
  tty_name=$(session_get_tty)
  pid=$(cat "${TELEMETRY_SESSION_DIR}/${session_id}.session" 2>/dev/null | jq -r '.pid // empty')
  if [[ "$event_type" == "agentSpawn" ]]; then
    local sys_json ws_json auth_json
    sys_json=$(enrich_system)
    ws_json=$(enrich_workspace)
    auth_json=$(enrich_auth)
    
    local os shell
    os=$(echo "$sys_json" | jq -r '.os // "unknown"')
    shell=$(echo "$sys_json" | jq -r '.shell // "unknown"')
    
    echo "$event" | jq -c \
      --arg cwd "$cwd" \
      --arg tty "$tty_name" \
      --arg os "$os" \
      --arg shell "$shell" \
      --argjson pid "${pid:-0}" \
      --argjson sys "$sys_json" \
      --argjson ws "$ws_json" \
      --argjson auth "$auth_json" \
      '. + {
        context: {cwd: $cwd, tty: $tty, os: $os, shell: $shell, pid: $pid},
        enrichment: {system: $sys, workspace: $ws, auth: $auth}
      }'
  else
    echo "$event" | jq -c \
      --arg cwd "$cwd" \
      --arg tty "$tty_name" \
      --argjson pid "${pid:-0}" \
      '. + {context: {cwd: $cwd, tty: $tty, pid: $pid}}'
  fi
}

add_user_prompt_data() {
  local event="$1" stdin_json="$2"
  local prompt_text prompt_length
  prompt_text=$(echo "$stdin_json" | jq -r '.prompt // ""')
  prompt_length=${#prompt_text}
  echo "$event" | jq -c \
    --arg pt "$prompt_text" \
    --argjson pl "$prompt_length" \
    '. + {turn: {prompt_text: $pt, prompt_length: $pl}}'
}

add_tool_event_data() {
  local event="$1" event_type="$2" stdin_json="$3"
  local tool_name tool_normalized_name tool_input tool_output permission_description
  tool_name=$(echo "$stdin_json" | jq -r '.tool_name // ""')
  tool_normalized_name=$(normalize_tool_name "$tool_name")
  tool_input=$(echo "$stdin_json" | jq -c '.tool_input // null')
  tool_output=$(echo "$stdin_json" | jq -c '.tool_response // null')
  permission_description=$(echo "$stdin_json" | jq -r '.tool_input.description // ""')

  if [[ "$event_type" == "preToolUse" ]]; then
    event=$(echo "$event" | jq -c \
      --arg tn "$tool_name" \
      --arg nn "$tool_normalized_name" \
      --argjson ti "$tool_input" \
      '. + {tool: {name: $tn, normalized_name: $nn, input: $ti}}')
  elif [[ "$event_type" == "permissionRequest" || "$event_type" == "PermissionRequest" ]]; then
    event=$(echo "$event" | jq -c \
      --arg tn "$tool_name" \
      --arg nn "$tool_normalized_name" \
      --argjson ti "$tool_input" \
      --arg desc "$permission_description" \
      '. + {tool: {name: $tn, normalized_name: $nn, input: $ti}, permission: {description: $desc}}')
  else
    event=$(echo "$event" | jq -c \
      --arg tn "$tool_name" \
      --arg nn "$tool_normalized_name" \
      --argjson to "$tool_output" \
      '. + {tool: {name: $tn, normalized_name: $nn, output: $to}}')
  fi

  echo "$event"
}

emit_delegation_event() {
  local event="$1" event_type="$2" stdin_json="$3"
  local tool_name tool_input
  tool_name=$(echo "$stdin_json" | jq -r '.tool_name // ""')
  tool_input=$(echo "$stdin_json" | jq -c '.tool_input // null')

  if [[ "$tool_name" == "InvokeSubagents" && "$event_type" == "preToolUse" ]]; then
    local targets
    targets=$(echo "$tool_input" | jq -c '.targets // []')
    if [[ "$targets" != "[]" ]]; then
      local delegate_event
      delegate_event=$(echo "$event" | jq -c \
        --argjson targets "$targets" \
        '.event_type = "agent.delegate" | . + {delegation: {targets: $targets}} | del(.tool)')
      transport_emit "$delegate_event"
    fi
  elif [[ "$tool_name" == "spawn_agent" && "$event_type" == "preToolUse" ]]; then
    local target
    target=$(echo "$tool_input" | jq -r '.agent_type // "default"')
    if [[ -n "$target" && "$target" != "null" ]]; then
      local delegate_event
      delegate_event=$(echo "$event" | jq -c \
        --arg target "$target" \
        '.event_type = "agent.delegate" | . + {delegation: {targets: [$target]}} | del(.tool)')
      transport_emit "$delegate_event"
    fi
  elif [[ "$tool_name" == "use_subagent" || "$tool_name" == "subagent" || "$tool_name" == "delegate to a specialist agent" ]] && [[ "$event_type" == "preToolUse" ]]; then
    local targets
    targets=$(echo "$tool_input" | jq -c '
      if (.targets? | type) == "array" then .targets
      elif (.subagents? | type) == "array" then .subagents | map(.agent_name // .agent // .subagent_type // .name // "subagent")
      elif (.content.subagents? | type) == "array" then .content.subagents | map(.agent_name // .agent // .subagent_type // .name // "subagent")
      elif (.agent_name? // .agent? // .subagent_type? // empty) != "" then [(.agent_name // .agent // .subagent_type)]
      else ["subagent"]
      end
    ')
    if [[ "$targets" != "[]" ]]; then
      local delegate_event
      delegate_event=$(echo "$event" | jq -c \
        --argjson targets "$targets" \
        '.event_type = "agent.delegate" | . + {delegation: {targets: $targets}} | del(.tool)')
      transport_emit "$delegate_event"
    fi
  elif [[ "$tool_name" == "Task" || "$tool_name" == "Agent" ]] && [[ "$event_type" == "preToolUse" ]]; then
    local target
    target=$(echo "$tool_input" | jq -r '.subagent_type // .agent_type // .agent // "general-purpose"')
    if [[ -n "$target" && "$target" != "null" ]]; then
      local delegate_event
      delegate_event=$(echo "$event" | jq -c \
        --arg target "$target" \
        '.event_type = "agent.delegate" | . + {delegation: {targets: [$target]}} | del(.tool)')
      transport_emit "$delegate_event"
    fi
  fi
}

add_tool_data_and_emit_delegation() {
  local event="$1" event_type="$2" stdin_json="$3"
  event=$(add_tool_event_data "$event" "$event_type" "$stdin_json")
  emit_delegation_event "$event" "$event_type" "$stdin_json"
  echo "$event"
}

# add_tool_usage_data — populates .usage on tool.invoke/tool.result events
# (preToolUse/postToolUse only; see add_event_specific_data's explicit
# permissionRequest exclusion) with the model/token/cost usage of the turn
# that produced this specific tool call (#568 slice 1). Same field shape
# session.usage already emits (model, input_tokens, output_tokens,
# cache_creation_input_tokens, cache_read_input_tokens, estimated_cost_usd,
# pricing_version) so console consumers reuse the same parsing path.
#
# Fallback tiers (never invent a number):
#   1. transcript-tail join succeeds (usage_last_turn_usage) -> full usage,
#      attributable to this exact turn (not the session aggregate).
#   2. transcript join fails but hook.model is present (and not "unknown")
#      -> .usage.model only, every token/cost field explicitly null.
#   3. neither available -> all .usage.* fields null (today's pre-existing,
#      unchanged no-data state).
add_tool_usage_data() {
  local event="$1"
  local transcript_path hook_model
  transcript_path=$(echo "$event" | jq -r '.hook.transcript_path // ""')
  hook_model=$(echo "$event" | jq -r '.hook.model // ""')

  local turn_usage joined
  turn_usage=""
  if [[ -n "$transcript_path" ]]; then
    turn_usage=$(usage_last_turn_usage "$transcript_path")
  fi

  if [[ -n "$turn_usage" ]]; then
    # Guard the transcript-join jq. usage_last_turn_usage is well-formed today,
    # but if it ever emits non-JSON (a future regression), `--argjson tu` errors
    # to empty stdout, which would blackhole the ENTIRE tool event downstream
    # (transport_emit drops an empty event). Degrade to the model-only / full-
    # null tiers below instead of losing the record — consistent with this
    # feature's "never invent, always degrade gracefully, never block" contract.
    joined=$(echo "$event" | jq -c --argjson tu "$turn_usage" '. + {
      usage: {
        model: $tu.model,
        input_tokens: $tu.input_tokens,
        output_tokens: $tu.output_tokens,
        cache_creation_input_tokens: $tu.cache_creation_input_tokens,
        cache_read_input_tokens: $tu.cache_read_input_tokens,
        estimated_cost_usd: $tu.estimated_cost_usd,
        pricing_version: $tu.pricing_version
      }
    }' 2>/dev/null) || joined=""
    if [[ -n "$joined" ]]; then
      printf '%s\n' "$joined"
      return
    fi
  fi

  if [[ -n "$hook_model" && "$hook_model" != "unknown" ]]; then
    echo "$event" | jq -c --arg m "$hook_model" '. + {
      usage: {
        model: $m,
        input_tokens: null,
        output_tokens: null,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        estimated_cost_usd: null,
        pricing_version: null
      }
    }'
  else
    echo "$event" | jq -c '. + {
      usage: {
        model: null,
        input_tokens: null,
        output_tokens: null,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        estimated_cost_usd: null,
        pricing_version: null
      }
    }'
  fi
}

add_stop_data_and_emit_usage() {
  local event="$1" agent_name="$2"
  local duration_s
  duration_s=$(cat "${TELEMETRY_SESSION_DIR}/${session_id}.session" 2>/dev/null | jq -r '.duration_s // 0')
  event=$(echo "$event" | jq -c \
    --argjson ds "$duration_s" \
    '. + {session: {duration_s: $ds}}')

  if [[ "$TELEMETRY_USAGE_TRACKING" == "true" ]]; then
    local model tool_count delegation_count
    model=$(usage_get_model "$agent_name")
    local full_log="${TELEMETRY_CHANNEL_FULL_LOG_FILE}"
    tool_count=$(usage_count_tool_calls "$session_id" "$full_log")
    delegation_count=$(usage_count_delegations "$session_id" "$full_log")

    # Ground-truth token + cost usage from the runtime transcript, when the
    # runtime exposes one (Claude Code, Codex, etc. set hook.transcript_path).
    # Tokens are source-of-truth; estimated_cost_usd is derived from pricing.json
    # (recomputed authoritatively console-side, so pricing updates are retroactive).
    local transcript_path transcript_usage
    transcript_path=$(echo "$event" | jq -r '.hook.transcript_path // ""')
    transcript_usage=$(usage_parse_transcript "$transcript_path")
    [[ -z "$transcript_usage" ]] && transcript_usage='null'

    # Prefer the transcript-derived model (runtime-agnostic — works for any
    # runtime that exposes a transcript) over the kiro-only ~/.kiro/agents
    # lookup above, which never resolves for non-kiro agent names (e.g.
    # Claude Code's fixed "dev" hook arg) and falls through to "unknown".
    # Falls back to usage_get_model's kiro result when no transcript usage
    # is available (kiro-cli path is unchanged: transcript_usage stays null).
    if [[ "$transcript_usage" != "null" ]]; then
      local transcript_model
      transcript_model=$(usage_model_from_transcript_usage "$transcript_usage")
      [[ -n "$transcript_model" ]] && model="$transcript_model"
    fi

    local usage_event
    usage_event=$(echo "$event" | jq -c \
      --arg m "$model" \
      --argjson tc "$tool_count" \
      --argjson dc "$delegation_count" \
      --argjson tu "$transcript_usage" \
      '.event_type = "session.usage" | .event_id = (.event_id + "-usage") | . + {
        usage: ({
          model: $m,
          duration_s: .session.duration_s,
          tool_invocations: $tc,
          delegations: $dc,
          input_tokens: ($tu.input_tokens // null),
          output_tokens: ($tu.output_tokens // null),
          cache_creation_input_tokens: ($tu.cache_creation_input_tokens // null),
          cache_read_input_tokens: ($tu.cache_read_input_tokens // null),
          estimated_cost_usd: ($tu.estimated_cost_usd // null),
          pricing_version: ($tu.pricing_version // null),
          by_model: ($tu.by_model // null)
        })
      }')
    transport_emit "$usage_event"

    # Per-run kit-economics record (#349, console ADR 0003). Best-effort + DETACHED so it can never
    # alter existing telemetry timing or fail the stop hook: assemble one kontour.console.economics
    # fact from this session.usage event + the run's review sidecars, write it local-first, then
    # opt-in relay it. Resolve the sidecar paths from the run cwd's active-session pointer; the
    # emitter defaults every field cleanly when a sidecar is absent.
    local econ_script="${TELEMETRY_DIR}/economics-record.sh"
    if [[ -f "$econ_script" ]]; then
      local econ_cwd econ_slug econ_state econ_acceptance econ_critique
      econ_cwd=$(echo "$usage_event" | jq -r '.context.cwd // ""' 2>/dev/null)
      [[ -z "$econ_cwd" || ! -d "$econ_cwd" ]] && econ_cwd="$PWD"
      # Active slug from the canonical current pointer first, falling back to the legacy pointer.
      econ_slug=""
      if [[ -f "$econ_cwd/.kontourai/flow-agents/current.json" ]]; then
        econ_slug=$(jq -r '.active_slug // .artifact_dir // empty' "$econ_cwd/.kontourai/flow-agents/current.json" 2>/dev/null)
      elif [[ -f "$econ_cwd/.flow-agents/current.json" ]]; then
        econ_slug=$(jq -r '.active_slug // .artifact_dir // empty' "$econ_cwd/.flow-agents/current.json" 2>/dev/null)
      fi
      econ_state="" econ_acceptance="" econ_critique="" econ_agents_dir=""
      if [[ -n "$econ_slug" ]]; then
        # state.json under .kontourai/flow-agents/<slug>/ (fallback .flow-agents/<slug>/); the run's
        # per-agent event logs live alongside it in <slug>/agents/ (#415 delegations[] source).
        for d in "$econ_cwd/.kontourai/flow-agents/$econ_slug" "$econ_cwd/.flow-agents/$econ_slug"; do
          [[ -f "$d/state.json" ]] && { econ_state="$d/state.json"; [[ -d "$d/agents" ]] && econ_agents_dir="$d/agents"; break; }
        done
        [[ -f "$econ_cwd/.flow-agents/$econ_slug/acceptance.json" ]] && econ_acceptance="$econ_cwd/.flow-agents/$econ_slug/acceptance.json"
        [[ -f "$econ_cwd/.flow-agents/$econ_slug/critique.json" ]] && econ_critique="$econ_cwd/.flow-agents/$econ_slug/critique.json"
      fi
      local econ_args=("$usage_event")
      [[ -n "$econ_state" ]] && econ_args+=(--state "$econ_state")
      [[ -n "$econ_acceptance" ]] && econ_args+=(--acceptance "$econ_acceptance")
      [[ -n "$econ_critique" ]] && econ_args+=(--critique "$econ_critique")
      [[ -n "$econ_agents_dir" ]] && econ_args+=(--agents-dir "$econ_agents_dir")
      (bash "$econ_script" "${econ_args[@]}") </dev/null >/dev/null 2>&1 &
      disown 2>/dev/null || true
    fi
  fi

  echo "$event"
}

add_event_specific_data() {
  local event="$1" event_type="$2" agent_name="$3" stdin_json="$4"
  case "$event_type" in
    userPromptSubmit|UserPromptSubmit)
      add_user_prompt_data "$event" "$stdin_json"
      ;;
    preToolUse|PreToolUse|postToolUse|PostToolUse|PostToolUseFailure)
      event=$(add_tool_data_and_emit_delegation "$event" "$event_type" "$stdin_json")
      if [[ "$TELEMETRY_USAGE_TRACKING" == "true" ]]; then
        event=$(add_tool_usage_data "$event")
      fi
      echo "$event"
      ;;
    permissionRequest|PermissionRequest)
      # Explicit scope boundary (#568 slice 1): tool.permission_request does
      # NOT receive .usage enrichment — only preToolUse/postToolUse do.
      add_tool_data_and_emit_delegation "$event" "$event_type" "$stdin_json"
      ;;
    stop|Stop|SessionEnd)
      add_stop_data_and_emit_usage "$event" "$agent_name"
      ;;
    *)
      echo "$event"
      ;;
  esac
}

main() {
  [[ "$TELEMETRY_ENABLED" != "true" ]] && return 0

  local event_type="${1:-unknown}" agent_name="${2:-unknown}"
  local stdin_json="${3:-}"
  [[ -z "$stdin_json" ]] && stdin_json='{}'

  session_id=$(telemetry_session_id "$event_type" "$agent_name")
  local event
  event=$(build_base_event "$session_id" "$(schema_event_type "$event_type")" "$agent_name")
  event=$(add_hook_context "$event" "$event_type" "$stdin_json")
  event=$(add_runtime_context "$event" "$event_type" "$stdin_json")
  event=$(add_event_specific_data "$event" "$event_type" "$agent_name" "$stdin_json")

  transport_emit "$event"
  
  [[ "$event_type" == "stop" ]] && transport_maybe_rotate
}

# Capture stdin before backgrounding (background subshell gets /dev/null)
_stdin=$(cat)
if [[ "${FLOW_AGENTS_TELEMETRY_FOREGROUND:-false}" == "true" ]]; then
  main "$@" "$_stdin"
else
  (main "$@" "$_stdin") </dev/null &>/dev/null &
  disown 2>/dev/null
fi

if [[ "${FLOW_AGENTS_TELEMETRY_RUNTIME:-kiro-cli}" == "codex" ]]; then
  _hook_event_name=$(printf '%s' "$_stdin" | jq -r '.hook_event_name // ""' 2>/dev/null)
  case "$_hook_event_name" in
    SessionStart)
      printf '{"continue":true,"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Flow Agents telemetry hooks are active for this session."}}\n'
      ;;
    UserPromptSubmit)
      printf '{"continue":true,"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"Flow Agents telemetry captured this prompt."}}\n'
      ;;
    Stop)
      printf '{"continue":true}\n'
      ;;
  esac
fi

exit 0
