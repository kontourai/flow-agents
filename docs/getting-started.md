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

To configure provider-backed Builder work at the same time, add
`--configure-providers --online`. This detects the repository, verifies GitHub
CLI access, and writes coherent backlog, assignment, and change-provider
settings. For non-interactive offline setup, provide
`--provider-project NUMBER`; remote state remains explicitly unverified until
you run the printed `gh` checks.

The installer copies agents, skills, context contracts, hook scripts, Kit assets, and the Flow Agents telemetry descriptor into the workspace. The Builder Kit installs automatically. Your agent reads those files at startup; no plugin registry required.

For a normal Codex global install, target the Codex home instead of a project workspace:

```bash
npx @kontourai/flow-agents init --runtime codex --global --activate-kits --yes
```

That splits installation by ownership: Codex-only runtime assets go into `CODEX_HOME` when set (otherwise `~/.codex`), while portable skills go into Codex's documented user catalog at `$HOME/.agents/skills`. A repository bundle install similarly exposes skills at `<repo>/.agents/skills`.

For OpenCode, a global install targets `${XDG_CONFIG_HOME:-$HOME/.config}/opencode` and keeps the candidate workspace clean:

```bash
npx @kontourai/flow-agents init --runtime opencode --global --activate-kit builder --yes
```

The installer additively merges `opencode.json`, syncs the Flow Agents plugin and agents, and exposes core skills plus the selected kits and their transitive dependencies. Runtime support and a SHA-256 managed-file manifest live under `.flow-agents/`; unrelated user plugins, agents, skills, and config entries remain user-owned. The manifest includes a secret-free Conduit receipt (asset IDs, kinds, and digests only) for the plugin, agents, and skills.

GNU Stow layouts are supported when `opencode.json` is a symlink to its canonical regular-file target and an immediately nested managed asset directory (`plugins`, `agents`, or `skills`) is a symlink contained by that config target's backing directory. The backing directory must be owned by the current user and must not be group- or world-writable. The installer atomically updates the config target without replacing either link, preserves an existing config file's mode, and creates a new config with mode `0600`. It rejects nested links, file links, unbound directories, and targets outside that backing directory. These path-based checks protect owner-controlled Stow state and fail closed on the state observed before each mutation; they are not an `openat`-style security boundary against a concurrent process that can rewrite the same directories. To migrate from an older incomplete global OpenCode install, upgrade Flow Agents and re-run this command. There is no compatibility path for stamp-only experimental installs.

Pass a positional runtime destination and `--skills-dir PATH` when both roots must be isolated, or set `FLOW_AGENTS_SKILLS_DIR` for headless environments:

```bash
bash scripts/install-codex-home.sh /tmp/codex-home --skills-dir /tmp/agents/skills
```

Installer output reports both destinations. Reinstall preserves unknown user skills and migrates only unchanged Flow Agents-owned files from the former `CODEX_HOME/skills` layout; modified legacy content is retained. Flow Agents intentionally does not create a compatibility symlink because the Codex runtime home must not own or mask a universal user catalog, and the installer refuses to write through symlinked destinations.

Keep generated Codex base config lean. Put profile-specific model, provider, and approval settings in separate `<profile>.config.toml` files and select them with `codex --profile <name>`.

**What lands in the workspace:**

- `context/` — shared contracts the agent follows, at the workspace root regardless of runtime
- Agent and skill definitions, in a runtime-specific location: `.claude/agents/` + `.claude/skills/` for Claude Code, `.codex/agents/` + `.agents/skills/` for Codex, top-level `agents/` + `skills/` for Kiro, `.opencode/agents/` + `.opencode/skills/` for opencode, and `.pi/skills/` for pi
- `scripts/hooks/` — four canonical policy scripts (steering, quality gate, stop-goal-fit, config protection) wired to the host's native hook surface
- `kits/builder/` — Builder Kit flows and skills
- `console.telemetry.json` — telemetry descriptor (writes locally by default)

### Completion checks by runtime

Installing hook files does not prove that a running agent loaded or executed them. Start a new session with the installed configuration and complete any host-required hook trust setup. Conformance levels describe supported policy behavior; they do not determine the installed enforcement mode.

