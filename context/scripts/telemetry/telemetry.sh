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

# classify_action_class — normalized cross-runtime activity taxonomy (#582).
# Given a RAW tool_name and its compact tool_input JSON, echoes ONE of the
# action classes {edit, search, test, git, build, web, read}, or empty when the
# tool is not classifiable (delegation / unknown / ambiguous shell -> no class;
# the field is then ABSENT, never fabricated). Additive & orthogonal to
# normalize_tool_name (canonical tool identity): this describes WHAT KIND of
# activity the tool performs. Privacy: for shell tools the command is read
# transiently ONLY to extract the leading (and 2nd/3rd) verb token; the raw
# command/args are never stored to derive the class. Any jq hiccup degrades to
# empty and never blocks the event.
classify_action_class() {
  local tool_name="$1" tool_input="$2"
  [[ -z "$tool_input" ]] && tool_input="null"
  case "$tool_name" in
    Edit|Write|MultiEdit|NotebookEdit|apply_patch|fs_write|write|code)
      echo "edit" ;;
    Grep|Glob|find|search)
      echo "search" ;;
    Read|fs_read|NotebookRead)
      echo "read" ;;
    WebFetch|WebSearch|web_search|web_fetch)
      echo "web" ;;
    Bash|bash|shell|execute_bash)
      # Bash-family verb sub-classification. Reuses #581's leading-token
      # extraction (resolve_delegation_targets): peel one bash/sh/zsh -c
      # wrapper, strip leading VAR=val env-assignments, then match the WHOLE
      # leading token (word-boundary: gitfoo / /path/git-helper / echo git MUST
      # NOT match git). test-vs-build for pkg-runners (npm/pnpm/yarn/bun) is
      # disambiguated by the 2nd (and 3rd for `run <script>`) token; a bare
      # runner / unknown script -> empty (NO guess). The command is read
      # transiently and never stored (privacy).
      echo "$tool_input" | jq -r '
        ((.command // "") | if type=="string" then . else "" end) as $cmd
        | ($cmd | gsub("^\\s+|\\s+$";"")) as $s
        | if $s=="" then ""
          else
            ( if ($s|test("^(?:bash|sh|zsh)\\s+-\\S*c\\s+\\x27[\\s\\S]*\\x27\\s*$"))
              then ($s|capture("^(?:bash|sh|zsh)\\s+-\\S*c\\s+\\x27(?<i>[\\s\\S]*)\\x27\\s*$")|.i)
              elif ($s|test("^(?:bash|sh|zsh)\\s+-\\S*c\\s+\\x22[\\s\\S]*\\x22\\s*$"))
              then ($s|capture("^(?:bash|sh|zsh)\\s+-\\S*c\\s+\\x22(?<i>[\\s\\S]*)\\x22\\s*$")|.i)
              else $s end
            ) as $inner0
            | ($inner0 | gsub("^\\s+|\\s+$";"")) as $inner
            | ( {r:$inner}
                | until( (.r|test("^[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+\\S")|not);
                         .r |= (capture("^[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+(?<rest>\\S[\\s\\S]*)$")|.rest) )
                | .r ) as $rest
            | ($rest | gsub("^\\s+|\\s+$";"")) as $rt
            | (if $rt=="" then [] else [$rt | splits("\\s+")] end) as $toks
            | ($toks[0] // "") as $t0
            | ($toks[1] // "") as $t1
            | ($toks[2] // "") as $t2
            | if $t0=="git" then "git"
              elif ($t0=="npm" or $t0=="pnpm" or $t0=="yarn" or $t0=="bun") then
                ( if $t1=="test" then "test"
                  elif ($t1=="run" and ($t2|test("^test([:_-]|$)"))) then "test"
                  elif ($t1=="run" and ($t2|test("^build([:_-]|$)"))) then "build"
                  else "" end )
              elif ($t0=="pytest" or $t0=="jest" or $t0=="vitest" or $t0=="mocha" or $t0=="tox") then "test"
              elif $t0=="go" then (if $t1=="test" then "test" elif $t1=="build" then "build" else "" end)
              elif $t0=="cargo" then (if $t1=="test" then "test" elif $t1=="build" then "build" else "" end)
              elif $t0=="make" then
                ( if $t1=="" then "build"
                  elif ($t1|test("^test([:_-]|$)")) then "test"
                  elif ($t1|test("^build([:_-]|$)")) then "build"
                  else "" end )
              elif ($t0=="tsc" or $t0=="webpack") then "build"
              elif ($t0=="vite" and $t1=="build") then "build"
              else "" end
          end
      ' 2>/dev/null || echo ""
      ;;
    *)
      echo "" ;;
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
  local tool_name tool_normalized_name tool_input tool_output permission_description tool_action
  tool_name=$(echo "$stdin_json" | jq -r '.tool_name // ""')
  tool_normalized_name=$(normalize_tool_name "$tool_name")
  tool_input=$(echo "$stdin_json" | jq -c '.tool_input // null')
  tool_output=$(echo "$stdin_json" | jq -c '.tool_response // null')
  permission_description=$(echo "$stdin_json" | jq -r '.tool_input.description // ""')
  # #582: normalized action class {edit,search,test,git,build,web,read}, or
  # empty when unclassifiable. Stamped additively inside .tool below (guarded so
  # a classifier hiccup degrades to NO .tool.action, never a dropped event).
  tool_action=$(classify_action_class "$tool_name" "$tool_input")

  if [[ "$event_type" == "preToolUse" ]]; then
    event=$(echo "$event" | jq -c \
      --arg tn "$tool_name" \
      --arg nn "$tool_normalized_name" \
      --arg ac "$tool_action" \
      --argjson ti "$tool_input" \
      '. + {tool: ({name: $tn, normalized_name: $nn, input: $ti} + (if $ac == "" then {} else {action: $ac} end))}')
  elif [[ "$event_type" == "permissionRequest" || "$event_type" == "PermissionRequest" ]]; then
    event=$(echo "$event" | jq -c \
      --arg tn "$tool_name" \
      --arg nn "$tool_normalized_name" \
      --arg ac "$tool_action" \
      --argjson ti "$tool_input" \
      --arg desc "$permission_description" \
      '. + {tool: ({name: $tn, normalized_name: $nn, input: $ti} + (if $ac == "" then {} else {action: $ac} end)), permission: {description: $desc}}')
  else
    event=$(echo "$event" | jq -c \
      --arg tn "$tool_name" \
      --arg nn "$tool_normalized_name" \
      --arg ac "$tool_action" \
      --argjson to "$tool_output" \
      '. + {tool: ({name: $tn, normalized_name: $nn, output: $to} + (if $ac == "" then {} else {action: $ac} end))}')
  fi

  echo "$event"
}

# resolve_delegation_targets — single source of truth for the delegation
# vocabulary (#581 D1). Given a RAW tool_name and its compact tool_input JSON,
# echoes a JSON array of delegation target identities, or [] when the tool does
# not delegate. Both the standalone agent.delegate event (emit_delegation_event)
# and the additive on-record .delegation enrichment (add_tool_data_and_emit_
# delegation) call this, so the two can never drift. Privacy: only target
# identities (agent type / "codex") are produced — never command args or prompt
# content. Any jq hiccup degrades to [] and never blocks the event.
resolve_delegation_targets() {
  local tool_name="$1" tool_input="$2"
  [[ -z "$tool_input" ]] && tool_input="null"
  case "$tool_name" in
    InvokeSubagents)
      echo "$tool_input" | jq -c '.targets // []' 2>/dev/null || echo '[]'
      ;;
    spawn_agent)
      echo "$tool_input" | jq -c '
        ((.agent_type // "default") | tostring) as $t
        | if ($t != "" and $t != "null") then [$t] else [] end
      ' 2>/dev/null || echo '[]'
      ;;
    use_subagent|subagent|"delegate to a specialist agent")
      echo "$tool_input" | jq -c '
        if (.targets? | type) == "array" then .targets
        elif (.subagents? | type) == "array" then .subagents | map(.agent_name // .agent // .subagent_type // .name // "subagent")
        elif (.content.subagents? | type) == "array" then .content.subagents | map(.agent_name // .agent // .subagent_type // .name // "subagent")
        elif (.agent_name? // .agent? // .subagent_type? // empty) != "" then [(.agent_name // .agent // .subagent_type)]
        else ["subagent"]
        end
      ' 2>/dev/null || echo '[]'
      ;;
    Task|Agent)
      echo "$tool_input" | jq -c '
        ((.subagent_type // .agent_type // .agent // "general-purpose") | tostring) as $t
        | if ($t != "" and $t != "null") then [$t] else [] end
      ' 2>/dev/null || echo '[]'
      ;;
    Bash|bash|shell|execute_bash)
      # Direct-CLI Codex (#581 D3): target is "codex" iff the command's FIRST
      # real shell token is exactly `codex`. Mirrors _is_ambiguous_absence's
      # unwrap/strip discipline — peel one `bash -lc '...'` / `sh -c "..."`
      # wrapper, strip leading VAR=val env-assignments, then match the WHOLE
      # first token (word-boundary: codexfoo, mycodex, /x/codex-helper MUST NOT
      # match). The command is read transiently and never stored (privacy).
      echo "$tool_input" | jq -c '
        ((.command // "") | if type=="string" then . else "" end) as $cmd
        | ($cmd | gsub("^\\s+|\\s+$";"")) as $s
        | if $s=="" then []
          else
            ( if ($s|test("^(?:bash|sh|zsh)\\s+-\\S*c\\s+\\x27[\\s\\S]*\\x27\\s*$"))
              then ($s|capture("^(?:bash|sh|zsh)\\s+-\\S*c\\s+\\x27(?<i>[\\s\\S]*)\\x27\\s*$")|.i)
              elif ($s|test("^(?:bash|sh|zsh)\\s+-\\S*c\\s+\\x22[\\s\\S]*\\x22\\s*$"))
              then ($s|capture("^(?:bash|sh|zsh)\\s+-\\S*c\\s+\\x22(?<i>[\\s\\S]*)\\x22\\s*$")|.i)
              else $s end
            ) as $inner0
            | ($inner0 | gsub("^\\s+|\\s+$";"")) as $inner
            | ( {r:$inner}
                | until( (.r|test("^[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+\\S")|not);
                         .r |= (capture("^[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+(?<rest>\\S[\\s\\S]*)$")|.rest) )
                | .r ) as $rest
            | (($rest|gsub("^\\s+|\\s+$";"")) as $rt | (first($rt|splits("\\s+")) // "")) as $first
            | if $first=="codex" then ["codex"] else [] end
          end
      ' 2>/dev/null || echo '[]'
      ;;
    *)
      echo '[]'
      ;;
  esac
}

emit_delegation_event() {
  local event="$1" event_type="$2" stdin_json="$3"
  # The standalone agent.delegate event stays preToolUse-only (#581 D4) with
  # targets IDENTICAL to pre-#581 for every existing vocabulary case.
  case "$event_type" in
    preToolUse|PreToolUse) ;;
    *) return 0 ;;
  esac
  local tool_name
  tool_name=$(echo "$stdin_json" | jq -r '.tool_name // ""')
  # Direct-CLI Codex is a Bash-family tool that never produced an agent.delegate
  # event before #581; it is surfaced SOLELY via the additive on-record
  # .delegation, so the agent.delegate stream (and delegation COUNTS) stay
  # byte-identical to before. Only the subagent-tool vocabulary emits here.
  case "$tool_name" in
    Bash|bash|shell|execute_bash) return 0 ;;
  esac
  local tool_input targets
  tool_input=$(echo "$stdin_json" | jq -c '.tool_input // null')
  targets=$(resolve_delegation_targets "$tool_name" "$tool_input")
  if [[ -n "$targets" && "$targets" != "[]" ]]; then
    local delegate_event
    delegate_event=$(echo "$event" | jq -c \
      --argjson targets "$targets" \
      '.event_type = "agent.delegate" | . + {delegation: {targets: $targets}} | del(.tool)')
    transport_emit "$delegate_event"
  fi
}

add_tool_data_and_emit_delegation() {
  local event="$1" event_type="$2" stdin_json="$3"
  event=$(add_tool_event_data "$event" "$event_type" "$stdin_json")

  # Emit the standalone agent.delegate event FIRST, from the UN-stamped tool
  # event, so its shape stays byte-identical to pre-#581 (the on-record
  # .delegation below is strictly additive — #581 D4).
  emit_delegation_event "$event" "$event_type" "$stdin_json"

  # #581 W2: stamp .delegation = {targets, target} on the tool event whenever the
  # invoked tool delegates (subagent tools OR direct-CLI codex).
  # resolve_delegation_targets is the shared vocabulary source (D1). Guarded
  # --argjson so a resolution hiccup degrades to no .delegation and never
  # blackholes the event (D5). Privacy: target identities only.
  local tool_name tool_input dtargets
  tool_name=$(echo "$stdin_json" | jq -r '.tool_name // ""')
  tool_input=$(echo "$stdin_json" | jq -c '.tool_input // null')
  dtargets=$(resolve_delegation_targets "$tool_name" "$tool_input")
  if [[ -n "$dtargets" && "$dtargets" != "[]" ]]; then
    local stamped
    stamped=$(echo "$event" | jq -c --argjson t "$dtargets" \
      '. + {delegation: {targets: $t, target: ($t[0])}}' 2>/dev/null) || stamped=""
    [[ -n "$stamped" ]] && event="$stamped"
  fi

  echo "$event"
}

# --- #580 tool.result enrichment: duration_ms / outcome / status -------------
# These three fields are added to the existing .tool object of tool.result
# records only (co-located with .tool.name/.tool.output). tool.invoke has no
# result yet and tool.permission_request is not a tool result, so neither is
# touched. Every unavailable signal degrades to null/ambiguous — never a
# fabricated value.

# Shared jq definitions for the deterministic outcome tri-state. This is a
# faithful port of scripts/hooks/evidence-capture.js `observeResult` (the
# canonical contract, docs/spec/runtime-hook-surface.md §2.5) into jq so the
# Claude hot path stays hermetic (no node subprocess). A drift-guard test
# (evals/integration/test_telemetry_tool_outcome.sh) feeds a shared fixture
# battery through BOTH this jq path and node observeResult and asserts they
# agree, so the port can never silently diverge from the canonical source.
# Regex note: \x27 / \x22 are the single/double quote chars (avoids embedding a
# literal quote inside this single-quoted bash string).
_TOOL_OUTCOME_JQ_DEFS='
def _clean(v):
  (v) as $x
  | if ($x|type)=="number" then (if $x==($x|floor) then $x else null end)
    elif ($x|type)=="string"
      then (($x|gsub("^\\s+|\\s+$";"")) as $t | if ($t|test("^-?[0-9]+$")) then ($t|tonumber) else null end)
    else null end;
def _is_ambiguous_absence($text):
  (($text | if type=="string" then . else "" end) | gsub("^\\s+|\\s+$";"")) as $s
  | if $s=="" then false
    else
      ( if ($s|test("^(?:bash|sh|zsh)\\s+-\\S*c\\s+\\x27[\\s\\S]*\\x27\\s*$"))
        then ($s|capture("^(?:bash|sh|zsh)\\s+-\\S*c\\s+\\x27(?<i>[\\s\\S]*)\\x27\\s*$")|.i)
        elif ($s|test("^(?:bash|sh|zsh)\\s+-\\S*c\\s+\\x22[\\s\\S]*\\x22\\s*$"))
        then ($s|capture("^(?:bash|sh|zsh)\\s+-\\S*c\\s+\\x22(?<i>[\\s\\S]*)\\x22\\s*$")|.i)
        else $s end
      ) as $inner0
      | ($inner0 | gsub("^\\s+|\\s+$";"")) as $inner
      | if $inner=="" then false
        elif ($inner|test("^!\\s*")) then false
        elif (($inner|test("\\|\\|")) or ($inner|test("&&"))) then false
        else
          ( {r:$inner}
            | until( (.r|test("^[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+\\S")|not);
                     .r |= (capture("^[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+(?<rest>\\S[\\s\\S]*)$")|.rest) )
            | .r ) as $rest
          | if ($rest|test("\\|")) then false
            else ( ($rest|gsub("^\\s+|\\s+$";"")) as $rt
                   | ([$rt|splits("\\s+")][0] // "") as $first
                   | ($first=="grep" or $first=="diff") )
            end
        end
    end;
def _is_failure:
  (.error) as $err
  | ( ($err|type=="string") and (($err|gsub("^\\s+|\\s+$";""))|length>0) ) as $e1
  | ( ($err|type=="object" or type=="array") and (($err|length)>0) ) as $e2
  | ( [ (.tool_response // null), (.tool_output // null) ]
      | map(select(type=="object"))
      | any(
          (.success==false)
          or (.failed==true) or (.is_error==true) or (.isError==true)
          or ((.error|type=="string") and ((.error|gsub("^\\s+|\\s+$";""))|length>0))
          or ( ($err==null)
               and (.stderr|type=="string")
               and ((.stderr|gsub("^\\s+|\\s+$";""))|length>0)
               and ( ((if (.stdout|type)=="string" then .stdout else "" end)|gsub("^\\s+|\\s+$";"")|length)==0 ) )
        ) ) as $e3
  | ($e1 or $e2 or $e3);
'

# Main program: derives {exitCode, observedResult} from the hook payload,
# folding a PostToolUseFailure event to fail. Consumes $et (event_type).
_TOOL_OUTCOME_JQ_MAIN='
( [ (.tool_response // null), (.tool_output // null) ]
  | map(select(type=="object"))
  | [ .[] | (.exitCode, .exit_code, .exitcode, .status, .code, .returnCode, .return_code) ] ) as $srcCands
| ( $srcCands + [ .exitCode, .exit_code, .status, .code ] ) as $cands
| ( first( $cands[] | _clean(.) | select(.!=null) ) // null ) as $exit
| ((.tool_input.command // "") | if type=="string" then . else "" end) as $cmd
| ( if $exit != null
    then ( if ($exit==1 and $cmd!="" and _is_ambiguous_absence($cmd))
           then {exitCode:$exit, observedResult:"ambiguous"}
           else {exitCode:$exit, observedResult:(if $exit==0 then "pass" else "fail" end)} end )
    else ( if _is_failure then {exitCode:null, observedResult:"fail"} else {exitCode:null, observedResult:"ambiguous"} end )
    end ) as $base
| ( if ($et=="PostToolUseFailure") then ($base + {observedResult:"fail"}) else $base end )
'

# Codex re-derivation: given a host-banner $code and $cmd, produce the
# observedResult string via the SAME tri-state (incl. the #362 grep/diff
# carve-out) so the codex path can never diverge from the jq/node contract.
_TOOL_OUTCOME_JQ_CODEX='
( if ($code==0) then "pass"
  elif ($code==1 and ($cmd|length)>0 and _is_ambiguous_absence($cmd)) then "ambiguous"
  else "fail" end )
'

# now_epoch_ms — portable millisecond wall clock. Prefer bash5 $EPOCHREALTIME
# (µs precision) -> ms; else GNU `date +%s%3N` when it returns pure digits
# (BSD/macOS date echoes a literal "%3N", which is rejected); else the
# second-granular `date +%s`*1000 fallback (resolution-honest).
now_epoch_ms() {
  local er="${EPOCHREALTIME:-}"
  if [[ "$er" =~ ^([0-9]+)[.,]([0-9]{3}) ]]; then
    printf '%s%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
    return
  fi
  local gnu
  gnu=$(date +%s%3N 2>/dev/null)
  if [[ "$gnu" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$gnu"
    return
  fi
  printf '%s000\n' "$(date +%s)"
}

# tool_call_correlation_key — a best-effort key that is stable across a tool's
# invoke and its result. Prefers a host-provided call id; else a content hash
# of tool_name + compact(tool_input) via whichever portable hasher is present.
# Output is filesystem-safe (any char outside [A-Za-z0-9._-] -> '_'). The
# content-hash fallback can theoretically collide for two identical tool+input
# runs with overlapping lifetimes (the disclosed start_record_liveness gap) —
# correlation is best-effort and yields null rather than a wrong number.
tool_call_correlation_key() {
  local stdin_json="$1"
  local call_id key
  call_id=$(printf '%s' "$stdin_json" | jq -r '.tool_use_id // .tool_call_id // .call_id // .id // ""' 2>/dev/null)
  if [[ -n "$call_id" && "$call_id" != "null" ]]; then
    key="id:${call_id}"
  else
    local tool_name tool_input hash
    tool_name=$(printf '%s' "$stdin_json" | jq -r '.tool_name // ""' 2>/dev/null)
    tool_input=$(printf '%s' "$stdin_json" | jq -c '.tool_input // null' 2>/dev/null)
    hash=$(printf '%s%s' "$tool_name" "$tool_input" | { shasum 2>/dev/null || sha256sum 2>/dev/null || cksum; } | awk '{print $1}')
    key="sha:${hash}"
  fi
  printf '%s' "$key" | tr -c 'A-Za-z0-9._-' '_'
}

tool_start_record_path() {
  printf '%s\n' "${TELEMETRY_SESSION_DIR}/toolstart-${session_id}-$1"
}

# write_tool_start_record — records the tool's start ms on preToolUse so the
# matching result can compute duration_ms. Best-effort/non-blocking: any
# failure is swallowed and simply yields duration_ms:null downstream. The
# stored value is a timestamp only — never any args/output content (privacy).
write_tool_start_record() {
  local stdin_json="$1"
  [[ -z "${TELEMETRY_SESSION_DIR:-}" ]] && return 0
  local key path
  key=$(tool_call_correlation_key "$stdin_json") || return 0
  [[ -z "$key" ]] && return 0
  path=$(tool_start_record_path "$key")
  mkdir -p "${TELEMETRY_SESSION_DIR}" 2>/dev/null || true
  now_epoch_ms >"$path" 2>/dev/null || true
  return 0
}

# add_tool_result_meta — enriches a tool.result event with the three #580
# fields on its existing .tool object: duration_ms (wall-clock ms since the
# matching invoke, or null when the start record is absent), outcome
# (deterministic pass|fail|ambiguous), exit_code (host exit code int or null),
# and typed status (completed|failed|canceled|blocked|unknown).
# Never fails the hook.
add_tool_result_meta() {
  local event="$1" event_type="$2" stdin_json="$3"

  # --- duration_ms: read + unlink the matching start record ---
  local duration_ms="null"
  if [[ -n "${TELEMETRY_SESSION_DIR:-}" ]]; then
    local key path start_ms end_ms
    key=$(tool_call_correlation_key "$stdin_json")
    if [[ -n "$key" ]]; then
      path=$(tool_start_record_path "$key")
      if [[ -f "$path" ]]; then
        start_ms=$(cat "$path" 2>/dev/null)
        rm -f "$path" 2>/dev/null || true
        if [[ "$start_ms" =~ ^[0-9]+$ ]]; then
          end_ms=$(now_epoch_ms)
          if [[ "$end_ms" =~ ^[0-9]+$ ]]; then
            duration_ms=$(( end_ms - start_ms ))
            (( duration_ms < 0 )) && duration_ms=0
          fi
        fi
      fi
    fi
  fi

  # --- outcome/status: hermetic jq tri-state (canonical observeResult port) ---
  local verdict outcome exit_code status
  verdict=$(printf '%s' "$stdin_json" | jq -c --arg et "$event_type" \
    "${_TOOL_OUTCOME_JQ_DEFS}${_TOOL_OUTCOME_JQ_MAIN}" 2>/dev/null)
  [[ -z "$verdict" ]] && verdict='{"exitCode":null,"observedResult":"ambiguous"}'
  exit_code=$(printf '%s' "$verdict" | jq -c '.exitCode' 2>/dev/null)
  outcome=$(printf '%s' "$verdict" | jq -r '.observedResult' 2>/dev/null)
  [[ -z "$exit_code" ]] && exit_code="null"
  [[ -z "$outcome" ]] && outcome="ambiguous"

  # --- Codex-only exit-code resolution when the payload carried no clean code.
  # Codex surfaces its exit code in the rollout banner, not the hook payload, so
  # the jq scan alone yields ambiguous/null. Gated strictly to the codex runtime
  # so the Claude path stays 100% hermetic (jq only, no node). An unreadable
  # rollout leaves the honest ambiguous/null verdict untouched.
  if [[ "${FLOW_AGENTS_TELEMETRY_RUNTIME:-}" == "codex" && "$exit_code" == "null" ]]; then
    local codex_lib
    codex_lib="${TELEMETRY_DIR}/../hooks/lib/codex-exit-code.js"
    if [[ -f "$codex_lib" ]]; then
      local tpath call_id cmd code
      tpath=$(printf '%s' "$stdin_json" | jq -r '.transcript_path // ""' 2>/dev/null)
      call_id=$(printf '%s' "$stdin_json" | jq -r '.call_id // .tool_call_id // .id // ""' 2>/dev/null)
      cmd=$(printf '%s' "$stdin_json" | jq -r '.tool_input.command // ""' 2>/dev/null)
      if [[ -n "$tpath" ]]; then
        code=$(FLOW_CODEX_LIB="$codex_lib" FLOW_TPATH="$tpath" FLOW_CALLID="$call_id" FLOW_CMD="$cmd" node -e '
          try {
            const m = require(process.env.FLOW_CODEX_LIB);
            const c = m.readExitCodeFromRollout(process.env.FLOW_TPATH, {
              callId: process.env.FLOW_CALLID || undefined,
              command: process.env.FLOW_CMD || undefined,
            });
            if (Number.isInteger(c)) process.stdout.write(String(c));
          } catch (e) {}
        ' 2>/dev/null)
        if [[ "$code" =~ ^-?[0-9]+$ ]]; then
          exit_code="$code"
          outcome=$(jq -nr --argjson code "$code" --arg cmd "$cmd" \
            "${_TOOL_OUTCOME_JQ_DEFS}${_TOOL_OUTCOME_JQ_CODEX}" 2>/dev/null)
          [[ -z "$outcome" ]] && outcome="fail"
        fi
      fi
    fi
  fi

  status=$(printf '%s' "$stdin_json" | jq -r --arg outcome "$outcome" '
    if (.canceled == true or .cancelled == true
        or .tool_response.canceled == true or .tool_response.cancelled == true
        or .tool_response.status == "canceled" or .tool_response.status == "cancelled")
    then "canceled"
    elif (.blocked == true or .denied == true
          or .tool_response.blocked == true or .tool_response.denied == true
          or .tool_response.status == "blocked" or .tool_response.status == "denied")
    then "blocked"
    elif $outcome == "pass" then "completed"
    elif $outcome == "fail" then "failed"
    else "unknown"
    end' 2>/dev/null)
  [[ -z "$status" ]] && status="unknown"

  echo "$event" | jq -c \
    --argjson dm "$duration_ms" \
    --argjson ec "$exit_code" \
    --arg st "$status" \
    --arg oc "$outcome" \
    '.tool = ((.tool // {}) + {duration_ms: $dm, outcome: $oc, exit_code: $ec, status: $st})'
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
        semantics: "delta",
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
        semantics: "delta",
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
        semantics: "delta",
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
          semantics: "snapshot",
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

    # Hook-native console board sync (#919): detached, cwd-scoped projection+bridge of this
    # repo's local flow-agents workflow state onto a hosted Kontour console board, wired
    # directly after the economics-record step above in the EXACT same best-effort DETACHED
    # shape so it can never alter telemetry timing or fail the stop hook -- board
    # transparency rides the existing session harness, never a launchd/cron daemon. The
    # script re-resolves config.sh itself and gate-checks console_telemetry_url + a token;
    # it exits 0 silently with zero side effects when no hosted console sink is configured.
    #
    # Review HIGH-1 fix: a globally-installed hook's TELEMETRY_DIR (and therefore config.sh's
    # own TELEMETRY_WORKSPACE_ROOT) points at the INSTALL location, not the project the
    # session actually stopped in -- console-board-sync.sh must never resolve its target repo
    # from that. Resolve the session's real cwd HERE, the exact same authoritative-source +
    # fallback the economics-record step above already uses (the usage event's own
    # .context.cwd, falling back to $PWD), and hand it to the script explicitly via
    # FLOW_AGENTS_BOARD_SYNC_CWD so it never has to guess at an install root.
    local board_sync_script="${TELEMETRY_DIR}/console-board-sync.sh"
    if [[ -f "$board_sync_script" ]]; then
      local board_sync_cwd
      board_sync_cwd=$(echo "$usage_event" | jq -r '.context.cwd // ""' 2>/dev/null)
      [[ -z "$board_sync_cwd" || ! -d "$board_sync_cwd" ]] && board_sync_cwd="$PWD"
      (FLOW_AGENTS_BOARD_SYNC_CWD="$board_sync_cwd" bash "$board_sync_script") </dev/null >/dev/null 2>&1 &
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
      case "$event_type" in
        preToolUse|PreToolUse)
          # #580: record the tool's start ms so its result can compute duration.
          write_tool_start_record "$stdin_json"
          ;;
        postToolUse|PostToolUse|PostToolUseFailure)
          # #580: add .tool.duration_ms / .tool.outcome / .tool.status.
          event=$(add_tool_result_meta "$event" "$event_type" "$stdin_json")
          ;;
      esac
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
