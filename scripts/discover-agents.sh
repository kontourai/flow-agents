#!/bin/bash
# Spawn hook: discover agent cards from the repo, installed bundle, or legacy root file.
echo "=== Agent Card Discovery ==="
FOUND=0
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
shopt -s nullglob
cards=(
  "$ROOT_DIR"/agent-cards/*.json
  "$HOME"/.flow-agents/agent-cards/*.json
  "$HOME"/.flow-agents/agent-card.json
)
for card in "${cards[@]}"; do
  [ -f "$card" ] || continue
  FOUND=$((FOUND + 1))
  name=$(node -e "const d=require(process.argv[1]); process.stdout.write(d.name||'?')" "$card" 2>/dev/null)
  agent=$(node -e "const d=require(process.argv[1]); process.stdout.write(d.agent||'?')" "$card" 2>/dev/null)
  desc=$(node -e "const d=require(process.argv[1]); process.stdout.write(d.description||'')" "$card" 2>/dev/null)
  echo ""
  echo "📋 $name (agent: $agent)"
  echo "   $desc"
done
if [ "$FOUND" -eq 0 ]; then
  echo "No agent cards found."
else
  echo ""
  echo "Discovered $FOUND orchestrator(s)."
fi
