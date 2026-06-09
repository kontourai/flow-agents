---
title: Release Notes
---

# Release Notes

## Unreleased

### Repository Cleanup

- Consolidated TypeScript tooling source under `src/tools/` and kept `scripts/` as the public wrapper/runtime surface.
- Documented repository structure, generated-output boundaries, runtime hook boundaries, and safe cleanup rules.
- Removed stale local runtime artifacts and corrected package metadata drift.

### Codex Runtime Hooks

- Reinstalled Codex into an isolated Flow Agents home and fixed generated Codex hook commands to prefer `CODEX_HOME`.
- Documented the stale repo-local `.codex/hooks.json` failure mode that caused Codex `PostToolUse` to reject Claude-only `suppressOutput` output.

### CI And Release Readiness

- Enabled permanent TypeScript unused-code enforcement with `noUnusedLocals` and `noUnusedParameters`.
- Made the Node runtime policy explicit: package metadata requires Node `>=22`, CI runs Node 22, and `@types/node` stays on the Node 22 major line until runtime policy changes.
- SHA-pinned GitHub Actions with version comments, including dereferencing the annotated `actions/checkout@v6.0.3` tag to its commit SHA.
- Split Flow Agents CI into independent source/static, workflow-contract, and runtime/kit lanes with separate evidence artifacts.
- Preserved fail-closed CI evidence finalization: failed, missing, duplicate, or invalid check rows fail the corresponding CI lane.
