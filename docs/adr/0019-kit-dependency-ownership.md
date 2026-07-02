---
title: "ADR 0019: Kit Dependency Ownership"
---

# ADR 0019: Kit Dependency Ownership

**Date:** 2026-07-01  
**Status:** Accepted

---

## Context

ADR 0007 ("Flow / Skill / Kit / Tool Boundary") left one question explicitly open under **Cross-Kit Skill Sharing: DEFERRED**: can a skill be shared across kits, and if so, how is that dependency declared and enforced? The motivating case is concrete and already live in this repository — the Builder Kit's `learning-review` skill invokes the Knowledge Kit's `knowledge-capture` skill (`kits/knowledge/skills/knowledge-capture/SKILL.md`) for durable knowledge storage. Today that cross-kit call is undeclared: nothing validates that Knowledge is present when Builder is installed or activated, so the dependency fails silently at agent-invocation time rather than loudly at install/activate time.

ADR 0007 named the leading candidate: *"an npm-dependency model: Kit B declares a peer dependency on Kit A and invokes Kit A's skills as a consumer, without absorbing them into Kit B's skill list."* It deferred adoption "until a concrete cross-kit case requires it." That case is now required, so this ADR resolves the deferral.

The open design question is **ownership**: does a cross-kit `dependencies` field belong in the Flow-owned container schema (`@kontourai/flow`'s `flow-kit-container.schema.json`), or in the Flow Agents extension layer?

---

## Decision

**Kit `dependencies` lives entirely in the Flow Agents extension layer. No `@kontourai/flow` schema or code change is required or planned.**

The `dependencies` field is a `kit.json` array of `{ kit_id, reason? }` entries validated and enforced exclusively by Flow Agents code:

- **Shape** (`src/flow-kit/validate.ts` `parseKitDependencies`, wired into `validateKitRepository`): each entry must be an object with a kebab-case `kit_id` (`^[a-z][a-z0-9-]*$`), no self-reference, and no duplicate `kit_id`. `reason` is an optional string. Shape errors are hard errors at `flow-agents kit install` / `inspect` / `validate` time.
- **Install-time presence** (`src/cli/kit.ts`): a non-blocking warning is printed when a declared dependency is absent from the destination's **local** registry. This check is deliberately scoped to the local registry only (not the built-in catalog) — an accepted v1 limitation, documented, not hidden.
- **Activation-time presence** (`src/runtime-adapters.ts`): a **hard error** (non-zero exit) when a declared `kit_id` is absent from the union of built-in catalog kits and locally-installed kits at activation time.

### Grounding: why the extension layer, not Flow

Three independent lines of evidence put `dependencies` on the Flow Agents side of the boundary:

1. **The container schema already permits it, agent-blind.** `@kontourai/flow`'s `flow-kit-container.schema.json` declares `"additionalProperties": true` and states that *"Consumer products (such as Flow Agents) may define additional asset-class fields as extensions; unknown top-level fields are consumer extensions and core validation ignores-but-permits them."* A `dependencies` array is schema-legal in Flow today with zero Flow-side change. Flow's `validateKitContainer` only enforces `schema_version` / `id` / `name` / `flows`; it never touches unknown top-level fields.

2. **ADR 0008's Dividing Test lands it on Flow Agents.** ADR 0008 asks: *"Does the operation need to INTERPRET the agent extension (what a skill or adapter MEANS), or only the container ... Container-only → Flow. Extension-interpreting → Flow Agents."* A kit-to-kit dependency exists **only** because one kit's *skill* invokes another kit's *skill* — that is interpreting what a skill means, squarely on the Flow Agents side of the line. Flow's gate / FlowDefinition engine has no concept of "kit A needs kit B" and needs none to evaluate gates.

3. **There is an existing precedent for exactly this pattern.** `src/flow-kit/validate.ts` already derives K0/K1/K2 conformance and consumer targets purely from Flow Agents-owned code reading the same `kit.json` that Flow validates agent-blind. `dependencies` follows the identical pattern: a new Flow Agents-recognized (not Flow-recognized) metadata field, added to a `KNOWN_METADATA_FIELDS` allowlist so it is never misreported as an unknown third-party extension namespace.

### First declared dependency

`kits/builder/kit.json` declares `dependencies: [{ "kit_id": "knowledge", "reason": "learning-review invokes knowledge-capture ... for durable knowledge storage" }]`, making the previously-implicit Builder→Knowledge relationship explicit and enforceable.

---

## Consequences

- **Single-repo change.** Because no cross-repo change is needed, there is no cross-repo prerequisite: everything lands in one `flow-agents` change. The Flow container contract is untouched.
- **Install stays non-blocking; activation is the hard gate.** Keeping install-time checks advisory avoids breaking a consumer repo that has forked/customized `kits/catalog.json`; activation-time enforcement is where a genuinely-missing dependency fails loudly. This split is itself documented in `docs/kit-authoring-guide.md`.
- **`dependencies` is metadata, not a K-level input.** It is presence/metadata, not evaluable-gate content, so it does NOT participate in K0/K1/K2 conformance scoring.
- **Not a package manager.** `dependencies` declares and validates presence; it does not fetch, resolve version ranges, or order installs. Version-range resolution and transitive-dependency graphs remain out of scope (a possible future extension, still extension-layer-owned by this decision).

---

## References

- [ADR 0007: Flow / Skill / Kit / Tool Boundary](./0007-flow-skill-kit-tool-boundary.md) — resolves its "Cross-Kit Skill Sharing: DEFERRED" question by adopting the npm-dependency-style model at the Flow Agents extension layer.
- [ADR 0008: Kit Operation Boundary](./0008-kit-operation-boundary.md) — the "Dividing Test" that locates extension-interpreting operations in Flow Agents.
- `@kontourai/flow`'s `flow-kit-container.schema.json` (`additionalProperties: true`, "ignores-but-permits" consumer extensions) and `validateKitContainer`.
- `src/flow-kit/validate.ts` (`parseKitDependencies`, `KNOWN_METADATA_FIELDS`, `deriveKitTargets`), `src/cli/kit.ts` (install-time warning), `src/runtime-adapters.ts` (activation-time enforcement).
