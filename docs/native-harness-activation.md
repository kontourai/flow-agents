# Installed kit activation in native harnesses

Install a kit into a project, then select its native discovery surface:

```sh
flow-agents kit install /path/to/kit --dest /path/to/project
flow-agents kit activate --adapter claude-code --dest /path/to/project
```

`runtime-adapter activate` accepts the same adapters. An omitted adapter retains
the legacy `codex-local` behavior; `strands-local` also remains available.

| Adapter | Project-local skill discovery | Additional guidance |
| --- | --- | --- |
| `claude-code` | `.claude/skills/<skill>/SKILL.md` | None |
| `codex` | `.agents/skills/<skill>/SKILL.md` | None |
| `kiro-cli` | `.kiro/skills/<skill>/SKILL.md` | `.kiro/agents/flow-agents-<kit>.json`, with `skill://` resources |
| `kiro-ide` | `.kiro/skills/<skill>/SKILL.md` | `.kiro/agents/flow-agents-<kit>.md` |
| `cursor` | `.cursor/skills/<skill>/SKILL.md` | `.cursor/rules/flow-agents-<kit>.mdc`, agent-selected |
| `opencode` | `.opencode/skills/<skill>/SKILL.md` | None |
| `copilot-cli` | `.github/skills/<skill>/SKILL.md` | None |
| `vscode` | `.github/skills/<skill>/SKILL.md` | None |

These are configuration projections. The receipt reports
`evidence_scope: native-configuration-placement`, `runtime_execution: NOT_VERIFIED`,
`authentication: NOT_VERIFIED`, and `hook_enforcement: NOT_INSTALLED`. IDE discovery,
agent selection, model access, and workflow execution require separate observations
in that native application. A CLI observation does not qualify an IDE.

The paths and Kiro formats were checked against the published AWS AI-DLC 2.11.0
release source at `6a378b53c0a4fe0641ed7d8de8dfff94264d5b6a`, specifically
`harness/{claude,codex,kiro,kiro-ide,cursor,copilot}` and their packaged runtime trees.
OpenCode uses Flow Agents' existing native `.opencode/skills` exporter layout;
AWS instead configures a custom `.aidlc/skills` path in `opencode.json`. Activation
does not replace that user configuration. These projections reuse Flow Agents'
kit inventory, compiled public assets, and file primitives; they do not copy AWS's
workflow engine or Station's persistent executor.

Skills retain their names and content and include their regular-file companion
trees. Duplicate native skill names refuse activation rather than overwrite each
other. Flows and docs retain their kit-relative paths below
`.kontourai/flow-agents/projections/<adapter>/<kit>/`. The authoritative installed
kit remains at `kits/local/repositories/<kit>/`; repository-relative references
outside a skill's companion directory refer to that repository. Kit authors should
use ordinary CLI operations and installed-kit bindings in portable entry skills.
Activation adds no hook, shell permission grant, model selection, or auth token.

The project ownership manifest is `.flow-agents/native-harness-activation.json`.
Activation serializes changes through the existing state-file lock and refuses
symlinks, malformed ownership, modified owned files, unowned destination files,
and installed-kit hash drift. Refresh removes only stale byte-identical owned
files. Shared Kiro and Copilot/VSCode skill files carry all active surface owners;
removing one owner preserves the others. A content update reports affected
surfaces, whose previous execution evidence must be refreshed. Interrupted writes
record ownership incrementally; directory shells may remain after stale cleanup.
User `AGENTS.md`, settings, and global configuration are not overwritten.

The published SDK exposes:

```ts
import { activateNativeHarness, NATIVE_HARNESS_SURFACES } from
  "@kontourai/flow-agents/kit-activation";

const receipt = activateNativeHarness(packageRoot, projectRoot, {
  surface: "codex",
  kitIdFilter: ["your-kit"],
});
```

`kitIdFilter` expands declared dependencies using the existing inventory. Without
a filter, activation uses all available built-in and installed kits. The SDK's
filter also bounds stale cleanup; unrelated kits keep their ownership records.
The packed-package tests exercise all eight surface IDs, ordinary installed-kit
CLI use from skill companions, legacy adapter compatibility, shared custody,
installed drift, conflicts, and unsafe destinations. They supply dependencies
from the checkout and do not attest a clean registry installation or live model
execution.
