---
title: Migrations
---

# Migrations

## Unreleased

- Workflow runtime artifacts now live under `.kontourai/flow-agents/` instead
  of earlier runtime roots such as `.flow-agents/` or `.agents/flow-agents/`.
  Move any local session directories, sidecars, or `current.json` pointers you
  want to keep into the new root. Runtime readers do not fall back to old roots.
  Runtime state remains ignored; promote durable outcomes into docs, source,
  schemas, or provider records before merge.
- Flow Agents setup no longer accepts Console bearer tokens as CLI arguments.
  Replace `--console-token TOKEN` with `--console-token-file PATH` for
  headless installs, or use the prompted `flow-agents init` flow. Interactive
  setup hides token input and passes it to installers through a temporary
  `0600` token file that is deleted after install.
- Telemetry setup now uses named sinks. Local file telemetry remains the
  default. Add `--telemetry-sink local-kontour-console`,
  `--telemetry-sink kontour-hosted-console`, or
  `--telemetry-sink user-hosted-console --console-url ...` to mirror local
  telemetry into a Console API. Legacy `kontour-cloud` and
  `hosted-kontour-console` names still work as aliases.
- Flow Agents now owns and ships `console.telemetry.json`. Console should load
  the descriptor from the Flow Agents product root rather than owning Flow
  Agents-specific telemetry facets or sidecar mappings.

## Evidence Reference Migration

Flow Agents sidecars now treat structured evidence reference objects as the schema contract. Legacy string refs in `acceptance.json` and `evidence.json` must be converted before validation.

Convert old strings like:

```json
"evidence_refs": ["npm run eval:static --silent"]
```

to objects like:

```json
"evidence_refs": [
  {
    "kind": "command",
    "excerpt": "npm run eval:static --silent",
    "summary": "Static eval suite passed."
  }
]
```

For source evidence, include file and line data:

```json
{
  "kind": "source",
  "url": "https://github.com/OWNER/REPO/blob/COMMIT_SHA/path/to/file.ts#L12-L24",
  "file": "path/to/file.ts",
  "line_start": 12,
  "line_end": 24,
  "excerpt": "Short excerpt that supports the acceptance claim."
}
```

Use immutable GitHub blob URLs pinned to a commit SHA when the commit/provider URL is available. Before publication, omit `url` and keep `file`, `line_start`, `line_end`, and `excerpt` as a local fallback. Upgrade local refs before provider closure whenever practical.
