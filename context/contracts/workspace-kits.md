# Workspace Kits v1

This contract defines the inert resolve/inspect slice of [#1418](https://github.com/kontourai/flow-agents/issues/1418), under extraction initiative [#1137](https://github.com/kontourai/flow-agents/issues/1137). Implementation and acceptance must follow these decisions; the contract alone is not an execution receipt.

## Scope and files

Every call names an existing scope directory and an existing cache directory. Canonicalize their roots once; refuse overlapping scope/cache/source roots and symlink roots. There is no parent search, Git-root discovery, runtime-home default, or merge of inherited settings. A Station Project is not a workspace Kit scope.

The scope contains `.flow-agents/workspace.kits.json` (declaration) and `.flow-agents/workspace.kits.lock.json` (resolved lock). Resolve never rewrites the declaration. These files do not replace `.flow-agents/config/<kit-id>.kit.config.json`, its committed-policy owner, or the legacy install registry.

The closed declaration has `schema_version: "1.0"`, `selected` (unique Kit IDs), `sources` (Kit ID to `{kind:"local", alias}`), `options: {}`, `provider_bindings: {}` and `contributions: "all"`. IDs and aliases use the existing lower-case Kit-ID grammar. Unsupported fields or nonempty options/bindings refuse. This slice has no contribution, gate or expectation suppression.

Resolve receives alias-to-existing-directory bindings separately. Absolute acquisition paths are local arguments, never lock identity. A declaration may list sources beyond the selected closure; they are not implicitly selected or read. Every transitive required dependency must have an explicit source declaration and binding when acquisition is necessary.

## Artifact identity and materialization

The new scheme is `flow-agents.kit-tree/v1`. It does not change legacy `observeKitContentHash` receipts.

The canonical input is UTF-8 JSON for `["flow-agents.kit-tree/v1", entries]`, with entries sorted by ordinal POSIX path. A directory record is `["directory", path, 0]`; a regular-file record is `["file", path, executable, size, contentSha256]`, where executable is 0 or 1 and contentSha256 is lower-case SHA-256 hex. Hash this framed serialization with SHA-256. Artifact IDs are `sha256:<64 lowercase hex>` within the named scheme; scheme and digest are inseparable contract fields.

Paths are relative UTF-8 NFC POSIX names with no traversal, controls, backslashes, colons, trailing dots/spaces, Windows reserved basenames or case-fold collisions. Keep directory entries, including empty directories. The root itself is implicit. Reject symlinks and non-regular special files. Read with no-follow semantics and verify file/directory identity around capture. Refuse detected source changes; this establishes exact staged bytes, not an atomic or coherent source snapshot against unrelated writers.

Prune `.git`, `__pycache__` and `.pytest_cache` path components before copying. Do not follow a pruned entry. Validate the staged root-shaped Kit so an asset declaration targeting pruned material refuses. No hidden exclusions apply to the published tree: every retained file and directory participates in its identity.

Normalize writable staging files to 0644 or 0755 according to their executable bit, and directories to 0755. Seal published files to 0444 or 0555 and directories to 0555. Write bits are not identity; executable behavior is. Do not claim protection from a malicious process already controlling the same OS user. Cache verification must detect changed bytes or executable bits before accepting a hit.

## Required closure and compatibility

Reuse public Flow container validation and existing Flow Agents extension validation on staged/cache artifact roots. Check the manifest Kit ID against its declaration. An actual manifest version may be retained; do not invent a release version when absent. Container schema v1 and this locked contract v1 are supported; unknown versions/schemes are `unsupported`.

V1 accepts only required dependency objects `{kit_id, reason?}`. Reject unknown dependency fields, including optional/version-selection semantics; do not let the legacy permissive parser discard them. Reject self edges, duplicates, cycles, absent bindings and conflicting identities. One artifact per Kit ID in a lock; separate scopes may select different artifacts for the same ID. Never satisfy a missing edge from bundled Kits or ambient installed registries.

The lock records `schema_version: "1.0"`, canonical declaration digest, sorted selected IDs and sorted artifact records. Each artifact records Kit ID, content scheme/digest, sorted required dependency IDs, manifest schema version and optional actual manifest version. No timestamps, absolute source/cache paths, credentials or Station Project identity enter the portable lock. Effective options and provider bindings are empty by contract, not silently defaulted.

## Publication and failure

The cache layout is versioned and content addressed. Artifact payloads and metadata have separate fixed locations; payload verification accounts for every payload entry. Immutable entries are never replaced or repaired in place. Corrupt entries refuse rather than falling back to the source.

Under a scope operation lock, capture declaration bytes and prior lock bytes. Stage the complete selected closure on the cache filesystem and validate every artifact before publishing any lock. Use per-artifact exclusion and atomic rename to publish a complete verified artifact entry. Concurrent scopes may reuse the same verified entry. Recheck the declaration and prior lock identities before a same-directory atomic replacement publishes the new complete lock.

Artifacts publish first, the portable lock last. Failure before lock replacement leaves the previous lock bytes intact; complete unreferenced cache entries may remain. Rollback must not delete shared published artifacts. A crash can leave staging or operation locks; return busy/recovery-required rather than reclaiming from age or PID absence. This contract covers process interruption, not fsync-backed power-loss durability.

V1 has no cache GC, activation, provisioning, install hooks, workflow execution, data migration or update of active runs. It does not remove consumer-owned files, evidence or Knowledge records. A future run-binding owner must retain exact artifacts and configuration before executing; a successful workspace lock is not proof the current workflow resolver uses it.

## Budgets and observations

The current filesystem implementation requires POSIX no-follow directory and mode semantics; unsupported platforms (including Windows in v1) refuse explicitly. The declaration and lock formats remain machine independent. Contract JSON files and the local binding file are bounded to 1 MiB.

Fixed v1 limits: 64 MiB per file, 256 MiB of file contents across the selected closure, 10,000 entries, depth 32, and 32 Kits. Count filesystem entries while enumerating; never read unbounded excluded content. Exceeding supported policy reports a named limit diagnostic, distinct from malformed data. No implicit larger budget is selected from host capacity.

Inspect is read-only: it does not create directories, acquire write locks, fetch source, activate a Kit or execute its code. Report canonical scope/cache roots, current declaration identity, previous/current lock identity and per-artifact observations. A declaration mismatch is `stale-declaration` and retains the prior lock identity; it does not imply deletion of those artifacts.

Stable outcomes are `verified`, `stale-declaration`, `missing`, `corrupt`, `unsupported`, `busy`, and `recovery-required`, with bounded specific diagnostics. Verified means the exact artifact bytes, supported manifest and closure passed current checks. It does not mean publisher trust, source-capture coherence, executable-flow readiness or human approval.

Public CLI: `flow-agents kit workspace resolve --scope <directory> --cache <directory> --bindings <local-json-file>` and `flow-agents kit workspace inspect --scope <directory> --cache <directory>`. Default resolve honors an existing matching lock and verified cache without reacquiring. Explicit `--update` admits a new resolution; missing locked artifacts require their explicit bindings and must reproduce the locked content identity. Inspect never reads those bindings. Public library consumers use the same resolver/inspector and outcomes.

## Acceptance boundary

Use neutral external two-Kit fixtures through the public caller in plain non-Git directories. Cover shared reuse, coexisting versions, offline inspection, declaration drift, missing/corrupt inputs, dependency closure, unsafe names/types, legacy digest-framing ambiguity, executable/empty-directory identity, budgets, concurrent resolution and process interruption. Tests must preserve old lock bytes and unrelated artifacts on refusal. Keep legacy install/activation and old run/data behavior unchanged; first-party extraction follows only after this contract is proven.
