# Git Worktree Isolation

When working on tasks that overlap with in-progress work from other sessions, use git worktrees to avoid conflicts.

## When to Use Worktrees

- Check existing TODO lists for incomplete work
- Compare your target files against `modified_files` in active TODOs
- If files overlap with another TODO's active changes, create a worktree
- If no overlap exists, work directly in the main tree

## Worktree Workflow

1. Create: `git worktree add ../worktree/kiro-<todo-id>-<feature> -b feat/<feature>`
2. Do all implementation work in the worktree path
3. On completion, attempt `git merge` back to the working branch
4. If merge conflicts arise, surface them to the user for resolution
5. Only clean up the worktree after a successful merge

## TODO Awareness

- Incomplete TODOs = active work — expect broken builds or partial implementations in those areas
- Always check for overlap before starting work
- If your task relates to an existing TODO, ask the user whether to continue it or start fresh
