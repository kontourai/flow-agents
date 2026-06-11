---
title: Harness Install
---

# Harness Install

This page walks through three harness installs: Claude Code (the L2 reference runtime), opencode, and pi. All three follow the same model — `npm run build:bundles` generates the bundle, `flow-agents init` places it — but each runtime expects different files at different paths.

## How harness bundles work

`npm run build:bundles` generates one bundle per runtime under `dist/<runtime>/`. Each bundle contains:

- A host-specific configuration file that maps lifecycle events to shell commands invoking the canonical hook adapter wrapper.
- A host-specific adapter wrapper (`<runtime>-hook-adapter.js`) that reads stdin JSON from the host, invokes `run-hook.js` with the canonical script path and profile, translates the exit code to the host-native response format, and fails open on errors.
- A host-specific telemetry wrapper (`<runtime>-telemetry-hook.js`) that maps host event names to canonical telemetry event names and invokes `scripts/telemetry/telemetry.sh`.
- An `install.sh` that places the generated files at the host-expected paths.

`flow-agents init` (from `npx @kontourai/flow-agents`) calls `install.sh` for the selected runtime.

## Claude Code

Claude Code is the L2 reference implementation. All four policy classes are wired: workflow steering, quality gate, stop-goal-fit, and config protection.

### Install

```bash
npx @kontourai/flow-agents init --runtime claude-code --dest /path/to/workspace --yes
```

