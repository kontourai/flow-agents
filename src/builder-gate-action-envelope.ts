import * as fs from "node:fs";
import { constants as fsConstants } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { evaluateGate, expectationsForGate, openGates, type FlowExpectation, type FlowGate, type FlowRunState } from "@kontourai/flow";
import { parseKitFlowStepActions, type KitFlowStepActionEntry, type KitFlowStepExpectationBinding } from "./flow-kit/validate.js";
import {
  EVIDENCE_REF_JSON_SCHEMA,
  PUBLIC_OPERATION_CONTRACTS,
  publicOperationContracts,
  type PublishChangeActionBinding,
  type PublishChangeOperationProtocol,
  WORKFLOW_CRITIQUE_PARAMETERS,
  WORKFLOW_EVIDENCE_PARAMETERS,
} from "./cli/public-contracts.js";
import { resolveEffectiveChangeProviderSettings } from "./cli/effective-change-provider-settings.js";
import { resolveEffectiveFlowDefinition } from "./lib/flow-resolver.js";
import { flowAgentsPackageRoot } from "./lib/package-version.js";

const MAX_METADATA_BYTES = 1_048_576;
const MAX_ENVELOPE_BYTES = 65_536;
const MAX_SKILLS = 16;
const MAX_REQUIREMENTS = 32;
const MAX_ARTIFACTS = 32;
const MAX_CANONICAL_EVIDENCE = 256;
const MAX_OBSERVED_ARTIFACTS = 128;
const MAX_OBSERVED_ARTIFACT_BYTES = 8 * 1_048_576;
const CONTROL_ARTIFACTS = new Set(["state.json"]);

type AnyRecord = Record<string, unknown>;

export type GateActionInterfaceParameter = {
  name: string;
  flag: string;
  required: boolean;
  allowed_values?: readonly string[];
  repeatable?: boolean;
  required_when?: { parameter: string; equals: string };
  value_schema_ref?: "#/public_interfaces/schemas/evidence_ref_json";
};

export type GateActionArtifactTarget =
  | {
      kind: "file";
      ref: string;
      path: string;
      direct_write_allowed: true;
      produced_via: { interface: "skill"; skill_ids: string[] };
    }
  | {
      kind: "file";
      ref: string;
      path: string;
      direct_write_allowed: false;
      produced_via: { interface: "operation"; operations: string[] };
    }
  | {
      kind: "trust_slice";
      ref: string;
      bundle_file: "trust.bundle";
      slice_id: string;
      direct_write_allowed: false;
      record_via: Array<"workflow.evidence" | "workflow.critique">;
    };

export type GateActionArtifactBinding = {
  target: GateActionArtifactTarget;
  expectation_ids: string[];
};

export type GateActionWorkflowMutation = {
      expectation_id: string;
      interface: "workflow.evidence" | "workflow.critique";
      package: { name: "@kontourai/flow-agents"; version: string };
      command: "flow-agents";
      argv: string[];
      parameters: readonly GateActionInterfaceParameter[];
    };

export type GateActionPublicMutation =
  | GateActionWorkflowMutation
  | {
      expectation_id: string;
      interface: "operation";
      operation: string;
      protocol: PublishChangeOperationProtocol | (typeof PUBLIC_OPERATION_CONTRACTS)[keyof typeof PUBLIC_OPERATION_CONTRACTS];
      binding: PublishChangeActionBinding;
      completion: {
        status: "external_verification_required" | "configured_provider_execution_required";
        executable_by_flow_agents: boolean;
        gate_evidence_interface: null;
      };
    };

