# ADR 0006: TypeScript-First Source Policy

Date: 2026-05-31

## Status

Accepted

## Context

Kontour repositories increasingly share source, contracts, adapters, workflow tooling, and evidence paths. Flow Agents currently includes JavaScript hook/runtime helpers and Python tooling; Flow and Veritas have JavaScript or MJS runtime surfaces; Surface is already TypeScript-first; and `kontourai.io` is an Astro site with TypeScript-enabled tooling plus JavaScript and MJS site/config files.

Without a cross-repo policy, new work can accidentally deepen language fragmentation or turn every existing JavaScript, MJS, or Python file into an implicit permanent exception. The policy needs to set direction without bundling source migration, CI rewrites, or sibling repository edits into this ADR.

The refreshed local inventory below was collected on 2026-05-31 from sibling checkouts under `~/code/kontourai/`. It is a branch-local snapshot, not a claim about all remote branches.

Inventory command:

```bash
rg --files -g '!node_modules' -g '!dist' -g '!_site' -g '!coverage' -g '!evals/results' |
  rg '\.(ts|tsx|js|jsx|mjs|cjs|py|d\.ts)$'
```

| Repo | Local branch/status caveat | Snapshot summary | Validation/typecheck surface observed | Follow-up |
| --- | --- | --- | --- | --- |
| `flow` | `flow-definition-transition-guard-impl...origin/flow-definition-transition-guard-impl`; untracked local runtime artifacts | 0 TS/TSX, 2 JS, 1 MJS, 0 Python. Small JS/MJS runtime and schema-check surface. | `check:schemas` and `test`; no TypeScript typecheck yet. | Track migration in [Flow #20](https://github.com/kontourai/flow/issues/20). |
| `flow-agents` | `main...origin/main` | 0 TS/TSX, 34 JS, 34 Python. Mixed hooks, eval helpers, runtime scripts, docs asset JS, and Python tooling. | Static/eval scripts exist outside `package.json`; no TypeScript typecheck yet. | Track TypeScript migration planning in [Flow Agents #65](https://github.com/kontourai/flow-agents/issues/65) and Python removal policy/migration in [Flow Agents #67](https://github.com/kontourai/flow-agents/issues/67). |
| `surface` | `main...origin/main` | 52 TS files, 0 JS, 2 MJS, 0 Python. Product and test source are TypeScript-first; MJS is limited to build/bin scripts. | `typecheck`, `build`, `test`, and `verify` scripts are present. | No new migration issue needed; refreshed inventory supports Surface as already TypeScript-first. |
| `veritas` | `main...origin/main [ahead 4, behind 4]` | 0 TS/TSX, 1 `.d.ts`, 80 MJS, 0 Python. MJS product/runtime surface with a typed plugin interface declaration. | `verify`, `test`, coverage, vocabulary, redaction, and Veritas readiness scripts; no TypeScript typecheck yet. | Track staged migration in [Veritas #21](https://github.com/kontourai/veritas/issues/21). |
| `kontourai.io` | `codex/survey-extraction-readiness-audit...origin/codex/survey-extraction-readiness-audit`; untracked local runtime artifacts | 0 TS/TSX, 1 `.d.ts`, 1 JS, 4 MJS, 0 Python. Astro/TypeScript-enabled site with environment typing, JS worker asset, MJS config/scripts/tests. | `build`, `validate`, and rendered-site test scripts are present; Astro build provides the TypeScript-enabled site validation path. | No new issue currently needed; remaining JS/MJS files fit accepted site/config/test/asset exceptions unless future product source expands in JS. |

The existing follow-up issues were checked with GitHub CLI on 2026-05-31 and were open:

- [Flow #20: Migrate Flow source toward TypeScript](https://github.com/kontourai/flow/issues/20)
- [Flow Agents #65: Plan Flow Agents TypeScript migration for runtime and hook code](https://github.com/kontourai/flow-agents/issues/65)
- [Flow Agents #67: Remove Python from Flow Agents source, tooling, and docs](https://github.com/kontourai/flow-agents/issues/67)
- [Veritas #21: Plan staged TypeScript migration for Veritas source](https://github.com/kontourai/veritas/issues/21)

## Decision

Kontour product and runtime source should be TypeScript-first across Flow, Flow Agents, Surface, Veritas, and `kontourai.io`.

New durable product code, runtime adapters, package APIs, CLI behavior, workflow orchestration, hooks, provider bridges, and shared contracts should be authored in TypeScript by default when they live in repositories that are TypeScript-enabled or are being migrated toward TypeScript. Existing JavaScript, MJS, and Python source is not grandfathered as permanent direction; repositories with nontrivial runtime source outside TypeScript should track staged migration through repo-specific issues.

This ADR does not require immediate source migration, package manifest changes, `tsconfig` changes, build script changes, or CI workflow edits. It defines the policy direction and the boundary for accepted exceptions.

### CI And Validation Expectations

TypeScript-enabled repositories should expose a typecheck or build validation that proves the authored TypeScript surface compiles. CI should run that validation before code is treated as releasable.

Repositories that are not yet TypeScript-enabled should first link a migration plan or issue before requiring a TypeScript typecheck in CI. During migration, existing test, schema, static, or verify commands remain valid evidence, but new TypeScript source should include an appropriate typecheck/build path before it becomes the normal implementation surface.

For `kontourai.io`, Astro build and site validation are the current TypeScript-enabled validation path. A separate migration issue is not needed for the current snapshot because the remaining JS/MJS files are config, script, test, or generated/site asset surfaces rather than a broad non-TypeScript product source layer.

### Allowed JavaScript And MJS Exceptions

JavaScript, MJS, CJS, or plain JS assets are acceptable when they are deliberately limited to one of these categories:

- package and tool configuration where the tool expects JavaScript or MJS, such as Astro, Playwright, build-page scripts, or package bin launchers
- generated docs or site assets, including browser-delivered files where TypeScript compilation would add no useful ownership boundary
- shell-adjacent launchers or thin entrypoints where portability, startup behavior, shebang support, or package-manager conventions materially matter
- fixtures, examples, and tests where local repository convention already uses JS/MJS and the files are not the primary product implementation surface
- historical archived, vendored, or generated artifacts that are not edited as active source

Exceptions should stay narrow. A file matching an exception category can remain JS/MJS, but expanding product/runtime behavior in JS/MJS should be treated as a deliberate exception or routed into the repository's TypeScript migration plan.

## Consequences

Positive:

- New cross-repo implementation work has a clear default language.
- Surface remains the reference TypeScript-first repository instead of being blocked by other repositories' migrations.
- Flow, Flow Agents, and Veritas can migrate deliberately through linked issues rather than ad hoc rewrites.
- CI expectations are explicit without forcing build-system changes into this policy slice.

Trade-offs:

- The policy depends on branch-local inventory snapshots and must be refreshed when migration work materially changes a repository.
- Existing JavaScript, MJS, and Python files still require staged migration decisions; this ADR does not remove them.
- Exception categories need discipline so config/tooling allowances do not become a broad runtime-source escape hatch.

## Alternatives Considered

### Allow Each Repository To Choose Independently

Rejected because shared contracts, adapters, and workflow tooling already cross repository boundaries. Independent language policy would preserve avoidable friction for maintainers and agents.

### Require Immediate TypeScript Migration Everywhere

Rejected because Flow, Flow Agents, and Veritas need staged migration plans, validation paths, and reviewable changes. This ADR sets direction and links follow-up issues without bundling broad source rewrites into a docs policy change.

### Ban All JavaScript And MJS

Rejected because package configuration, tool scripts, site assets, thin launchers, fixtures, and generated or historical artifacts often have practical reasons to remain JS/MJS. The policy narrows those exceptions instead of pretending they do not exist.
