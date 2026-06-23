#!/usr/bin/env bash
# prove-teeth.sh — End-to-end proof that the SHIPPED bundles enforce goal fit
# (block mode) and re-ground active goals (SessionStart re-injection), through
# the real install + adapter path, for Claude Code and Codex.
#
# This is deterministic (no live model spend): it installs each bundle and runs
# the installed hook commands with seeded .flow-agents state, exactly as the
# runtime would on a Stop / SessionStart event.
#
# Usage: bash evals/acceptance/prove-teeth.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
pass=0; fail=0
_p(){ echo "  ✓ $1"; pass=$((pass+1)); }
_f(){ echo "  ✗ $1"; fail=$((fail+1)); }

echo "Building bundles..."
(cd "$ROOT" && npm run build:bundles >/dev/null 2>&1) || { echo "build failed"; exit 1; }

# Extract an installed hook command by event + script-name substring.
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

seed_false_completion(){ # $1 project dir — evidence FAIL but markdown claims PASS
  local p="$1"; mkdir -p "$p/.flow-agents/false-done"
  [ -f "$p/AGENTS.md" ] || printf '# Repo\n' > "$p/AGENTS.md"
  printf '%s' '{"schema_version":"1.0","task_slug":"false-done","status":"in_progress","phase":"verification","updated_at":"2026-06-18T00:00:00Z","next_action":{"status":"continue","summary":"Make the failing tests pass."}}' > "$p/.flow-agents/false-done/state.json"
  printf '%s' '{"schema_version":"1.0","task_slug":"false-done","verdict":"fail","checks":[{"id":"unit-tests","kind":"test","status":"fail","summary":"3 unit tests still failing"}]}' > "$p/.flow-agents/false-done/evidence.json"
  cat > "$p/.flow-agents/false-done/false-done--deliver.md" <<'MD'
# False Done

branch: main
status: executing
type: deliver

## Definition Of Done
- [x] all unit tests pass

## Goal Fit Gate
- [x] acceptance criteria verified

### Verdict: PASS
MD
}

seed_active_resume(){ # $1 project dir — active in_progress task with a concrete next step
  local p="$1"; mkdir -p "$p/.flow-agents/resume-task"
  [ -f "$p/AGENTS.md" ] || printf '# Repo\n' > "$p/AGENTS.md"
  printf '%s' '{"schema_version":"1.0","task_slug":"resume-task","status":"in_progress","phase":"execution","updated_at":"2026-06-18T00:00:00Z","next_action":{"status":"continue","summary":"Create a file named RESUMED.txt containing the word resumed.","target_phase":"verification"}}' > "$p/.flow-agents/resume-task/state.json"
}

is_block(){ grep -q '"decision":"block"'; }
has_reground(){ # stdin = adapter json; assert additionalContext re-grounds the goal
  python3 -c "import json,sys
d=json.load(sys.stdin); ctx=d.get('hookSpecificOutput',{}).get('additionalContext','')
sys.exit(0 if ('STATE:' in ctx and 'resume-task' in ctx and 'RESUMED.txt' in ctx) else 1)"
}

run_bundle(){ # $1 label, $2 install.sh, $3 settings-json-rel, $4 home-env-name
  local label="$1" installer="$2" cfgrel="$3" homevar="$4"
  echo ""
  echo "── $label: shipped bundle install ──"
  local home proj
  home="$(mktemp -d)"; proj="$(mktemp -d)"
  bash "$installer" "$home" >/dev/null 2>&1 || { _f "$label install.sh failed"; return; }
  local cfg="$home/$cfgrel"
  [ -f "$cfg" ] || { _f "$label config not found at $cfgrel after install"; return; }
  [ -f "$home/scripts/hooks/stop-goal-fit.js" ] || { _f "$label bundle missing scripts/hooks after install"; return; }

  # --- Teeth 1: false-completion block ---
  seed_false_completion "$proj"
  local stopcmd; stopcmd="$(hook_cmd "$cfg" Stop stop-goal-fit)"
  [ -n "$stopcmd" ] || { _f "$label: no Stop stop-goal-fit hook in shipped config"; return; }
  local blk; blk="$(printf '{"hook_event_name":"Stop","cwd":"%s"}' "$proj" | env "$homevar=$home" CLAUDE_PROJECT_DIR="$home" bash -c "$stopcmd" 2>/dev/null)"
  echo "$blk" | is_block && _p "$label BLOCKS false completion by default (evidence=fail vs markdown PASS)" || _f "$label did NOT block: $blk"
  # control: warn mode must pass through
  local wrn; wrn="$(printf '{"hook_event_name":"Stop","cwd":"%s"}' "$proj" | env "$homevar=$home" CLAUDE_PROJECT_DIR="$home" FLOW_AGENTS_GOAL_FIT_MODE=warn bash -c "$stopcmd" 2>/dev/null)"
  echo "$wrn" | is_block && _f "$label warn-mode override should NOT block" || _p "$label warn-mode override passes through (control)"

  # --- Teeth 2: re-ground active goal on SessionStart ---
  local sscmd; sscmd="$(hook_cmd "$cfg" SessionStart workflow-steering)"
  [ -n "$sscmd" ] || { _f "$label: no SessionStart workflow-steering hook in shipped config"; return; }
  seed_active_resume "$proj"
  local rg; rg="$(printf '{"hook_event_name":"SessionStart","cwd":"%s","source":"compact"}' "$proj" | env "$homevar=$home" CLAUDE_PROJECT_DIR="$home" bash -c "$sscmd" 2>/dev/null)"
  echo "$rg" | has_reground && _p "$label RE-GROUNDS the active goal on SessionStart (goal + next step survive compaction)" || _f "$label SessionStart did not re-ground: $rg"
}

run_bundle "Claude Code" "$ROOT/dist/claude-code/install.sh" ".claude/settings.json" "CLAUDE_PROJECT_DIR"
run_bundle "Codex"       "$ROOT/dist/codex/install.sh"       ".codex/hooks.json"     "CODEX_HOME"

echo ""
echo "──────────────────────────────────"
echo "prove-teeth: $pass passed, $fail failed"
[ "$fail" -eq 0 ] && echo "PROOF: shipped Claude Code + Codex bundles enforce goal-fit and re-ground on compaction." || true
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
