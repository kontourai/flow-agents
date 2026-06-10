---
title: Kontour Resource Contract
---

# Kontour Resource Contract

Kontour Resource Contracts are the durable, versioned record shape for Flow Agents configuration, selected scope, workflow state, evidence pointers, provider output, and cross-product interchange.

They are Kubernetes-inspired, not Kubernetes-dependent. A local file, a provider-backed Work Item, a workflow sidecar, a CLI output, or a future control-plane record can all use the same contract shape. Kubernetes CRDs or operators may become adapters over these records later, but Kubernetes is not the Flow Agents runtime substrate.

This page is the canonical Flow Agents reference skeleton. It documents contract shape and vocabulary only; it does not migrate existing sidecars, change provider behavior, add schemas, or alter Flow, Surface, Veritas, Console, or Builder Kit runtime behavior.

## Contract Shape

Every durable Flow Agents resource should follow this shape unless a product records an explicit exception or mapping.

```yaml
apiVersion: flowagents.kontourai.io/v1alpha1
kind: ResourceKind
metadata:
  name: resource-name
  uid: stable-resource-id
  namespace: optional-project-or-provider-scope
  labels: {}
  annotations: {}
  ownerReferences: []
  createdAt: "2026-05-28T00:00:00Z"
  updatedAt: "2026-05-28T00:00:00Z"
spec: {}
status:
  observedGeneration: 1
  resourceVersion: "1"
  conditions: []
```

## Field Semantics

| Field | Semantics |
| --- | --- |
| `apiVersion` | Versioned product namespace for the contract. Flow Agents core resources use a Flow Agents namespace such as `flowagents.kontourai.io/v1alpha1`. Kit-specific resources use their own owner namespace, such as `builder.flowagents.kontourai.io/v1alpha1`. |
| `kind` | The resource type. Use core Flow Agents kinds for provider-neutral concepts and kit-specific kinds only for kit-owned specializations. |
| `metadata` | Stable identity, ownership, labels, annotations, timestamps, and relationship pointers that help tools find and correlate records without interpreting desired intent or observed status. |
| `metadata.name` | Human-readable stable name within the relevant scope. Names should be deterministic enough for local files and provider-backed records. |
| `metadata.uid` | Durable unique identity for correlation across local files, provider records, evidence, and future adapters. |
| `metadata.namespace` | Optional project, workspace, tenant, provider, or environment boundary. Absence of a namespace does not imply global scope. |
| `metadata.labels` | Low-cardinality selectors for grouping, filtering, ownership, workflow mode, provider, or kit. Labels should not carry large evidence or status payloads. |
| `metadata.annotations` | Non-selector metadata for humans, adapters, and tooling. Annotations may carry external IDs or source hints but should not replace typed fields where a resource owns a concept. |
| `metadata.ownerReferences` | Links to owning or parent resources, such as an Initiative owning related Work Items or a Workflow Run owning a Run Plan. Ownership should not hide cross-resource dependency links. |
| `metadata.createdAt` / `metadata.updatedAt` | Record lifecycle timestamps for local files and provider-backed records. These are record timestamps, not proof that workflow evidence is fresh. |
| `spec` | Desired intent. This is what the user, workflow, kit, provider adapter, or controller wants to be true: selected subjects, required capabilities, gate order, expected evidence, route-back policy, or declared configuration. Observed results do not belong here. |
| `status` | Observed state. This is what Flow Agents, a provider, a gate, a verifier, or an adapter has observed about the resource. Status summarizes facts, outcomes, gaps, and current lifecycle state; it should not redefine desired intent. |
| `status.conditions` | Current inspectable Status Condition summaries. Conditions are for reporting, gating summaries, Console views, evals, and analytics. They do not replace underlying evidence records. |
| `status.observedGeneration` | Optional marker for which desired generation the status reflects. Use it when a writer can detect that `spec` changed after status was last observed. |
| `status.resourceVersion` | Optional concurrency or freshness marker from a local writer, provider, or adapter. It is a resource record version, not an API requirement. |
| References | Resource references should identify `apiVersion`, `kind`, `name`, and when available `uid`. Provider-backed references should also include provider type and external ID when needed for traceability. |
| Evidence pointers | Evidence should be referenced by stable pointers such as sidecar paths, provider artifact URLs, claim IDs, Flow Reports, logs, test reports, review artifacts, or Gate evidence records. Conditions may summarize evidence state, but the evidence must remain separately inspectable. |
| Versioning | Contract versions are carried by `apiVersion`. Backward-incompatible changes require a new version. Provider adapters and local-file readers should tolerate unknown fields when possible. |

