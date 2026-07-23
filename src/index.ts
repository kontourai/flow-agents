/**
 * Public library surface for `@kontourai/flow-agents`.
 *
 * Native orchestration hosts can import the canonical workflow runtime and
 * sidecar writer/validator instead of reimplementing validated state changes.
 * Agent-facing Kit guidance uses the public `flow-agents workflow` CLI.
 *
 * The sidecar JSON Schemas ship under `schemas/` and can be validated against
 * directly (also resolvable via the package's `./schemas/*` export subpath);
 * the helpers below are the canonical writer/validator that produce and check
 * conforming artifacts.
 *
 * `workItemStatuses`, `WorkItemStatus`, `WorkItem`, `SourceProvider`, and
 * `BoardMembership` are the canonical provider-neutral work-item vocabulary
 * and shapes from `context/contracts/work-item-contract.md`; hosts should
 * import these instead of hand-mirroring them.
 *
 * `WorkItemProvider`, `BoardProvider`, `AssignmentProvider`, and `WorkItemMutationProvider` are
 * the four provider-role TypeScript interfaces (#777) for the CLIs those roles are implemented
 * by; `createLocalFileAssignmentProvider`/`createLocalFileMutationProvider` are local-file
 * adapters that formally satisfy the latter two.
 *
 * @module
 */
import * as path from "node:path";
import { loadJson as _loadJson, writeJson as _writeJson } from "./cli/workflow-sidecar.js";

export {
  NARRATIVE_SOURCE_ID_VERSION,
  SourceIdParseError,
  compareSourceIds,
  formatSourceId,
  parseSourceId,
} from "./narrative/source-ids.js";
export type {
  AgentEventSourceId,
  ChainedCommandLogSourceId,
  CommandLogSourceId,
  FileSourceId,
  FlowReportSourceId,
  FlowStateSourceId,
  FlowTransitionSourceId,
  LegacyCommandLogSourceId,
  NarrativeSourceId,
  NarrativeSourceStream,
  SourceIdErrorCode,
  SurfaceExplanationSourceId,
  TelemetrySourceId,
  TranscriptSourceId,
  TrustSourceId,
} from "./narrative/source-ids.js";
export {
  DEFAULT_INTEGRITY_CLASS,
  KNOWN_CAPTURE_GAPS,
  buildCaptureCompleteness,
  integrityClassForSource,
} from "./narrative/integrity.js";
export type {
  CaptureChannelStatus,
  CaptureCompleteness,
  IntegrityClass,
  KnownGapClass,
  UnavailableReason,
} from "./narrative/integrity.js";
export {
  TELEMETRY_CHANNEL_ANALYTICS_REDACT_DEFAULT,
  TELEMETRY_CHANNEL_FULL_REDACT_DEFAULT,
  effectiveNarrativeRedactionFields,
  filterNarrativeRecord,
} from "./narrative/policy-filter.js";
export type { NarrativePolicyFilterResult } from "./narrative/policy-filter.js";
export { snapshotNarrative, validateNarrativeSourceManifest } from "./narrative/snapshot.js";
export type {
  NarrativeLineageEvent,
  NarrativeSourceManifest,
  NarrativeSourceManifestEntry,
  NarrativeSourceOrigin,
  NarrativeSourceRequest,
  NarrativeSourceRoots,
  SnapshotNarrativeDependencies,
  SnapshotNarrativeInput,
} from "./narrative/snapshot.js";
export { resolveManifestEntry, resolveSource, verifyManifest } from "./narrative/resolver.js";
export type { FrozenManifestEntry, ResolveSourceOptions, ResolveSourceResult, VerifyManifestReport } from "./narrative/resolver.js";
export {
  NARRATIVE_RUNTIME_PROJECTION_SCHEMA_VERSION,
  NARRATIVE_RUNTIME_PROJECTOR,
  NarrativeProjectionError,
  projectRuntimeNarrative,
  stableStringify,
  validateNarrativeRuntimeProjection,
} from "./narrative/projection.js";
export {
  GROUNDED_EXECUTION_NARRATIVE_COMPILER_NAME,
  GROUNDED_EXECUTION_NARRATIVE_SCHEMA_VERSION,
  GroundedNarrativeError,
  composeGroundedNarrative,
  validateGroundedNarrative,
  writeEnvelope,
} from "./narrative/envelope.js";
export { renderGroundedNarrative } from "./narrative/render.js";
export type {
  GroundedExecutionNarrative,
  GroundedNarrativeConclusion,
  GroundedNarrativeConfig,
  GroundedNarrativeCorrelation,
  GroundedNarrativeErrorCode,
  GroundedNarrativeFlowTransition,
  GroundedNarrativeForeignSection,
  GroundedNarrativeRule,
  GroundedNarrativeRuntimeSection,
  GroundedNarrativeSection,
  SchemaIssue as GroundedNarrativeSchemaIssue,
  WriteEnvelopeOptions,
  WrittenGroundedNarrative,
} from "./narrative/envelope.js";
export type {
  NarrativeRuntimeProjection,
  NarrativeProjectionErrorCode,
  ProjectRuntimeNarrativeOptions,
  RuntimePurpose,
  RuntimeProjectionTurn,
} from "./narrative/projection.js";
export { QUARANTINE_SESSION_ID, TURN_SPINE_RULE_ID, buildTurnSpine } from "./narrative/turn-spine.js";
export type { ResolvedTelemetryRecord, Turn, TurnBoundary } from "./narrative/turn-spine.js";
export {
  AGENT_STATED_ACTOR_MAX_LENGTH,
  AGENT_STATED_PURPOSE_MAX_LENGTH,
  NarrativeStatementError,
  agentStatedIntent,
  derivedNoOpTurn,
  derivedRetry,
  derivedTimeout,
  derivedUnavailableSource,
  observedCommand,
  observedDelegation,
  observedFileCreation,
  observedToolAction,
  summarizerInferredConnective,
  workflowDerivedPurpose,
} from "./narrative/statements.js";
export type {
  NarrativeStatementErrorCode,
  ObservedResult,
  Statement,
  StatementClass,
  StatementRule,
} from "./narrative/statements.js";

