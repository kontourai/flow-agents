---
status: current
subject: Model routing
decided: 2026-07-03
evidence:
  - kind: issue
    ref: https://github.com/kontourai/flow-agents/issues/364
  - kind: url
    ref: https://claude.ai/code/session_01CEPxsn2GuWdysEMACRHsFQ
---

# Model routing

Which model backs which delegate role is **data resolved by the orchestrator
at delegation time**, not code baked into generated files or per-agent
frontmatter.

## Decision

- Model-routing policy is committed data in `.datum/config.json` (read by the
  `@kontourai/datum` registry, `datum.schema.json`): a `providers` map
  (`anthropic`, `zai`) and a `roles` map keyed by delegate role name
  (`delegate-mechanical`, `delegate-implementation`, `delegate-design`,
  `orchestrator`, `extraction-default`) to a `model@provider` ref.
- **The orchestrator resolves the role via datum at delegation time** —
  `datum resolve <role> --json` or the library `resolve()` — and passes the
  resolved model **explicitly** when spawning each delegate. The consumption
  instruction lives in `context/contracts/execution-contract.md` § Delegation:
  Model Routing (where orchestrators actually read it), with a matching
  summary table in `kits/builder/skills/deliver/SKILL.md` § Model Routing.
  `.datum/config.json` is the single source of truth for the mapping; the
  contracts/skills only say where to read it.
- No generated files and no per-agent frontmatter changes. Roles are the
  stable reference; which model a role resolves to can change without
  touching any delegation call site, skill, or agent definition.
- When datum or the config is absent, delegation falls back to the runtime's
  inherited model and the fallback is noted in the session/task artifact
  rather than blocking delegation.

## Rejected alternatives

- **Generated per-agent frontmatter** (a build step stamping a model into
  each agent definition file) — rejected because it reintroduces a generated
  artifact that drifts from the data it was generated from and requires a
  regeneration step on every routing-policy change, which this program has
  standing directives against (no generated files as the routing surface).
- **Environment-variable-only selection** (e.g. one global
  `ANTHROPIC_MODEL`-style override with no role granularity) — rejected
  because it collapses distinct delegate shapes (mechanical vs.
  precisely-planned implementation vs. design-latitude vs. orchestrator) onto
  a single model choice, losing the per-role routing this design exists to
  express, and because it is not resolvable per-delegate-spawn within a
  single process the way an explicit per-call model override is.

## Rationale

Routing policy changes independently of, and more often than, the skills and
contracts that consume it (new models, new providers, retuned role-to-model
mappings). Keeping it as data in `.datum/config.json` — the same registry
shape datum's `extraction-default` role already uses for the campfit
precedent — means a routing change is a config edit reviewed like any other
data change, not a source/doc change scattered across every delegating
skill.