The most important boundary is between `spec` and `status`: `spec` records desired intent, while `status` records observed facts. A Selected Scope declares the subjects a Workflow Run is authorized to operate on in `spec`; overlap findings, material scope changes, missing evidence, and gate outcomes belong in `status.conditions` or evidence records.

## Core Resource Registry

The first core Flow Agents resources are provider-neutral concepts from the Flow Agents glossary. They are core because multiple work modes, Flow Kits, providers, adapters, gates, evals, or future reporting surfaces need to understand them without importing Builder Kit-specific delivery semantics.

| Kind | Why it is core |
| --- | --- |
| `SelectedScope` | Declares the explicit subject or subjects a Workflow Run is authorized to operate on. It can include Work Items, files, documents, customers, meetings, research sources, or provider-backed records across work modes. |
| `WorkflowRun` | Represents one execution of a Workflow from selected scope through gates, evidence, route-backs, and terminal outcome. Builder Kit Delivery Runs specialize this concept but do not replace it. |
| `RunPlan` | Describes intended gate order, selected scope, required capabilities, required evidence, route-back policy, and learning points for a Workflow Run without assuming software delivery. |
| `WorkItem` | Represents an executable backlog or queue unit selected by a workflow. It remains provider-neutral while allowing GitHub, Jira, local Markdown, or other provider-backed records to stay first-class. |
| `Gate` | Represents a workflow checkpoint that decides whether a Workflow Run can advance, stop, or route back, with structured evidence, gaps, authority, actors, attempts, and condition summaries. |
| `Initiative` | Optionally groups related product, platform, governance, or internal validation outcomes for planning and traceability. It is not an executable unit and does not replace dependency links or Work Items. |

`ExecutionPlan` and `DeliveryRun` are not core Flow Agents registry entries. They are Builder Kit-specific specializations: an Execution Plan specializes a Run Plan for delivery work, and a Delivery Run is a build-specific kind of Workflow Run.

## Status Conditions

Status Conditions are current, inspectable statements about a Kontour Resource Contract, Gate, Workflow Run, or Builder Kit Delivery Run. They summarize lifecycle state, reason, message, evidence pointers, and transition time without replacing underlying evidence.

Use conditions for shared reporting and gate visibility. Keep detailed proof in evidence records.

```yaml
type: Ready
status: "False"
reason: MissingEvidence
message: Verification evidence has not been recorded.
evidenceRefs: []
observedGeneration: 1
lastTransitionTime: "2026-05-28T00:00:00Z"
```

| Field | Semantics |
| --- | --- |
| `type` | Shared condition meaning, such as `Ready`, `Blocked`, or `MissingEvidence`. Use stable PascalCase names in records even when docs describe the meaning in prose. |
| `status` | Condition truth value. Use `"True"`, `"False"`, or `"Unknown"` unless a specific contract version defines a narrower enum. |
| `reason` | Stable machine-readable reason code. Flow Kits may add domain-specific reasons, but they must not redefine shared condition meanings. |
| `message` | Human-readable explanation of the current condition. Keep it concise and factual. |
| `evidenceRefs` | Stable pointers to evidence records, provider artifacts, sidecars, claim IDs, reports, or logs that support the condition. Required for non-trivial pass, fail, blocked, and not-verified states. |
| `observedGeneration` | Optional desired generation this condition observed. Useful when `spec` changed and old status may be stale. |
| `lastTransitionTime` | Timestamp for when this condition last changed truth value or reason. |

## Core Condition Vocabulary

