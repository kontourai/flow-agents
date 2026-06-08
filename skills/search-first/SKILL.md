---
name: search-first
description: "Research-before-coding workflow. Search for existing tools, libraries, and patterns before writing custom code."
---

# Search-First

Research before building. Every implementation task starts here.

## Workflow

### 1. Need Analysis
Define clearly before searching:
- What functionality is needed (inputs, outputs, behavior)
- Language and framework constraints
- Performance, size, or license requirements

### 2. Parallel Search
Search all sources simultaneously:
- **Codebase** — grep/code search for existing implementations or utilities
- **Package registries** — npm (`npmjs.com`), PyPI (`pypi.org`), crates.io, Go modules
- **GitHub** — code search for patterns, reference implementations
- **Web** — blog posts, Stack Overflow, official docs for recommended approaches

### 3. Evaluate Candidates

Score each candidate (1-5) on:

| Criterion | Weight | What to check |
|-----------|--------|---------------|
| Functionality | High | Does it solve the actual need? |
| Maintenance | High | Last release, open issues, bus factor |
| Community | Medium | Downloads, stars, dependents |
| Documentation | Medium | API docs, examples, migration guides |
| License | High | Compatible with project? (MIT/Apache preferred) |
| Dependencies | Medium | Transitive dep count, known vulnerabilities |

### 4. Decide

- **Adopt** — exact match, well-maintained, good community → install and use directly
- **Extend** — partial match, solid core → wrap with thin adapter layer
- **Build** — nothing suitable, unique requirements → write minimal custom code

### 5. Implement
- Adopt: install package, write integration code
- Extend: install package, write wrapper/adapter
- Build: write minimal custom implementation, document why existing solutions were rejected

## Search Shortcuts

| Category | First check |
|----------|-------------|
| HTTP client | axios (JS), httpx (Python), net/http (Go) |
| Validation | Zod (TS), Pydantic (Python), validator (Go) |
| CLI parsing | commander/yargs (JS), click/typer (Python), cobra (Go) |
| Testing | Jest/Vitest (TS), pytest (Python), testing (Go) |
| Date/time | date-fns (JS), pendulum (Python), time (Go) |
| Logging | pino/winston (JS), structlog (Python), slog (Go) |

## Anti-Patterns

- **Jumping to code** — writing custom implementations without searching first
- **Ignoring existing solutions** — the codebase already has a utility for this
- **Over-customizing** — wrapping a library so heavily it's harder than building from scratch
- **Dependency bloat** — adding a 50KB package for one function (just copy the function)
- **Stale picks** — choosing unmaintained packages because they were popular 3 years ago
