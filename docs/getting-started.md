---
title: Builder Kit Quick Start
---

# Builder Kit Quick Start

This guide takes you from nothing to a running, gated build flow in about two minutes. By the end you will have Flow Agents installed in your coding agent's workspace and understand how the Builder Kit's two flows — `builder.shape` and `builder.build` — turn a raw idea into a merged change with evidence.

## 1. Install

Run this from any workspace you want to add discipline to:

```bash
npx @kontourai/flow-agents init --runtime <your-agent> --dest .
```

Where `--runtime` is one of `claude-code`, `codex`, `kiro`, `opencode`, or `pi`. For a fully unattended install:

```bash
npx @kontourai/flow-agents init --runtime claude-code --dest . --yes
npx @kontourai/flow-agents init --runtime codex       --dest . --yes
npx @kontourai/flow-agents init --runtime opencode    --dest . --yes
```

The installer copies agents, skills, context contracts, hook scripts, Kit assets, and the Flow Agents telemetry descriptor into the workspace. The Builder Kit installs automatically. Your agent reads those files at startup; no plugin registry required.

For a normal Codex global install, target the Codex home instead of a project workspace:

```bash
npx @kontourai/flow-agents init --runtime codex --global --activate-kits --yes
```

That installs into `CODEX_HOME` when it is set, otherwise `~/.codex`. Use `--dest /path/to/codex-home` only when you need an explicit override for an isolated install, CI fixture, or test.

Keep generated Codex base config lean. Put profile-specific model, provider, and approval settings in separate `<profile>.config.toml` files and select them with `codex --profile <name>`.

**What lands in the workspace:**

- `agents/`, `skills/`, `context/` — skill definitions and shared contracts the agent follows
- `scripts/hooks/` — four canonical policy scripts (steering, quality gate, stop-goal-fit, config protection) wired to the host's native hook surface
- `kits/builder/` — Builder Kit flows and skills
- `console.telemetry.json` — telemetry descriptor (writes locally by default)

At L2 conformance (Claude Code, Codex, Kiro) all four hooks are active and the stop hook blocks early exits that lack evidence. At L1 (opencode, pi) steering and stop-goal-fit run but without blocking capability; see the [Runtime Hook Surface spec](spec/runtime-hook-surface.html) for the gaps.

## 2. What the Builder Kit gives you

The Builder Kit installs two flows:

| Flow | ID | What it does |
|---|---|---|
| Shape | `builder.shape` | Turns a raw idea into slices and executable work items |
| Build | `builder.build` | Takes a ready work item through design probe → plan → execute → verify → PR → merge readiness → learn |

These are not freeform chat sessions. Each flow has **evidence gates** — named checkpoints that expect specific claims before the next step starts. The agent cannot silently skip a gate; it either satisfies the expectation or the transition is blocked (at L2) or flagged (at L1).

**Shape flow gates** (`builder.shape`):

- `shape-gate` — problem, outcome, constraints, non-goals, success criteria, and risk are stated
- `breakdown-gate` — work is split into independently useful slices
- `file-issues-gate` — each slice becomes a filed work item with enough context to pull later

**Build flow gates** (`builder.build`):

- `pull-work-gate` — a ready work item is selected with scope and acceptance context
- `design-probe-gate` — goal fit, blockers, dependencies, and planning readiness are recorded before a plan is written
- `plan-gate` — the plan names files, changes, acceptance evidence, and sequencing
- `execute-gate` — changed files are recorded and unrelated work is excluded
- `verify-gate` — tests or checks have evidence tied to the implementation (up to 3 route-back attempts before blocking)
- `merge-ready-gate` — scope, evidence, and residual risks support a merge-ready decision
- `pr-open-gate` — a pull request exists with linked work and verification evidence
- `merge-ready-ci-gate` — CI and review status support merge
- `learn-gate` — decisions and delivery learnings are recorded for future work

