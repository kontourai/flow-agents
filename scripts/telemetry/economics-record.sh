#!/usr/bin/env bash
# economics-record.sh — per-run kit-economics record emitter (#349, console ADR 0003 calls 1/2/3/6).
#
# Assembles ONE immutable `kontour.console.economics` v0.2 record per run — cost, time, iterations,
# and defects caught — the measurement substrate for the value proof (I32–I35). Modeled byte-for-byte
# on scripts/liveness/relay.sh (#295): source ${TELEMETRY_DIR}/lib/transport.sh, build the record with
# a single `jq -c` filter (valid JSON + \u-escaping of every untrusted field), then hand off to the
# SHARED `console_post_json` core. Do NOT hand-roll a curl; do NOT fork the transport.
#
# LOCAL-FIRST (ADR 0003 call 6): the record is ALWAYS written to the local economics log FIRST. The
# console POST is a detached, opt-in, best-effort fire that can NEVER block or fail a run — every
# failure path is a quiet `exit 0`. flow-agents emits a per-run FACT, never a rollup (call 3);
# aggregation/value is a console projection. Tenancy is stamped console-side from the principal (call
# 2); tenant_id here is self-description only.
#
# Ground-truth tokens/cost and canonical run correlation come from the `session.usage` event.
# Defects join from the review sidecar critique.json; verdict/phase come from state.json only after
# telemetry.sh has authenticated that sidecar against the same correlation envelope.
#
# Invoked (detached, best-effort) from scripts/telemetry/telemetry.sh after the session.usage event is
# emitted at run end. Usage:
#   economics-record.sh '<session.usage-event-json>' [--state PATH] [--acceptance PATH]
#                        [--critique PATH] [--agents-dir DIR]
#   (the session.usage event may also arrive on stdin instead of $1)
#
# --agents-dir DIR (#415 slice 1): the run's `<slug>/agents` directory. When present, the emitter
# assembles a `delegations[]` FACT — one entry per delegated sub-agent {agent_id, role, resolved_model,
# summary, escalated_from?} joined from each `<DIR>/<agent-id>/events.jsonl` (latest delegation/
# escalation event wins). This is a per-run FACT only (ADR 0003 call 3): cost-per-(role,model) rollups
# and per-delegation outcome are console projections / a later slice, NOT fabricated here — telemetry
# does not isolate per-sub-agent token usage today, so no per-delegation cost is invented.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 0

# transport.sh sources ${TELEMETRY_DIR}/lib/redact.sh at load — point it at the telemetry lib dir,
# then reuse the SAME console POST core the telemetry mirror + liveness relay use (#356: one core,
# never forked). config.sh gives us TELEMETRY_DATA_DIR for the local log location.
export TELEMETRY_DIR="${TELEMETRY_DIR:-$SCRIPT_DIR}"
[[ -f "$TELEMETRY_DIR/lib/transport.sh" ]] || exit 0
# shellcheck source=/dev/null
source "$TELEMETRY_DIR/lib/config.sh" 2>/dev/null || true
# shellcheck source=/dev/null
source "$TELEMETRY_DIR/lib/transport.sh" 2>/dev/null || exit 0
# #970: the SAME producer-identity resolver telemetry.sh stamps onto every event, sourced here so the
# durable economics record carries the identical {package_version, content_fingerprint, source} tuple
# and the two halves join on one vocabulary. Best-effort: a missing lib degrades to the labeled unknown
# tuple below, never blocks the record.
# shellcheck source=/dev/null
source "$TELEMETRY_DIR/lib/install-identity.sh" 2>/dev/null || true

# jq is mandatory — it is what guarantees valid JSON + \u-escaping of untrusted fields. No jq ⇒ no-op.
command -v jq >/dev/null 2>&1 || exit 0

# --- parse args: the session.usage event (positional or stdin) + optional sidecar paths -------------
usage_event=""
state_path=""
acceptance_path=""
critique_path=""
agents_dir=""
flow_run_dir=""
flow_run_now=""
flow_run_task_slug=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --state) state_path="${2:-}"; shift 2 ;;
    --acceptance) acceptance_path="${2:-}"; shift 2 ;;
    --critique) critique_path="${2:-}"; shift 2 ;;
    --agents-dir) agents_dir="${2:-}"; shift 2 ;;
    --flow-run-dir) flow_run_dir="${2:-}"; shift 2 ;;
    --now) flow_run_now="${2:-}"; shift 2 ;;
    --task-slug) flow_run_task_slug="${2:-}"; shift 2 ;;
    --) shift ;;
    *) [[ -z "$usage_event" ]] && usage_event="$1"; shift ;;
  esac
done