| Condition meaning | Suggested `type` | Meaning | Reason and evidence guidance |
| --- | --- | --- | --- |
| Ready | `Ready` | The resource or gate has enough satisfied required conditions to advance or be consumed. | Use reasons such as `RequirementsSatisfied` or a kit-specific pass reason. Include evidence references for the checks that justify readiness. |
| Blocked | `Blocked` | The resource or Workflow Run cannot make useful progress without a required decision, capability, provider state, or external change. | Use stable reasons that identify the blocking class, such as `ConfigurationGap`, `MissingEvidence`, `ScopeOverlap`, or `NeedsUserDecision`. Include evidence or provider pointers when the block was observed. |
| In progress | `InProgress` | Work has started and has not reached a terminal ready, blocked, failed, or accepted state. | Use reasons for the active step, gate, or attempt. Evidence may point to the current session, Flow Run, provider operation, or active handoff. |
| Scope overlap | `ScopeOverlap` | One active Selected Scope intersects with another active Workflow Run or provider-backed work record. This supports Alignment Gate coordination and does not imply lock, lease, or reservation semantics. | Include references to the overlapping Selected Scope, Workflow Run, Work Item, provider record, or file/document path. |
| Scope changed | `ScopeChanged` | The Selected Scope changed after alignment, planning, or downstream evidence began. Material changes route back to an Alignment Gate. | Include old and new scope references when available, plus the gate or evidence that detected the material change. |
| Configuration gap | `ConfigurationGap` | A required provider, capability, setting, permission, or version is missing, invalid, unavailable, or incompatible. | Required gaps usually set `Blocked=True` or `Ready=False`; optional gaps may be advisory or unknown. Point to provider settings, capability checks, or validation output. |
| Missing evidence | `MissingEvidence` | Required evidence has not been recorded, cannot be found, or is stale for the current desired generation. | Point to the expected evidence contract, gate requirement, sidecar, provider check, or artifact path. Do not mark readiness true until the missing required evidence is resolved or explicitly accepted. |
| Route-back required | `RouteBackRequired` | A gate cannot advance and the next useful action is an earlier workflow step. | Include route reason, target step or gate, attempt count when available, and evidence supporting the route-back decision. |

Flow Kits may add domain-specific condition reasons and additional condition types for their own resources. Shared condition meanings remain stable across kits so Flow Agents, adapters, evals, analytics, and future Console views can compare state without understanding every kit.

## Canonical Examples

These examples use one provider-neutral documentation workflow: add the Kontour Resource Contract reference for work item `workitem-resource-contract-56`. The same stable identifiers connect the Selected Scope, Workflow Run, and Run Plan. Desired intent stays in `spec`; observed facts, gaps, and current lifecycle summaries stay in `status.conditions`.

### SelectedScope

```yaml
apiVersion: flowagents.kontourai.io/v1alpha1
kind: SelectedScope
metadata:
  name: selected-scope-resource-contract-56
  uid: scope-20260528-resource-contract-56
  namespace: flow-agents
  labels:
    flowagents.kontourai.io/workflow: docs-reference
  annotations:
    flowagents.kontourai.io/source: local-work-item
  ownerReferences: []
  createdAt: "2026-05-28T06:09:09Z"
  updatedAt: "2026-05-28T06:10:21Z"
spec:
  workflowIntent: Document the core Kontour Resource Contract shape for Flow Agents.
  authorizedSubjects:
    - apiVersion: flowagents.kontourai.io/v1alpha1
      kind: WorkItem
      name: workitem-resource-contract-56
      uid: workitem-kontourai-flow-agents-56
      providerRef:
        type: local
        externalId: kontourai-flow-agents-56
    - apiVersion: flowagents.kontourai.io/v1alpha1
      kind: Document
      name: kontour-resource-contract-reference
      uid: doc-docs-kontour-resource-contract
      path: docs/kontour-resource-contract.md
  boundaries:
    include:
      - docs/kontour-resource-contract.md
    exclude:
      - dist/
      - runtime code
      - provider records
  materialChangePolicy:
    routeBackGate: Alignment
status:
  observedGeneration: 1
  resourceVersion: "1"
  conditions:
    - type: Ready
      status: "True"
      reason: ScopeSelected
      message: The selected Work Item and documentation file are narrow enough for the planned workflow.
      evidenceRefs:
        - kind: SessionArtifact
          path: .flow-agents/resource-contract-skeleton/resource-contract-skeleton--deliver.md
      observedGeneration: 1
      lastTransitionTime: "2026-05-28T06:10:21Z"
    - type: ScopeOverlap
      status: "False"
      reason: NoOverlapObserved
      message: No active overlapping workflow was recorded for this selected scope.
      evidenceRefs:
        - kind: SessionArtifact
          path: .flow-agents/resource-contract-skeleton/resource-contract-skeleton--deliver.md
      observedGeneration: 1
      lastTransitionTime: "2026-05-28T06:10:21Z"
```

