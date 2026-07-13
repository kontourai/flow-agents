/**
 * Public library surface for `@kontourai/flow-agents`.
 *
 * Native orchestration hosts can import the canonical workflow runtime and
 * sidecar writer/validator instead of reimplementing validated state changes.
 * Agent-facing Kit guidance uses the public `flow-agents workflow` CLI.
 *
 * The sidecar JSON Schemas ship under `schemas/` and can be validated against
 * directly; the helpers below are the canonical writer/validator that produce
 * and check conforming artifacts.
 *
 * @module
 */
import * as path from "node:path";
import { loadJson as _loadJson, writeJson as _writeJson } from "./cli/workflow-sidecar.js";

export {
  BUILDER_BUILD_FLOW_ID,
  BUILDER_BUILD_FLOW_RELATIVE_PATH,
  BuilderBuildRunInputError,
  BuilderBuildRunIdentityError,
  evaluateBuilderBuildRun,
  loadBuilderBuildRun,
  resolveBuilderBuildFlowDefinitionPath,
  startBuilderBuildRun,
} from "./builder-flow-run-adapter.js";
export type {
  BuilderBuildRunResult,
  BuilderBuildRunIdentityMismatch,
  BuilderBuildTrustBundleEvidenceInput,
  EvaluateBuilderBuildRunInput,
  LoadBuilderBuildRunInput,
  StartBuilderBuildRunInput,
} from "./builder-flow-run-adapter.js";

export {
  archiveBuilderFlowSession,
  cancelBuilderFlowSession,
  pauseBuilderFlowSession,
  recoverBuilderFlowSession,
  releaseBuilderFlowAssignment,
  resumeBuilderFlowSession,
  startBuilderFlowSession,
  syncBuilderFlowSession,
} from "./builder-flow-runtime.js";
export type { BuilderFlowAgentLifecycleInput, BuilderFlowAuthorizedLifecycleInput, BuilderFlowSessionInput, BuilderFlowSessionResult } from "./builder-flow-runtime.js";

export {
  ContinuationAdapterTimeoutError,
  createFileContinuationStore,
  driveBuilderFlowSession,
  runContinuationDriver,
  withContinuationDriverLock,
} from "./continuation-driver.js";
export type {
  ContinuationBarrier,
  ContinuationDriverEvent,
  ContinuationDriverLockLease,
  ContinuationDriverOutcome,
  ContinuationDriverState,
  ContinuationRuntimePort,
  ContinuationSnapshot,
  ContinuationStateStore,
  ContinuationTurnAuthority,
  ContinuationTurnContext,
  ContinuationTurnRequest,
  ContinuationTurnResult,
  DriveBuilderFlowSessionInput,
  RunContinuationDriverInput,
} from "./continuation-driver.js";

// Pure serialization contract used by external lifecycle authorities when
// signing requests. This does not load, create, or mutate a Flow run.
export { builderLifecycleAuthorizationPayload, loadBuilderLifecycleAuthorization } from "./builder-lifecycle-authority.js";
export type { BuilderLifecycleAuthorization } from "./builder-lifecycle-authority.js";

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
} from "./lib/local-artifact-root.js";

export {
  // Trust-bundle (Hachure) validation — the same validator the writer uses.
  validateTrustBundle,
  // Evidence / check / learning validation + normalization. These throw on
  // invalid input (with the same messages the CLI surfaces) and return the
  // normalized object on success.
  normalizeCheck,
  normalizeFinding,
  normalizeLearning,
  normalizeEvidenceRefs,
  validateEvidenceRef,
  validateLearningCorrection,
  // Sidecar read / merge / write primitives.
  loadJson,
  writeJson,
  appendJsonl,
  sidecarBase,
  writeState,
  // Schema vocabularies (the allowed status/phase/kind values).
  statuses,
  phases,
  checkKinds,
  checkStatuses,
  verdicts,
} from "./cli/workflow-sidecar.js";

/** Read a sidecar JSON file from a workflow artifact directory; returns `{}` if absent. */
export function readSidecar(dir: string, name: string): Record<string, any> {
  return _loadJson(path.join(dir, name));
}

/** Write a sidecar JSON file into a workflow artifact directory (pretty-printed, trailing newline). */
export function writeSidecar(dir: string, name: string, payload: Record<string, any>): void {
  _writeJson(path.join(dir, name), payload);
}
