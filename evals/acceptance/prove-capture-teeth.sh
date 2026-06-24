#!/usr/bin/env bash
# prove-capture-teeth.sh — Deterministic proof (no model spend) that capture-first
# evidence determinism has teeth through the SHIPPED bundles: an agent claims a
# command passed, but the deterministically-captured command-log shows it actually
# FAILED → Stop is blocked. Also proves the trusted backstop catches a never-run
# claimed-pass command, and that a matching capture log lets Stop through.
#
# Mirrors prove-teeth.sh: installs each bundle and runs the installed hook commands
# with seeded .flow-agents state, exactly as the runtime would on PostToolUse / Stop.
#
# Usage: bash evals/acceptance/prove-capture-teeth.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
pass=0; fail=0
_p(){ echo "  ✓ $1"; pass=$((pass+1)); }
_f(){ echo "  ✗ $1"; fail=$((fail+1)); }

echo "Building bundles..."
(cd "$ROOT" && npm run build:bundles >/dev/null 2>&1) || { echo "build failed"; exit 1; }

hook_cmd(){ # $1 settings/hooks json, $2 event, $3 script needle
  python3 - "$1" "$2" "$3" <<'PY'
import json,sys
s=json.load(open(sys.argv[1]))
for g in s.get("hooks",{}).get(sys.argv[2],[]):
    for h in g["hooks"]:
        if sys.argv[3] in h["command"]:
            print(h["command"]); sys.exit(0)
sys.exit(0)
PY
}

# Seed: model CLAIMS the command passed (evidence.json) but the deterministic
# capture log recorded it as FAIL — a false-completion the gate must catch.
seed_capture_false_pass(){ # $1 project dir
  local p="$1"; mkdir -p "$p/.flow-agents/cap-false"
  [ -f "$p/AGENTS.md" ] || printf '# Repo\n' > "$p/AGENTS.md"
  printf '%s' '{"schema_version":"1.0","task_slug":"cap-false","status":"delivered","phase":"done","updated_at":"2026-06-23T00:00:00Z","next_action":{"status":"done","summary":"done"}}' > "$p/.flow-agents/cap-false/state.json"
  printf '%s' '{"schema_version":"1.0","task_slug":"cap-false","verdict":"pass","checks":[{"id":"unit-tests","kind":"command","status":"pass","command":"npm test","summary":"tests passed"}]}' > "$p/.flow-agents/cap-false/evidence.json"
  printf '%s\n' '{"command":"npm test","observedResult":"fail","exitCode":1,"capturedAt":"2026-06-23T00:00:00Z","source":"postToolUse-capture"}' > "$p/.flow-agents/cap-false/command-log.jsonl"
  cat > "$p/.flow-agents/cap-false/cap-false--deliver.md" <<'MD'
# Cap False

branch: main
status: delivered
type: deliver

## Definition Of Done
- [x] all unit tests pass

## Goal Fit Gate
- [x] acceptance criteria verified

### Verdict: PASS
MD
}

is_block(){ grep -q '"decision":"block"'; }

run_bundle(){ # $1 label, $2 install.sh, $3 settings-json-rel, $4 home-env-name
  local label="$1" installer="$2" cfgrel="$3" homevar="$4"
  echo ""
  echo "── $label: shipped bundle install ──"
  local home proj
  home="$(mktemp -d)"; proj="$(mktemp -d)"
  bash "$installer" "$home" >/dev/null 2>&1 || { _f "$label install.sh failed"; return; }
  local cfg="$home/$cfgrel"
  [ -f "$cfg" ] || { _f "$label config not found at $cfgrel after install"; return; }
  [ -f "$home/scripts/hooks/evidence-capture.js" ] || { _f "$label bundle missing evidence-capture.js after install"; return; }

  # --- Capture hook is wired on PostToolUse in the shipped config ---
  local capcmd; capcmd="$(hook_cmd "$cfg" PostToolUse evidence-capture)"
  [ -n "$capcmd" ] || { _f "$label: no PostToolUse evidence-capture hook in shipped config"; return; }
  _p "$label ships evidence-capture on PostToolUse"

  # The capture hook deterministically records a real command result through the
  # installed adapter path.
  mkdir -p "$proj/.flow-agents/live-cap"
  [ -f "$proj/AGENTS.md" ] || printf '# Repo\n' > "$proj/AGENTS.md"
  printf '%s' '{"schema_version":"1.0","task_slug":"live-cap","status":"in_progress","phase":"verification","updated_at":"2026-06-23T00:00:00Z"}' > "$proj/.flow-agents/live-cap/state.json"
  printf '{"hook_event_name":"PostToolUse","tool_name":"Bash","cwd":"%s","tool_input":{"command":"npm run lint"},"error":"command failed"}' "$proj" \
    | env "$homevar=$home" CLAUDE_PROJECT_DIR="$home" bash -c "$capcmd" >/dev/null 2>&1 || true
  if rg -q '"command":"npm run lint","observedResult":"fail"' "$proj/.flow-agents/live-cap/command-log.jsonl" 2>/dev/null; then
    _p "$label capture hook records a real FAIL to command-log.jsonl through the installed adapter"
  else
    _f "$label capture hook did not record the command result: $(cat "$proj/.flow-agents/live-cap/command-log.jsonl" 2>/dev/null)"
  fi

  # --- Teeth: claims-pass-but-log-shows-fail → Stop is BLOCKED ---
  seed_capture_false_pass "$proj"
  local stopcmd; stopcmd="$(hook_cmd "$cfg" Stop stop-goal-fit)"
  [ -n "$stopcmd" ] || { _f "$label: no Stop stop-goal-fit hook in shipped config"; return; }
  local blk; blk="$(printf '{"hook_event_name":"Stop","cwd":"%s"}' "$proj" | env "$homevar=$home" CLAUDE_PROJECT_DIR="$home" FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip bash -c "$stopcmd" 2>/dev/null)"
  echo "$blk" | is_block && _p "$label BLOCKS a claimed-pass command that the capture log recorded as FAIL" || _f "$label did NOT block the captured false-completion: $blk"

  # control: a matching capture log (pass) lets Stop through on the capture axis.
  printf '%s\n' '{"command":"npm test","observedResult":"pass","exitCode":0,"capturedAt":"2026-06-23T00:00:00Z","source":"postToolUse-capture"}' > "$proj/.flow-agents/cap-false/command-log.jsonl"
  local okblk; okblk="$(printf '{"hook_event_name":"Stop","cwd":"%s"}' "$proj" | env "$homevar=$home" CLAUDE_PROJECT_DIR="$home" FLOW_AGENTS_GOAL_FIT_BACKSTOP=skip bash -c "$stopcmd" 2>&1)"
  if echo "$okblk" | grep -q 'caught false-completion'; then
    _f "$label control: a confirming capture log should not raise a false-completion"
  else
    _p "$label control: a confirming capture log clears the false-completion (no re-run)"
  fi
}

run_bundle "Claude Code" "$ROOT/dist/claude-code/install.sh" ".claude/settings.json" "CLAUDE_PROJECT_DIR"
run_bundle "Codex"       "$ROOT/dist/codex/install.sh"       ".codex/hooks.json"     "CODEX_HOME"

echo ""
echo "──────────────────────────────────"
echo "prove-capture-teeth: $pass passed, $fail failed"
[ "$fail" -eq 0 ] && echo "PROOF: shipped bundles capture real command results and BLOCK claimed-pass-but-actually-failed completions." || true
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
