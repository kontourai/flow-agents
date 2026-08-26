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

  # FOUR-way. The first version of this scored CLEAN as "not STACK and not on a short
  # denylist" — a verdict derived from ABSENCE, which an independent review refuted by
  # exhibiting `flow-agents workflow: Operation failed`: no stack, not on the denylist,
  # scored CLEAN, and tells the operator nothing. CLEAN now requires POSITIVE evidence
  # that the message names something to act on, and VAGUE catches everything that
  # merely avoids looking like a crash.
  frames="$(printf '%s\n' "$out" | grep -cE '^[[:space:]]+at |node:internal|node:fs' || true)"

  # Classify on the FULL first line; truncate only for display. The earlier version
  # classified on `cut -c1-72`, so a raw error beyond column 72 scored CLEAN.
  first_full="$(printf '%s\n' "$out" | head -1)"
  first="$(printf '%s' "$first_full" | cut -c1-72)"

  # Anchored after any `flow-agents <verb>: ` prefix: an authored sentence that QUOTES a
  # parser error is good practice and must not score RAW; a message that IS the runtime
  # error must, even once a top-level catch has stripped its stack. The error-name pattern
  # is general (any `SomethingError:`, any `EUPPERCASE`) rather than a hand-listed few,
  # because the denylist could never keep up with Node's error surface.
  body="$(printf '%s' "$first_full" | sed -E 's/^flow-agents([ ][a-z][a-z-]*|[ ]--[a-z][a-z-]*)*: //')"
  raw="$(printf '%s\n' "$body" | grep -cE '^([A-Za-z][A-Za-z]*Error: )?E[A-Z]{2,}[,:]|^[A-Za-z][A-Za-z]*Error:|^Unexpected token|^Cannot read propert' || true)"

  # POSITIVE requirement for CLEAN: somewhere in the output, name a referent the operator
  # can act on — an absolute path, a flag, or a usage line. This is what makes the verdict
  # a derivation rather than a label. An empty-suffix message ("... not found at ") has no
  # path and now scores VAGUE, which is the whole point.
  #
  # The path pattern is NOT anchored to whitespace. It was, and that produced a false
  # VAGUE on a message which named its file as `(/private/var/...` — the opening paren
  # defeated the anchor. Matching a run containing two separators finds a path wherever
  # it is punctuated, which is what "names a path" actually means.
  actionable="$(printf '%s\n' "$out" | grep -cE '/[^[:space:]]+/|--[a-z][a-z-]+|[Uu]sage:' || true)"

  total=$((total + 1))
  if [ "$frames" -gt 0 ]; then
    verdict="STACK"; stacky=$((stacky + 1))
  elif [ "$raw" -gt 0 ]; then
    verdict="RAW"; stacky=$((stacky + 1))
  elif [ "$actionable" -eq 0 ]; then
    verdict="VAGUE"; stacky=$((stacky + 1))
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
  [ "$stacky" -gt 0 ] && printf '  %s probe(s) did not.\n' "$stacky"
  printf '  STACK = internal frames leaked.\n'
  printf '  RAW   = stackless, but the message IS a runtime error (ENOENT, SyntaxError).\n'
  printf '  VAGUE = neither, but names no path, flag or usage — nothing to act on.\n'
  printf '\n'
fi

exit 0