export type GateActionEnvelope = {
  schema_version: "3.0";
  flow: {
    run_id: string;
    definition_id: string;
    definition_version: string;
    status: string;
    current_step: string;
    gate_ids: string[];
  };
  gate: {
    requirements: Array<{
      id: string;
      gate_id: string;
      required: boolean;
      description: string;
      claim_type: string;
      subject_type: string | null;
      status: "satisfied" | "accepted_exception" | "unresolved";
    }>;
    unresolved_requirement_ids: string[];
    accepted_exceptions: Array<{ gate_id: string; exception_id: string }>;
  };
  action: {
    skills: Array<{
      id: string;
      package: { name: "@kontourai/flow-agents"; version: string };
      /** Stable package-relative source path, bound to package version and SHA-256. */
      path: string;
      sha256: string;
    }>;
    operations: string[];
    declared_artifacts: GateActionArtifactTarget[];
    artifact_bindings: GateActionArtifactBinding[];
    declared_evidence: string[];
    implementation_allowed: boolean;
  };
  public_interfaces: {
    status: {
      package: { name: "@kontourai/flow-agents"; version: string };
      command: "flow-agents";
      argv: string[];
    };
    schemas: {
      evidence_ref_json: AnyRecord;
    };
    mutations: GateActionPublicMutation[];
  };
  stop_condition: {
    kind: "one_turn";
    scope: {
      run_id: string;
      current_step: string;
      gate_ids: string[];
      current_gate_only: true;
    };
    required: {
      skill_ids: string[];
      artifact_refs: GateActionArtifactTarget[];
      unresolved_evidence_ids: string[];
    };
    sequence: ["activate_required_skills", "produce_declared_artifacts", "record_bound_evidence", "synchronize_canonical_flow", "return_adapter_result"];
    after: "return_adapter_result";
    synchronize_canonical_flow: true;
    adapter_evidence_is_gate_evidence: false;
    external_capability?: {
      status: "waiting";
      operation: string;
      capability: string;
      completion: "external_verification_required";
    };
  };
  progress: {
    canonical_evidence: string[];
    observed_artifacts: string[];
    prior_turn?: GateActionPriorProgress;
  };
};

export { EVIDENCE_REF_JSON_SCHEMA } from "./cli/public-contracts.js";

export type GateActionProgressSnapshot = Pick<GateActionEnvelope["progress"], "canonical_evidence" | "observed_artifacts"> & {
  current_step: string;
  /** Optional for compatibility with snapshots persisted before terminal status capture. */
  canonical_status?: string;
};

export type GateActionPriorProgress = {
  step_advanced: boolean;
  evidence_added: string[];
  artifact_changes: string[];
  no_progress: boolean;
  consecutive_no_progress: number;
  stagnation: "none" | "possible" | "stagnant";
};

export type BuilderGateActionEnvelopeInput = {
  sessionDir: string;
  projectRoot: string;
  run: {
    runId: string;
    definitionId: string;
    definitionVersion: string;
    state: FlowRunState;
    manifest: AnyRecord;
    config: AnyRecord;
  };
  definition: AnyRecord;
};

type LoadedGateAction = {
  packageRoot: string;
  packageVersion: string;
  kit: AnyRecord;
  action: KitFlowStepActionEntry;
  actions: KitFlowStepActionEntry[];
  actionableArtifacts: string[];
};

type DerivedGateRequirements = {
  gates: Array<FlowGate & { id: string }>;
  requirements: GateActionEnvelope["gate"]["requirements"];
  unresolved: string[];
  unresolvedRequired: string[];
  acceptedExceptions: GateActionEnvelope["gate"]["accepted_exceptions"];
};

export function installedBuilderSkillIdentity(skill: string): GateActionEnvelope["action"]["skills"][number] {
  const packageRoot = flowAgentsPackageRoot();
  const packageMetadata = readBoundedJson(packageRoot, "package.json", "flow-agents package metadata");
  if (typeof packageMetadata.version !== "string" || !packageMetadata.version) throw new Error("flow-agents package metadata has no version");
  const kit = readBoundedJson(packageRoot, path.join("kits", "builder", "kit.json"), "Builder kit metadata");
  return skillIdentity(kit, packageRoot, packageMetadata.version, skill);
}

export function installedBuilderImplementationAllowed(definitionId: string, currentStep: string): boolean {
  const packageRoot = flowAgentsPackageRoot();
  const kit = readBoundedJson(packageRoot, path.join("kits", "builder", "kit.json"), "Builder kit metadata");
  const parsed = parseKitFlowStepActions(kit, "kits/builder/kit.json");
  if (parsed.errors.length) throw new Error(`Builder gate-action metadata is invalid: ${parsed.errors.join("; ")}`);
  const selected = parsed.entries.filter((entry) => entry.flow_id === definitionId && entry.step_id === currentStep);
  if (selected.length !== 1) throw new Error(`Builder gate-action metadata must declare exactly one action for ${definitionId}/${currentStep}`);
  return selected[0]!.implementation_allowed;
}

