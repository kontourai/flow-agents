---
status: current
subject: Published package contents and host memory entries
decided: 2026-11-06
evidence:
  - kind: issue
    ref: https://github.com/kontourai/flow-agents/issues/1616
  - kind: issue
    ref: https://github.com/kontourai/flow-agents/issues/1611
  - kind: issue
    ref: https://github.com/kontourai/flow-agents/issues/1618
  - kind: doc
    ref: docs/developer-architecture.md
  - kind: doc
    ref: src/cli/bundle-pack.test.mjs
  - kind: doc
    ref: src/cli/memory-host-subpaths.test.mjs
---

# Published package contents and host memory entries

Version 9.12.0 was 179 MB unpacked, about 95% of it six per-harness `dist/` trees that share most of their bytes and
that a host importing the package never reads. This record covers how the install bundles now travel and which memory
modules a host may import.

## Decision

- **The bundles travel as one pack.** `prepack` writes `bundles/flow-agents-bundles.pack`: each distinct file once, a
  manifest of path, mode and SHA-256, and one Brotli stream. Root `dist/`, `src/` and `evals/` are not published; bundle copies remain in the pack. The source
  checkout still builds `dist/` with `npm run build:bundles`, and a built `dist/` always wins over the pack.
- **Consumers expand, they never build.** `init`, `kit`, `workflow doctor` and `uninstall` use
  `src/lib/bundle-store.ts`; the Codex installer expands the same pack directly. A published package yields the harness into a private temporary directory
  removed when the command ends. Every blob is checked before the first file is written; a damaged pack is refused with the
  missing-bundle diagnostic, and nothing is compiled or downloaded. The installed package directory is never written to.
- **Rejected: generating the bundles at install time.** The documented rule is that a consumer's global install never
  compiles. The builder is not aware of hoisted dependency layouts, and the bundles embed the acceptance evals, so a
  consumer-side build would need most of what the slimming removes.
- **Rejected: a separate bundles package.** It would add a second publish, a new bootstrap and a version-skew failure for
  every install, to save bytes a single pack already saves.
- **Host memory entries are the kit's own modules.** `memory-envelope`, `memory-marker`, `memory-brief` and
  `memory-recall` are subpath exports that point at the canonical kit files, with hand-written declarations that a test
  pins to the runtime export names. They are not copies, so there is one codec, one marker, one brief compiler and one
  recall. `memory-recall` is a thin entry over the existing recall pieces; it decides nothing about who may read what.
  Authority and identity checks stay with the host that calls it.
- **Entity proposals have a wire shape here; detection is a later change.** `memory-entity-envelope` defines category
  `memory.entity-proposal` and the body `{ version, proposal }`, where `proposal` is Survey's `EntityProposal` verbatim
  and is accepted only when `createEntityProposal(proposal.spec)` gives the same canonical JSON. It is a sibling module, not
  part of `memory-envelope`. The create key derives from the
  proposal id. Alternatives, evidence per alternative and excerpt size are bounded and refused at max + 1. The module
  detects nothing and applies nothing: no identity mapping is applied from an accepted outcome (no published function does
  that), and review stays human-only. The `dream` step that proposes candidates is tracked in flow-agents#1618 and ships
  as its own change after this one merges.
- **One Surface package.** The `@kontourai/surface-knowledge` alias (flow-agents#1581) was removed when the shared
  trust gates moved to Surface 6.3.0; the package now carries a single `@kontourai/surface` pin.
