---
title: Veritas Integration Boundary
---

# Veritas Integration Boundary

Veritas owns both the standalone governance engine and the optional governance Flow Kit
that teaches agents how to set it up and use its results. Flow Agents remains a neutral
kit installer, activator, and gate host.

## Install the external kit

The Veritas repository is a root-installable Flow Kit, so the normal Git installer works
without a repository-specific command:

```bash
flow-agents kit install https://github.com/kontourai/veritas.git#v1.5.1
flow-agents kit activate --adapter codex-local
```

Use a release tag or commit ref when reproducibility matters. Git installation requires
`kit.json` at the repository root; Flow Agents does not execute installation scripts from
remote kits.

## Engine setup

Activating the kit projects its agent guidance and Flow Definitions. It does not silently
install packages or overwrite repository policy. Follow the activated
`setup-governance` skill to:

1. detect an existing `veritas` CLI,
2. ask before installing `@kontourai/veritas`,
3. generate and review a proposed governance plan,
4. apply approved standards and hooks, and
5. bootstrap and run the first readiness check.

The engine remains directly usable without Flow Agents, and installing the kit does not
make Veritas a dependency of Flow Agents.

## Evidence boundary

Veritas emits the canonical gate artifact directly:

```bash
veritas readiness --format trust-bundle > .veritas/readiness/trust.bundle.json
```

The Veritas Governance Kit's readiness flow expects a verified
`software-readiness-verdict` claim for a `repository-change` subject. Flow Agents attaches
the resulting `trust.bundle` to the generic gate and evaluates the Flow Definition; it
does not translate Veritas rule models or maintain a Veritas-specific adapter.

If Veritas was expected but its artifact is absent, unreadable, stale, or rejected, the
workflow must report the actual blocked or not-verified state. It must not invent a pass.

## Ownership

| Concern | Owner |
| --- | --- |
| Repo standards, authority, checks, explanations, and readiness semantics | Veritas engine |
| Governance setup guidance and governance Flow Definitions | Veritas repository kit |
| Git install, activation, generic gate execution, and runtime projection | Flow Agents |
| Portable trust bundle semantics | Hachure / Surface boundary |

Flow Agents must not vendor Veritas source, duplicate its policy schemas, or require it
for unrelated kits. Veritas must not import Flow Agents internals; its root `kit.json`
is a declarative consumer-facing package boundary.

See [Engine and kits](architecture-engine-and-kits.md), the
[Flow Kit repository contract](flow-kit-repository-contract.md), and Veritas's
[Engine / Surface Seam](https://github.com/kontourai/veritas/blob/main/docs/architecture/engine-surface-seam.md).
