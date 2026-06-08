---
name: "github-cli"
description: "Interact with GitHub via gh CLI — PRs, issues, repos, releases, workflows, gists."
---

# GitHub CLI

Interact with GitHub using the `gh` CLI — manage pull requests, issues, repos, releases, Actions workflows, and more without leaving the terminal.

## Trigger Patterns

This skill activates when the user:

- Wants to create, view, merge, or review pull requests
- Wants to create, list, or manage issues
- Wants to check GitHub Actions workflow runs or status
- Wants to create or manage releases, gists, or repos
- Wants to search GitHub for repos, issues, or PRs
- Wants to browse a repo or PR in the browser
- Mentions `gh` by name or references GitHub operations

## Prerequisites

Confirm `gh` is available by running `gh --help`. If not found, tell the user it's not installed and stop.

The user must be authenticated. If a command fails with an auth error, suggest `gh auth login` and let the user handle it interactively.

## What `gh` Does

`gh` is GitHub's official CLI. Key capability areas:

- **Pull Requests** — create, list, view, checkout, review, merge, close, diff, checks
- **Issues** — create, list, view, close, reopen, comment, assign, label
- **Repos** — create, clone, fork, view, archive, rename, sync
- **Releases** — create, list, view, delete, upload assets
- **Actions** — view workflow runs, watch live logs, re-run failed jobs, list workflows
- **Gists** — create, list, view, edit, delete
- **Search** — search repos, issues, PRs, code across GitHub
- **API** — make arbitrary authenticated GitHub API requests
- **Browse** — open any repo/issue/PR in the default browser

Run `gh --help` for the full command list and `gh <command> --help` for subcommand details. Defer to the CLI as the source of truth.

## Workflow

### Step 1: VERIFY
Run `gh --help` to confirm availability. If not found, stop.

### Step 2: UNDERSTAND INTENT
Map the user's request to the right `gh` command area. If unsure which subcommand to use, run `gh <command> --help` to discover options.

### Step 3: EXECUTE
Run the appropriate `gh` command. For commands that create or mutate (PR create, issue close, release create, etc.), confirm the action with the user first unless they were explicit.

### Step 4: PRESENT RESULTS
Format output clearly. For list commands, summarize key fields. For view commands, highlight the important details. Offer follow-up actions where natural (e.g. after listing PRs, offer to check out or review one).

## Key Principles
- ALWAYS verify `gh` is available before any operation
- Use `gh <command> --help` to discover flags and subcommands — don't assume syntax
- Confirm destructive or mutating operations before executing
- If auth fails, direct the user to `gh auth login` — don't attempt to authenticate programmatically
- Prefer `gh` over raw `git` commands when the operation involves GitHub-specific features (PRs, issues, Actions, etc.)