### WorkflowRun

```yaml
apiVersion: flowagents.kontourai.io/v1alpha1
kind: WorkflowRun
metadata:
  name: workflow-run-resource-contract-56
  uid: run-20260528-resource-contract-56
  namespace: flow-agents
  labels:
    flowagents.kontourai.io/workflow: docs-reference
  annotations:
    flowagents.kontourai.io/source: local-session
  ownerReferences:
    - apiVersion: flowagents.kontourai.io/v1alpha1
      kind: SelectedScope
      name: selected-scope-resource-contract-56
      uid: scope-20260528-resource-contract-56
  createdAt: "2026-05-28T06:09:09Z"
  updatedAt: "2026-05-28T06:10:21Z"
spec:
  workflow: docs-reference
  selectedScopeRef:
    apiVersion: flowagents.kontourai.io/v1alpha1
    kind: SelectedScope
    name: selected-scope-resource-contract-56
    uid: scope-20260528-resource-contract-56
  runPlanRef:
    apiVersion: flowagents.kontourai.io/v1alpha1
    kind: RunPlan
    name: run-plan-resource-contract-56
    uid: plan-20260528-resource-contract-56
  gateOrder:
    - Alignment
    - Planning
    - Execution
    - Verification
    - Evidence
  terminalPolicy:
    requireEvidenceForReady: true
    routeBackOnMaterialScopeChange: true
status:
  observedGeneration: 1
  resourceVersion: "1"
  phase: execution
  attempt: 1
  selectedSubjectSnapshot:
    - kind: WorkItem
      uid: workitem-kontourai-flow-agents-56
    - kind: Document
      uid: doc-docs-kontour-resource-contract
  conditions:
    - type: InProgress
      status: "True"
      reason: WaveExecutionStarted
      message: The documentation workflow is executing the resource contract examples and compatibility guidance.
      evidenceRefs:
        - kind: SessionArtifact
          path: .flow-agents/resource-contract-skeleton/resource-contract-skeleton--deliver.md
      observedGeneration: 1
      lastTransitionTime: "2026-05-28T06:10:21Z"
    - type: MissingEvidence
      status: "True"
      reason: VerificationPending
      message: Final YAML parsing and text checks have not been recorded for this run.
      evidenceRefs:
        - kind: ExpectedEvidence
          name: yaml-parse-and-rg-checks
      observedGeneration: 1
      lastTransitionTime: "2026-05-28T06:10:21Z"
    - type: Ready
      status: "False"
      reason: VerificationPending
      message: The workflow cannot be marked ready until required evidence is recorded.
      evidenceRefs:
        - kind: ExpectedEvidence
          name: yaml-parse-and-rg-checks
      observedGeneration: 1
      lastTransitionTime: "2026-05-28T06:10:21Z"
```

### RunPlan