export function installedBuilderGateActionAuthority(definitionId: string, currentStep: string, runId: string): {
  definition_version: string;
  gate_id: string;
  requirements: Array<Omit<GateActionEnvelope["gate"]["requirements"][number], "status">>;
  action: GateActionEnvelope["action"];
  mutations: GateActionPublicMutation[];
  artifact_bindings: GateActionArtifactBinding[];
  external_capability?: NonNullable<GateActionEnvelope["stop_condition"]["external_capability"]>;
} {
  const packageRoot = flowAgentsPackageRoot();
  const packageMetadata = readBoundedJson(packageRoot, "package.json", "flow-agents package metadata");
  if (typeof packageMetadata.version !== "string" || !packageMetadata.version) throw new Error("flow-agents package metadata has no version");
  const packageVersion = packageMetadata.version;
  const kit = readBoundedJson(packageRoot, path.join("kits", "builder", "kit.json"), "Builder kit metadata");
  const parsed = parseKitFlowStepActions(kit, "kits/builder/kit.json");
  if (parsed.errors.length) throw new Error(`Builder gate-action metadata is invalid: ${parsed.errors.join("; ")}`);
  const selected = parsed.entries.filter((entry) => entry.flow_id === definitionId && entry.step_id === currentStep);
  if (selected.length !== 1) throw new Error(`Builder gate-action metadata must declare exactly one action for ${definitionId}/${currentStep}`);
  const action = selected[0]!;
  const definition = resolveEffectiveFlowDefinition(definitionId, packageRoot, { allowOverride: false });
  if (typeof definition?.version !== "string" || definition.version.length === 0) {
    throw new Error(`Installed Builder Flow has no version for ${definitionId}`);
  }
  const gates: Array<[string, AnyRecord]> = isRecord(definition?.gates) ? Object.entries(definition.gates)
    .flatMap(([gateId, gate]) => isRecord(gate) && gate.step === currentStep ? [[gateId, gate]] : []) : [];
  if (gates.length !== 1) throw new Error(`Installed Builder Flow must declare exactly one gate for ${definitionId}/${currentStep}`);
  const [gateId, gate] = gates[0]!;
  const expects = Array.isArray(gate.expects) ? gate.expects : [];
  const requirements = expects.map((expectation) => {
    if (!isRecord(expectation)) throw new Error("Installed Builder gate expectation is malformed");
    const requirement = requirementFromExpectation(gateId, expectation as unknown as FlowExpectation, new Set<string>(), false);
    const { status: _status, ...shape } = requirement;
    return shape;
  });
  if (!sameSet(action.expectation_ids, requirements.map((requirement) => requirement.id))) {
    throw new Error(`Installed Builder action evidence does not match ${definitionId}/${currentStep}`);
  }
  const sessionArgument = `.kontourai/flow-agents/${runId}`;
  const declaredArtifacts = action.artifacts.filter((artifact) => !isControlArtifact(artifact))
    .map((artifact) => artifactTarget(artifact, runId, sessionArgument, action));
  const artifactBindings = action.artifact_bindings
    .filter((binding) => !isControlArtifact(binding.artifact))
    .map((binding) => ({
      target: artifactTarget(binding.artifact, runId, sessionArgument, action),
      expectation_ids: [...binding.expectation_ids],
    }));
  const operation = action.operations[0];
  const protocol = operation ? PUBLIC_OPERATION_CONTRACTS[operation as keyof typeof PUBLIC_OPERATION_CONTRACTS] : undefined;
  const actionEnvelope: GateActionEnvelope["action"] = {
    skills: action.skills.map((skill) => skillIdentity(kit, packageRoot, packageVersion, skill)),
    operations: [...action.operations],
    declared_artifacts: declaredArtifacts,
    artifact_bindings: artifactBindings,
    declared_evidence: [...action.expectation_ids],
    implementation_allowed: action.implementation_allowed,
  };
  return {
    definition_version: definition.version,
    gate_id: gateId,
    requirements,
    action: actionEnvelope,
    mutations: action.expectation_bindings.map((binding) => publicMutation(
      binding,
      sessionArgument,
      packageVersion,
      operationContractsForProject(packageRoot),
      authorityOperationBinding(runId, definitionId, definition.version as string, currentStep, gateId),
    )),
    artifact_bindings: artifactBindings,
    ...(protocol?.availability.status === "external_capability_required" ? {
      external_capability: {
        status: "waiting" as const,
        operation: protocol.operation,
        capability: protocol.capability,
        completion: "external_verification_required" as const,
      },
    } : {}),
  };
}

/** Derive bounded adapter context without trusting adapter telemetry. */
export function deriveBuilderGateActionEnvelope(input: BuilderGateActionEnvelopeInput): GateActionEnvelope {
  const loaded = loadGateAction(input);
  const derived = deriveFlowRequirements(input, loaded.action);
  const envelope = assembleGateActionEnvelope(input, loaded, derived);
  assertBoundedEnvelope(envelope);
  return envelope;
}

/**
 * Canonical progress is useful after a run becomes terminal, when no adapter
 * action envelope may be emitted. Keep this deliberately separate from the
 * request-only envelope so terminal snapshots cannot be mistaken for work.
 */
