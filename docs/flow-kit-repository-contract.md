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

## Install From A Local Path Or Git

Flow Agents accepts either a local kit repository path or a Git URL:

```bash
npm run kit -- install path/to/local-kit --dest /path/to/installed-flow-agents
npm run kit -- install https://github.com/example/example-kit.git#v1.0.0 --dest /path/to/installed-flow-agents
npm run kit -- list --dest /path/to/installed-flow-agents
npm run kit -- status --dest /path/to/installed-flow-agents
npm run kit -- status example-kit --dest /path/to/installed-flow-agents
npm run kit -- activate --dest /path/to/installed-flow-agents --format json
```

`--dest` is the installed bundle, workspace root, isolated Codex home, or test fixture destination. When omitted, Codex-oriented kit commands install into the normal Codex home: `CODEX_HOME` when it is set, otherwise `~/.codex`. Pass `--dest` to override that destination for workspace installs, isolated homes, or tests.

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
- `source`: local source path used for the install, or caller-declared logical provenance supplied with local-only `--record-source <locator>`. `--record-source` is metadata and is not independently acquired or verified.
- `hash`: `sha256:` content hash of the installed repository bytes; this is the verified byte identity, not `source` metadata.
- `version`: optional manifest version when a future contract permits one.
- `installed_at`: UTC ISO timestamp.
- `installed_path`: canonical POSIX repository-relative path, always `kits/local/repositories/<kit-id>`.
- `state`: install state recorded at install time. Read-only status observation reports the current state separately and never rewrites this registry field.

Reinstalling the same kit id from the same source metadata with the same content is idempotent and leaves the registry unchanged. `--record-source <locator>` is available only for local paths, so callers can preserve logical provenance across source-directory moves; it must be trimmed and non-blank, at most 1024 characters, and contain no Unicode control (`Cc`), format (`Cf`), line-separator (`Zl`), or paragraph-separator (`Zp`) characters. This includes C0/C1 controls (`U+0000`–`U+001F`, `U+007F`–`U+009F`), U+2028, U+2029, and bidirectional format controls such as U+202E. Git installs reject `--record-source` and retain their normalized URL/ref provenance. Installing a different source with an existing kit id fails with a conflict unless `--update` is passed. `--update` replaces the copied kit and registry entry after the new source validates. `--force` re-copies an existing same-source install after validation.

Git sources are shallow-cloned into a temporary directory and validated at the clone root. A
repository installed from Git must therefore place `kit.json` at its root; subdirectory selection
is not supported. Use a URL `#ref` fragment or `--ref <branch|tag|sha>` to pin the source. Install
records the normalized URL/ref and content hash, and never executes scripts from the cloned
repository.

`list` and `status` are read-only. `list` prints one summary line per installed kit. `status` prints JSON provenance plus `recorded_hash` and `observed_hash`, and reports copied-kit state as one of:

- `installed`: the safely observed tree exactly matches the recorded hash.
- `drifted`: the safely observed tree is present but its canonical content hash differs from the recorded hash.
- `missing`: the registered copied tree is absent.
- `invalid`: the registry entry or copied tree cannot be safely observed (including symlinks, special files, unreadable paths, and paths replaced during observation).

The canonical tree hash sorts relative paths in locale-independent code-unit order and hashes each regular file's path and bytes, while excluding the VCS/cache paths excluded by installation (`.git`, `__pycache__`, and `.pytest_cache`). Observation derives the copied Kit target only from the current trusted destination plus kit id; it never follows a registry-supplied target. It accepts the canonical relative `installed_path`, and accepts a legacy absolute value only when it exactly equals that current destination target. Relative aliases, traversal, controls, and an absolute path from another checkout are invalid. Observation never follows symlinks: for an installed Kit it checks every component from the requested destination root through the copied Kit root, so intermediate and dangling links are invalid too. Status and activation do not repair or rewrite registry metadata; reinstall (or `--force` for the same source) is the explicit refresh path.

## Runtime Activation

`activate` reads the built-in Kit Catalog and local install overlay, selects a runtime adapter, and writes generated non-durable projection files into the destination workspace. When `--adapter` is omitted, Flow Agents selects the only implemented adapter:

```text
codex-local
```

Unknown adapter ids fail with JSON diagnostics that include the available adapters. Git fetching belongs to install, not activation; activation still does not perform npm module extraction or execute kit setup code.

The `codex-local` adapter supports assets declared in `flows`, `skills`, and `docs`. It activates the built-in Builder Kit Flow Definitions, including `builder.shape` and `builder.build`, plus supported assets from locally installed kit copies under:

