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

Optional fields: `product_name`, `description`, `skills`, `docs`, `adapters`, `evals`, `assets`, `dependencies` (cross-kit dependency declarations; see [Cross-kit dependencies](#cross-kit-dependencies)), `workflow_triggers` (structured workflow steering keyed by engine trigger names such as `implementation-work-detected`), `hook_influence_expectations` (kit-owned required hook-influence fixture expectations), and `first_party` (legacy catalog/marketplace metadata; no runtime privilege). Optional asset fields list relative asset paths or objects with `id`, `path`, and optional `description`. `skills` and `docs` assets are activated by both adapters alongside flows. `adapters`, `evals`, and `assets` appear in diagnostics as `skipped_assets` (see the Activate section for the full per-adapter table).

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
          "kind": "trust.bundle",
          "required": true,
          "description": "The change was reviewed and findings were recorded.",
          "bundle_claim": {
            "claimType": "my-kit.review.finding",
            "subjectType": "artifact",
            "accepted_statuses": ["trusted", "accepted"]
          }
        }
      ]
    }
  }
}
```

The `id` in the flow file should match the `id` declared in `kit.json`'s `flows` list. Look at `kits/builder/flows/shape.flow.json` and `kits/builder/flows/build.flow.json` in this repository for fuller examples of multi-step flows with required and optional gate evidence.

Flow Definitions may compose another declared Flow Definition at a step with `uses_flow`. The parent keeps lifecycle ownership (`active_flow_id` can remain the parent flow), while gate resolution for that step comes from the child flow with the same step id. Use this for reusable extensions such as publish, CI merge readiness, or learning closeout:

```json
{
  "id": "builder.build",
  "steps": [
    { "id": "verify", "next": "pr-open" },
    { "id": "pr-open", "next": "merge-ready-ci", "uses_flow": "builder.publish-learn" },
    { "id": "merge-ready-ci", "next": "learn", "uses_flow": "builder.publish-learn" },
    { "id": "learn", "next": "done", "uses_flow": "builder.publish-learn" }
  ]
}
```

The child flow should declare the gates for those step ids and list the claim types it intentionally exposes in `exports` (expectation ids are also accepted for non-claim expectations). Composition fails closed when a child gate expectation is not exported. Parent verification is still determined by trust-bundle claims: required child claims that are missing, disputed, or `not_verified` prevent the composed parent from being treated as verified.

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

Each adapter copies declared assets into `.kontourai/flow-agents/projections/<adapter>/` and produces an `activation.json` manifest. The table below shows which asset classes are activated today:

| Asset class | `codex-local` | `strands-local` | Notes |
|---|---|---|---|
| `flows` | Activated — `.kontourai/flow-agents/projections/codex/flows/<kit-id>/<asset-id>.flow.json` | Activated — `.kontourai/flow-agents/projections/strands/flows/<kit-id>/<asset-id>.flow.json` | Gate definitions read by each adapter's flow-routing layer. |
| `skills` | Activated — `.kontourai/flow-agents/projections/codex/skills/<kit-id>/<filename>` | Activated — `.kontourai/flow-agents/projections/strands/skills/<kit-id>/<filename>` | Agent guidance markdown. For codex-local, reference these paths from AGENTS.md. For strands-local, the Strands steering layer can glob for `*.md` under `skills/` during system-prompt injection. |
| `docs` | Activated — `.kontourai/flow-agents/projections/codex/docs/<kit-id>/<filename>` | Activated — `.kontourai/flow-agents/projections/strands/docs/<kit-id>/<filename>` | Documentation assets. Co-located with skill files for easy reference. |
| `adapters` | `skipped_assets` | `skipped_assets` | Framework or runtime adapter code — not copied by the activation layer. |
| `evals` | `skipped_assets` | `skipped_assets` | Evaluation suites — not run or copied during activation. |
| `assets` | `skipped_assets` | `skipped_assets` | General supporting assets — not copied during activation. |

Assets in `skipped_assets` are recorded in `activation.json` for diagnostics but are not an error. They are not activated because no activation path is defined for those classes in the current adapters.

Flows with a missing `id` field in `kit.json` are also placed in `skipped_assets` with an explicit reason.

When installing through `npx @kontourai/flow-agents init` with the Codex runtime, pass `--activate-kits` to run activation as part of init:

```bash
npx @kontourai/flow-agents init --runtime codex --dest /path/to/workspace --activate-kits --yes
```

`init` activates no kits by default. To activate one or more catalog kits explicitly, pass `--activate-kit <kit-id>` once per selected kit. Declared kit dependencies are auto-included transitively during activation; for example, activating Builder also activates its Knowledge dependency:

```bash
npx @kontourai/flow-agents init --runtime codex --dest /path/to/workspace --activate-kit builder --yes
```

`--activate-kits` remains a backwards-compatible alias for selecting every catalog kit.

## Troubleshooting

Common validation errors and fixes are documented in the [Flow Kit Repository Contract](flow-kit-repository-contract.md#common-failures). The most frequent:

- `kit.json: .schema_version must be "1.0"` — update the manifest.
- `kit.json: .id must be a stable kebab-case string` — use a lowercase id like `review-kit`.
- `kit.json: .flows must be a non-empty list` — declare at least one Flow Definition.
- `kit.json: flows[0].path points at missing Flow Definition` — add the file or fix the path.
- `kit.json: docs[0].path points at missing asset` — add the asset or remove the entry.

For path errors: all declared paths must be relative, must not contain `..`, and must point at existing files. Absolute paths are rejected because a kit must be portable between machines.

For conflicts on re-install: if you install a different source with an existing kit id, the command fails unless you pass `--update`. Use `--force` to re-copy an existing same-source install after validation.

For cross-kit dependency errors:

- `kit.json: dependencies[N].kit_id must be a kebab-case kit id` — the entry's `kit_id` is missing or not lowercase kebab-case. Fix the id.
- `kit.json: dependencies[N].kit_id must not reference the declaring kit itself` — remove the self-referential entry; a kit cannot depend on itself.
- `kit.json: dependencies[N].kit_id duplicates '<id>'` — collapse the duplicate declaration to a single entry.
- `warning: kit '<id>' declares a dependency on '<dep>' ... which is not installed` (at install) — advisory only; install the depended-on kit with `flow-agents kit install <source>` before activating, or activation will fail.
- `<id>: declares a dependency on kit '<dep>' ... which is not installed or activated` (at activate, non-zero exit) — install the missing kit and re-activate, or remove the dependency declaration if it is no longer needed.

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

### Cross-kit dependencies

A kit may declare that it depends on **another kit** whose skills it invokes at runtime. This is a Flow Agents extension-layer concern (a skill in one kit calling a skill in another), not part of the Flow-owned container contract — see [ADR 0019](adr/0019-kit-dependency-ownership.md) for the ownership rationale (grounded in the container schema's `additionalProperties: true` and ADR 0008's Dividing Test). It is **not** a package manager: it declares and validates *presence*, it does not fetch kits or resolve versions.

Shape:

```json
{
  "schema_version": "1.0",
  "id": "builder",
  "name": "Builder Kit",
  "flows": [ /* ... */ ],
  "dependencies": [
    {
      "kit_id": "knowledge",
      "reason": "learning-review invokes knowledge-capture for durable knowledge storage"
    }
  ],
  "skills": [ /* ... */ ]
}
```

| Field | Rule |
|---|---|
| `kit_id` | Required. Kebab-case kit id (`^[a-z][a-z0-9-]*$`) of the depended-on kit. Must not reference the declaring kit itself, and must not be duplicated across entries. |
| `reason` | Optional string explaining why the dependency exists (which skill invokes which). |

Where it is checked:

- **Shape** — at `flow-agents kit install`, `inspect`, and `validate` time. A malformed entry (bad `kit_id`, self-reference, duplicate) is a **hard error**.
- **Presence at install** — `flow-agents kit install` prints a **non-blocking warning** when a declared dependency is not present in the destination's **local** registry, then exits 0. This check sees only the local installed-kits registry, not the built-in Kit Catalog (an accepted v1 limitation).
- **Presence at activation** — `flow-agents kit activate` is a **hard error** (non-zero exit) when a declared `kit_id` is not present among the union of built-in catalog kits and locally-installed kits.

`dependencies` is metadata, not evaluable-gate content, so it does **not** affect K0/K1/K2 conformance scoring (see the K-levels section below).

### Structured workflow triggers

A kit may declare `workflow_triggers` to let the engine route matching prompts into a kit workflow. Triggers do not contain freeform prose. The engine owns the rendered wording and applies the same template to every kit. Every trigger steering field is an identifier and must match `^[a-z0-9]+(?:[.-][a-z0-9]+)*$`; malformed values fail closed and the trigger is skipped.

Shape:

```json
{
  "workflow_triggers": [
    {
      "id": "builder-build-work",
      "when": "implementation-work-detected",
      "target_flow_id": "builder.build",
      "default_skill": "deliver",
      "conditional_skills": [
        { "when": "user-requested-tdd", "skill": "tdd-workflow" }
      ],
      "required_sequence": ["plan-work", "execute-plan", "review-work", "verify-work"],
      "post_verify_targets": ["release-readiness", "learning-review"]
    }
  ]
}
```

| Field | Rule |
|---|---|
| `id` | Required trigger id unique within the kit. |
| `when` | Required engine trigger category such as `implementation-work-detected` or `knowledge-capture-detected`. |
| `target_flow_id` | Optional flow id the session should stay on. |
| `default_skill` | Optional skill id to activate when no conditional skill applies. |
| `conditional_skills` | Optional list of `{ "when": "...", "skill": "..." }` identifier entries. |
| `required_sequence` | Optional ordered list of workflow skills or steps the engine should name as the required sequence. |
| `post_verify_targets` | Optional list of post-verification targets such as release readiness or learning capture. |

The retired `hint` field is invalid. `display_name` is not a workflow trigger field; keep human-readable names in catalog/listing metadata such as top-level `name` or `product_name`. Do not put natural-language steering instructions in kit metadata; express routing needs through the structured identifier fields above.

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

Kit gates reference evidence using `"kind": "trust.bundle"` with a `bundle_claim` selector (`claimType`, optional `subjectType`, `accepted_statuses`). This is **Flow-native vocabulary** in the Hachure open trust-bundle format: Flow is built on Surface, so trust bundles are the expected evidence substrate at the Flow level, validated against Hachure's `trust-bundle.schema.json`. They are not a Flow Agents coupling. (Earlier Flow releases used `kind: "surface.claim"` with a `claim` selector; Flow 1.3.0 replaced that with `trust.bundle`, kontourai/flow#84.)

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
  "third_party_extensions": [],
  "trust": "unverified"
}
```

