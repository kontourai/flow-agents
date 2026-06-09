---
title: Flow Kit Repository Contract
---

# Flow Kit Repository Contract

A Flow Kit repository is a local folder with a root `kit.json`. Flow Agents validates the repository shape, declared paths, declared assets, fixture behavior, and diagnostics. Flow validates Flow Definition semantics.

Use this command before adding a kit to a catalog or sharing it with another maintainer:

```bash
npm run validate:source -- --kit path/to/local-kit
```

The full source-tree command validates the built-in Kit Catalog and Builder Kit through the same repository contract:

```bash
npm run validate:source --
```

## Local Install

Installed Flow Agents bundles include a local-only install command for Flow Kit repositories that already exist on disk:

```bash
npm run flow-kit -- install-local path/to/local-kit --dest /path/to/installed-flow-agents
npm run flow-kit -- list --dest /path/to/installed-flow-agents
npm run flow-kit -- status --dest /path/to/installed-flow-agents
npm run flow-kit -- status example-kit --dest /path/to/installed-flow-agents
npm run flow-kit -- activate --dest /path/to/installed-flow-agents --format json
```

`--dest` is the installed bundle or workspace root. When omitted, the command uses the current working directory. Tests and automation should pass a temp destination; the command does not need to write to a user home directory.

Install always runs the same repository validation used by `npm run validate:source -- --kit` before it creates or updates local install state. A validation failure exits nonzero and leaves the destination registry and copied kits unchanged.

Local installs are runtime overlay state. The command writes registry metadata to:

```text
<dest>/kits/local/installed-kits.json
```

and copies validated repositories under:

```text
<dest>/kits/local/repositories/<kit-id>/
```

It does not edit the source Kit Catalog at `kits/catalog.json`.

Each registry entry records:

- `id`: kit id from `kit.json`.
- `source`: absolute local source path used for the install.
- `hash`: `sha256:` content hash of the source repository.
- `version`: optional manifest version when a future contract permits one.
- `installed_at`: UTC ISO timestamp.
- `installed_path`: copied kit path under the destination.
- `state`: install state reported by status commands.

Reinstalling the same kit id from the same source with the same content is idempotent and leaves the registry unchanged. Installing a different source with an existing kit id fails with a conflict unless `--update` is passed. `--update` replaces the copied kit and registry entry after the new source validates. `--force` re-copies an existing same-source install after validation.

`list` and `status` are read-only. `list` prints one summary line per installed local kit. `status` prints JSON provenance and reports copied kit state as `installed` or `missing`.

## Runtime Activation

`activate` reads the built-in Kit Catalog and local install overlay, selects a runtime adapter, and writes generated runtime-local files into the destination workspace. When `--adapter` is omitted, Flow Agents selects the only implemented adapter:

```text
codex-local
```

Unknown adapter ids fail with JSON diagnostics that include the available adapters. No Claude, Kiro, framework, API, npm module extraction, or remote install adapters are implemented by this activation surface.

The `codex-local` adapter supports only Flow Definition assets declared in `flows`. It activates the built-in Builder Kit Flow Definitions, including `builder.shape` and `builder.build`, plus Flow Definitions from locally installed kit copies under:

```text
<dest>/kits/local/repositories/<kit-id>/
```

Activation reuses the installed local kit registry at `<dest>/kits/local/installed-kits.json`; it does not duplicate installed kit state and does not edit `kits/catalog.json`.

Generated files are written under:

```text
<dest>/.flow-agents/runtime/codex/
```

Flow Definition copies are placed under `flows/<kit-id>/<flow-id>.flow.json`, and activation writes an `activation.json` manifest in the same runtime-local area.

The stable activation diagnostics include:

- `selected_adapter`: selected adapter id, currently `codex-local`.
- `supported_asset_classes`: asset classes the selected adapter activates, currently `["flows"]`.
- `generated_runtime_files`: generated runtime-local files with asset class, path, kit id, asset id, and source path.
- `skipped_assets`: unsupported declared assets with asset class, path, kit id, asset id when present, and reason.
- `warnings`: recoverable catalog, registry, or asset discovery problems.
- `errors`: blocking discovery or activation problems.

Declared `skills`, `docs`, `adapters`, `evals`, and generic `assets` are diagnostic-only for this adapter. They are skipped with explicit `skipped_assets` entries; they are not copied, installed, invoked, or treated as active runtime behavior.

## Root Manifest

`kit.json` must be valid JSON at the repository root.

```json
{
  "schema_version": "1.0",
  "id": "example-kit",
  "name": "Example Kit",
  "product_name": "Example Kit",
  "description": "A local kit used to validate the repository contract.",
  "flows": [
    {
      "id": "example.review",
      "path": "flows/review.flow.json",
      "description": "Review a small change."
    }
  ],
  "docs": [
    {
      "id": "example.readme",
      "path": "docs/README.md"
    }
  ]
}
```

Required fields:

- `schema_version`: must be `"1.0"`.
- `id`: stable kebab-case kit id, such as `builder` or `example-kit`.
- `name`: non-empty display name.
- `flows`: non-empty list of Flow Definition entries. Each entry must be an object with `id` and `path`.

Optional fields:

- `product_name`: non-empty display name when the product name differs from `name`.
- `description`: non-empty summary.
- `skills`, `docs`, `adapters`, `evals`, `assets`: lists of relative asset paths or objects with `id`, `path`, and optional `description`.

## Path Rules

All declared paths are local to the kit directory. A path must be relative, must not contain `..`, and must point at an existing file or folder. Absolute paths are rejected because a kit must be portable between worktrees and machines.

Valid:

```json
{ "id": "example.review", "path": "flows/review.flow.json" }
```

Invalid:

```json
{ "id": "example.review", "path": "../flow/review.flow.json" }
```

Diagnostic:

```text
kit.json: flows[0].path must stay inside the kit directory; '..' path traversal is not allowed
```

## Flow Boundary

Flow Agents checks that a declared Flow Definition path is present and delegates Flow Definition validation to Flow with `flow validate-definition <path> --json` or the local Flow CLI fallback when available. If the Flow validation surface is unavailable, the source validator keeps only the existing minimal shape fallback and verification must record that gap as `NOT_VERIFIED`.

Flow Agents must not duplicate Flow gate semantics, trusted-producer rules, route-back behavior, or claim validation. Those belong to Flow.

## Scope

This contract and install surface are local repository validation, local runtime bookkeeping, and Codex-local Flow Definition activation only. Remote install is a non-goal: Flow Agents does not install remote kits, fetch git repositories, split npm packages, select adapter packages, invoke the full Builder Kit provider graph, or implement Claude, Kiro, framework, API, or provider adapters.

## Common Failures

- `kit.json: .schema_version must be "1.0"`: update the manifest schema version.
- `kit.json: .id must be a stable kebab-case string`: use a lowercase id such as `review-kit`.
- `kit.json: .flows must be a non-empty list`: declare at least one Flow Definition.
- `kit.json: flows[0].path points at missing Flow Definition`: add the file or fix the relative path.
- `kit.json: docs[0].path points at missing asset`: add the asset or remove the entry.
