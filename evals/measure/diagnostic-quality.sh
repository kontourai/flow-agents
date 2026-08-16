#!/usr/bin/env bash
# Measure CLI diagnostic quality: when a verb refuses, does it explain, or dump a stack?
#
# Every probe supplies input a real operator plausibly types (a session dir that does not
# exist yet, a missing required flag, a malformed state file). None of them mutate anything:
# all paths live under a throwaway temp root.
#
# Emits a human table on stdout and, with --json, a machine record for trend tracking.
# Re-runnable: the numbers here are derived on every run, never transcribed.
#
# Usage: diagnostic-quality.sh [--json] [--cli <path to cli.js>]
set -euo pipefail

CLI=""
EMIT_JSON=0
while [ $# -gt 0 ]; do
  case "$1" in
    --json) EMIT_JSON=1; shift ;;
    --cli) CLI="$2"; shift 2 ;;
    *) echo "diagnostic-quality.sh: unknown argument: $1" >&2; exit 64 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[ -n "$CLI" ] || CLI="$ROOT/build/src/cli.js"
if [ ! -f "$CLI" ]; then
  echo "diagnostic-quality.sh: no CLI at $CLI (run npm run build, or pass --cli)" >&2
  exit 69
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PROJECT="$TMP/project"
mkdir -p "$PROJECT/.kontourai/flow-agents"
git -C "$PROJECT" init -q 2>/dev/null || true

# A session dir that is well-formed in shape but has no state.json.
mkdir -p "$PROJECT/.kontourai/flow-agents/empty-session"
# A session dir whose state.json is not JSON.
mkdir -p "$PROJECT/.kontourai/flow-agents/malformed-session"
printf 'not json at all\n' > "$PROJECT/.kontourai/flow-agents/malformed-session/state.json"

# id | description | argv...
PROBES=(
  "evidence-missing-dir|session dir does not exist|workflow|evidence|--session-dir|.kontourai/flow-agents/absent|--expectation|implementation-plan|--status|pass|--summary|probe"
  "evidence-no-state|session dir exists, no state.json|workflow|evidence|--session-dir|.kontourai/flow-agents/empty-session|--expectation|implementation-plan|--status|pass|--summary|probe"
  "evidence-bad-state|state.json is not JSON|workflow|evidence|--session-dir|.kontourai/flow-agents/malformed-session|--expectation|implementation-plan|--status|pass|--summary|probe"
  "status-missing-dir|status on a missing session|workflow|status|--session-dir|.kontourai/flow-agents/absent"
  "critique-missing-dir|critique on a missing session|workflow|critique|--session-dir|.kontourai/flow-agents/absent|--id|x|--verdict|pass|--summary|probe"
  "start-unknown-flow|start with an unregistered flow|workflow|start|--flow|no.such.flow|--work-item|probe:1"
  "uninstall-no-runtime|uninstall without --runtime|init|--uninstall|--dest|$PROJECT"
  "kit-unknown-verb|kit with an unknown subcommand|kit|nosuchverb"
)

clean=0; stacky=0; total=0
rows=""
json_rows=""

for probe in "${PROBES[@]}"; do
  IFS='|' read -r id desc rest <<< "$probe"
  IFS='|' read -r -a argv <<< "$rest"
  out="$( (cd "$PROJECT" && node "$CLI" "${argv[@]}") 2>&1 || true )"
  code="$( (cd "$PROJECT" && node "$CLI" "${argv[@]}" >/dev/null 2>&1; echo $?) )"

  # Three-way, deliberately. A top-level catch that prints err.message would turn every
  # STACK into a stackless line without the operator learning anything more — so a raw
  # runtime message is scored separately from an authored diagnostic. Without this the
  # instrument rewards catching the error rather than explaining it.
  frames="$(printf '%s\n' "$out" | grep -cE '^\s+at |node:internal|node:fs' || true)"
  first="$(printf '%s\n' "$out" | head -1 | cut -c1-72)"
  # Anchored deliberately: the check is whether the message BEGINS as a raw runtime error,
  # after any `flow-agents <verb>: ` prefix. An authored sentence that quotes the underlying
  # parser error is good practice and must not score as RAW; a message that IS the runtime
  # error must, even when a top-level catch has stripped its stack.
  body="$(printf '%s\n' "$first" | sed -E 's/^flow-agents( [a-z-]+)*: //')"
  raw="$(printf '%s\n' "$body" | grep -cE '^([A-Za-z]*Error: )?(ENOENT|EACCES|EISDIR|ENOTDIR)[,:]|^(SyntaxError|TypeError|ReferenceError):|^Unexpected token|^Cannot read propert' || true)"

  total=$((total + 1))
  if [ "$frames" -gt 0 ]; then
    verdict="STACK"; stacky=$((stacky + 1))
  elif [ "$raw" -gt 0 ]; then
    verdict="RAW"; stacky=$((stacky + 1))
  else
    verdict="CLEAN"; clean=$((clean + 1))
  fi

  rows="${rows}$(printf '  %-7s exit=%-3s %-34s %s\n' "$verdict" "$code" "$desc" "$first")
"
  esc_first="$(printf '%s' "$first" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  json_rows="${json_rows}    {\"id\":\"$id\",\"verdict\":\"$verdict\",\"exit\":$code,\"frames\":$frames,\"first_line\":\"$esc_first\"},
"
done

pct=$(( clean * 100 / total ))

if [ "$EMIT_JSON" -eq 1 ]; then
  printf '{\n  "measurement": "cli-diagnostic-quality",\n  "probes_total": %s,\n  "probes_clean": %s,\n  "probes_stack": %s,\n  "clean_pct": %s,\n  "probes": [\n%s  ]\n}\n' \
    "$total" "$clean" "$stacky" "$pct" "$(printf '%s' "$json_rows" | sed '$ s/,$//')"
else
  printf '\nCLI DIAGNOSTIC QUALITY\n'
  printf '  When a verb refuses, does it explain the refusal or dump a stack trace?\n\n'
  printf '%s' "$rows"
  printf '\n  %s/%s probes answered with an authored diagnostic (%s%%)\n' "$clean" "$total" "$pct"
  [ "$stacky" -gt 0 ] && printf '  %s probe(s) answered with a stack trace or a raw runtime error.\n' "$stacky"
  printf '  STACK = internal frames leaked.  RAW = stackless but still an unauthored\n'
  printf '  runtime message (ENOENT, SyntaxError); the operator still learns nothing.\n'
  printf '\n'
fi

exit 0