Exit code 0 when the kit is at least K0 (valid core container); exit code 1 when K0 validation fails.

The `inspect` command is read-only and safe to run before install.

## Trust axis: who vouches for a kit

The **trust axis** is a separate, orthogonal classification from the K-level capability axis. It answers the question "who vouches for this kit?" rather than "what does this kit contain?".

### Two orthogonal axes

Every kit carries two independent badges:

| Axis | Values | Question answered |
|---|---|---|
| **Capability** (K-level) | K0 / K1 / K2 | What does the kit CONTAIN? (derived from assets) |
| **Trust** | verified / unverified | WHO vouches for it? |

A K2 kit can be `unverified`. The levels are independent.

**Marketplace listing format**: `Works with: Flow (gates-only) | K1 | Official`

`official` / `first_party` is catalog and marketplace metadata only. It grants no runtime privilege: every kit uses the same structured steering mechanism, and no capability decision keys off kit id or load provenance.

### Trust levels

| Level | Meaning | How it is assigned (v1) |
|---|---|---|
| `verified` | Reserved for a future third-party verification process. | Not yet implemented; the value is reserved but not granted to any kit today. |
| `unverified` | Default for all kits. | All current kits, including built-ins and third-party community kits. |

`unverified` says nothing about the quality of a kit — it only means Kontour has not vouched for it through one of the above channels.