export function deriveBuilderGateActionProgressSnapshot(input: BuilderGateActionEnvelopeInput): GateActionProgressSnapshot {
  const { actions } = loadGateAction(input);
  return {
    current_step: input.run.state.current_step,
    canonical_status: input.run.state.status,
    canonical_evidence: canonicalEvidence(input.run.manifest),
    observed_artifacts: observeBuilderArtifactsForProgress(input.sessionDir, actions.flatMap((entry) => entry.artifacts)),
  };
}

function loadGateAction(input: BuilderGateActionEnvelopeInput): LoadedGateAction {
  const packageRoot = flowAgentsPackageRoot();
  const packageMetadata = readBoundedJson(packageRoot, "package.json", "flow-agents package metadata");
  if (typeof packageMetadata.version !== "string" || !packageMetadata.version) throw new Error("flow-agents package metadata has no version");
  const packageVersion = packageMetadata.version;
  const kit = readBoundedJson(packageRoot, path.join("kits", "builder", "kit.json"), "Builder kit metadata");
  const parsed = parseKitFlowStepActions(kit, "kits/builder/kit.json");
  if (parsed.errors.length) throw new Error(`Builder gate-action metadata is invalid: ${parsed.errors.join("; ")}`);
  const actions = parsed.entries.filter((entry) => entry.flow_id === input.run.definitionId);
  const selected = actions.filter((entry) => entry.step_id === input.run.state.current_step);
  if (selected.length !== 1) throw new Error(`Builder gate-action metadata must declare exactly one action for ${input.run.definitionId}/${input.run.state.current_step}`);
  const action = selected[0]!;
  const actionableArtifacts = action.artifacts.filter((artifact) => !isControlArtifact(artifact));
  if (action.skills.length > MAX_SKILLS || action.artifacts.length > MAX_ARTIFACTS) {
    throw new Error("Builder gate-action metadata exceeds the supported envelope bound");
  }
  return { packageRoot, packageVersion, kit, action, actions, actionableArtifacts };
}

function deriveFlowRequirements(input: BuilderGateActionEnvelopeInput, action: KitFlowStepActionEntry): DerivedGateRequirements {
  const gates = openGates(input.definition, input.run.state) as Array<FlowGate & { id: string }>;
  const acceptedExceptions: GateActionEnvelope["gate"]["accepted_exceptions"] = [];
  const requirements = gates.flatMap((gate) => {
    const outcome = evaluateGate(input.definition, input.run.state, input.run.manifest, gate.id, input.run.config);
    if (typeof outcome.accepted_exception_id === "string") {
      acceptedExceptions.push({ gate_id: gate.id, exception_id: outcome.accepted_exception_id });
    }
    const matched = new Set((Array.isArray(outcome.matched_expectations) ? outcome.matched_expectations : [])
      .flatMap((entry) => isRecord(entry) && typeof entry.expectation_id === "string" ? [entry.expectation_id] : []));
    return (expectationsForGate(gate, input.run.config) as FlowExpectation[])
      .map((expectation) => requirementFromExpectation(gate.id, expectation, matched, typeof outcome.accepted_exception_id === "string"));
  });
  if (requirements.length > MAX_REQUIREMENTS) throw new Error("Builder gate-action envelope requirements exceed the supported bound");
  if (!sameSet(action.expectation_ids, requirements.map((requirement) => requirement.id))) {
    throw new Error(`Builder gate-action metadata evidence does not exactly match canonical Flow requirements for ${input.run.definitionId}/${input.run.state.current_step}`);
  }
  const unresolved = requirements.filter((requirement) => requirement.status === "unresolved").map((requirement) => requirement.id);
  const unresolvedRequired = requirements.filter((requirement) => requirement.required && requirement.status === "unresolved").map((requirement) => requirement.id);
  return { gates, requirements, unresolved, unresolvedRequired, acceptedExceptions };
}

