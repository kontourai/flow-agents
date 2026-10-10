# Installed kit activation in native harnesses

Install a kit in its tooling bootstrap, then project its native discovery assets
into the application:

```sh
flow-agents kit install /path/to/kit --dest /path/to/bootstrap
flow-agents kit activate --adapter claude-code --dest /path/to/bootstrap \
  --target /path/to/project --kits your-kit
```

`runtime-adapter activate` accepts the same adapters. An omitted adapter retains
the legacy `codex-local` behavior; `strands-local` also remains available.
Omitting `--target` retains same-root activation. Separate roots must be
canonically disjoint, so an application does not contain its bootstrap's tooling
dependencies or receive writes into an installed repository. `--target` requires
an explicit native adapter; legacy projection adapters retain their own layouts.
`--kits` accepts one comma-separated list and expands declared dependencies.
The CLI finds built-in kits relative to its own published dispatcher, including
when launched through npm's compiled entry point. `--source-root` remains an
explicit catalog override.

| Adapter | Project-local skill discovery | Additional guidance |
| --- | --- | --- |
| `claude-code` | `.claude/skills/<skill>/SKILL.md` | None |
| `codex` | `.agents/skills/<skill>/SKILL.md` | None |
| `kiro-cli` | `.kiro/skills/<skill>/SKILL.md` | `.kiro/agents/flow-agents-<kit>-cli.json`, with `skill://` resources |
| `kiro-ide` | `.kiro/skills/<skill>/SKILL.md` | `.kiro/agents/flow-agents-<kit>-ide.md` |
| `cursor` | `.cursor/skills/<skill>/SKILL.md` | `.cursor/rules/flow-agents-<kit>.mdc`, agent-selected |
| `opencode` | `.opencode/skills/<skill>/SKILL.md` | None |
| `copilot-cli` | `.github/skills/<skill>/SKILL.md` | None |
| `vscode` | `.github/skills/<skill>/SKILL.md` | None |

These are configuration projections. The receipt reports
`evidence_scope: native-configuration-placement`, `runtime_execution: NOT_VERIFIED`,
`authentication: NOT_VERIFIED`, and `hook_enforcement: NOT_INSTALLED`. IDE discovery,
agent selection, model access, and workflow execution require separate observations
in that native application. A CLI observation does not qualify an IDE.

Kiro CLI and IDE agents have distinct names so both native formats can coexist in
one project while sharing owned skills.

The paths and Kiro formats were checked against the published AWS AI-DLC 2.11.0
release source at `6a378b53c0a4fe0641ed7d8de8dfff94264d5b6a`, specifically
`harness/{claude,codex,kiro,kiro-ide,cursor,copilot}` and their packaged runtime trees.
OpenCode uses Flow Agents' existing native `.opencode/skills` exporter layout;
AWS instead configures a custom `.aidlc/skills` path in `opencode.json`. Activation
does not replace that user configuration. These projections reuse Flow Agents'
kit inventory, compiled public assets, and file primitives; they do not copy AWS's
workflow engine or Station's persistent executor.

Skills retain their names and procedures and include their regular-file companion
trees. Separate-root projection adds a generic runtime/source header after skill
frontmatter and to generated native agent/rule guidance. It records `installed_root`,
`installed_kit_root`, `source_path`, and `runtime_argv`, derived from Node and the
published SDK's adjacent compiled CLI. Agents can invoke that CLI with `--dest`
bound to the bootstrap without relying on their application session's PATH.
Same-root skill content remains unchanged. Duplicate native skill names refuse activation rather than overwrite each
other. Flows and docs retain their kit-relative paths below
`.kontourai/flow-agents/projections/<adapter>/<kit>/`. The authoritative installed
kit remains at `kits/local/repositories/<kit>/`; repository-relative references
outside a skill's companion directory refer to that repository. Kit authors should
use ordinary CLI operations and installed-kit bindings in portable entry skills.
Activation adds no hook, shell permission grant, model selection, or auth token.

The project ownership manifest is `.flow-agents/native-harness-activation.json`.
Inventory, dependency closure, and strict installed integrity are read from the
bootstrap. Native files, the ownership manifest, and its lock are written in the
target project; activation does not copy npm dependencies or mutate the bootstrap
registry. Receipts and ownership entries preserve the original installed source
paths and launcher rather than temporary snapshot paths.
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

const receipt = activateNativeHarness(packageRoot, bootstrapRoot, {
  surface: "codex",
  targetRoot: projectRoot,
  kitIdFilter: ["your-kit"],
});
```

`kitIdFilter` expands declared dependencies using the existing inventory. Without
a filter, activation uses all available built-in and installed kits. The SDK's
filter bounds strict installed content integrity and stale cleanup to the selected
kit and its transitive dependencies. Unrelated integrity failures remain warnings
and their files stay untouched. Ambiguous or duplicate registry identities always
refuse activation, because a kit cannot be selected reliably from that registry.
Unrelated kits keep their ownership records. `targetRoot` defaults to the second
argument, preserving existing SDK callers.
The packed-package tests exercise all eight surface IDs, ordinary installed-kit
CLI use from skill companions, legacy adapter compatibility, shared custody,
installed drift, conflicts, and unsafe destinations. They supply dependencies
from the checkout and do not attest a clean registry installation or live model
execution.