// #622: bounded, capability-declared at-action stated-intent capture + the
// annotation-on/off A/B measurement with uncertainty.
export {
  INTENT_ANNOTATION_FILE,
  INTENT_ANNOTATION_SCHEMA_VERSION,
  bindIntentAnnotation,
  captureIntent,
} from "./narrative/intent.js";
export type {
  CaptureIntentDependencies,
  CaptureIntentInput,
  CapturedIntent,
  IntentAnnotation,
  IntentCapabilityStatus,
  IntentCaptureMode,
} from "./narrative/intent.js";
export {
  INTENT_ECONOMICS_FILE,
  appendIntentEconomics,
  readIntentEconomics,
  reduceIntentEconomics,
} from "./narrative/intent-economics.js";
export type {
  IntentAnnotationMode,
  IntentEconomicsDelta,
  IntentEconomicsRecord,
  IntentEconomicsSummary,
} from "./narrative/intent-economics.js";
export {
  entailmentIndependenceHolds,
  isAssertionProhibited,
  materialEventCoverage,
  NarrativeGroundingError,
  validateNarrativeGrounding,
} from "./narrative/grounding-validator.js";
export type {
  AssertionKind,
  EntailmentIdentity,
  EntailmentProvenance,
  EntailmentVerdict,
  GroundingKnownGap,
  GroundingViolation,
  GroundingViolationCode,
  GroundingVerdict,
  MaterialEventClassCoverage,
  MaterialEventCoverage,
  MaterialEventKind,
  ValidateNarrativeGroundingOptions,
} from "./narrative/grounding-validator.js";

// #612: consolidated grounded-narrative eval-result schema + ajv-free validator.
// The shared, versioned package (corpus.json + this result schema) consumed by
// kontourai/evals#95 unmodified (R6/AC6).
export {
  NARRATIVE_EVAL_RESULT_SCHEMA_VERSION,
  validateNarrativeEvalResult,
} from "./narrative/eval-result.js";
export type {
  NarrativeEvalCapabilityParity,
  NarrativeEvalFixtureResult,
  NarrativeEvalKnownGap,
  NarrativeEvalMetricUncertainty,
  NarrativeEvalMetrics,
  NarrativeEvalRawSourceLink,
  NarrativeEvalResult,
  NarrativeEvalVerdict,
  SchemaIssue as NarrativeEvalResultSchemaIssue,
} from "./narrative/eval-result.js";

