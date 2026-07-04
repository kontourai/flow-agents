---
title: ADR 0002: Flow Kits As The Extension Unit
---

> **FROZEN — immutable history.** Superseding/current decisions live in [`docs/decisions/`](../decisions/index.md). Do not edit.

# ADR 0002: Flow Kits As The Extension Unit

Flow Agents will use **Flow Kit** as the product and implementation term for installable workflow bundles, replacing the older "pack" vocabulary. A Flow Kit may contain Flow Definitions, skills, adapters, provider contracts, docs, and evals; the Kit Catalog lists available kits and installable assets, but the workflow semantics live in kit-owned Flow Definition files. This avoids overloading packaging metadata with process semantics and gives custom workflow authoring a clearer product language.

**Status**: Accepted

**Considered Options**: Keeping "pack" was familiar from the then-current `packaging/` pack-composition layer, but it was too generic and carried plugin-marketplace baggage. Keeping "pack" internally while using "kit" publicly was rejected because the repository is unpublished and a split vocabulary would make the migration harder to understand. (That legacy composition layer was subsequently removed outright; the standalone base always installs and Kits carry depth through the Kit Catalog.)

**Consequences**: Flow Agents will use `kits/catalog.json` as the Kit Catalog. The first real kit will live under `kits/builder/` with its own `kit.json` and Flow Definitions under `kits/builder/flows/`. The Builder Kit must be installable through the same compliance path as future external Flow Kit repositories.