function assembleGateActionEnvelope(input: BuilderGateActionEnvelopeInput, loaded: LoadedGateAction, derived: DerivedGateRequirements): GateActionEnvelope {
  const { packageRoot, packageVersion, kit, action, actions, actionableArtifacts } = loaded;
  const { gates, requirements, unresolved, unresolvedRequired, acceptedExceptions } = derived;
  const sessionDir = path.resolve(input.sessionDir);
  const sessionArgument = sessionPathForPublicCommand(input.projectRoot, sessionDir);
  const requiredArtifacts = action.artifact_bindings
    .filter((binding) => !isControlArtifact(binding.artifact) && binding.expectation_ids.some((id) => unresolvedRequired.includes(id)))
    .map((binding) => artifactTarget(binding.artifact, sessionDir, sessionArgument, action));
  const operationContracts = operationContractsForProject(input.projectRoot);
  const envelope: GateActionEnvelope = {
    schema_version: "3.0",
    flow: {
      run_id: input.run.runId,
      definition_id: input.run.definitionId,
      definition_version: input.run.definitionVersion,
      status: input.run.state.status,
      current_step: input.run.state.current_step,
      gate_ids: gates.map((gate) => gate.id),
    },
    gate: { requirements, unresolved_requirement_ids: unresolved, accepted_exceptions: acceptedExceptions },
    action: envelopeAction(action, actionableArtifacts, sessionDir, sessionArgument, kit, packageRoot, packageVersion),
    public_interfaces: {
      status: {
        package: { name: "@kontourai/flow-agents", version: packageVersion },
        command: "flow-agents",
        argv: ["workflow", "status", "--session-dir", sessionArgument, "--json"],
      },
      schemas: { evidence_ref_json: structuredClone(EVIDENCE_REF_JSON_SCHEMA) },
      mutations: action.expectation_bindings.map((binding) => publicMutation(binding, sessionArgument, packageVersion, operationContracts, operationBinding(input, gates))),
    },
    stop_condition: envelopeStopCondition(input, gates, action, requiredArtifacts, unresolvedRequired, operationContracts),
    progress: {
      canonical_evidence: canonicalEvidence(input.run.manifest),
      observed_artifacts: observeBuilderArtifactsForProgress(sessionDir, actions.flatMap((entry) => entry.artifacts)),
    },
  };
  return envelope;
}

function envelopeAction(action: KitFlowStepActionEntry, artifacts: string[], sessionDir: string, sessionArgument: string, kit: AnyRecord, packageRoot: string, packageVersion: string): GateActionEnvelope["action"] {
  const declaredArtifacts = artifacts.map((artifact) => artifactTarget(artifact, sessionDir, sessionArgument, action));
  return {
    skills: action.skills.map((skill) => skillIdentity(kit, packageRoot, packageVersion, skill)),
    operations: [...action.operations],
    declared_artifacts: declaredArtifacts,
    artifact_bindings: action.artifact_bindings
      .filter((binding) => !isControlArtifact(binding.artifact))
      .map((binding) => ({
        target: artifactTarget(binding.artifact, sessionDir, sessionArgument, action),
        expectation_ids: [...binding.expectation_ids],
      })),
    declared_evidence: [...action.expectation_ids],
    implementation_allowed: action.implementation_allowed,
  };
}

function envelopeStopCondition(
  input: BuilderGateActionEnvelopeInput,
  gates: Array<FlowGate & { id: string }>,
  action: KitFlowStepActionEntry,
  artifactRefs: GateActionArtifactTarget[],
  unresolvedEvidenceIds: string[],
  operationContracts: Record<string, PublishChangeOperationProtocol | (typeof PUBLIC_OPERATION_CONTRACTS)[keyof typeof PUBLIC_OPERATION_CONTRACTS]>,
): GateActionEnvelope["stop_condition"] {
  const operation = action.operations[0];
  const protocol = operation ? operationContracts[operation] : undefined;
  return {
    kind: "one_turn",
    scope: { run_id: input.run.runId, current_step: input.run.state.current_step, gate_ids: gates.map((gate) => gate.id), current_gate_only: true },
    required: { skill_ids: unresolvedEvidenceIds.length > 0 ? action.skills : [], artifact_refs: artifactRefs, unresolved_evidence_ids: unresolvedEvidenceIds },
    sequence: ["activate_required_skills", "produce_declared_artifacts", "record_bound_evidence", "synchronize_canonical_flow", "return_adapter_result"],
    after: "return_adapter_result",
    synchronize_canonical_flow: true,
    adapter_evidence_is_gate_evidence: false,
    ...(protocol?.availability.status === "external_capability_required" ? {
      external_capability: {
        status: "waiting",
        operation: protocol.operation,
        capability: protocol.capability,
        completion: "external_verification_required",
      },
    } : {}),
  };
}

export function gateActionProgressSnapshot(envelope: GateActionEnvelope): GateActionProgressSnapshot {
  return {
    current_step: envelope.flow.current_step,
    canonical_status: envelope.flow.status,
    canonical_evidence: [...envelope.progress.canonical_evidence],
    observed_artifacts: [...envelope.progress.observed_artifacts],
  };
}

export function withGateActionPriorProgress(envelope: GateActionEnvelope, priorTurn: GateActionPriorProgress): GateActionEnvelope {
  const copy = structuredClone(envelope);
  copy.progress.prior_turn = structuredClone(priorTurn);
  assertBoundedEnvelope(copy);
  return copy;
}

