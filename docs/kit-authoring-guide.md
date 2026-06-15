---
title: Flow Kit Authoring Guide
---

# Flow Kit Authoring Guide

A Flow Kit is a portable workflow bundle you author once and install into any Flow Agents workspace. It lets you package one or more Flow Definitions — plus optional skills, docs, adapters, evals, and assets — under a single validated manifest. The same install, validation, and activation path that ships the built-in Builder Kit is available to your own kits.

This guide walks you from an empty directory to a validated, locally installed kit.

## Concepts

- **Kit** — a directory with a root `kit.json` manifest and the assets it declares. The manifest is the contract; Flow Agents validates it before anything is copied.
- **Flow Definition** — a `.flow.json` file that declares steps, gates, and expected evidence. Validation of the Flow Definition semantics belongs to [Kontour Flow](https://kontourai.github.io/flow/); the kit contract delegates to it.
- **Activation** — the step that reads the installed kit and writes runtime-local files into your workspace. Both `codex-local` and `strands-local` adapters activate Flow Definitions, skills, and docs. See the Activate section for the full asset-class table.

## Directory layout

```text
my-kit/
  kit.json            ← required manifest
  flows/
    review.flow.json  ← at least one Flow Definition
  docs/               ← optional
    README.md
```

All paths declared in `kit.json` must be relative to the kit directory and must not contain `..`. The kit must be fully self-contained so it can be installed from any machine or worktree.

## Minimal kit.json

```json
{
  "schema_version": "1.0",
  "id": "my-kit",
  "name": "My Kit",
  "description": "A minimal kit that adds a review flow.",
  "flows": [
    {
      "id": "my-kit.review",
      "path": "flows/review.flow.json",
      "description": "Review a change against agreed criteria."
    }
  ]
}
```

Required fields:

| Field | Rule |
|---|---|
| `schema_version` | Must be `"1.0"` |
| `id` | Stable kebab-case string, e.g. `review-kit` |
| `name` | Non-empty display name |
| `flows` | Non-empty list; each entry must have `id` and `path` |

Optional fields: `product_name`, `description`, `skills`, `docs`, `adapters`, `evals`, `assets`. Optional fields list relative asset paths or objects with `id`, `path`, and optional `description`. `skills` and `docs` assets are activated by both adapters alongside flows. `adapters`, `evals`, and `assets` appear in diagnostics as `skipped_assets` (see the Activate section for the full per-adapter table).

## Minimal flow file

A Flow Definition at minimum needs `id`, `version`, `steps`, and `gates`. Steps form a linked list; each gate names the step it guards and the evidence it expects.

```json
{
  "id": "my-kit.review",
  "version": "1.0",
  "steps": [
    { "id": "review", "next": "done" },
    { "id": "done", "next": null }
  ],
  "gates": {
    "review-gate": {
      "step": "review",
      "expects": [
        {
          "id": "review-finding",
          "kind": "surface.claim",
          "required": true,
          "description": "The change was reviewed and findings were recorded.",
          "claim": {
            "type": "my-kit.review.finding",
            "subject": "artifact",
            "accepted_statuses": ["trusted", "accepted"]
          }
        }
      ]
    }
  }
}
```

The `id` in the flow file should match the `id` declared in `kit.json`'s `flows` list. Look at `kits/builder/flows/shape.flow.json` and `kits/builder/flows/build.flow.json` in this repository for fuller examples of multi-step flows with required and optional gate evidence.

## Validate

Before installing or sharing a kit, run validation from the flow-agents checkout:

```bash
npm run validate:source -- --kit path/to/my-kit
```

This runs the same repository contract validation used by `install-local`. A validation failure exits nonzero with a diagnostic. Fix errors and re-run until it passes cleanly.

The full source-tree validation (no `--kit` flag) additionally validates the built-in catalog and Builder Kit:

```bash
npm run validate:source --
```

## Install locally

Once validation passes, install the kit into a target workspace:

```bash
npx @kontourai/flow-agents kit install path/to/my-kit --dest /path/to/workspace
```

`--dest` is the installed Flow Agents bundle root. When omitted the command uses the current directory. From a contributor checkout of this repository, the equivalent form is `npm run flow-kit -- <command>`.

Confirm the install:

```bash
npx @kontourai/flow-agents kit list --dest /path/to/workspace
npx @kontourai/flow-agents kit status my-kit --dest /path/to/workspace
```

`list` prints one summary line per installed kit. `status` prints JSON provenance including the SHA256 content hash and `installed` or `missing` state.

To replace an existing install after you update the kit source:

```bash
npx @kontourai/flow-agents kit install path/to/my-kit --dest /path/to/workspace --update
```

## Activate

After installing, run activate to write runtime-local files into the workspace:

```bash
npx @kontourai/flow-agents kit activate --dest /path/to/workspace --format json
```

The `codex-local` adapter is selected automatically. To activate for Strands, pass `--adapter strands-local`.

### What each adapter activates

Each adapter copies declared assets into `.flow-agents/runtime/<adapter>/` and produces an `activation.json` manifest. The table below shows which asset classes are activated today:

| Asset class | `codex-local` | `strands-local` | Notes |
|---|---|---|---|
| `flows` | Activated — `.flow-agents/runtime/codex/flows/<kit-id>/<asset-id>.flow.json` | Activated — `.flow-agents/runtime/strands/flows/<kit-id>/<asset-id>.flow.json` | Gate definitions read by each adapter's flow-routing layer. |
| `skills` | Activated — `.flow-agents/runtime/codex/skills/<kit-id>/<filename>` | Activated — `.flow-agents/runtime/strands/skills/<kit-id>/<filename>` | Agent guidance markdown. For codex-local, reference these paths from AGENTS.md. For strands-local, the Strands steering layer can glob for `*.md` under `skills/` during system-prompt injection. |
| `docs` | Activated — `.flow-agents/runtime/codex/docs/<kit-id>/<filename>` | Activated — `.flow-agents/runtime/strands/docs/<kit-id>/<filename>` | Documentation assets. Co-located with skill files for easy reference. |
| `adapters` | `skipped_assets` | `skipped_assets` | Framework or runtime adapter code — not copied by the activation layer. |
| `evals` | `skipped_assets` | `skipped_assets` | Evaluation suites — not run or copied during activation. |
| `assets` | `skipped_assets` | `skipped_assets` | General supporting assets — not copied during activation. |

Assets in `skipped_assets` are recorded in `activation.json` for diagnostics but are not an error. They are not activated because no activation path is defined for those classes in the current adapters.

Flows with a missing `id` field in `kit.json` are also placed in `skipped_assets` with an explicit reason.

When installing through `npx @kontourai/flow-agents init` with the Codex runtime, pass `--activate-kits` to run activation as part of init:

```bash
npx @kontourai/flow-agents init --runtime codex --dest /path/to/workspace --activate-kits --yes
```

## Troubleshooting

Common validation errors and fixes are documented in the [Flow Kit Repository Contract](flow-kit-repository-contract.md#common-failures). The most frequent:

- `kit.json: .schema_version must be "1.0"` — update the manifest.
- `kit.json: .id must be a stable kebab-case string` — use a lowercase id like `review-kit`.
- `kit.json: .flows must be a non-empty list` — declare at least one Flow Definition.
- `kit.json: flows[0].path points at missing Flow Definition` — add the file or fix the path.
- `kit.json: docs[0].path points at missing asset` — add the asset or remove the entry.

For path errors: all declared paths must be relative, must not contain `..`, and must point at existing files. Absolute paths are rejected because a kit must be portable between machines.

For conflicts on re-install: if you install a different source with an existing kit id, the command fails unless you pass `--update`. Use `--force` to re-copy an existing same-source install after validation.

See the [Flow Kit Repository Contract](flow-kit-repository-contract.md) for the full validation rules, registry schema, activation diagnostics, and the install/update/force semantics.

## Layering: container vs. agent extension

A Flow Agents Kit is built on two distinct layers. Understanding the split helps you know which rules come from Flow and which come from Flow Agents.

### Layer 1: the Flow Kit container (Flow-owned)

The **container contract** is owned by [Kontour Flow](https://kontourai.github.io/flow/flow-kit-container). It governs:

- `kit.json` required fields: `schema_version` ("1.0"), `id` (kebab-case), `name`, `flows` (non-empty list with `path` entries).
- Optional core fields: `description`, `product_name`.
- Path rules: all declared paths must be relative, must not contain `..`, and must resolve inside the kit directory.
- The **extension model**: unknown top-level fields are consumer extensions; core validation ignores-but-permits them.

Container validation is surfaced in Flow's CLI as `flow kit validate <kit-dir>`. Flow Agents delegates core container validation to `@kontourai/flow`'s `validateKitContainer` library function; the contract lives once, in Flow.

For the authoritative container spec and JSON Schema, see [kontourai/flow#67](https://github.com/kontourai/flow/pull/67) (the spec PR) and the published `schemas/flow-kit-container.schema.json` in the `@kontourai/flow` package.

### Layer 2: the Flow Agents agent extension (Flow Agents-owned)

The **agent extension** is owned by Flow Agents. It defines the optional asset classes that turn a Flow Kit into a **Flow Agents Kit**:

| Extension field | Asset type |
|---|---|
| `skills` | Reusable agent skill procedures |
| `docs` | Documentation assets |
| `adapters` | Runtime or framework adapters |
| `evals` | Evaluation suites |
| `assets` | General supporting assets |

Each extension field is an optional array of entries with `id`, `path`, and optional `description`. Extension fields are validated by Flow Agents using the same path rules as the container layer (relative, no `..`, must exist). Unknown extension entries are recorded as `skipped_assets` during activation rather than treated as errors.

### When a kit "is" a Flow Agents Kit

A kit is a **Flow Agents Kit** when it satisfies both layers:

1. It passes Flow Kit container validation (valid `kit.json` with core fields and at least one `flows` entry).
2. It optionally declares one or more Flow Agents extension fields (`skills`, `docs`, `adapters`, `evals`, `assets`).

A kit with only core fields (no extension fields) is a valid Flow Kit and is also a valid Flow Agents Kit — it just installs and activates only its Flow Definitions.

### Why two layers?

The split keeps ownership clean:

- Flow authors, installs, and validates the container shape. Any tool that understands Flow Kits can install any kit without knowing about Flow Agents.
- Flow Agents extends the container for agent-specific assets without modifying the core contract. Third-party kit authors who don't need skills or adapters never have to know about the extension layer.

## K-levels: kit conformance and consumer-target badges

Every Flow Agents Kit declares assets in a manifest. The K-level system classifies what consumers can do with a kit based on observable asset classes — no extra declaration needed for the level itself. Levels derive from what is present.

### Conformance levels

| Level | What is present | Who can consume it |
|---|---|---|
| **K0** | Valid core Flow Kit container: `schema_version`, `id`, `name`, `flows` (non-empty). | Any Flow consumer: gates and definition-of-done are evaluable agentlessly in CI or without an agent framework. |
| **K1** | K0 + at least one Flow Agents extension field present (`skills`, `docs`, `adapters`, `evals`, or `assets`). | Flow Agents (>= installed version) can activate the kit in at least one agent harness or framework. |
| **K2** | K1 + `evals` present with at least one entry. | Live evidence layer: eval suites run against an adapter and produce verifiable output records. |

Every kit published by Kontour is K0 or higher. K0 is the minimum bar — a kit that fails K0 is not distributable.

### The degradation invariant

Every Flow Agents Kit **must remain a valid core Flow Kit container when agent-extension fields are ignored**. This is the degradation invariant:

- Strip `skills`, `docs`, `adapters`, `evals`, and `assets` from a kit's `kit.json`.
- The remaining manifest must satisfy the Flow Kit container contract (`schema_version`, `id`, `name`, `flows` non-empty, no `..` traversal).
- This invariant is enforced by the kit validator (`npm run validate:source -- --kit <dir>`).

Why this matters: any Flow consumer (CI gate runner, definition-of-done checker, release audit tool) can evaluate a kit's gates without knowing about Flow Agents. The kit's flow definitions carry the definition-of-done independently of whether an agent ever runs.

### Consumer-target derivation

Consumer targets are **derived** from observable asset classes — no declaration is required for standard targets:

| Observable state | Derived target |
|---|---|
| K0 (flows present) | `flow` — any Flow consumer (gate evaluation, definition-of-done) |
| K1 (agent extension assets present) | `flow-agents` — Flow Agents activates the kit |
| Unknown top-level key(s) | Listed verbatim as third-party consumer target(s) |

Unknown top-level keys are permitted by the container spec's `additionalProperties: true` rule. A third-party tool built on Flow can extend a kit with its own namespace (e.g. `"my-platform.widgets": [...]`) — the key becomes a derived consumer-target badge without requiring any pre-registration.

Version constraints (e.g. minimum `flow-agents` version) are the only case where a declaration is needed beyond what derivation can reach.

**Marketplace listing format**: `Works with: Flow (gates-only) | Flow Agents | <Consumer X>`

### Evidence layering: Surface and Veritas

Kit gates reference evidence using `"kind": "surface.claim"`. This is **Flow-native vocabulary**: Flow is built on Surface, so Surface claims are the expected evidence substrate at the Flow level. Surface claims are not a Flow Agents coupling.

Veritas is an **optional claim family** — a developer-repo specialization for evidence that has been through a trust pipeline. Kits may be opinionated about requiring Veritas-class evidence. Builder Kit requiring Veritas-class evidence is the kit's own policy choice, defined by Kontour as the kit author, not a platform requirement. Other kits may not require Veritas at all.

Layering summary:

- **Surface** = claim substrate (Flow-level, always available)
- **Veritas** = optional claim kind, kit-opinionated (Builder Kit requires it; others need not)

### Inspecting a kit's K-level

Use the `inspect` subcommand to derive a kit's conformance level and consumer targets:

```bash
npm run kit -- inspect path/to/my-kit
```

Output is stable JSON:

```json
{
  "kit_id": "my-kit",
  "kit_name": "My Kit",
  "conformance": {
    "k0": true,
    "k1": true,
    "k2": false
  },
  "targets": ["flow", "flow-agents"],
  "third_party_extensions": []
}
```

Exit code 0 when the kit is at least K0 (valid core container); exit code 1 when K0 validation fails.

The `inspect` command is read-only and safe to run before install.

## Direction

Flow Kits are designed to be shareable workflow units — authored once, carried across teams and workspaces. The intended growth path is distribution from git remotes and a curated Kontour kit catalog of Kontour-authored kits covering work modes beyond software delivery. Today install is local-path only; remote fetch is explicitly a non-goal in this version.

## Migration: flow-kit → flow-agents kit

The standalone `flow-kit` binary was removed in this release. The `flow-agents kit` subcommand is the replacement.

| Old command | New command |
|---|---|
| `flow-kit install-local <path>` | `flow-agents kit install <path>` |
| `flow-kit install-git <url>` | `flow-agents kit install <url>` |
| `flow-kit activate` | `flow-agents kit activate` |
| `flow-kit inspect <dir>` | `flow-agents kit inspect <dir>` |
| `flow-kit list` | `flow-agents kit list` |
| `flow-kit status <id>` | `flow-agents kit status <id>` |
| `npx @kontourai/flow-agents flow-kit ...` | `npx @kontourai/flow-agents kit ...` |
| `npm run flow-kit -- ...` | `npm run kit -- ...` |

`install-local` and `install-git` are unified into a single `install` command. The source argument auto-detects whether it is a local path or a git URL (http://, https://, git+, ssh://, file://).

Running the old `flow-kit` command will produce a "command not found" error from your shell — there is no alias or shim. Update any scripts or CI configurations that call `flow-kit` to use `flow-agents kit`.