// #614: model-assisted prose renderer (display-only, fail-closed). Lives outside
// src/narrative/ (I/O, provider gating, timeout orchestration; see narrative-render.ts's
// header comment) but is exported here alongside the pure narrative primitives it composes.
export {
  GeneratorTimeoutError,
  PROSE_ECONOMICS_FILE,
  PROSE_PROMPT_VERSION,
  ProviderNotAllowedError,
  hostedModelGenerator,
  localModelGenerator,
  providerAllowed,
  renderProse,
  stubGenerator,
} from "./cli/narrative-render.js";
export type {
  GeneratedProse,
  ModelGeneratorConfig,
  ProseEconomicsRecord,
  ProseGenerator,
  ProseGeneratorInput,
  ProseGeneratorSentence,
  ProseGeneratorUsage,
  ProseRenderOutcome,
  ProseSourceView,
  ProviderConfig,
  ProviderOptIn,
  RenderProseOptions,
  RenderProseResult,
} from "./cli/narrative-render.js";

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
  createSurveyFlowGateAdapter,
  continuePausedFlowGateFromSurvey,
  SurveyFlowGateInputError,
} from "./survey-flow-gate-adapter.js";

export {
  bindSurveyGateReviewItem,
  discoverSurveyGateReviewWork,
  publishSurveyGateReviewWork,
} from "./survey-flow-gate-review-work.js";
export type {
  DiscoverSurveyGateReviewWorkInput,
  PublishedSurveyGateReviewWork,
  PublishSurveyGateReviewWorkDependencies,
  SurveyGateReviewWorkProducer,
  SurveyGateReviewWorkQueue,
  SurveyGateReviewWorkRequest,
} from "./survey-flow-gate-review-work.js";
export type {
  ContinuePausedFlowGateFromSurveyInput,
  ContinuePausedFlowGateFromSurveyResult,
  ResolvedSurveyFlowGateReviewSession,
  SurveyFlowGateAdapterDependencies,
  SurveyFlowGateReviewSessionResolver,
} from "./survey-flow-gate-adapter.js";

export {
  deriveBuilderGateActionEnvelope,
  gateActionProgressSnapshot,
  withGateActionPriorProgress,
} from "./builder-gate-action-envelope.js";

export {
  CHANGE_PROVIDER_CAPABILITIES,
  PUBLISH_CHANGE_OPERATION,
  PUBLISH_CHANGE_OPERATION_PROTOCOL,
  publishChangeOperationProtocol,
  resolveChangeProviderSupport,
} from "./cli/public-contracts.js";
export type {
  ChangeProviderCapability,
  ChangeProviderSettings,
  ChangeProviderSupport,
  PublishChangeActionBinding,
  PublishChangeOperationProtocol,
} from "./cli/public-contracts.js";
export type {
  BuilderGateActionEnvelopeInput,
  GateActionArtifactBinding,
  GateActionArtifactTarget,
  GateActionEnvelope,
  GateActionInterfaceParameter,
  GateActionPriorProgress,
  GateActionProgressSnapshot,
  GateActionPublicMutation,
} from "./builder-gate-action-envelope.js";

