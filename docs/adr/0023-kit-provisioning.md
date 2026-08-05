---
title: "ADR 0023: Declarative Kit Provisioning"
---

# ADR 0023: Declarative Kit Provisioning

**Date:** 2026-07-16
**Status:** Accepted (owner-ratified Option A in flow-agents#647)

---

## Context

Kits sometimes need to supply repository-owned configuration or policy files in addition to runtime projections. The motivating `veritas-governance` follow-up needs this capability, but embedding kit-specific copy logic in Flow Agents would violate the kit boundary. Runtime activation is also the wrong mechanism: its projection directory is regenerable adapter state, while these files must become normal files in the consumer repository.

## Decision

A kit may declare a `provisions` list in `kit.json`. Each entry is inert data naming an id, a source file inside the kit, and a consumer-repository-relative target. Provision declarations are never executed.

The Flow Agents engine performs agent-blind file copying through an explicit `kit provision` operation. It validates source and target containment, preflights every destination, and creates files only when no declared destination already exists. An explicit `--force` option may replace declared destination files; the default never silently overwrites an anchor-owned or consumer-owned file. `--dry-run` reports the plan without writing.

`flow-agents init --activate-kit` invokes the same engine after activation with create-only semantics. Existing destinations are reported as skipped warnings so init remains safe to rerun. Provisioning remains separate from runtime activation and its projection directory.

The engine records successful copies under `.kontourai/flow-agents/provisions/<kit-id>.json`. This manifest is bookkeeping and may be replaced on a later successful provisioning operation. Enforcement policy and ownership of protected paths remain anchor-side; a kit declaration does not grant permission to overwrite them.

## Consequences

- Kits can ship repository files without executable installers or kit-specific engine behavior.
- Create-only defaults preserve consumer and anchor ownership; replacement requires an explicit user operation.
- Provisioned files belong to the consumer repository once written. Uninstalling or deactivating a kit never removes or reverts them.
- Runtime adapters continue to activate only their supported projection assets and report provisions as explicitly skipped.
- Consumers that need stronger protected-path policy enforce it at their anchor; the generic engine remains deliberately dumb and kit-neutral.

## Accepted residuals

- **Copy is best-effort against concurrent interposition (both ends).** The checks and the copy
  are separate steps (check-then-act): a file created into a declared destination between the
  conflict preflight and the write can still be overwritten, and a source re-pointed to a link
  between its containment check and its read could resolve elsewhere. Provisioning targets a
  developer/CI working tree, not a hostile multi-writer path, so both TOCTOU windows are accepted
  rather than closed with exclusive-create / open-then-fstat plumbing. The static guarantees are
  enforced up front: reserved-directory (`.git`, the provision manifest namespace), source and
  destination containment (link-resolved), and case-fold collision rejection; concurrent
  interposition on either end is out of scope.
- **Target case-folding assumes the common single-case-family repo.** Collision and reserved-path
  checks case-fold targets so case-insensitive filesystems are safe; a genuinely case-sensitive
  repo that intends two targets differing only in case is rejected as a portability hazard.
