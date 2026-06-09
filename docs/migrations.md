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
  `--telemetry-sink kontour-cloud`, or
  `--telemetry-sink hosted-kontour-console --console-url ...` to mirror local
  telemetry into a Console API.