export {
  ContinuationAdapterTimeoutError,
  MAX_CONTINUATION_ADAPTER_EVIDENCE_BYTES,
  MAX_CONTINUATION_TURN_RESULT_BYTES,
  createFileContinuationStore,
  driveBuilderFlowSession,
  runContinuationDriver,
  withContinuationDriverLock,
} from "./continuation-driver.js";
export type {
  ContinuationBarrier,
  ContinuationContextPolicy,
  ContinuationContextStrategy,
  ContinuationAcceptedTurn,
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
export { builderLifecycleAuthorizationPayload, buildUnsignedCritiqueResolutionAuthorization, critiqueResolutionAuthorizationPayload, loadBuilderLifecycleAuthorization } from "./builder-lifecycle-authority.js";
export type { BuilderLifecycleAuthorization, CritiqueResolutionAuthorization } from "./builder-lifecycle-authority.js";

export { workItemStatuses } from "./lib/work-item-vocabulary.js";
export type {
  BoardMembership,
  SourceProvider,
  WorkItem,
  WorkItemStatus,
} from "./lib/work-item-vocabulary.js";

// #776: provider-neutral work-item MUTATION vocabulary (status transition, field update,
// comment) plus the shared conflict-detection function every adapter
// (src/cli/work-item-mutation-provider.ts's GitHub render-only and local-file real-I/O adapters)
// calls instead of reimplementing the "provider wins, with staleness detection" comparison. See
// context/contracts/work-item-contract.md's "Mutations" section for the governing prose.
export {
  WORK_ITEM_MUTATION_SCHEMA_VERSION,
  WorkItemMutationError,
  detectMutationConflict,
  parseObservedWorkItemState,
  parseWorkItemMutationRequest,
  workItemMutationOperations,
  workItemMutationResultStatuses,
} from "./lib/work-item-mutations.js";
export type {
  WorkItemCanonicalStatus,
  WorkItemCommentPayload,
  WorkItemFieldUpdatePayload,
  WorkItemMutationBase,
  WorkItemMutationConflict,
  WorkItemMutationFieldValue,
  WorkItemMutationOperation,
  WorkItemMutationRef,
  WorkItemMutationRequest,
  WorkItemMutationResult,
  WorkItemMutationResultStatus,
  WorkItemStatusTransitionPayload,
} from "./lib/work-item-mutations.js";

// #777: provider-neutral TypeScript interfaces for the four provider roles (WorkItemProvider,
// BoardProvider, AssignmentProvider, WorkItemMutationProvider) this repository already
// implements as CLIs, plus the `AssignmentProvider`/`ActorStruct`/`AssignmentClaimRecord`/
// `AssignmentStatus` shapes those interfaces are typed against (assignment-provider-contract.md,
// formalizing ADR 0021 §2), `canonicalHolderActorKey` (the one canonical actor-key comparison
// rule every holder-identity check in this repository should share), and three adapters that
// formally satisfy `AssignmentProvider`/`WorkItemMutationProvider`: two local-file
// (`local-file-provider-adapters.ts`) and one GitHub-render (`github-mutation-renderer.ts`).
// Native hosts should import these instead of shelling out to the CLIs or hand-mirroring their
// I/O shapes. See `src/cli/provider-interfaces.ts` for the full per-interface documentation,
// including flagged discrepancies between contract prose and the reference CLIs' actual behavior
// — notably `WorkItemDriftOutcome` (the contract's normative material-drift JUDGMENT vocabulary,
// produced by pickup Probe for routing) vs. `ReferenceAdapterFreshnessDiagnostic` (the reference
// CLI's mechanical revision-freshness SEVERITY diagnostic) — two distinct dimensions, not
// competing vocabularies for one signal; see `WorkItemDriftOutcome`'s doc comment (#818) for how
// they compose.
export type {
  AssignmentClaimMeta,
  AssignmentProvider,
  AssignmentReleaseMeta,
  AssignmentSupersedeMeta,
  BacklogProviderCapability,
  BacklogProviderRepoRef,
  BoardIntakeGapItem,
  BoardProvider,
  BoardProviderBoardRef,
  BoardProviderSettings,
  BoardProviderWarning,
  BoardReadResult,
  ClassifiedWorkItem,
  EffectiveBacklogProviderSettings,
  LocalAssignmentProviderExt,
  ProviderMutationContext,
  ReferenceAdapterFreshnessDiagnostic,
  WorkItemDependencyImpact,
  WorkItemDriftOutcome,
  WorkItemListOptions,
  WorkItemListResult,
  WorkItemMutationCapability,
  WorkItemMutationPolicy,
  WorkItemMutationProvider,
  WorkItemProvider,
  WorkItemProviderSettings,
  WorkItemProviderWarning,
  WorkItemReadiness,
  WorkItemReadinessClassification,
  WorkItemReadinessReason,
  WorkItemRevisionFreshness,
  WorkItemRevisionFreshnessRouteRecommendation,
  WorkItemSelectionFilters,
  WorkItemSelectionSettings,
  WorkItemWipPolicy,
} from "./cli/provider-interfaces.js";
export type { ActorStruct, AssignmentClaimRecord, AssignmentStatus } from "./cli/assignment-provider.js";
export { canonicalHolderActorKey } from "./cli/assignment-provider.js";
export { createLocalFileAssignmentProvider, createLocalFileMutationProvider } from "./cli/local-file-provider-adapters.js";
export { createGithubMutationRenderer } from "./cli/github-mutation-renderer.js";
// The reference adapter's OWN runtime classification vocabularies (#777 review finding 5) — the
// same arrays `WorkItemReadinessClassification`/`ReferenceAdapterFreshnessDiagnostic` derive their
// types from, exported as values too so a consumer can validate an observed classification against
// the live vocabulary instead of a hand-copied list.
export { workItemReadinessClassifications, referenceAdapterFreshnessDiagnostics } from "./cli/pull-work-provider.js";

export {
  CAPABILITIES,
  RUNTIME_ADAPTER_IDS,
  RUNTIME_CAPABILITY_DECLARATIONS,
  RUNTIME_ID_ALIASES,
  getDeclaration,
  normalizeRuntimeId,
  queryCapability,
} from "./lib/capability-declarations.js";
export type {
  Capability,
  CapabilityStatus,
  RuntimeAdapterId,
  RuntimeCapabilityDeclaration,
} from "./lib/capability-declarations.js";

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