```text
<dest>/kits/local/repositories/<kit-id>/
```

Activation reuses the installed local kit registry at `<dest>/kits/local/installed-kits.json`; it does not duplicate installed kit state and does not edit `kits/catalog.json`. It performs the same read-only integrity observation as `kit status`: missing and invalid local copies are skipped with a warning, and a drifted but safely readable copy emits a warning with both hashes and remains activatable for this warning-only rollout. Before generating runtime files, activation copies a safely observed local Kit to a private staging snapshot and generates only from that snapshot, so a later replacement cannot change the activated bytes. Malformed registry entries, including missing or non-string ids, are warnings and are skipped. Drift is therefore never represented as registry-matched, but it is not yet an activation blocker.

Generated adapter projections are written under:

```text
<dest>/.kontourai/flow-agents/projections/codex/
```

Flow Definition copies are placed under `flows/<kit-id>/<flow-id>.flow.json`, and activation writes an `activation.json` manifest in the same projection area. These files are regenerable from the Kit Catalog plus `kits/local`; they are not the durable run state for a workflow.

The stable activation diagnostics include:

- `selected_adapter`: selected adapter id, currently `codex-local`.
- `supported_asset_classes`: asset classes the selected adapter activates, currently `["flows", "skills", "docs"]`.
- `generated_runtime_files`: generated runtime-local files with asset class, path, kit id, asset id, and source path.
- `skipped_assets`: unsupported declared assets with asset class, path, kit id, asset id when present, and reason.
- `warnings`: recoverable catalog, registry, or asset discovery problems.
- `errors`: blocking discovery or activation problems.

Declared `skills` and `docs` are copied into the runtime projection alongside flows. Declared `adapters`, `evals`, generic `assets`, and `provisions` are diagnostic-only for this adapter. They are skipped with explicit `skipped_assets` entries; they are not copied, installed, invoked, or treated as active runtime behavior.

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
  ],
  "provisions": [
    {
      "id": "example-kit.editor-policy",
      "path": "provisions/editor-policy.json",
      "target": ".editor/policy.json",
      "description": "Initial repository policy."
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
- `provisions`: a list of objects with kit-id-prefixed `id`, source `path`, consumer-repository-relative `target`, and optional `description`.

## Repository Provisioning

Provision entries declare inert files; kits do not execute installer code. Source paths follow the other extension-asset rules: they must be relative, stay inside the kit directory, and name an existing regular file. Targets must be non-empty relative paths, must not contain traversal segments or resolve outside the consumer repository, must not be inside `.git`, and must be unique after normalization.

Provision a catalog kit, an installed-registry kit, or a kit at a direct local path with:

```bash
flow-agents kit provision <kit-id-or-path> [--target <consumer-repo>] [--force] [--dry-run]
```

`--target` defaults to the current working directory and must already be a directory. The engine resolves the real path of the deepest existing destination ancestor before writing, so a symlink cannot redirect a provision outside the target repository. It preflights the whole declaration: by default, any existing destination reports every conflict, exits nonzero, and writes none of the provisioned files. `--force` replaces declared destination files. `--dry-run` prints every source-to-target mapping and writes nothing.

After a successful non-dry-run copy, Flow Agents writes or replaces this bookkeeping manifest:

```text
<target>/.kontourai/flow-agents/provisions/<kit-id>.json
```

The schema is `{ schema_version: "1.0", kit_id, kit_hash, provisioned_at, files: [{ id, target }] }`. Provisioned files become consumer-repository content; uninstalling or deactivating the kit does not remove them.

When `flow-agents init --activate-kit <id>` successfully activates a selected kit, init invokes the same provisioning engine against its destination with create-only semantics. Existing destinations are reported as skipped warnings and do not fail an init rerun. Provisions never enter the runtime projection directory.

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

This contract covers local and Git-backed repository installation, local runtime bookkeeping, and Codex-local Flow Definition activation. Git sources are shallow-cloned only during an explicit `kit install`; activation never fetches repositories or executes setup code from the kit. Flow Agents does not split npm packages, select adapter packages, invoke the full Builder Kit provider graph, or implement Claude, Kiro, framework, API, or provider adapters.

## Common Failures

- `kit.json: .schema_version must be "1.0"`: update the manifest schema version.
- `kit.json: .id must be a stable kebab-case string`: use a lowercase id such as `review-kit`.
- `kit.json: .flows must be a non-empty list`: declare at least one Flow Definition.
- `kit.json: flows[0].path points at missing Flow Definition`: add the file or fix the relative path.
- `kit.json: docs[0].path points at missing asset`: add the asset or remove the entry.
