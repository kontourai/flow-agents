// Compiled by src/cli/light-host-subpaths.test.mjs: each light subpath carries the types the package root exports
// from the same source module, and those types are the root's own.
import type * as Root from "@kontourai/flow-agents";
import type { AbsentRunCorrelationIdentity, PresentRunCorrelationIdentity, RunCorrelationCarrier, RunCorrelationEnvelope, RunCorrelationIdentity, RunCorrelationIdentityKey, RunCorrelationIdentityStatus, RunCorrelationInput, RunCorrelationPresence, RuntimeCorrelationIdentityDeclaration, RuntimeCorrelationIdentitySupport } from "@kontourai/flow-agents/run-correlation";
import type { HostWorkflowAuthority, HostWorkflowBinding, HostWorkflowBindingInput, RetireHostWorkflowBindingInput } from "@kontourai/flow-agents/host-workflow-binding";
import type { ReadGroundedNarrativeInput, ReadGroundedNarrativeResult, RetainedNarrativeReadFailure, RetainedNarrativeReadLimits, RetainedNarrativeScope } from "@kontourai/flow-agents/narrative-retained-reader";
import type { ContinuePausedFlowGateFromSurveyInput, ContinuePausedFlowGateFromSurveyResult, ResolvedSurveyFlowGateReviewSession, SurveyFlowGateAdapterDependencies, SurveyFlowGateReviewSessionResolver } from "@kontourai/flow-agents/survey-flow-gate-adapter";
import type { DiscoverSurveyGateReviewWorkInput, PublishedSurveyGateReviewWork, PublishSurveyGateReviewWorkDependencies, SurveyGateReviewWorkProducer, SurveyGateReviewWorkQueue, SurveyGateReviewWorkRequest } from "@kontourai/flow-agents/survey-flow-gate-review-work";
import { flowAgentsArtifactRoot } from "@kontourai/flow-agents/local-artifact-root";
import { phases, statuses, writeJson } from "@kontourai/flow-agents/workflow-sidecar-vocabulary";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const same = <T extends true>(): T => true as T;

same<Same<AbsentRunCorrelationIdentity, Root.AbsentRunCorrelationIdentity>>();
same<Same<PresentRunCorrelationIdentity, Root.PresentRunCorrelationIdentity>>();
same<Same<RunCorrelationCarrier<{ id: string }>, Root.RunCorrelationCarrier<{ id: string }>>>();
same<Same<RunCorrelationEnvelope, Root.RunCorrelationEnvelope>>();
same<Same<RunCorrelationIdentity, Root.RunCorrelationIdentity>>();
same<Same<RunCorrelationIdentityKey, Root.RunCorrelationIdentityKey>>();
same<Same<RunCorrelationIdentityStatus, Root.RunCorrelationIdentityStatus>>();
same<Same<RunCorrelationInput, Root.RunCorrelationInput>>();
same<Same<RunCorrelationPresence, Root.RunCorrelationPresence>>();
same<Same<RuntimeCorrelationIdentityDeclaration, Root.RuntimeCorrelationIdentityDeclaration>>();
same<Same<RuntimeCorrelationIdentitySupport, Root.RuntimeCorrelationIdentitySupport>>();
same<Same<HostWorkflowAuthority, Root.HostWorkflowAuthority>>();
same<Same<HostWorkflowBinding, Root.HostWorkflowBinding>>();
same<Same<HostWorkflowBindingInput, Root.HostWorkflowBindingInput>>();
same<Same<RetireHostWorkflowBindingInput, Root.RetireHostWorkflowBindingInput>>();
same<Same<ReadGroundedNarrativeInput, Root.ReadGroundedNarrativeInput>>();
same<Same<ReadGroundedNarrativeResult, Root.ReadGroundedNarrativeResult>>();
same<Same<RetainedNarrativeReadFailure, Root.RetainedNarrativeReadFailure>>();
same<Same<RetainedNarrativeReadLimits, Root.RetainedNarrativeReadLimits>>();
same<Same<RetainedNarrativeScope, Root.RetainedNarrativeScope>>();
same<Same<ContinuePausedFlowGateFromSurveyInput, Root.ContinuePausedFlowGateFromSurveyInput>>();
same<Same<ContinuePausedFlowGateFromSurveyResult, Root.ContinuePausedFlowGateFromSurveyResult>>();
same<Same<ResolvedSurveyFlowGateReviewSession, Root.ResolvedSurveyFlowGateReviewSession>>();
same<Same<SurveyFlowGateAdapterDependencies, Root.SurveyFlowGateAdapterDependencies>>();
same<Same<SurveyFlowGateReviewSessionResolver, Root.SurveyFlowGateReviewSessionResolver>>();
same<Same<DiscoverSurveyGateReviewWorkInput, Root.DiscoverSurveyGateReviewWorkInput>>();
same<Same<PublishedSurveyGateReviewWork, Root.PublishedSurveyGateReviewWork>>();
same<Same<PublishSurveyGateReviewWorkDependencies, Root.PublishSurveyGateReviewWorkDependencies>>();
same<Same<SurveyGateReviewWorkProducer, Root.SurveyGateReviewWorkProducer>>();
same<Same<SurveyGateReviewWorkQueue, Root.SurveyGateReviewWorkQueue>>();
same<Same<SurveyGateReviewWorkRequest, Root.SurveyGateReviewWorkRequest>>();
same<Same<typeof flowAgentsArtifactRoot, typeof Root.flowAgentsArtifactRoot>>();
same<Same<typeof phases, typeof Root.phases>>();
same<Same<typeof statuses, typeof Root.statuses>>();
same<Same<typeof writeJson, typeof Root.writeJson>>();