function publicMutation(
  binding: KitFlowStepExpectationBinding,
  sessionArgument: string,
  packageVersion: string,
  operationContracts: Record<string, PublishChangeOperationProtocol | (typeof PUBLIC_OPERATION_CONTRACTS)[keyof typeof PUBLIC_OPERATION_CONTRACTS]>,
  operationBindingValue?: PublishChangeActionBinding,
): GateActionPublicMutation {
  if (binding.interface === "operation") {
    const operation = binding.operation!;
    const protocol = operationContracts[operation];
    if (!protocol) throw new Error(`Builder gate-action operation '${operation}' has no canonical public protocol`);
    if (!operationBindingValue) throw new Error(`Builder gate-action operation '${operation}' requires canonical run and gate-visit binding`);
    const configured = protocol.availability.status === "configured";
    return {
      expectation_id: binding.expectation_id,
      interface: "operation",
      operation,
      protocol: structuredClone(protocol),
      binding: structuredClone(operationBindingValue),
      completion: {
        status: configured ? "configured_provider_execution_required" : "external_verification_required",
        executable_by_flow_agents: configured,
        gate_evidence_interface: null,
      },
    };
  }
  if (binding.interface === "workflow.critique") {
    return {
      expectation_id: binding.expectation_id,
      interface: binding.interface,
      package: { name: "@kontourai/flow-agents", version: packageVersion },
      command: "flow-agents",
      argv: ["workflow", "critique", "--session-dir", sessionArgument, "--json"],
      parameters: structuredClone(WORKFLOW_CRITIQUE_PARAMETERS),
    };
  }
  return workflowEvidenceMutation(binding.expectation_id, sessionArgument, packageVersion);
}

function operationContractsForProject(projectRoot: string): Record<string, PublishChangeOperationProtocol | (typeof PUBLIC_OPERATION_CONTRACTS)[keyof typeof PUBLIC_OPERATION_CONTRACTS]> {
  const resolved = resolveEffectiveChangeProviderSettings(
    projectRoot,
    path.join(projectRoot, "context", "settings", "change-provider-settings.json"),
  );
  const provider = resolved.status === "configured" ? resolved.provider : resolved.status === "unsupported" ? {} : undefined;
  return { ...PUBLIC_OPERATION_CONTRACTS, ...publicOperationContracts(provider) };
}

function operationBinding(input: BuilderGateActionEnvelopeInput, gates: Array<FlowGate & { id: string }>): PublishChangeActionBinding {
  const enteredAt = currentGateVisitIdentity(input.run.state, input.run.state.current_step);
  const gateIds = gates.map((gate) => gate.id);
  const source = [input.run.runId, input.run.definitionId, input.run.definitionVersion, input.run.state.current_step, ...gateIds, enteredAt].join("\n");
  return {
    run_id: input.run.runId,
    definition_id: input.run.definitionId,
    definition_version: input.run.definitionVersion,
    step_id: input.run.state.current_step,
    gate_ids: gateIds,
    gate_visit_id: createHash("sha256").update(source).digest("hex"),
  };
}

function authorityOperationBinding(runId: string, definitionId: string, definitionVersion: string, stepId: string, gateId: string): PublishChangeActionBinding {
  return {
    run_id: runId,
    definition_id: definitionId,
    definition_version: definitionVersion,
    step_id: stepId,
    gate_ids: [gateId],
    gate_visit_id: "0".repeat(64),
  };
}

function currentGateVisitIdentity(state: FlowRunState, step: string): string {
  const transitions = Array.isArray(state.transitions) ? state.transitions : [];
  for (const transition of [...transitions].reverse()) {
    if (transition?.to_step === step && typeof transition.at === "string" && transition.at.length > 0) return transition.at;
  }
  if (typeof state.updated_at === "string" && state.updated_at.length > 0) return state.updated_at;
  throw new Error("Builder gate-action operation requires a canonical current gate visit timestamp");
}

function workflowEvidenceMutation(expectationId: string, sessionArgument: string, packageVersion: string): GateActionWorkflowMutation {
  return {
    expectation_id: expectationId,
    interface: "workflow.evidence",
    package: { name: "@kontourai/flow-agents", version: packageVersion },
    command: "flow-agents",
    argv: ["workflow", "evidence", "--session-dir", sessionArgument, "--expectation", expectationId, "--json"],
    parameters: structuredClone(WORKFLOW_EVIDENCE_PARAMETERS),
  };
}

