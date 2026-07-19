---
name: "consult-standards"
description: "Get just-in-time Veritas governance guidance for a file or work area before editing it: run `veritas explain --file <path>` (or `--work-area <id>`) to see the governance excerpt, the Repo Standards rules that apply, their do/don't/examples, and the latest recorded surface status — then edit within those rules. Use before changing a governed repo's files, or when you want to know what standards apply to a path. Pull-based guidance; it does not block (the PreToolUse hook is the enforcement gate)."
---

# Consult Standards

Before you edit a file in a Veritas-governed repo, ask Veritas what applies to it. `veritas
explain` projects the repo's governance excerpt + the Repo Standards rules matching that file (or
work area) + their latest surface status into one just-in-time briefing — so you edit *within* the
rules instead of discovering a violation only when the PreToolUse hook blocks the write.

**This skill wraps the `veritas` CLI. It reimplements no rule evaluation** — `veritas explain`
does the matching and projection; the skill only tells you when and how to ask.

## When to use this

- **Before editing** a file in a repo that has a `.veritas/` governance config — especially a
  file under a governed work area, or one you haven't touched before.
- **When you want to know what standards apply** to a path or area without reading every rule in
  `.veritas/repo-standards/` yourself.
- Not a gate: this is **pull-based** guidance you invoke. Enforcement is separate and automatic —
  the Veritas PreToolUse hook (engine-side; installed via the kit's governance hooks) evaluates
  and can *block* a non-conforming write whether or not you consulted first. Consulting first
  means you shape the edit to pass, rather than getting blocked and retrying.

## How to consult

```bash
# For a specific file you're about to change:
veritas explain --file src/path/to/file.ts

# For a whole work area (a Repo Map graph node id):
veritas explain --work-area <work-area-id>

# Or pass a bare selector (auto-classified as a rule id, a file path if it contains '/', or a work-area token):
veritas explain src/path/to/file.ts
```

`veritas explain` prints a **`Veritas JIT Context`** briefing:

- **`Governance:`** — the leading lines of `.veritas/GOVERNANCE.md` (the repo's terse governance rules).
- One block per **matching rule**: `Rule` / `Kind` / `Enforcement Level` (`Require` / `Guide` / …) /
  `Summary` / `Do` / `Do not` / `Good` / `Bad` / `Context`.
- **`Surface status:`** — the latest recorded status for that rule from the evidence artifacts
  (e.g. `verified`), plus any `Surface fault:` transparency-gap lines.

Read the matching rules, honor their `Do`/`Do not`, and keep the change inside the work area's
guidance. `No matching requirement found.` means no additional Repo Standard applies to that path
— proceed normally, it is not an error.

## Source of truth

`veritas explain` is a *projection* of the repo's own governance config. When you want the raw
standards rather than the filtered view, read them directly — they are the source `explain` reads:

- `.veritas/GOVERNANCE.md` — the terse agent-facing governance rules.
- `.veritas/repo-standards/*.json` — the Repo Standards (each rule's `summary` / `mustDo` /
  `mustNotDo` / `exampleGood` / `exampleBad` / `contextLinks`).
- `.veritas/repo-map.json` — the work-area graph `--work-area` selects against.

## Contract

- **Read-only advisory.** This skill runs `veritas explain`, which reads config and evidence and
  writes nothing. It never gates, never blocks, never attaches evidence, and has no pass/fail
  verdict — it surfaces guidance, full stop. Enforcement stays the PreToolUse hook (engine-side).
- **No MCP server.** Just-in-time guidance here is agent-invoked CLI (`veritas explain`), not a
  standing MCP service. Per the flow-agents MCP posture (ADR 0011), MCP never carries the gate and
  enforcement stays hooks; this skill is the deliberate agent-pull replacement for a guidance
  server, not a new server.
- **Wraps the engine; reimplements nothing.** All rule matching, governance projection, and
  surface-status lookup live in `@kontourai/veritas` (`veritas explain` / `src/explain.mjs`). The
  skill adds no evaluation logic.
