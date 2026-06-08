---
name: code-audit
description: "Iterative codebase audit. First run: broad sweep. Subsequent runs: deep dive into specific dimensions or files."
---

# Codebase Audit — {depth:broad} | Focus: {focus:all}

Audit this repository at the requested depth and focus. Every finding must reference specific files and line ranges.

## Depth Modes

**broad** (default) — Scan the full codebase across all dimensions. Produce a summary-level report with the top findings per dimension. Don't read every file — sample key files, entry points, and the largest/most-changed modules. Goal: identify WHERE the problems are so subsequent deep dives are targeted.

**deep** — Exhaustive analysis of the specified focus area. Read every relevant file. Trace call chains, map dependencies, and propose specific refactors with before/after sketches. If focus is "all", pick the highest-severity dimension from a prior broad scan and go deep on that.

## Focus Areas

When focus is not "all", restrict analysis to the specified dimension:

- **dry** — Duplicated logic, repeated patterns, copy-pasted code, magic values that should be constants
- **abstractions** — SRP violations, missing interfaces, tight coupling, business logic in wrong layers, god objects
- **testability** — Hardcoded dependencies, side effects, missing DI, logic buried in framework code, test organization
- **errors** — Swallowed exceptions, missing error handling on I/O/network, inconsistent error formats, missing retries/timeouts
- **naming** — Misleading names, overgrown files, dead code, TODO/FIXME/HACK markers, structural inconsistencies
- **security** — Hardcoded secrets, missing input validation, overly permissive access, sensitive data in logs
- **dependencies** — Outdated/unused deps, missing lock files, build script complexity

## Scope Narrowing

{scope?}

If a scope is provided above (file paths, directories, or module names), restrict the audit to those areas only. Otherwise audit the full repository.

## Phase 1: Orient

Before analyzing, understand the codebase:

1. Map directory structure, tech stack, frameworks, languages
2. Identify entry points (main files, API routes, CLI commands, exports)
3. Read key config files (package.json, pyproject.toml, Cargo.toml, Dockerfile, etc.)
4. Understand testing setup (frameworks, coverage, test locations)
5. Check for linting/formatting config

**If depth is deep**: Also read the specific files in the focus area thoroughly. Trace imports and call chains. Understand how the focused code interacts with the rest of the system.

Summarize your understanding before proceeding.

## Phase 2: Analyze

### Broad Mode

For each applicable dimension, scan for the most significant issues. Limit to 3-5 findings per dimension. For each:

```
### [Finding Title] — Severity: HIGH | MEDIUM | LOW

**Files:** `path/to/file.ext` (lines X-Y)
**Problem:** What's wrong and why it matters.
**Recommendation:** One-line concrete fix direction.
```

### Deep Mode

For the focused dimension, provide exhaustive analysis:

```
### [Finding Title] — Severity: HIGH | MEDIUM | LOW

**Files:** `path/to/file.ext` (lines X-Y), `path/to/other.ext` (lines A-B)

**Problem:** Detailed explanation — what's wrong, why it happened, what breaks or degrades because of it.

**Current pattern:**
[Show the actual problematic code or describe the pattern concretely]

**Proposed refactor:**
[Show the target structure — new files, interfaces, function signatures. Not full implementations, but enough to be unambiguous about the design.]

**Migration path:** Steps to get from current to proposed without breaking things.

**Effort:** S / M / L
**Risk:** What could go wrong during the refactor.
```

## Phase 3: Report

### Broad Mode Report

1. **Heatmap** — Which dimensions have the most/worst findings? Rank them.
2. **Top 5 highest-impact changes** — Best ROI refactors across all dimensions.
3. **Recommended deep dive order** — Which focus area to audit next and why.
4. **What's done well** — Patterns worth preserving.

### Deep Mode Report

1. **All findings** for the focused dimension, ordered by severity then effort.
2. **Dependency graph** — How do the findings relate? Which refactors unlock others?
3. **Suggested implementation order** — Sequence the fixes to minimize risk and maximize incremental value.
4. **What's done well** in this dimension — patterns to extend, not just problems to fix.

## Severity Guide

- **HIGH** — Actively causes bugs, security issues, or makes the codebase significantly harder to maintain
- **MEDIUM** — Creates friction, slows development, or will become a problem as the codebase grows
- **LOW** — Cleanup opportunity, style improvement, or minor inconsistency

## Rules

- Be specific. "This function is too long" is useless. "This function handles parsing, validation, and persistence — split into three" is useful.
- Don't nitpick formatting if a formatter/linter is configured — focus on logic and design.
- Don't suggest adding tests — focus on making code testable. The user will decide when to write tests.
- Respect the existing tech stack. Don't suggest rewrites in different languages/frameworks.
- In broad mode, prioritize breadth over depth. In deep mode, prioritize thoroughness.
- If you've seen a prior broad audit in this conversation, reference those findings and go deeper — don't repeat the surface-level observations.
- If the codebase is small, say so and keep the audit proportional.

## Iterative Usage

Typical progression:
1. `@code-audit` — broad sweep, identify hotspots
2. `@code-audit deep abstractions` — deep dive into worst dimension
3. `@code-audit deep testability src/agents/` — targeted deep dive on specific code
4. Repeat until satisfied
