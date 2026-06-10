---
title: ADR 0004: Gates Expect Surface Claims
---

# ADR 0004: Gates Expect Surface Claims

Flow-backed kits will model rich gate evidence as claim expectations rather than provider-specific requirements. A gate expectation can require `kind: "surface.claim"`, a Surface claim type such as `repo.policy_compliance`, accepted trust statuses such as `verified`, and whether the expectation blocks the transition; project or runtime config maps claim types to trusted Surface producers and authority traces. This lets the Builder Kit use repo governance, command checks, CI, human decisions, or future producers without naming a specific provider in the Flow Definition.

**Status**: Accepted

**Considered Options**: Provider-aware gate rules were rejected because they would make Flow Definitions know too much about individual tools. Plain evidence strings such as `tests` or `veritas` were rejected because they cannot represent claim type, accepted status, producer authority, transparency gaps, or project-level enforcement overrides cleanly.

**Consequences**: Trusted producer mappings belong upstream in Flow project configuration, not Flow Agents runtime configuration. Flow Agents can help author, install, and adapt that configuration for agent runtimes, but CI, framework agents, local CLIs, and humans should all evaluate gates against the same Flow-owned authority model.

**Initial Shape**: Gate expectations should use `expects` entries with `id`, `kind: "surface.claim"`, `required`, `claim.type`, optional `claim.subject`, `claim.accepted_statuses`, `description`, and optional `explore_hint`. The Builder Kit should use intuitive subject strings such as `flow-run`, `flow-step`, `work-item`, `change`, `pull-request`, `release`, `decision`, and `artifact`, while the schema remains open to other subject values.
