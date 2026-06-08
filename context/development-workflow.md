# Development Workflow

Standard workflow for all dev agent tasks. Steps are sequential — do not skip.

## 0. Research & Reuse (mandatory)

Before writing new code, search for existing solutions:
- Codebase: grep/code search for similar logic already implemented
- Package registries: npm, PyPI, crates.io for proven libraries
- GitHub: public repos, code search for patterns and approaches

Prefer adopting proven solutions over writing net-new. Use the `search-first` skill for structured research when the decision isn't obvious.

## 1. Plan

Use `plan-work` skill or `tool-planner` agent. Produce a plan artifact that covers:
- Files to create/modify with specific changes
- Dependencies and risks
- Phased execution (waves for parallelization)

## 2. TDD

Write tests first, then implement, then refactor:
- **RED** — write failing tests that define expected behavior
- **GREEN** — write minimum code to pass
- **IMPROVE** — refactor without changing behavior

Target 80%+ coverage. Use `tdd-workflow` skill for structured TDD.

## 3. Code Review

Use `review-work` for automated critique. It delegates to `tool-code-reviewer` for quality, standards, and architecture fit, and to `tool-security-reviewer` when security triggers are present.
- Address all CRITICAL and HIGH severity issues before proceeding
- LOW/INFO items are advisory — fix if trivial, otherwise note and move on

## 4. Verify

Use `verify-work` skill for functional verification and evidence:
- Build succeeds
- Type checking passes
- Linter clean
- All tests pass
- No security vulnerabilities introduced

## 5. Commit

Follow Conventional Commits per AGENTS.md:
- Format: `<type>(<scope>): <description>`
- Lowercase, imperative, no period, under 72 chars
- Append `!` for breaking changes
