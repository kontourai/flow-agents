// `@kontourai/flow-agents/local-artifact-root`: the artifact-root and telemetry-directory helpers, without the package root's import graph.
// Re-exports exactly what the package root exports from this module; widen both together.
export {
  defaultArtifactRootForRead,
  defaultCodexHome,
  defaultTelemetryDirForRead,
  defaultTelemetryDirsForRead,
  durableFlowAgentsRoot,
  durableInstallRecordPath,
  DURABLE_FLOW_AGENTS_DIR,
  FLOW_AGENTS_RUNTIME_DIR,
  FLOW_AGENTS_RUNTIME_SUBDIR,
  firstExistingPath,
  flowAgentsArtifactRoot,
  KONTOURAI_DIR,
  legacyTelemetryDataDir,
  LEGACY_TELEMETRY_DIR,
  telemetryDataDir,
} from "../lib/local-artifact-root.js";