### Deferred: verified trust and cryptographic attestation (v2)

The `verified` value is reserved for a future verification process. The intended v2 path:

- Third-party kit authors can apply for `verified` status.
- Verification evidence: the kit passes the conformance kit self-certification + a cryptographic signature or Veritas attestation.
- The [conformance kit](https://github.com/kontourai/flow) and [Veritas claims](veritas-integration.md) are the natural substrate for this attestation layer.
- The signature or attestation would be checked by `flow-agents kit inspect` at derivation time.

v1 deliberately omits the signing/attestation mechanism and the verification process. The `verified` value is reserved so consuming tools can handle it when it arrives without a breaking schema change.

### Inspecting trust

The `trust` field appears in `flow-agents kit inspect` output alongside `conformance`:

```bash
npm run kit -- inspect kits/builder
```

```json
{
  "kit_id": "builder",
  "kit_name": "Builder Kit",
  "conformance": {
    "k0": true,
    "k1": true,
    "k2": false
  },
  "targets": ["flow", "flow-agents"],
  "third_party_extensions": [],
  "trust": "unverified"
}
```

A third-party kit inspected before verification:

```json
{
  "kit_id": "my-custom-kit",
  "kit_name": "My Custom Kit",
  "conformance": {
    "k0": true,
    "k1": true,
    "k2": false
  },
  "targets": ["flow", "flow-agents"],
  "third_party_extensions": [],
  "trust": "unverified"
}
```

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