# --- Phase A run-derived mode (#922/#925): --flow-run-dir bypasses the session.usage-event path
# entirely and derives phases[]/iterations/defects/terminal_status straight from the canonical Flow
# run store (schemas/flow-run.schema.json) via flow-run-economics.mjs — see that file for the full
# derivation rationale. This is a SEPARATE, self-contained branch so the legacy session.usage-event
# invocation below is untouched. Token/cost fields stay null/0 here (never fabricated); token
# attribution is the separate, explicit scripts/telemetry/economics-enrich-tokens.mjs tool (not
# wired in automatically — see docs/specs/economics-record-contract.md "flow-run-record mode").
# Local-only: this mode never relays to the console (producer_authority "flow_run_record" is not an
# authenticated runtime binding); it only appends to the local economics log.
if [[ -n "$flow_run_dir" ]]; then
  node_bin="$(command -v node 2>/dev/null || true)"
  helper="$SCRIPT_DIR/flow-run-economics.mjs"
  if [[ -z "$node_bin" || ! -f "$helper" ]]; then
    exit 0
  fi
  now_arg=()
  [[ -n "$flow_run_now" ]] && now_arg=(--now "$flow_run_now")
  # Portability (review finding 1): expand as "${now_arg[@]+"${now_arg[@]}"}" rather than the
  # plain "${now_arg[@]}" -- macOS's stock /bin/bash (3.2, pre-GPLv3) treats a zero-element
  # array as unbound under `set -u` and aborts with "unbound variable" (this script's shebang
  # resolves whichever `bash` PATH finds first, which is not guaranteed to be >= 4.4). Same
  # documented idiom as scripts/telemetry/console-board-sync.sh:60-64.
  derived="$("$node_bin" "$helper" --flow-run-dir "$flow_run_dir" "${now_arg[@]+"${now_arg[@]}"}" 2>/dev/null)" || exit 0
  printf '%s' "$derived" | jq -e '.ok == true' >/dev/null 2>&1 || exit 0

  # --- producer identity (#970), resolved the same way as the legacy path below. -------------------
  install_identity_json=""
  if declare -f install_identity >/dev/null 2>&1; then
    install_identity_json=$(install_identity 2>/dev/null) || install_identity_json=""
  fi
  printf '%s' "$install_identity_json" | jq -e 'type == "object"' >/dev/null 2>&1 \
    || install_identity_json='{"package_version":"unknown","content_fingerprint":"unknown","source":"unknown"}'

  tenant_self="${CONSOLE_TENANT_ID:-${FLOW_AGENTS_CONSOLE_TENANT:-}}"

  record="$(printf '%s' "$derived" | jq -c \
    --argjson install_identity "$install_identity_json" \
    --arg tenant "$tenant_self" \
    --arg task_slug "$flow_run_task_slug" '
    def bounded_number: if (type == "number" and . >= 0) then . else 0 end;
    . as $d
    | ($d.phases // []) as $phases
    | ({critical:0, high:0, medium:0, low:0}) as $sev
    # Review finding 3 fix: a real zero and "we do not know" must never be byte-identical.
    # tokens_unattributed is true iff ANY phase has null token fields -- in that case the
    # top-level cost.* token fields are ALSO null (never a coalesced 0-sum of partial/absent
    # data); only when EVERY phase carries real, attributed tokens does cost.* sum them.
    # estimated_cost_usd is unconditionally null in this mode: pricing is never attempted here
    # regardless of token attribution (see docs/specs/economics-record-contract.md).
    | (([$phases[] | select(.input_tokens == null)] | length) > 0) as $tokens_unattributed
    | {
        schema: "kontour.console.economics",
        version: "0.2",
        run_id: $d.run_id,
        run_correlation: {
          status: "incomplete",
          reason: "flow-run-record mode derives from the Flow run store only; runtime session identity is not bound here (flow-agents#922)"
        },
        observation_semantics: "snapshot",
        producer_authority: "flow_run_record",
        terminal_status: $d.terminal_status,
        at: (if $d.record_at_iso then
              (($d.record_at_iso | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) * 1000 | floor | tostring)
            else null end),
        task_slug: (if $task_slug == "" then null else $task_slug end),
        model: null,
        pricing_version: null,
        cost: {
          input_tokens: (if $tokens_unattributed then null else ([$phases[].input_tokens] | add // 0) end),
          output_tokens: (if $tokens_unattributed then null else ([$phases[].output_tokens] | add // 0) end),
          cache_creation_input_tokens: (if $tokens_unattributed then null else ([$phases[].cache_creation_input_tokens] | add // 0) end),
          cache_read_input_tokens: (if $tokens_unattributed then null else ([$phases[].cache_read_input_tokens] | add // 0) end),
          estimated_cost_usd: null,
          by_model: []
        },
        time: {
          wall_clock_s: ($d.time.wall_clock_s | bounded_number),
          human_wait_s: ($d.time.human_wait_s | bounded_number)
        },
        phases: $phases,
        tokens_unattributed: $tokens_unattributed,
        iterations: {
          count: ($d.iterations.count | bounded_number),
          route_backs: ($d.iterations.route_backs | bounded_number)
        },
        defects: {
          gate_fires: ($d.defects.gate_fires | bounded_number),
          findings_by_severity: $sev,
          caught_false_completions: 0,
          verification_verdict: $d.defects.verification_verdict
        },
        delegations: [],
        signals: {
          runtime: null,
          per_delegation_tokens: false,
          per_delegation_outcome: "n/a"
        },
        tenant_id: (if $tenant == "" then null else $tenant end),
        install_identity: $install_identity
      }' 2>/dev/null)" || exit 0
  [[ -z "$record" || "$record" == "null" ]] && exit 0

  # Structural sanity check before the local-first write (mirrors the legacy path's guard).
  # Review finding 3: cost.* token/cost leaves may be null (tokens_unattributed) -- never
  # required to be a real number here. Review finding 11 (defense-in-depth): also pin
  # terminal_status to the canonical observable Flow-status vocabulary before it reaches the local log.
  if ! printf '%s' "$record" | jq -e '
    def number: type == "number" and . >= 0;
    def number_or_null: (type == "number" and . >= 0) or . == null;
    .schema == "kontour.console.economics"
    and .version == "0.2"
    and (.run_id | type == "string")
    and (.cost.input_tokens | number_or_null)
    and (.cost.estimated_cost_usd | number_or_null)
    and (.time.wall_clock_s | number)
    and (.iterations.count | number)
    and (.defects.gate_fires | number)
    and (.terminal_status as $t | ["completed","canceled","failed","accepted_by_exception","active","blocked","needs_decision","paused"] | index($t) != null)
  ' >/dev/null 2>&1; then
    exit 0
  fi

  if [[ -n "${TELEMETRY_ECONOMICS_LOG_FILE:-}" ]]; then
    economics_log="$TELEMETRY_ECONOMICS_LOG_FILE"
  elif [[ -n "${TELEMETRY_DATA_DIR:-}" ]]; then
    economics_log="${TELEMETRY_DATA_DIR}/economics.jsonl"
  else
    economics_log="${TELEMETRY_DIR}/../../.kontourai/telemetry/economics.jsonl"
  fi
  mkdir -p "$(dirname "$economics_log")" 2>/dev/null || true
  # Terminal Flow snapshots are byte-identical on every later Stop. Scan only the bounded recent
  # tail for this producer/run pair so an old terminal record is not appended forever; beyond 1000
  # lines a duplicate snapshot is benign, while an unbounded scan of a growing local log is not.
  if [[ -f "$economics_log" ]]; then
    flow_run_id="$(printf '%s' "$record" | jq -r '.run_id // empty' 2>/dev/null)"
    # -R + fromjson? so ONE corrupt line does not abort the scan: jq halts a JSON stream at the
    # first parse error, which would hide every matching record after it and re-append a duplicate.
    # Degradation was already benign (duplicate, never a suppressed observation) -- this just makes
    # the common case correct too.
    recent_flow_run_record="$(tail -n 1000 "$economics_log" 2>/dev/null | jq -R -c \
      --arg run_id "$flow_run_id" '
        fromjson? | select(type == "object" and .producer_authority == "flow_run_record" and .run_id == $run_id)
      ' 2>/dev/null | tail -n 1)"
    [[ -n "$recent_flow_run_record" && "$recent_flow_run_record" == "$record" ]] && exit 0
  fi
  printf '%s\n' "$record" >> "$economics_log" 2>/dev/null || true
  exit 0
fi

explicit_sidecars=false
[[ -n "$state_path$acceptance_path$critique_path$agents_dir" ]] && explicit_sidecars=true
if [[ "$explicit_sidecars" == "true" && "${FLOW_AGENTS_ECONOMICS_FIXTURE_MODE:-}" != "true" ]]; then
  echo "economics-record: explicit sidecars require FLOW_AGENTS_ECONOMICS_FIXTURE_MODE=true" >&2
  exit 2
fi
# Fall back to stdin when no positional event was supplied.
if [[ -z "$usage_event" && ! -t 0 ]]; then
  usage_event="$(cat 2>/dev/null || true)"
fi
[[ -z "$usage_event" ]] && exit 0

# Canonical validation is mandatory even for direct invocation. Invalid, missing, or explicit
# incomplete input remains explicit and cannot carry an authenticated task slug or sidecar join.
validated_correlation="$(
  printf '%s' "$usage_event" | node "$SCRIPT_DIR/run-correlation-binding.js" --validate-correlation 2>/dev/null
)" || validated_correlation='{"run_correlation":{"status":"incomplete","reason":"the economics correlation validator is unavailable"}}'
usage_event="$(
  printf '%s' "$usage_event" | jq -c \
    --argjson correlation "$(printf '%s' "$validated_correlation" | jq -c '.run_correlation')" '
      .run_correlation = $correlation
      | if $correlation.status? == "incomplete" then del(.task_slug) else . end
    ' 2>/dev/null
)" || exit 0
run_usage_authenticated=false
if printf '%s' "$usage_event" | jq -e '
  .usage.scope == "run"
  and .usage.semantics == "delta"
  and .usage.baseline_status == "present"
' >/dev/null 2>&1; then
  run_usage_authenticated=true
fi

# --- read sidecars as JSON args (never the token source; join sources only) -------------------------
# Production stop telemetry supplies no paths. In that mode, resolve one descriptor-safe snapshot
# through the authenticated actor binding and compare its exact envelope to the usage event.
# Explicit paths remain available for direct fixture/operator invocation.
read_json_or_null() {
  local p="$1" out
  [[ -n "$p" && -f "$p" ]] || { printf 'null'; return; }
  out="$(jq -c '.' < "$p" 2>/dev/null)" || { printf 'null'; return; }
  [[ -z "$out" ]] && out='null'
  printf '%s' "$out"
}
state_json='null'
critique_json='null'
acceptance_json='null'
agent_events_json='[]'
production_snapshot_authenticated=false
if [[ -z "$state_path$acceptance_path$critique_path$agents_dir" && -f "$SCRIPT_DIR/run-correlation-binding.js" ]]; then
  expected_correlation="$(printf '%s' "$usage_event" | jq -c '.run_correlation // null' 2>/dev/null)" || expected_correlation='null'
  sidecar_snapshot="$(printf '%s' "$usage_event" | node "$SCRIPT_DIR/run-correlation-binding.js" --sidecar-snapshot --terminal-capture 2>/dev/null)" || sidecar_snapshot=''
  if [[ -n "$sidecar_snapshot" ]] && printf '%s' "$sidecar_snapshot" | jq -e \
    --argjson expected "$expected_correlation" '
      .run_correlation == $expected
      and (.task_slug | type == "string")
      and (.sidecars.state | type == "object")
      and .sidecars.state.task_slug == .task_slug
      and .sidecars.state.run_correlation == $expected
      and (.sidecars.agent_events | type == "array")
    ' >/dev/null 2>&1; then
    state_json="$(printf '%s' "$sidecar_snapshot" | jq -c '.sidecars.state')"
    critique_json="$(printf '%s' "$sidecar_snapshot" | jq -c '.sidecars.critique')"
    acceptance_json="$(printf '%s' "$sidecar_snapshot" | jq -c '.sidecars.acceptance')"
    agent_events_json="$(printf '%s' "$sidecar_snapshot" | jq -c '.sidecars.agent_events')"
    production_snapshot_authenticated=true
  else
    usage_event="$(printf '%s' "$usage_event" | jq -c '
      .run_correlation = {
        status: "incomplete",
        reason: "the economics source event was not authenticated against its runtime binding"
      }
      | del(.task_slug)
    ')"
  fi
else
  state_json="$(read_json_or_null "$state_path")"
  critique_json="$(read_json_or_null "$critique_path")"
  # acceptance.json is read for future criteria/goal_fit joins; carried but not yet a required field.
  acceptance_json="$(read_json_or_null "$acceptance_path")"
fi
if [[ "$explicit_sidecars" == "true" ]] && ! jq -e -n \
  --argjson event "$usage_event" \
  --argjson state "$state_json" '
    $event.run_correlation.status? != "incomplete"
    and ($state | type) == "object"
    and $state.task_slug == $event.task_slug
    and $state.run_correlation == $event.run_correlation
  ' >/dev/null 2>&1; then
  state_json='null'
  critique_json='null'
  acceptance_json='null'
  agent_events_json='[]'
  agents_dir=''
fi

# Malformed optional components must not suppress the authenticated usage core.
# Reject the whole component when a field consumed below has an incompatible
# shape; the record then degrades to unattributed/NOT_VERIFIED defaults.
state_json="$(printf '%s' "$state_json" | jq -c '
  def valid_number: type == "number" and . >= 0;
  if type != "object"
    or ((.iterations? != null) and ((.iterations | type) != "object"))
    or ((.workflow_outcome? != null) and ((.workflow_outcome | type) != "object"))
    or ((.phase? != null) and ((.phase | type) != "string"))
    or ((.iteration_count? != null) and (.iteration_count | valid_number | not))
    or ((.route_backs? != null) and (.route_backs | valid_number | not))
    or ((.gate_fires? != null) and (.gate_fires | valid_number | not))
    or ((.human_wait_s? != null) and (.human_wait_s | valid_number | not))
    or ((.iterations.count? != null) and (.iterations.count | valid_number | not))
    or ((.iterations.route_backs? != null) and (.iterations.route_backs | valid_number | not))
  then null else . end
' 2>/dev/null)" || state_json='null'
acceptance_json="$(printf '%s' "$acceptance_json" | jq -c '
  if type == "object" then . else null end
' 2>/dev/null)" || acceptance_json='null'
critique_json="$(printf '%s' "$critique_json" | jq -c '
  def valid_number: type == "number" and . >= 0;
  if type != "object"
    or ((.critiques? != null) and ((.critiques | type) != "array"))
    or ((.gate_fires? != null) and (.gate_fires | valid_number | not))
    or ((.caught_false_completions? != null) and (.caught_false_completions | valid_number | not))
    or any((.critiques // [])[];
      type != "object"
      or ((.findings? != null) and ((.findings | type) != "array"))
      or any((.findings // [])[];
        type != "object"
        or ((.severity? != null) and ((.severity | type) != "string"))
        or ((.category? != null) and ((.category | type) != "string"))
        or ((.type? != null) and ((.type | type) != "string"))
      )
    )
  then null else . end
' 2>/dev/null)" || critique_json='null'

# --- delegations[] FACT (#415): per-sub-agent role/model + honestly-derived outcome ------------------
# Scan each per-agent event log; group ALL events by agent_id. Role/model come from the latest
# delegation/escalation event (an escalation supersedes the initial delegation, carrying escalated_from).
#
# `outcome` is derived ONLY from real recorded signals — NEVER fabricated (see harness-capability-matrix).
# Crucially these are ORCHESTRATOR-OBSERVABLE — the orchestrator knows what it dispatched, how often it
# re-dispatched, and how it corrected — so they hold WITHOUT peeking inside the sub-agent (which most
# harnesses forbid). dispatch_count = how many times this agent_id was (re)dispatched (delegation +
# escalation events); >1 means the orchestrator re-prompted it.
#   diverged   — an explicit supersession marker (kind=="supersession" or status=="diverged") exists.
#   rework     — an escalation happened, OR the orchestrator re-dispatched the agent (dispatch_count>1).
#   failed     — the latest terminal verdict event (kind evidence/verdict) for the agent is a FAIL.
#   accepted   — the latest terminal verdict event is a PASS (and no escalation/redispatch/supersession).
#   unavailable— no terminal verdict was recorded for this agent on this harness. NOT assumed accepted.
# Per-delegation COST is still not attributed here — token usage IS sub-agent-internal and no runtime
# isolates it today (see the `signals` block); cost-per-(role,model) is a console projection.
# Any read/parse failure degrades to an empty array; never fatal (local-first, best-effort).
if [[ -n "$agents_dir" && -d "$agents_dir" ]]; then
  agent_events_json="$(
    { for f in "$agents_dir"/*/events.jsonl; do [[ -f "$f" ]] && cat "$f"; done; } 2>/dev/null \
    | jq -s -c '[.[] | select(type == "object")]' 2>/dev/null
  )"
fi
delegations_json="$(
  printf '%s' "$agent_events_json" | jq -c '
        [ .[] | select(type == "object") | select(.agent_id != null) ]
        | group_by(.agent_id)
        | map(
            . as $all
            | [ $all[] | select((.kind == "delegation" or .kind == "escalation")
                                and (.role != null) and (.model != null)) ] as $routes
            | select(($routes | length) > 0)
            | ($routes | sort_by(.timestamp // "") | last) as $l
            | ($routes | length) as $dispatch_count
            | (any($all[]; .kind == "escalation")) as $escalated
            | (any($all[]; .kind == "supersession" or .status == "diverged")) as $diverged
            | ([ $all[] | select(.kind == "evidence" or .kind == "verdict") ]
                 | sort_by(.timestamp // "") | last) as $verdict
            | (($verdict.status // "") | ascii_downcase) as $vs
            | (if   $diverged  then "diverged"
               elif ($escalated or $dispatch_count > 1) then "rework"
               elif ($verdict != null and $vs == "fail") then "failed"
               elif ($verdict != null and $vs == "pass") then "accepted"
               else "unavailable" end) as $outcome
            | {
                agent_id: $l.agent_id,
                role: $l.role,
                resolved_model: $l.model,
                dispatch_count: $dispatch_count,
                outcome: $outcome
              }
            + (if ($l.escalated_from // null) != null then { escalated_from: $l.escalated_from } else {} end)
          )
      ' 2>/dev/null
)" || delegations_json='[]'
[[ -z "$delegations_json" || "$delegations_json" == "null" ]] && delegations_json='[]'

# --- per_delegation_tokens signal: DERIVED from the capability declaration (#620) ------------------
# Replaces the former hardcoded `false` literal. The value is read from the build-only generated
# JSON (build/generated/capability-declarations.json — src/tools/generate-capability-matrix.ts, keyed
# on canonical runtime id), keyed on the NORMALIZED `.agent.runtime`. The alias fold mirrors
# src/lib/capability-declarations.ts::normalizeRuntimeId (lowercase, trim, collapse whitespace,
# kiro-cli→kiro / raw-model→base) so a Kiro record (whose runtime value is `kiro-cli`) resolves its
# declaration instead of silently missing. Kept hermetic: jq-only, no node subprocess at emit time.
#
# SENTINEL SEMANTICS (never fabricate a `true` one layer down): the boolean is true IFF the declared
# per_delegation_tokens capability STATUS is "supported". An unresolved runtime (blank, or a runtime
# with no declaration) OR a missing/unreadable JSON yields the EXPLICIT sentinel `false` — matching
# the prior default — via a DISTINCT jq branch from a declared-false value. Declared-false (status
# unsupported/partial) and unresolved both map to `false` today, but because they travel separate
# branches, a future `supported` declaration flips the signal ONLY for a genuinely-declared runtime
# while an unknown runtime stays sentinel-false. The final `case` re-clamps any non-boolean jq output
# (parse/read failure) back to the `false` sentinel so a fabricated `true` is impossible.
capability_decl_file="${FLOW_AGENTS_CAPABILITY_DECL_FILE:-$SCRIPT_DIR/../../build/generated/capability-declarations.json}"
capability_decl_json="$(read_json_or_null "$capability_decl_file")"
raw_runtime="$(printf '%s' "$usage_event" | jq -r '.agent.runtime // ""' 2>/dev/null)" || raw_runtime=""
per_delegation_tokens="$(
  printf '%s' "$capability_decl_json" | jq -r \
    --arg raw "$raw_runtime" '
    ( $raw | ascii_downcase | gsub("^\\s+";"") | gsub("\\s+$";"") | gsub("\\s+";"-") ) as $lc
    | ( if   $lc == "kiro-cli"         then "kiro"
        elif $lc == "raw-model"        then "base"
        elif $lc == "raw-model-runner" then "base"
        else $lc end ) as $canon
    | if   . == null            then false   # missing/unreadable JSON  -> sentinel false (unresolved)
      elif ($canon == "")       then false   # blank runtime            -> sentinel false (unresolved)
      elif (has($canon) | not)  then false   # runtime not declared     -> sentinel false (unresolved)
      else ((.[$canon].per_delegation_tokens.status // "") == "supported")  # DECLARED value
      end
  ' 2>/dev/null
)" || per_delegation_tokens="false"
case "$per_delegation_tokens" in
  true | false) ;;
  *) per_delegation_tokens="false" ;;   # re-clamp any jq parse/read failure to the sentinel
esac

tenant_self="${CONSOLE_TENANT_ID:-${FLOW_AGENTS_CONSOLE_TENANT:-}}"
producer_authority="unavailable"
if [[ "$production_snapshot_authenticated" == "true" ]]; then
  producer_authority="authenticated_runtime_binding"
elif [[ "$explicit_sidecars" == "true" ]]; then
  producer_authority="fixture_input"
fi

# --- producer identity (#970): the SAME tuple telemetry.sh stamps onto every event, resolved from the
# shared lib. Rides as a TOP-LEVEL sibling of the record (ConsoleEconomicsRecord has an open index
# signature; the store appends untouched). Fail-safe parity with telemetry.sh's build_base_event:
# --argjson aborts jq on malformed input, which would drop the whole record — any resolution hiccup
# (missing lib, jq error) degrades to the explicit unknown tuple, never a missing block, never a block.
install_identity_json=""
if declare -f install_identity >/dev/null 2>&1; then
  install_identity_json=$(install_identity 2>/dev/null) || install_identity_json=""
fi
printf '%s' "$install_identity_json" | jq -e 'type == "object"' >/dev/null 2>&1 \
  || install_identity_json='{"package_version":"unknown","content_fingerprint":"unknown","source":"unknown"}'

# --- assemble the record with ONE jq -c filter (injection-safe, valid JSON) -------------------------
# Untrusted fields (task_slug, model names, finding text) flow through jq string handling so hostile
# control bytes are \u-escaped rather than emitted raw. NEVER printf/concatenate JSON.
record="$(printf '%s' "$usage_event" | jq -c \
  --argjson install_identity "$install_identity_json" \
  --argjson state "$state_json" \
  --argjson critique "$critique_json" \
  --argjson acceptance "$acceptance_json" \
  --argjson delegations "$delegations_json" \
  --argjson per_delegation_tokens "$per_delegation_tokens" \
  --arg producer_authority "$producer_authority" \
  --arg tenant "$tenant_self" '
  def valid_number: type == "number" and . >= 0;
  def bounded_number: if valid_number then . else 0 end;
  . as $e
  | ($e.usage // {}) as $u
  | ($e.run_correlation // {
      status: "incomplete",
      reason: "the economics source event did not provide run correlation"
    }) as $correlation
  # findings_by_severity: group critique.json .critiques[].findings[] on .severity; missing → low.
  | ([($critique.critiques // [])[].findings[]?
       | (.severity // "low" | ascii_downcase)]
     | reduce .[] as $s (
         {critical:0, high:0, medium:0, low:0};
         if ($s=="critical" or $s=="high" or $s=="medium" or $s=="low")
         then .[$s] += 1 else .low += 1 end)) as $sev
  # distinct caught false-completions: findings flagged as such (category/type/false_completion).
  | ([($critique.critiques // [])[].findings[]?
       | select((.false_completion == true)
                or ((.category // "") | ascii_downcase | test("false[_-]?completion"))
                or ((.type // "")     | ascii_downcase | test("false[_-]?completion")))]
     | length) as $cfc
  # verification verdict: explicit sidecar field wins; else null-derived → NOT_VERIFIED.
  | (($state.workflow_outcome.verification_status // null)) as $vv0
  | (if ($vv0 == "PASS" or $vv0 == "FAIL" or $vv0 == "NOT_VERIFIED") then $vv0 else "NOT_VERIFIED" end) as $vv
  # phase attribution: when state.json carries a phase, one bucket for it; else all → unattributed.
  # The single bucket carries the full cost/time totals so the phase-sum invariant holds by construction.
  | (($state.phase // null) | if . == null or . == "" then "unattributed" else . end) as $phase
  | (($u.input_tokens // 0) | bounded_number) as $it
  | (($u.output_tokens // 0) | bounded_number) as $ot
  | (($u.cache_creation_input_tokens // 0) | bounded_number) as $cc
  | (($u.cache_read_input_tokens // 0) | bounded_number) as $cr
  | (($u.estimated_cost_usd // 0) | bounded_number) as $ec
  | (($u.duration_s // 0) | bounded_number) as $wc
  | {
      schema: "kontour.console.economics",
      version: "0.2",
      run_id: (if $correlation.status? == "incomplete"
        then ($e.session_id // "unknown")
        else $correlation.correlation_id
      end),
      run_correlation: $correlation,
      observation_semantics: "snapshot",
      producer_authority: $producer_authority,
      at: ($e.timestamp // null),
      task_slug: ($e.task_slug // null),
      model: ($u.model // null),
      pricing_version: ($u.pricing_version // null),
      cost: {
        input_tokens: $it,
        output_tokens: $ot,
        cache_creation_input_tokens: $cc,
        cache_read_input_tokens: $cr,
        estimated_cost_usd: $ec,
        by_model: (if ($u.by_model | type) == "array" then $u.by_model else [] end)
      },
      time: {
        wall_clock_s: $wc,
        human_wait_s: ((($state.human_wait_s // $e.usage.human_wait_s) // 0) | bounded_number)
      },
      phases: [ {
        phase: $phase,
        input_tokens: $it,
        output_tokens: $ot,
        cache_creation_input_tokens: $cc,
        cache_read_input_tokens: $cr,
        estimated_cost_usd: $ec,
        wall_clock_s: $wc
      } ],
      iterations: {
        count: ((($state.iterations.count // $state.iteration_count) // 1) | bounded_number),
        route_backs: ((($state.iterations.route_backs // $state.route_backs) // 0) | bounded_number)
      },
      defects: {
        gate_fires: ((($critique.gate_fires // $state.gate_fires) // 0) | bounded_number),
        findings_by_severity: $sev,
        caught_false_completions: ((($critique.caught_false_completions // $cfc) // 0) | bounded_number),
        verification_verdict: $vv
      },
      delegations: ($delegations // []),
      # signals: what telemetry the CURRENT runtime actually exposed, so a consumer can tell a real zero
      # from a harness-blind gap (never fabricate — see docs/specs/harness-capability-matrix.md).
      #   per_delegation_tokens: DERIVED (not hardcoded, #620) from the runtime capability declaration
      #     via build/generated/capability-declarations.json, keyed on the normalized .agent.runtime
      #     (kiro-cli→kiro). true IFF the declared status is "supported"; unresolved runtime / missing
      #     JSON → explicit sentinel false (never a fabricated true). No runtime isolates per-sub-agent
      #     token usage today → cost-per-delegation is unavailable; the console attributes at
      #     (role,model) granularity via cost.by_model instead.
      #   per_delegation_outcome: coverage of the outcome signal on THIS run — "full" (every delegation has
      #     a real outcome), "partial" (some do), "none" (delegations exist but none had a verdict/escalation),
      #     "n/a" (no delegations observed).
      signals: {
        runtime: ($e.agent.runtime // null),
        per_delegation_tokens: $per_delegation_tokens,
        per_delegation_outcome: (
          ($delegations // []) as $d
          | ($d | length) as $n
          | if $n == 0 then "n/a"
            else ([ $d[] | select(.outcome != null and .outcome != "unavailable") ] | length) as $known
              | if $known == 0 then "none" elif $known == $n then "full" else "partial" end
            end)
      },
      tenant_id: (if $tenant == "" then null else $tenant end),
      install_identity: $install_identity
    }' 2>/dev/null)" || exit 0
[[ -z "$record" || "$record" == "null" ]] && exit 0
if ! printf '%s' "$record" | jq -e '
  def number: type == "number" and . >= 0;
  .schema == "kontour.console.economics"
  and .version == "0.2"
  and (.run_id | type == "string")
  and (.cost.input_tokens | number)
  and (.cost.output_tokens | number)
  and (.cost.cache_creation_input_tokens | number)
  and (.cost.cache_read_input_tokens | number)
  and (.cost.estimated_cost_usd | number)
  and (.cost.by_model | type == "array")
  and (.time.wall_clock_s | number)
  and (.time.human_wait_s | number)
  and (.iterations.count | number)
  and (.iterations.route_backs | number)
  and (.defects.gate_fires | number)
  and (.defects.caught_false_completions | number)
  and ([.defects.findings_by_severity[] | number] | all)
  and ([.phases[] | (.input_tokens | number)
    and (.output_tokens | number)
    and (.cache_creation_input_tokens | number)
    and (.cache_read_input_tokens | number)
    and (.estimated_cost_usd | number)
    and (.wall_clock_s | number)] | all)
' >/dev/null 2>&1; then
  exit 0
fi

# --- LOCAL-FIRST: append the record to the local economics log BEFORE any network attempt -----------
# This write must happen and must NOT depend on the POST. TELEMETRY_DATA_DIR comes from config.sh
# and is ALREADY the fully-qualified `.../.kontourai/telemetry` data dir (lib/config.sh:47), so only
# `economics.jsonl` is appended to it here — do NOT re-append `.kontourai/telemetry/...` on top of an
# already-fully-qualified TELEMETRY_DATA_DIR (that doubled the suffix, #469). The TELEMETRY_DIR-
# relative last resort below only applies when TELEMETRY_DATA_DIR truly isn't set (config.sh failed
# to source), in which case it legitimately needs the full `.kontourai/telemetry/economics.jsonl`
# suffix since it resolves from the workspace root, not a data dir.
if [[ -n "${TELEMETRY_ECONOMICS_LOG_FILE:-}" ]]; then
  economics_log="$TELEMETRY_ECONOMICS_LOG_FILE"
elif [[ -n "${TELEMETRY_DATA_DIR:-}" ]]; then
  economics_log="${TELEMETRY_DATA_DIR}/economics.jsonl"
else
  economics_log="${TELEMETRY_DIR}/../../.kontourai/telemetry/economics.jsonl"
fi
mkdir -p "$(dirname "$economics_log")" 2>/dev/null || true
printf '%s\n' "$record" >> "$economics_log" 2>/dev/null || true

# --- BEST-EFFORT console relay: opt-in + only when a console endpoint is configured ------------------
# Off by default (local-first). Endpoint resolution copies relay.sh: explicit override, else base + /records.
case "${FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY:-}" in
  1 | true | TRUE | yes | on) ;;
  *) exit 0 ;;
esac

# Explicit paths are a hermetic fixture/operator surface, not an authenticated
# producer. They may write only to the caller-selected local log and can never
# relay an apparently authoritative record.
[[ "$explicit_sidecars" == "true" ]] && exit 0
[[ "$production_snapshot_authenticated" != "true" ]] && exit 0
[[ "$run_usage_authenticated" != "true" ]] && exit 0

# Production Stop observations are cumulative snapshots. Keep every local
# observation for deterministic retrospective compilation, but relay only a
# canonical terminal snapshot so Console's immutable per-run store cannot
# freeze an early partial total or double-count repeated Stops.
process_status="$(printf '%s' "$state_json" | jq -r '.workflow_outcome.process_status // ""' 2>/dev/null)"
case "$process_status" in
  completed|canceled|failed) ;;
  *) exit 0 ;;
esac

# --- suppression guard: never relay a record with neither attribution nor cost/token/defect signal
# An "unattributed" $0/no-token/no-defect record carries no signal for the console ROI view and
# only dilutes cross-run aggregates (firstPassRate, totalCostUsd, defectsCaught). Suppress the
# POST — NOT the local write above, which stays an unconditional immutable per-run fact — only
# when task_slug is empty/"unattributed" AND cost is zero AND there is NO token volume (input +
# output + cache all zero — cost legitimately degrades to null/0 on an unpriced/new model while
# TOKENS remain source-of-truth, so a token-volume leg is required or real usage on unpriced
# models is wrongly suppressed) AND there is no defect/gate signal. ANY of real attribution, real
# cost, real token volume, or a real defect signal is enough to still relay unchanged. This guard
# is itself best-effort and fails OPEN toward RELAYING: dropping a real record is worse than an
# extra empty one reaching the console, so we suppress ONLY when jq successfully computed an
# explicit `false` (a genuinely-empty record); a jq/read failure (non-zero exit, or any output
# other than the literal "false") falls through and RELAYS unchanged — never toward silently
# swallowing real data (see docs/specs/economics-record-contract.md).
has_signal="$(printf '%s' "$record" | jq -r '
  ((.task_slug // "") | ascii_downcase) as $slug
  | ($slug != "" and $slug != "unattributed") as $attributed
  | ((.cost.estimated_cost_usd // 0) > 0) as $has_cost
  | ((((.cost.input_tokens // 0) + (.cost.output_tokens // 0)
       + (.cost.cache_creation_input_tokens // 0)
       + (.cost.cache_read_input_tokens // 0)) > 0)) as $has_tokens
  | ((.defects.gate_fires // 0) > 0) as $has_gate_fires
  | ((.defects.caught_false_completions // 0) > 0) as $has_cfc
  | (([.defects.findings_by_severity[]?] | add // 0) > 0) as $has_findings
  | ($attributed or $has_cost or $has_tokens or $has_gate_fires or $has_cfc or $has_findings)
' 2>/dev/null)"
jq_rc=$?
if [[ $jq_rc -eq 0 && "$has_signal" == "false" ]]; then
  [[ "${TELEMETRY_ECONOMICS_DEBUG:-}" == "1" ]] && echo "economics-record: suppressing console relay (genuinely-empty record: no attribution/cost/tokens/defects)" >&2
  exit 0
fi
# jq error (non-zero rc), or any signal present ($has_signal == "true") -> fall through and RELAY
# (fail-open toward relaying real data, never toward silently dropping a record on guard failure).

# The economics ingress is the shared kind-routed `<origin>/records` endpoint — NOT the same path as
# the telemetry endpoint (`.../api/telemetry/records`) — so CONSOLE_TELEMETRY_ENDPOINT_URL can only
# contribute an origin here (its path is stripped), never be reused verbatim (#469 review).
endpoint="${FLOW_AGENTS_CONSOLE_ECONOMICS_ENDPOINT_URL:-}"
if [[ -z "$endpoint" ]]; then
  base="${FLOW_AGENTS_CONSOLE_URL:-${CONSOLE_TELEMETRY_URL:-${CONSOLE_URL:-}}}"
  if [[ -z "$base" && -n "${CONSOLE_TELEMETRY_ENDPOINT_URL:-}" ]]; then
    base="$(printf '%s' "$CONSOLE_TELEMETRY_ENDPOINT_URL" | sed -E 's#^(https?://[^/]+).*#\1#')"
  fi
  [[ -z "$base" ]] && exit 0
  endpoint="${base%/}/records"
fi

# Auth reuses the env names console_post_json reads (CONSOLE_TELEMETRY_TOKEN / CONSOLE_TENANT_ID),
# accepting FLOW_AGENTS_CONSOLE_* aliases and an optional token file — never fatal on a missing token.
if [[ -z "${CONSOLE_TELEMETRY_TOKEN:-}" ]]; then
  token_file="${FLOW_AGENTS_CONSOLE_TOKEN_FILE:-${CONSOLE_TELEMETRY_TOKEN_FILE:-}}"
  if [[ -n "$token_file" && -r "$token_file" ]]; then
    CONSOLE_TELEMETRY_TOKEN="$(tr -d '\r\n' < "$token_file" 2>/dev/null || true)"
    export CONSOLE_TELEMETRY_TOKEN
  fi
fi
if [[ -z "${CONSOLE_TENANT_ID:-}" && -n "${FLOW_AGENTS_CONSOLE_TENANT:-}" ]]; then
  export CONSOLE_TENANT_ID="$FLOW_AGENTS_CONSOLE_TENANT"
fi

# Optional field redaction (default none — jq escaping already neutralizes injection), then the shared
# best-effort POST. console_post_json enforces the https/localhost endpoint-allow gate + detached fire.
processed="$(redact_event "$record" "${FLOW_AGENTS_CONSOLE_ECONOMICS_REDACT:-none}")"
console_post_json "$endpoint" "$processed"
exit 0