function artifactTarget(artifact: string, sessionDir: string, sessionArgument: string, action: KitFlowStepActionEntry): GateActionArtifactTarget {
  if (!artifact.includes("#")) {
    const fileName = artifact.replaceAll("<slug>", path.basename(sessionDir));
    const expectationIds = new Set(action.artifact_bindings
      .filter((binding) => binding.artifact === artifact)
      .flatMap((binding) => binding.expectation_ids));
    const operations = action.expectation_bindings
      .filter((binding) => expectationIds.has(binding.expectation_id) && binding.interface === "operation")
      .flatMap((binding) => binding.operation ? [binding.operation] : []);
    if (operations.length > 0) {
      return {
        kind: "file",
        ref: artifact,
        path: path.join(sessionArgument, fileName).split(path.sep).join("/"),
        direct_write_allowed: false,
        produced_via: { interface: "operation", operations: [...new Set(operations)] },
      };
    }
    if (action.skills.length === 0) throw new Error(`Builder gate-action file '${artifact}' has no skill or operation producer`);
    return {
      kind: "file",
      ref: artifact,
      path: path.join(sessionArgument, fileName).split(path.sep).join("/"),
      direct_write_allowed: true,
      produced_via: { interface: "skill", skill_ids: [...action.skills] },
    };
  }
  const match = /^trust\.bundle#([a-z0-9]+(?:[.-][a-z0-9]+)*)$/.exec(artifact);
  if (!match) throw new Error(`Builder gate-action artifact '${artifact}' is not a supported trust slice`);
  const expectationIds = new Set(action.artifact_bindings
    .filter((binding) => binding.artifact === artifact)
    .flatMap((binding) => binding.expectation_ids));
  const recordVia = [...new Set(action.expectation_bindings
    .filter((binding) => expectationIds.has(binding.expectation_id))
    .flatMap((binding) => binding.interface === "workflow.evidence" || binding.interface === "workflow.critique" ? [binding.interface] : []))];
  if (recordVia.length === 0) throw new Error(`Builder gate-action trust slice '${artifact}' has no public recording interface`);
  return {
    kind: "trust_slice",
    ref: artifact,
    bundle_file: "trust.bundle",
    slice_id: match[1]!,
    direct_write_allowed: false,
    record_via: recordVia,
  };
}

function requirementFromExpectation(gateId: string, expectation: FlowExpectation, satisfied: Set<string>, acceptedException: boolean): GateActionEnvelope["gate"]["requirements"][number] {
  const record = expectation as unknown as AnyRecord;
  const claim = isRecord(record.bundle_claim) ? record.bundle_claim : null;
  if (typeof record.id !== "string" || typeof record.description !== "string" || !claim || typeof claim.claimType !== "string") {
    throw new Error("canonical Flow gate contains malformed expectation metadata");
  }
  return {
    id: record.id,
    gate_id: gateId,
    required: record.required === true,
    description: record.description,
    claim_type: claim.claimType,
    subject_type: typeof claim.subjectType === "string" ? claim.subjectType : null,
    status: satisfied.has(record.id) ? "satisfied" : acceptedException ? "accepted_exception" : "unresolved",
  };
}

function skillIdentity(kit: AnyRecord, packageRoot: string, version: string, skill: string): GateActionEnvelope["action"]["skills"][number] {
  const skills = Array.isArray(kit.skills) ? kit.skills : [];
  const entry = skills.find((candidate): candidate is AnyRecord => isRecord(candidate) && candidate.id === `builder.${skill}`);
  if (!entry || typeof entry.path !== "string") throw new Error(`Builder gate-action skill '${skill}' has no installed skill source`);
  const kitRoot = path.join(packageRoot, "kits", "builder");
  const source = readStableRegularFile(kitRoot, entry.path, `Builder skill '${skill}'`, MAX_METADATA_BYTES);
  if (!source) throw new Error(`Builder skill '${skill}' has no installed skill source`);
  return {
    id: skill,
    package: { name: "@kontourai/flow-agents", version },
    path: path.relative(fs.realpathSync(packageRoot), source.path).split(path.sep).join("/"),
    sha256: createHash("sha256").update(source.bytes).digest("hex"),
  };
}

function canonicalEvidence(manifest: AnyRecord): string[] {
  const ids = (Array.isArray(manifest.evidence) ? manifest.evidence : []).flatMap((entry) => {
    if (!isRecord(entry) || entry.superseded_by || typeof entry.gate_id !== "string") return [];
    const identity = typeof entry.sha256 === "string" ? entry.sha256 : typeof entry.id === "string" ? entry.id : null;
    return identity ? [`${entry.gate_id}:${identity}`] : [];
  });
  const unique = [...new Set(ids)].sort();
  if (unique.length > MAX_CANONICAL_EVIDENCE) throw new Error("canonical Flow evidence exceeds the supported envelope bound");
  return unique;
}

