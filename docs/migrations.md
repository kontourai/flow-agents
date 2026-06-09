# Migrations

## Unreleased

- Workflow runtime artifacts now live under `.flow-agents/` instead of
  `.agents/flow-agents/`. Move any local session directories, sidecars, or
  `current.json` pointers you want to keep into the new root. Runtime state
  remains ignored; promote durable outcomes into docs, source, schemas, or
  provider records before merge.
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