The install script writes hook wiring into `.claude/settings.json` inside the destination workspace. The hooks object in `settings.json` maps Claude Code lifecycle events (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`) to shell commands invoking the adapter:

```bash
bash -lc 'root="${FLOW_AGENTS_CLAUDE_CODE_ROOT:-$(pwd)}"; \
  node "$root/scripts/hooks/claude-telemetry-hook.js" UserPromptSubmit dev'
bash -lc 'root="${FLOW_AGENTS_CLAUDE_CODE_ROOT:-$(pwd)}"; \
  node "$root/scripts/hooks/claude-hook-adapter.js" UserPromptSubmit \
    workflow-steering workflow-steering.js default'
```

Telemetry always fires first and is always non-blocking (timeout: 10 s). Policy hooks fire second and may block on `PreToolUse` (timeout: 30 s). Both fail open on hook runtime errors.

### Dogfood variant (repo-local)

Inside the `flow-agents` source repo itself, the dogfood script writes hook wiring that points at the local `scripts/hooks/` directory rather than a published package:

```bash
npm run dogfood -- --runtime claude-code
```

The destination defaults to the repo root. Pass `--dest` to override.

### Scope-collision warning

When `init` detects that an existing `.claude/settings.json` already has hooks entries for the same lifecycle events, it emits a scope-collision warning to stderr:

```
[flow-agents] WARNING: .claude/settings.json already has hooks for UserPromptSubmit.
Existing entries will be preserved; Flow Agents hooks will be appended.
Review .claude/settings.json to confirm hook ordering is correct.
```

The install appends rather than replaces, so existing hooks are not removed. Review the settings file after install to confirm the ordering is what you want.

### Resulting file layout

```
<workspace>/
  .claude/
    settings.json          ← hook wiring (appended by install)
  scripts/
    hooks/
      claude-hook-adapter.js
      claude-telemetry-hook.js
      run-hook.js
      config-protection.js
      quality-gate.js
      stop-goal-fit.js
      workflow-steering.js
      …
  skills/
    …
  .flow-agents/            ← runtime workflow artifacts (not committed)
```

## opencode

opencode is an L1 adapter. It has no native `prompt.submit`-equivalent event, so workflow steering is approximated at `session.created` rather than at each user turn. This is a documented gap: see <a href="../spec/runtime-hook-surface.html">the spec, section 2.1</a>.

### Install

```bash
npx @kontourai/flow-agents init --runtime opencode --dest /path/to/workspace --yes
```

### Dogfood variant

```bash
npm run dogfood -- --runtime opencode
```

### Resulting file layout

```
<workspace>/
  .opencode/
    plugins/
      flow-agents.js       ← auto-loaded at opencode startup
    agents/
      dev.md               ← agent prompts (opencode markdown format)
      tool-planner.md
      tool-worker.md
      …
    skills/
      deliver.md
      fix-bug.md
      …
  opencode.json            ← workspace instructions pointer
  scripts/
    hooks/
      opencode-hook-adapter.js
      opencode-telemetry-hook.js
      run-hook.js
      …
  skills/
    …
```

`opencode.json` at the workspace root is a minimal config file:

```json
{
  "instructions": "This workspace uses Flow Agents. See AGENTS.md for conventions, skills, and workflow guidance."
}
```

The plugin at `.opencode/plugins/flow-agents.js` is auto-loaded at opencode startup. It exports `FlowAgentsPlugin` and registers handlers for:

| opencode event | What fires |
| --- | --- |
| `session.created` | Telemetry + workflow steering (session-start context injection) |
| `tool.execute.before` | Telemetry + config-protection (blocking via thrown Error) |
| `tool.execute.after` | Telemetry + quality gate |
| `session.idle` | Telemetry + stop-goal-fit (warning only — not a true stop event) |
| `session.error`, `session.compacted`, `permission.asked`, `file.edited` | Telemetry only |

**Accepted gaps**: opencode has no `prompt.submit` hook, so workflow steering fires only on `session.created` — not at each user turn. `session.idle` is the closest event to a stop hook but does not reliably fire on session completion. These gaps are declared in the conformance level (L1) and in the plugin source comments.

**Agents**: opencode receives agent prompts as markdown files in `.opencode/agents/`. The main orchestrator is `dev.md`; specialist tools (planner, worker, reviewer, etc.) are additional markdown files in the same directory.

## pi

pi is an L1 adapter. It has no stop hook, so stop-goal-fit cannot fire at session end. This is a documented gap: see <a href="../spec/runtime-hook-surface.html">the spec, section 2.3</a>.

### Install

```bash
npx @kontourai/flow-agents init --runtime pi --dest /path/to/workspace --yes
```

### Dogfood variant

```bash
npm run dogfood -- --runtime pi
```

### Resulting file layout

```
<workspace>/
  .pi/
    extensions/
      flow-agents.ts       ← auto-discovered at startup (needs project trust)
    skills/
      deliver.md
      fix-bug.md
      …
  AGENTS.md                ← agent instructions (pi uses AGENTS.md, not a registry)
  scripts/
    hooks/
      pi-hook-adapter.js
      pi-telemetry-hook.js
      run-hook.js
      …
  skills/
    …
```

The extension at `.pi/extensions/flow-agents.ts` is auto-discovered at startup. It registers handlers for:

| pi event | What fires |
| --- | --- |
| `session_start` | Telemetry |
| `before_agent_start` | Telemetry + workflow steering (injects context into system prompt) |
| `tool_call` | Telemetry + config-protection (blocking via `{ block: true }` return) |
| `tool_result` | Telemetry + quality gate |
| `session_shutdown` | Telemetry + stop-goal-fit (warning only — not a true stop event) |

**Accepted gaps**: pi has no stop hook. `session_shutdown` is used as the closest equivalent but does not carry the same semantics as a stop event. This gap is declared in the conformance level (L1) and in the extension source comments.

**Agents**: pi has no named-subagent registry. Agent guidance is delivered through `AGENTS.md` at the workspace root, plus the skills in `.pi/skills/` and the extension. The `flow-agents.ts` extension comment says explicitly: "pi has no named-subagent registry. Agents are not exported for pi."

### Scope-collision warning

Same behavior as Claude Code: if an existing `.pi/extensions/` directory contains a file with conflicting event registrations, `init` warns and appends. Review the extension file after install.

## Related references

- `dist/opencode/` — generated opencode bundle (do not edit by hand)
- `dist/pi/` — generated pi bundle (do not edit by hand)
- `dist/claude-code/` — generated Claude Code bundle
- `scripts/hooks/run-hook.js` — canonical hook runner
- <a href="../spec/runtime-hook-surface.html">Runtime Hook Surface spec</a> — event taxonomy, policy classes, conformance levels
- <a href="conformance.html">Conformance</a> — how to self-certify a new adapter