export function observeBuilderArtifactsForProgress(sessionDir: string, artifacts: string[]): string[] {
  const observed: string[] = [];
  const candidates = [...new Set(artifacts)].filter((artifact) => !artifact.includes("#") && !isControlArtifact(artifact));
  if (candidates.length > MAX_OBSERVED_ARTIFACTS) throw new Error(`Builder artifact progress exceeds ${MAX_OBSERVED_ARTIFACTS} unique files`);
  const aggregateBudget = { remaining: MAX_OBSERVED_ARTIFACT_BYTES };
  for (const artifact of candidates) {
    const relative = artifact.replaceAll("<slug>", path.basename(sessionDir));
    const file = readStableRegularFile(sessionDir, relative, `Builder artifact '${artifact}'`, MAX_METADATA_BYTES, false, aggregateBudget);
    observed.push(file
      ? `${artifact}:${createHash("sha256").update(file.bytes).digest("hex")}`
      : `${artifact}:absent`);
  }
  return observed.sort();
}

function isControlArtifact(artifact: string): boolean {
  return CONTROL_ARTIFACTS.has(path.posix.normalize(artifact.replaceAll("\\", "/")));
}

function readBoundedJson(root: string, candidate: string, label: string): AnyRecord {
  const file = readStableRegularFile(root, candidate, label, MAX_METADATA_BYTES);
  if (!file) throw new Error(`${label} is missing`);
  const value = JSON.parse(file.bytes.toString("utf8")) as unknown;
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object`);
  return value;
}

function readStableRegularFile(
  root: string,
  candidate: string,
  label: string,
  maxBytes: number,
  required = true,
  aggregateBudget?: { remaining: number },
): { path: string; bytes: Buffer } | null {
  if (path.isAbsolute(candidate) || candidate.includes("\0")) throw new Error(`${label} must be a relative path`);
  const canonicalRoot = fs.realpathSync(root);
  const resolved = path.resolve(canonicalRoot, candidate);
  const relative = path.relative(canonicalRoot, resolved);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must remain within its package or session`);
  }
  let fd: number | undefined;
  try {
    const canonicalParentBefore = fs.realpathSync(path.dirname(resolved));
    assertWithinRoot(canonicalRoot, canonicalParentBefore, label);
    const parentBefore = fs.statSync(canonicalParentBefore);
    if (!parentBefore.isDirectory()) throw new Error(`${label} parent must be a directory`);
    if (typeof fsConstants.O_NOFOLLOW !== "number") throw new Error(`${label} cannot be read safely because O_NOFOLLOW is unavailable`);
    fd = fs.openSync(resolved, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > maxBytes) throw new Error(`${label} must be a bounded regular file`);
    if (aggregateBudget && before.size > aggregateBudget.remaining) throw new Error(`Builder artifact progress exceeds ${MAX_OBSERVED_ARTIFACT_BYTES} aggregate bytes`);
    if (aggregateBudget) aggregateBudget.remaining -= before.size;
    const pathBefore = fs.lstatSync(resolved);
    if (pathBefore.isSymbolicLink() || !sameIdentity(before, pathBefore)) throw new Error(`${label} changed identity while opening`);
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (!sameIdentity(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== after.size) {
      throw new Error(`${label} changed while reading`);
    }
    const pathAfter = fs.lstatSync(resolved);
    if (pathAfter.isSymbolicLink() || !sameIdentity(after, pathAfter)) throw new Error(`${label} changed identity while reading`);
    const canonicalParentAfter = fs.realpathSync(path.dirname(resolved));
    const parentAfter = fs.statSync(canonicalParentAfter);
    if (canonicalParentAfter !== canonicalParentBefore || !sameIdentity(parentBefore, parentAfter)) throw new Error(`${label} parent changed identity while reading`);
    assertWithinRoot(canonicalRoot, canonicalParentAfter, label);
    return { path: resolved, bytes };
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function assertWithinRoot(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must remain within its package or session`);
  }
}

function sameIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sessionPathForPublicCommand(projectRoot: string, sessionDir: string): string {
  const relative = path.relative(path.resolve(projectRoot), sessionDir);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Builder session must remain within the project root for public commands");
  }
  return relative;
}

function assertBoundedEnvelope(envelope: GateActionEnvelope): void {
  if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > MAX_ENVELOPE_BYTES) throw new Error("Builder gate-action envelope exceeds 65536 bytes");
}

function sameSet(left: string[], right: string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && left.every((entry) => right.includes(entry));
}

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