```yaml
apiVersion: flowagents.kontourai.io/v1alpha1
kind: RunPlan
metadata:
  name: run-plan-resource-contract-56
  uid: plan-20260528-resource-contract-56
  namespace: flow-agents
  labels:
    flowagents.kontourai.io/workflow: docs-reference
  annotations:
    flowagents.kontourai.io/source: local-plan
  ownerReferences:
    - apiVersion: flowagents.kontourai.io/v1alpha1
      kind: WorkflowRun
      name: workflow-run-resource-contract-56
      uid: run-20260528-resource-contract-56
  createdAt: "2026-05-28T06:10:21Z"
  updatedAt: "2026-05-28T06:10:21Z"
spec:
  selectedScopeRef:
    apiVersion: flowagents.kontourai.io/v1alpha1
    kind: SelectedScope
    name: selected-scope-resource-contract-56
    uid: scope-20260528-resource-contract-56
  requiredCapabilities:
    - docs-edit
    - yaml-parse
    - text-search
  gates:
    - name: Alignment
      requiredEvidence:
        - selected-scope-recorded
    - name: Execution
      requiredEvidence:
        - modified-files-recorded
    - name: Verification
      requiredEvidence:
        - yaml-parse-and-rg-checks
  routeBackPolicy:
    materialScopeChange:
      targetGate: Alignment
      reason: ScopeChanged
    missingEvidence:
      targetGate: Verification
      reason: MissingEvidence
  learningPoints:
    - Resource examples should remain provider-neutral.
    - Compatibility guidance should document direction without migrating sidecars.
status:
  observedGeneration: 1
  resourceVersion: "1"
  conditions:
    - type: Ready
      status: "True"
      reason: PlanAccepted
      message: The Run Plan has enough desired gate and evidence detail for execution.
      evidenceRefs:
        - kind: PlanArtifact
          path: .flow-agents/resource-contract-skeleton/resource-contract-skeleton--plan.md
      observedGeneration: 1
      lastTransitionTime: "2026-05-28T06:10:21Z"
    - type: RouteBackRequired
      status: "False"
      reason: NoRouteBackObserved
      message: No material scope change or missing required plan input has been observed.
      evidenceRefs:
        - kind: PlanArtifact
          path: .flow-agents/resource-contract-skeleton/resource-contract-skeleton--plan.md
      observedGeneration: 1
      lastTransitionTime: "2026-05-28T06:10:21Z"
```

## Compatibility Guidance

This issue documents the resource direction only. It does not migrate current sidecars, rewrite provider-backed Work Items, add schemas, alter sidecar writers, or change runtime behavior. Existing local artifacts and provider records remain valid while future adapters and docs converge on the Kontour Resource Contract shape.

Current workflow sidecars can be interpreted as resource-shaped status, evidence, and handoff data without changing their files:

| Current artifact | Resource Contract direction |
| --- | --- |
| `state.json` | Maps toward `WorkflowRun.status` for phase, lifecycle status, next action, and current condition summaries. It should not become the only evidence source for gate outcomes. |
| `acceptance.json` | Maps toward required evidence and acceptance expectations on `RunPlan.spec`, plus observed criterion outcomes in gate or workflow status. Desired acceptance criteria remain intent; pass, fail, and not-verified outcomes remain observed facts. |
| `evidence.json` | Maps toward evidence records and `status.conditions[].evidenceRefs`. Conditions summarize the evidence verdict, while detailed proof remains inspectable in the evidence sidecar or future evidence resource. |
| `handoff.json` | Maps toward route-back, pause, blocker, owner, and next-action status on `WorkflowRun.status` or handoff evidence. It records observed workflow continuity facts, not desired scope or plan intent. |
| `critique.json`, `release.json`, and `learning.json` | Map toward gate-specific evidence and condition summaries for review, release, and learning gates. They remain separate sidecars until a deliberate migration or adapter is designed. |

Provider-backed Work Items keep the provider-neutral vocabulary from `context/contracts/work-item-contract.md`. A provider record can be represented as a `WorkItem` resource by preserving stable identity, provider references, title, state, acceptance pointers, and artifact references, but the provider remains the source of provider state. Local files, tests, kit demos, and migrations may use the same resource-shaped Work Item without requiring GitHub, Jira, Linear, Kubernetes, or any other provider.

Adapters should treat provider-specific IDs and URLs as references, not as generic resource identity. For example, a provider-backed Work Item may include a provider reference in `metadata.annotations`, `spec.providerRef`, or a typed reference field while keeping `metadata.uid` stable for Flow Agents correlation. Workflow artifacts such as plans, sidecars, reviews, verification reports, and durable docs should remain linked through artifact or evidence references so users and gates can inspect the underlying proof.

No compatibility text on this page requires an immediate migration. A future migration or adapter should be planned as its own Workflow Run with explicit Selected Scope, Run Plan, acceptance evidence, sidecar compatibility checks, provider behavior checks, and route-back policy.
