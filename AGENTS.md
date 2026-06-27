# Universal Agent Bundle (Claude Code)

This bundle was generated from the canonical source in this repo. Treat the repo root as the source of truth and regenerate the bundle instead of editing exported agent files by hand. (Exception: the "Repository Conventions" section below is source-repo-specific, maintained by hand, and intentionally absent from generated bundles.)

## Repository Conventions (source repo only)

- **Commit messages drive releases.** Releases are automated with release-please: `feat:` bumps minor, `fix:` bumps patch, `feat!:`/`BREAKING CHANGE` bumps major; `docs:`/`chore:`/`test:`/`refactor:` don't bump. Commits without a conventional prefix are invisible to version inference — use one. Details: CONTRIBUTING.md ("Releases").
- **Never hand-edit release PRs** (`release-please--branches--*`); they are regenerated on every push to main.
- **Evidence hygiene:** issue/PR permalinks must pin a real commit SHA (`git rev-parse`, never typed by hand); claims about behavior need command/test evidence.
- `.flow-agents/` runtime artifacts stay untracked; durable records belong in docs/, issues, or tracked source.

### Operating discipline (working agreements)

Confirmed agreements for developing this repo — the *kit-discipline* bucket of ADR 0013, seeded here by hand (encoded by us, shipped uniform; the kit does not self-evolve on user machines). Keep this list short and principle-level; let stale entries be pruned.

- **Consume, never fork — survey before building.** Before adding any concept/command/schema, check what already exists (exported `@kontourai/*` types, ADRs, skills/commands) *and what's in flight* (open PRs, branches, `git worktree list`). Many agents run here in parallel; work is often already built or being built (ADR 0008/0010).
- **Coordinate shared-area changes; surface, don't brute-force.** When a change touches code another agent is actively in (e.g. `workflow-sidecar.ts`, the gate), prefer an additive change and flag the overlap on the issue; build on the latest `origin/main` in an isolated `git worktree`. **The working tree is shared across agents — clean up only the worktrees *you* created (match your own path prefix); never `git worktree remove` "all non-main" worktrees, which destroys another agent's uncommitted state** (branches/commits survive, but in-progress working-dir changes do not).
- **A "flake" or a silent success is a real bug — root-cause it, never re-run past it.** Flakiness is usually a real race or fail-open; an operation that can pass without doing its job, or drop data silently, *is* the bug.
- **Prove it; don't design on assumption.** Gate changes on the suite (`prove-capture-teeth`, conformance L2, `test_workflow_sidecar_writer`, `tsc`) before merge; verify load-bearing assumptions with a quick experiment, not reasoning alone.
- **Name the primitive, not the use-case.** Center the general mechanism (e.g. a *liveness policy*); the use-case is a label, the primitive is the abstraction.
- **Merge mechanics:** strict protection + a fast `main` makes CLI merges racy — `update-branch` for a clean window, then merge; never `--no-verify`; `pre-push` validation needs `node_modules/.bin` on `PATH`; keep dev + CI Node in sync via `.tool-versions`. **During a fast-`main` *burst*, do not reflexively `update-branch`** — each one resets CI to pending and you lose the race; let the *current* CI settle, then `--admin`-merge a **verified, isolated, conflict-free** PR (admin bypasses only the up-to-date requirement, never a check — use only when the change cannot conflict with the newer `main`).
- **Delegate the next increment via fresh-context handoff (`continue-work`).** A multi-slice item's next slice is best run in a *fresh* context that inherits the durable system, not this session's history (ADR 0013): spawn an agent (or a new session) pointed at the issue + these operating agreements + the precedent PRs. Prompt size scales with **novelty** — a precedented, mechanical slice needs only the minimal template (task + entry artifact + precedent); novel work (a new skill, a subtle composition) needs the subtlety spelled out. **Parallelize the *implementation*** of independent slices; **serialize only the *merge*** where they share a file (e.g. a kit's flow-runner).

## Shared Conventions

- `skills/`, `context/`, `powers/`, `prompts/`, `scripts/`, and `evals/` were copied from the canonical source.
- Cross-session task artifacts should live under `.flow-agents`.
- Kiro-only hook wiring was stripped from exported non-Kiro agents to keep the package portable.
- **Gate awareness:** `context/gate-awareness.md` — the three active gates (goal-fit/Stop, evidence-capture, reground), why a block is the system working, and how to diagnose a suspected missed block.

## Exported Agents

- `dev` — Development agent for coding tasks. Writes, modifies, and validates code following existing patterns. Delegates to specialists for domain-specific research when available.
- `tool-code-reviewer` — Delegate to me for code quality review. Analyzes readability, maintainability, patterns, DRY compliance, and produces structured review with severity levels. Separate from verification (build/test/lint).
- `tool-dependencies-updater` — Delegate to me for updating your project dependencies - checks latest versions, identifies outdated packages, and finds security advisories across npm, PyPI, Cargo, Maven/Gradle, Go, NuGet, Ruby, PHP, Swift, Dart, Docker, Helm, Terraform, and GitHub Actions
- `tool-explore-config` — Delegate to me for project configuration inspection - finds and summarizes configuration files and environment variables within a project
- `tool-explore-deps` — Delegate to me for Dependency analysis - parses package manifests to identify tech stack and dependencies
- `tool-explore-entry` — Delegate to me to find the Entry point of a project - locates main files, CLI commands, API routes, and exports
- `tool-explore-patterns` — Delegate to me for Pattern detection - identifies architectural patterns, frameworks, and coding conventions
- `tool-explore-structure` — Delegate to me to scout out the project structure - maps directory layout and identifies key folders in a codebase
- `tool-explore-tests` — Delegate to me to find and understand testing strategies - locates test files and understands testing strategy
- `tool-planner` — Delegate to me for codebase analysis and execution planning. Explores code, identifies patterns and dependencies, and writes plan/sidecar artifacts under .flow-agents. No production file modifications.
- `tool-playwright` — Delegate to me for browser automation, testing, and debugging - loading real pages, testing navigation, checking accessibility via structured snapshots, evaluating scripts, and visual verification. Anything that would otherwise require a browser. Do NOT use for general web search or fetching content
- `tool-security-reviewer` — Delegate to me for security analysis. Checks OWASP Top 10, secrets detection, input validation, injection vulnerabilities, auth/authz, and rate limiting. Read-only analysis with shell for scanning tools.
- `tool-verifier` — Delegate to me for implementation verification. Read-only + shell for source code; writes review/evidence artifacts under .flow-agents. Verifies acceptance criteria and produces PASS/FAIL/NOT_VERIFIED verdicts with evidence. No production file modifications.
- `tool-worker` — Delegate to me for writing and developing source code for a project. Works best when a detailed plan can be provided. NO access to web tools. Can be used in parallel for any coding tasks that require trusted access to the write and shell tools. WARNING: May spawn a `git worktree`