The gate semantics live in [Kontour Flow](https://kontourai.github.io/flow/); Flow Agents compiles them to whatever hook surface your agent exposes.

## 3. A two-minute first run

### Step 1 — Shape an idea

In your coding agent, paste this:

```text
Use Builder Kit shape. I want to add a progress indicator to the CLI output so
users can see what step the installer is on. Keep it simple — just a step count
like "[2/5] Copying agents". Shape this into an executable work item and stop
at the backlog gate.
```

The agent will run the `builder-shape` / `idea-to-backlog` skill, which:

1. inventories the idea and classifies it
2. proposes the thinnest meaningful slice (the step counter) and names what is out of scope
3. drafts a shaped work item with a stated outcome, non-goals, acceptance criteria, and a verification expectation
4. stops at the `breakdown-gate` and waits for you to confirm before creating GitHub issues

You will see the agent write a local artifact at `.kontourai/flow-agents/<slug>/<slug>--idea-to-backlog.md`. That artifact is the machine-readable input to the next stage — not a summary in the chat window.

To continue and file the GitHub issue:

```text
That looks right. File the GitHub issue and stop.
```

The agent runs the `file-issues` step, checks the `file-issues-gate`, and stops. You now have a shaped, filed work item that the build flow can pull.

### Step 2 — Build that work item

```text
Use deliver for the issue you just filed. Pull it, probe the design, plan it,
implement it, review it, verify it, and stop if any evidence is missing.
```

The `deliver` skill orchestrates the full `builder.build` flow:

1. **pull-work** — selects the issue, confirms scope and acceptance criteria (`pull-work-gate`)
2. **design-probe** — checks goal fit, identifies blockers and dependencies, and records planning readiness before touching a file (`design-probe-gate`)
3. **plan-work** — delegates to `tool-planner`, which writes a structured plan artifact naming files, changes, sequencing, and acceptance evidence (`plan-gate`)
4. **execute-plan** — fans out to up to four `tool-worker` subagents in parallel waves (`execute-gate`)
5. **review-work** — code and optional security review (`critique.json` sidecar)
6. **verify-work** — tests and checks with evidence tied to the change; if evidence is missing the verify-gate triggers a route-back (`verify-gate`)
7. **release-readiness** — scope, evidence, and risk assessment (`merge-ready-gate`)
8. **pull-request** — PR with linked work item and verification evidence (`pr-open-gate`)

You can also invoke each skill individually if you want explicit control:

```text
Use pull-work to select issue #42.
```

```text
Use plan-work on the session artifact from the pull-work step.
```

```text
Use verify-work on the current branch and report what evidence is present.
```

### What you observe

- **Between each step**, the agent writes a local session sidecar under `.kontourai/flow-agents/<slug>/` — `state.json`, `acceptance.json`, `evidence.json`, and `handoff.json`. These survive compaction, tab close, or a new session. A future session resumes from recorded state.
- **At each gate**, the agent either presents the evidence and moves forward, or blocks and explains what is missing. It does not make up a confident summary and proceed.
- **The stop-goal-fit hook** (at L2) prevents the agent from stopping when evidence is still incomplete — you see a warning or block rather than "all done!" on partial work.
- **If verify fails**, the verify-gate routes back to execution (or plan, or design-probe, depending on the failure class) and tries again — up to three times before hard-blocking.

This is guided, not fully automated. The agent handles the mechanics; you make product decisions. Gates are explicit handoff points, not invisible checkboxes.

## 4. Inspect what you installed

After installing, you can inspect the Builder Kit's declared contents:

```bash
node build/src/cli.js kit inspect kits/builder
```

(Or, from a global install: `flow-agents kit inspect kits/builder`)

This prints the kit id, name, declared flows, skills, and conformance level (K0/K1). It does not require a running agent or active session.

To see the raw flow definitions with their gate expectations:

```bash
cat kits/builder/flows/shape.flow.json
cat kits/builder/flows/build.flow.json
```

## 5. Verify your setup

After installing, run the source validation to confirm the workspace is coherent:

```bash
npm run validate:source
```

For a full static eval pass (docs layout, legacy-term checks, bundle assertions):

```bash
npm run eval:static
```

## What to read next

- [Workflow Usage Guide](workflow-usage-guide.html) — example prompts and expected behavior for every skill and stage
- [Agent System Guidebook](agent-system-guidebook.html) — how the pieces fit together conceptually
- [Kit Authoring Guide](kit-authoring-guide.html) — author your own Flow Kit from scratch
- [Runtime Hook Surface spec](spec/runtime-hook-surface.html) — hook events, conformance levels, and host gaps
- [Workflow Artifact Lifecycle](workflow-artifact-lifecycle.html) — when to promote local artifacts to durable docs
