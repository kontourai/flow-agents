#!/bin/bash
# Spawn hook: git status + worktree context for parallel safety

if ! git rev-parse --is-inside-work-tree &>/dev/null; then
  echo "📁 Not a git repository — skipping git context"
  exit 0
fi

# Basic status
echo "=== Git Status ==="
git status --short

# Branch/worktree context
echo ""
echo "=== Branch ==="
git branch --show-current

# Detect if we're in a worktree (not the main working tree)
TOPLEVEL=$(git rev-parse --show-toplevel)
COMMON=$(git rev-parse --git-common-dir)
GIT_DIR=$(git rev-parse --git-dir)

if [ "$GIT_DIR" != "$COMMON" ]; then
  echo "⚠️  Running inside a git worktree: $TOPLEVEL"
  echo "   Main repo: $(cd "$COMMON/.." && pwd)"
fi

# List active worktrees for conflict awareness
WORKTREE_COUNT=$(git worktree list | wc -l | tr -d ' ')
if [ "$WORKTREE_COUNT" -gt 1 ]; then
  echo ""
  echo "=== Active Worktrees ($WORKTREE_COUNT) ==="
  git worktree list
  echo ""
  echo "⚠️  Multiple worktrees active — check .kontourai/flow-agents/ for in-progress tasks before modifying shared files"
fi

# List existing TODOs for awareness
TODO_DIR=".kontourai/flow-agents"
if [ -d "$TODO_DIR" ]; then
  TODO_COUNT=$(find "$TODO_DIR" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$TODO_COUNT" -gt 0 ]; then
    echo ""
    echo "=== Active TODOs ($TODO_COUNT) ==="
    while IFS= read -r f; do
      [ -f "$f" ] && echo "  - $(basename "$f" .md): $(head -1 "$f")"
    done < <(find "$TODO_DIR" -mindepth 2 -maxdepth 2 -name "*.md" 2>/dev/null | sort)
  fi
fi