| Runtime | Shipped completion check | Configuration and limits |
|---|---|---|
| Claude Code | `Stop` hook with `FLOW_AGENTS_GOAL_FIT_MODE=block` as its default | Can block completion on qualifying evidence gaps once the host loads the hooks. |
| Codex | `Stop` hook with the same `block` default | Requires the host to load and trust the installed hooks; files in a destination alone do not establish live enforcement. |
| Kiro | `stop` hook on the shipped `dev` agent, enabled in the `standard` and `strict` hook profiles | Does not inject a blocking mode default. With no committed policy or environment override, the engine uses `warn`. Set `FLOW_AGENTS_GOAL_FIT_MODE=block` in the agent's environment to request blocking; selecting `strict` alone does not set that mode. |
| opencode | Calls stop-goal-fit at `session.idle` | Advisory for completion: the generated plugin does not act on the returned stop decision. Setting `block` does not make this callback prevent completion. |
| pi | No native Stop trigger; calls stop-goal-fit at `session_shutdown` | The shutdown callback does not act on the returned decision and cannot serve as a blocking completion check. |

`FLOW_AGENTS_GOAL_FIT_MODE` accepts `block`, `warn`, or `off`. In development, an explicit value overrides the Claude Code/Codex default. With `NODE_ENV=production` or `prod`, environment overrides cannot weaken committed goal-fit policy in `.flow-agents/config/core.config.json`. Hook profile and disable settings also affect whether a check runs.

Even in blocking mode, stop-goal-fit checks recorded workflow state and evidence; it is not a guarantee that every incomplete task is caught. Bounded retry and escalation behavior can end a turn with unresolved gaps. See the [Runtime Hook Surface spec](spec/runtime-hook-surface.md#23-stop-goal-fit) for policy resolution and limits. Repository-required CI checks remain a separate boundary.

## 2. What the Builder Kit gives you

The Builder Kit installs two flows:

| Flow | ID | What it does |
|---|---|---|
| Shape | `builder.shape` | Turns a raw idea into slices and executable work items |
| Build | `builder.build` | Takes a ready work item through design probe → plan → execute → verify → PR → merge readiness → learn |

These are not freeform chat sessions. Each flow has **evidence gates** — named checkpoints that expect specific claims before the next step starts. Flow evaluates those expectations when a transition is requested. Whether the host can also prevent the agent from ending its turn depends on the completion-check wiring and configuration above.

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
9. **learning and workspace closeout** — route durable follow-up, retain open
   changes for review, and reclaim only clean linked worktrees whose exact head
   is freshly confirmed merged

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
- **The stop-goal-fit hook**, when loaded and configured to block on a host that supports it, can refuse completion for qualifying evidence gaps. Check the runtime table above; warning-only and shutdown callbacks do not provide the same completion control.
- **If verify fails**, the verify-gate routes back to execution (or plan, or design-probe, depending on the failure class) and tries again — up to three times before hard-blocking.

This is guided, not fully automated. The agent handles the mechanics; you make product decisions. Gates are explicit handoff points, not invisible checkboxes.

## 4. Inspect what you installed

After installing, you can inspect the Builder Kit's declared contents:

```bash
node build/src/cli.js kit inspect kits/builder
```

(Or, from a global install: `flow-agents kit inspect kits/builder`)

This prints a JSON object with the kit id, name, conformance levels (`k0`/`k1`/`k2`), declared targets, and any third-party extensions — for example:

```json
{
  "kit_id": "builder",
  "kit_name": "Builder Kit",
  "conformance": { "k0": true, "k1": true, "k2": false },
  "targets": ["flow", "flow-agents"],
  "third_party_extensions": [],
  "trust": "unverified"
}
```

It does not require a running agent or active session.

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

- [Workflow Usage Guide](workflow-usage-guide.md) — example prompts and expected behavior for every skill and stage
- [Agent System Guidebook](agent-system-guidebook.md) — how the pieces fit together conceptually
- [Kit Authoring Guide](kit-authoring-guide.md) — author your own Flow Kit from scratch
- [Runtime Hook Surface spec](spec/runtime-hook-surface.md) — hook events, conformance levels, and host gaps
- [Workflow Artifact Lifecycle](workflow-artifact-lifecycle.md) — when to promote local artifacts to durable docs
