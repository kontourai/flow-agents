import { isDeepStrictEqual } from "node:util";
import { MAX_CONTINUATION_TURNS } from "./continuation-persistence.js";
import {
  installedBuilderGateActionAuthority,
  type GateActionEnvelope,
  type GateActionPriorProgress,
  type GateActionProgressSnapshot,
} from "./builder-gate-action-envelope.js";
import {
  EVIDENCE_REF_JSON_SCHEMA,
  PUBLIC_OPERATION_CONTRACTS,
  WORKFLOW_CRITIQUE_PARAMETERS,
  WORKFLOW_EVIDENCE_PARAMETERS,
} from "./cli/public-contracts.js";
import { flowAgentsPackageVersion } from "./lib/package-version.js";
import type { ContinuationAcceptedTurn, ContinuationBarrier, ContinuationDriverState, ContinuationSnapshot, ContinuationTurnResult } from "./continuation-driver.js";

export const MAX_CONTINUATION_ADAPTER_EVIDENCE_BYTES = 65_536;
export const MAX_CONTINUATION_TURN_RESULT_BYTES = 74_000;

export function validateSnapshot(value: ContinuationSnapshot): ContinuationSnapshot {
  if (!value || typeof value !== "object") throw new Error("continuation runtime returned an invalid canonical snapshot");
  for (const field of ["run_id", "definition_id", "status", "current_step"] as const) if (typeof value[field] !== "string" || value[field].length === 0) throw new Error(`continuation snapshot ${field} must be a non-empty string`);
  if (!new Set(["continue", "waiting", "done", "failed"]).has(value.disposition)) throw new Error("continuation snapshot disposition is invalid");
  if (value.next_action !== null && (typeof value.next_action !== "object" || Array.isArray(value.next_action))) throw new Error("continuation snapshot next_action must be an object or null");
  if (value.gate_action_envelope !== undefined) validateGateActionEnvelope(value.gate_action_envelope, value);
  if (value.progress_snapshot !== undefined) validateProgressSnapshot(value.progress_snapshot);
  return structuredClone(value);
}

function validateGateActionEnvelope(value: GateActionEnvelope, snapshot: ContinuationSnapshot): void {
  if (!value || typeof value !== "object" || value.schema_version !== "3.0" || !value.flow || typeof value.flow.current_step !== "string"
    || !value.progress || !Array.isArray(value.progress.canonical_evidence) || !Array.isArray(value.progress.observed_artifacts)) throw new Error("continuation snapshot gate-action envelope is malformed");
  if (!hasExactKeys(value, ["schema_version", "flow", "gate", "action", "public_interfaces", "stop_condition", "progress"])) {
    throw new Error("continuation snapshot gate-action envelope has unsupported root fields");
  }
  if (!value.gate || !value.action || !Array.isArray(value.action.declared_artifacts) || !Array.isArray(value.action.artifact_bindings)
    || !value.stop_condition?.required || !Array.isArray(value.stop_condition.required.artifact_refs)
    || !value.public_interfaces?.schemas?.evidence_ref_json) throw new Error("continuation snapshot gate-action envelope is missing typed public interfaces");
  if (!isDeepStrictEqual(value.public_interfaces.schemas.evidence_ref_json, EVIDENCE_REF_JSON_SCHEMA)) throw new Error("continuation snapshot gate-action evidence schema is not canonical");
  if (!safeTaskSlug(value.flow.run_id)) throw new Error("continuation snapshot gate-action run id is not a safe task slug");
  if (value.flow.run_id !== snapshot.run_id || value.flow.definition_id !== snapshot.definition_id
    || value.flow.current_step !== snapshot.current_step || value.flow.status !== snapshot.status) throw new Error("continuation snapshot gate-action identity does not match the canonical snapshot");
  if (!value.stop_condition.scope || value.stop_condition.scope.run_id !== snapshot.run_id
    || value.stop_condition.scope.current_step !== snapshot.current_step || value.stop_condition.scope.current_gate_only !== true
    || !isDeepStrictEqual(value.stop_condition.scope.gate_ids, value.flow.gate_ids)) throw new Error("continuation snapshot gate-action scope does not match the canonical snapshot");
  validateFixedEnvelopeShape(value);
  if (!Array.isArray(value.action.skills) || !Array.isArray(value.action.operations) || !Array.isArray(value.action.declared_evidence)
    || !Array.isArray(value.public_interfaces.mutations)) throw new Error("continuation snapshot gate-action action bindings are malformed");
  const sessionArgument = `.kontourai/flow-agents/${value.flow.run_id}`;
  const packageIdentity = validateStatusInterface(value, sessionArgument);
  const authority = installedBuilderGateActionAuthority(value.flow.definition_id, value.flow.current_step, value.flow.run_id);
  if (value.flow.definition_version !== authority.definition_version) {
    throw new Error("continuation snapshot gate-action definition version does not match installed Builder authority");
  }
  if (!isDeepStrictEqual(value.stop_condition.external_capability, authority.external_capability)) {
    throw new Error("continuation snapshot gate-action external capability does not match installed Builder authority");
  }
  const declaredSkillIds = value.action.skills.map((skill) => skill.id);
  const declaredOperations = value.action.operations;
  if (!sameUniqueStrings(declaredSkillIds) || !sameUniqueStrings(declaredOperations) || !sameUniqueStrings(value.action.declared_evidence)) {
    throw new Error("continuation snapshot gate-action declarations contain invalid or duplicate ids");
  }
  for (const skill of value.action.skills) {
    if (!skill || !hasExactKeys(skill, ["id", "package", "path", "sha256"]) || !safeIdentifier(skill.id)
      || !authority.action.skills.some((installed) => isDeepStrictEqual(skill, installed))) {
      throw new Error("continuation snapshot gate-action skill binding is malformed");
    }
  }
  const mutationInterfaces = validateMutations(value, sessionArgument, packageIdentity);
  if (!isDeepStrictEqual(value.public_interfaces.mutations, authority.mutations)) {
    throw new Error("continuation snapshot gate-action mutations do not match installed Builder authority");
  }
  const operationMutations = new Set(value.public_interfaces.mutations.flatMap((mutation) => mutation.interface === "operation" ? [mutation.operation] : []));
  if (declaredOperations.some((operation) => !operationMutations.has(operation))) {
    throw new Error("continuation snapshot gate-action declared operation has no canonical mutation");
  }
  const declaredByRef = new Map<string, GateActionEnvelope["action"]["declared_artifacts"][number]>();
  for (const artifact of value.action.declared_artifacts) {
    validateArtifactTarget(artifact, value.flow.run_id, declaredSkillIds, declaredOperations, operationMutations, mutationInterfaces);
    if (declaredByRef.has(artifact.ref)) throw new Error("continuation snapshot gate-action artifact targets contain duplicate refs");
    declaredByRef.set(artifact.ref, artifact);
  }
  const boundRefs = new Set<string>();
  for (const binding of value.action.artifact_bindings) {
    if (!binding || !hasExactKeys(binding, ["target", "expectation_ids"])
      || !Array.isArray(binding.expectation_ids) || !sameUniqueStrings(binding.expectation_ids)
      || binding.expectation_ids.some((id) => !value.action.declared_evidence.includes(id))
      || !binding.target || !isDeepStrictEqual(declaredByRef.get(binding.target.ref), binding.target)
      || boundRefs.has(binding.target.ref)) {
      throw new Error("continuation snapshot gate-action artifact binding is malformed");
    }
    boundRefs.add(binding.target.ref);
  }
  if (boundRefs.size !== declaredByRef.size || [...declaredByRef.keys()].some((ref) => !boundRefs.has(ref))) {
    throw new Error("continuation snapshot gate-action artifact bindings are incomplete");
  }
  for (const artifact of value.stop_condition.required.artifact_refs) {
    validateArtifactTarget(artifact, value.flow.run_id, declaredSkillIds, declaredOperations, operationMutations, mutationInterfaces);
    if (!isDeepStrictEqual(declaredByRef.get(artifact.ref), artifact)) throw new Error("continuation snapshot gate-action required artifact is not a declared target");
  }
  if (!isDeepStrictEqual(value.action, authority.action) || !isDeepStrictEqual(value.flow.gate_ids, [authority.gate_id])) {
    throw new Error("continuation snapshot gate-action action does not match installed Builder authority");
  }
  validateGateRequirementBindings(value, authority);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 65_536) throw new Error("continuation snapshot gate-action envelope exceeds 65536 bytes");
}

function validateArtifactTarget(
  artifact: GateActionEnvelope["action"]["declared_artifacts"][number],
  runId: string,
  declaredSkillIds: string[],
  declaredOperations: string[],
  operationMutations: Set<string>,
  mutationInterfaces: Set<string>,
): void {
  if (!artifact || typeof artifact !== "object") throw new Error("continuation snapshot gate-action artifact target is malformed");
  if (artifact.kind === "file") {
    const prefix = `.kontourai/flow-agents/${runId}/`;
    const resolvedRef = typeof artifact.ref === "string" ? artifact.ref.replaceAll("<slug>", runId) : "";
    if (!hasExactKeys(artifact, ["kind", "ref", "path", "direct_write_allowed", "produced_via"])
      || typeof artifact.ref !== "string" || artifact.ref.length === 0 || artifact.ref.includes("#") || resolvedRef.includes("<") || resolvedRef.includes(">")
      || resolvedRef.includes("\\") || resolvedRef.includes("\0") || resolvedRef.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
      || forbiddenFileTarget(resolvedRef) || artifact.path !== `${prefix}${resolvedRef}`
      || !artifact.produced_via || (artifact.direct_write_allowed === true
        ? artifact.produced_via.interface !== "skill" || !hasExactKeys(artifact.produced_via, ["interface", "skill_ids"])
          || !safeDeclaredSubset(artifact.produced_via.skill_ids, declaredSkillIds)
        : artifact.direct_write_allowed === false
          ? artifact.produced_via.interface !== "operation" || !hasExactKeys(artifact.produced_via, ["interface", "operations"])
            || !safeDeclaredSubset(artifact.produced_via.operations, declaredOperations)
            || artifact.produced_via.operations.some((operation) => !operationMutations.has(operation))
          : true)) throw new Error("continuation snapshot gate-action file target is malformed");
  } else if (artifact.kind === "trust_slice") {
    if (!hasExactKeys(artifact, ["kind", "ref", "bundle_file", "slice_id", "direct_write_allowed", "record_via"])
      || artifact.bundle_file !== "trust.bundle" || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(artifact.slice_id)
      || artifact.ref !== `trust.bundle#${artifact.slice_id}` || artifact.direct_write_allowed !== false
      || !Array.isArray(artifact.record_via) || artifact.record_via.length === 0 || new Set(artifact.record_via).size !== artifact.record_via.length
      || artifact.record_via.some((entry) => (entry !== "workflow.evidence" && entry !== "workflow.critique") || !mutationInterfaces.has(entry))) throw new Error("continuation snapshot gate-action trust slice is malformed");
  } else {
    throw new Error("continuation snapshot gate-action artifact target kind is invalid");
  }
}

function safeDeclaredSubset(value: unknown, declared: string[]): value is string[] {
  const allowed = new Set(declared);
  return Array.isArray(value) && value.length > 0 && new Set(value).size === value.length
    && value.every((entry) => typeof entry === "string" && safeIdentifier(entry) && allowed.has(entry));
}

function validateStatusInterface(value: GateActionEnvelope, sessionArgument: string): { name: "@kontourai/flow-agents"; version: string } {
  const status = value.public_interfaces.status;
  if (!status || !hasExactKeys(status, ["package", "command", "argv"]) || status.command !== "flow-agents" || !isPackageIdentity(status.package)
    || status.package.version !== flowAgentsPackageVersion()
    || !isDeepStrictEqual(status.argv, ["workflow", "status", "--session-dir", sessionArgument, "--json"])) {
    throw new Error("continuation snapshot gate-action status interface is not canonical");
  }
  return status.package;
}

function validateMutations(
  value: GateActionEnvelope,
  sessionArgument: string,
  packageIdentity: { name: "@kontourai/flow-agents"; version: string },
): Set<string> {
  const expectationIds: string[] = [];
  const interfaces = new Set<string>();
  for (const mutation of value.public_interfaces.mutations) {
    if (!mutation || !safeIdentifier(mutation.expectation_id)) throw new Error("continuation snapshot gate-action mutation expectation is malformed");
    expectationIds.push(mutation.expectation_id);
    interfaces.add(mutation.interface);
    if (mutation.interface === "workflow.evidence") {
      if (!hasExactKeys(mutation, ["expectation_id", "interface", "package", "command", "argv", "parameters"])
        || !isDeepStrictEqual(mutation.package, packageIdentity) || mutation.command !== "flow-agents"
        || !isDeepStrictEqual(mutation.argv, ["workflow", "evidence", "--session-dir", sessionArgument, "--expectation", mutation.expectation_id, "--json"])
        || !isDeepStrictEqual(mutation.parameters, WORKFLOW_EVIDENCE_PARAMETERS)) {
        throw new Error("continuation snapshot gate-action evidence mutation is not canonical");
      }
    } else if (mutation.interface === "workflow.critique") {
      if (!hasExactKeys(mutation, ["expectation_id", "interface", "package", "command", "argv", "parameters"])
        || !isDeepStrictEqual(mutation.package, packageIdentity) || mutation.command !== "flow-agents"
        || !isDeepStrictEqual(mutation.argv, ["workflow", "critique", "--session-dir", sessionArgument, "--json"])
        || !isDeepStrictEqual(mutation.parameters, WORKFLOW_CRITIQUE_PARAMETERS)) {
        throw new Error("continuation snapshot gate-action critique mutation is not canonical");
      }
    } else if (mutation.interface === "operation") {
      const expected = PUBLIC_OPERATION_CONTRACTS[mutation.operation as keyof typeof PUBLIC_OPERATION_CONTRACTS];
      if (!hasExactKeys(mutation, ["expectation_id", "interface", "operation", "protocol", "completion"])
        || !expected || !value.action.operations.includes(mutation.operation) || !isDeepStrictEqual(mutation.protocol, expected)
        || !isDeepStrictEqual(mutation.completion, { status: "external_verification_required", executable_by_flow_agents: false, gate_evidence_interface: null })) {
        throw new Error("continuation snapshot gate-action operation mutation is not canonical");
      }
    } else {
      throw new Error("continuation snapshot gate-action mutation interface is invalid");
    }
  }
  if (!sameSet(expectationIds, value.action.declared_evidence)) {
    throw new Error("continuation snapshot gate-action mutations do not match declared evidence");
  }
  return interfaces;
}

function isPackageIdentity(value: unknown): value is { name: "@kontourai/flow-agents"; version: string } {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && hasExactKeys(value, ["name", "version"])
    && (value as { name?: unknown }).name === "@kontourai/flow-agents"
    && typeof (value as { version?: unknown }).version === "string"
    && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test((value as { version: string }).version);
}

function safeTaskSlug(value: string): boolean {
  return value.length <= 128 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function safeIdentifier(value: string): boolean {
  return /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value);
}

function sameUniqueStrings(value: unknown): value is string[] {
  return Array.isArray(value) && new Set(value).size === value.length && value.every((entry) => typeof entry === "string" && safeIdentifier(entry));
}

function sameSet(left: string[], right: string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && left.every((entry) => right.includes(entry));
}

function forbiddenFileTarget(ref: string): boolean {
  const segments = ref.split("/");
  return ref === "state.json" || ref === "trust.bundle"
    || segments.some((segment) => segment.startsWith(".") || segment === "continuation-driver");
}

function hasExactKeys(value: object, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  return isDeepStrictEqual(keys, [...expected].sort());
}

function validateFixedEnvelopeShape(value: GateActionEnvelope): void {
  if (!hasExactKeys(value.flow, ["run_id", "definition_id", "definition_version", "status", "current_step", "gate_ids"])
    || typeof value.flow.definition_version !== "string" || value.flow.definition_version.length === 0
    || !Array.isArray(value.flow.gate_ids) || !sameUniqueGateIds(value.flow.gate_ids)) {
    throw new Error("continuation snapshot gate-action flow binding is malformed");
  }
  if (!hasExactKeys(value.gate, ["requirements", "unresolved_requirement_ids", "accepted_exceptions"])
    || !Array.isArray(value.gate.requirements) || !Array.isArray(value.gate.unresolved_requirement_ids)
    || !Array.isArray(value.gate.accepted_exceptions)) {
    throw new Error("continuation snapshot gate-action gate binding is malformed");
  }
  if (!hasExactKeys(value.action, ["skills", "operations", "declared_artifacts", "artifact_bindings", "declared_evidence", "implementation_allowed"])
    || typeof value.action.implementation_allowed !== "boolean") {
    throw new Error("continuation snapshot gate-action action policy is malformed");
  }
  if (!hasExactKeys(value.public_interfaces, ["status", "schemas", "mutations"])
    || !hasExactKeys(value.public_interfaces.schemas, ["evidence_ref_json"])) {
    throw new Error("continuation snapshot gate-action public interfaces are malformed");
  }
  if (!hasExactKeys(value.stop_condition.scope, ["run_id", "current_step", "gate_ids", "current_gate_only"])) {
    throw new Error("continuation snapshot gate-action stop scope is malformed");
  }
  const required = value.stop_condition.required;
  if (!hasExactKeys(required, ["skill_ids", "artifact_refs", "unresolved_evidence_ids"])
    || value.stop_condition.kind !== "one_turn" || value.stop_condition.after !== "return_adapter_result"
    || value.stop_condition.synchronize_canonical_flow !== true || value.stop_condition.adapter_evidence_is_gate_evidence !== false
    || !isDeepStrictEqual(value.stop_condition.sequence, ["activate_required_skills", "produce_declared_artifacts", "record_bound_evidence", "synchronize_canonical_flow", "return_adapter_result"])
    || !Array.isArray(required.skill_ids) || !Array.isArray(required.unresolved_evidence_ids)) {
    throw new Error("continuation snapshot gate-action stop condition is malformed");
  }
  const allowedStopKeys = ["kind", "scope", "required", "sequence", "after", "synchronize_canonical_flow", "adapter_evidence_is_gate_evidence"];
  if (value.stop_condition.external_capability !== undefined) allowedStopKeys.push("external_capability");
  if (!hasExactKeys(value.stop_condition, allowedStopKeys)) throw new Error("continuation snapshot gate-action stop condition is malformed");
  if (value.stop_condition.external_capability !== undefined) {
    const capability = value.stop_condition.external_capability;
    const protocol = PUBLIC_OPERATION_CONTRACTS[capability.operation as keyof typeof PUBLIC_OPERATION_CONTRACTS];
    if (!hasExactKeys(capability, ["status", "operation", "capability", "completion"])
      || capability.status !== "waiting" || capability.completion !== "external_verification_required"
      || !protocol || !value.action.operations.includes(capability.operation) || capability.capability !== protocol.capability) {
      throw new Error("continuation snapshot gate-action external capability is malformed");
    }
  }
  const progressKeys = ["canonical_evidence", "observed_artifacts"];
  if (value.progress.prior_turn !== undefined) progressKeys.push("prior_turn");
  if (!hasExactKeys(value.progress, progressKeys)
    || !value.progress.canonical_evidence.every((entry) => typeof entry === "string")
    || !value.progress.observed_artifacts.every((entry) => typeof entry === "string")) {
    throw new Error("continuation snapshot gate-action progress is malformed");
  }
  if (value.progress.prior_turn !== undefined) validatePriorProgress(value.progress.prior_turn);
}

function sameUniqueGateIds(value: unknown): value is string[] {
  return Array.isArray(value) && new Set(value).size === value.length && value.every((entry) => typeof entry === "string"
    && entry.split(":").every((part) => safeIdentifier(part)));
}

function validateGateRequirementBindings(
  value: GateActionEnvelope,
  authority: ReturnType<typeof installedBuilderGateActionAuthority>,
): void {
  if (!Array.isArray(value.flow.gate_ids) || !Array.isArray(value.gate.requirements) || !Array.isArray(value.gate.accepted_exceptions)) {
    throw new Error("continuation snapshot gate-action envelope has malformed gate bindings");
  }
  const activeGates = new Set(value.flow.gate_ids);
  const requirementIds: string[] = [];
  const unresolvedIds: string[] = [];
  const unresolvedRequiredIds: string[] = [];
  const acceptedGates = new Set<string>();
  for (const exception of value.gate.accepted_exceptions) {
    if (!exception || !hasExactKeys(exception, ["gate_id", "exception_id"])
      || typeof exception.gate_id !== "string" || typeof exception.exception_id !== "string" || exception.exception_id.length === 0
      || !activeGates.has(exception.gate_id) || acceptedGates.has(exception.gate_id)) {
      throw new Error("continuation snapshot gate-action envelope has invalid accepted exceptions");
    }
    acceptedGates.add(exception.gate_id);
  }
  const gatesWithRequirements = new Set<string>();
  const authorityRequirements = new Map(authority.requirements.map((requirement) => [requirement.id, requirement]));
  for (const requirement of value.gate.requirements) {
    if (!requirement || !hasExactKeys(requirement, ["id", "gate_id", "required", "description", "claim_type", "subject_type", "status"])
      || !safeIdentifier(requirement.id) || typeof requirement.gate_id !== "string" || !activeGates.has(requirement.gate_id)
      || typeof requirement.required !== "boolean" || typeof requirement.description !== "string" || requirement.description.length === 0
      || typeof requirement.claim_type !== "string" || requirement.claim_type.length === 0
      || (requirement.subject_type !== null && (typeof requirement.subject_type !== "string" || requirement.subject_type.length === 0))
      || !new Set(["satisfied", "accepted_exception", "unresolved"]).has(requirement.status)) {
      throw new Error("continuation snapshot gate-action envelope has an invalid requirement gate binding");
    }
    const { status: _status, required: _required, ...shape } = requirement;
    const authoritative = authorityRequirements.get(requirement.id);
    if (!authoritative) throw new Error("continuation snapshot gate-action requirement does not match installed Flow authority");
    const { required: _authoritativeRequired, ...authoritativeShape } = authoritative;
    if (!isDeepStrictEqual(shape, authoritativeShape)) {
      throw new Error("continuation snapshot gate-action requirement does not match installed Flow authority");
    }
    requirementIds.push(requirement.id);
    if (requirement.status === "unresolved") {
      unresolvedIds.push(requirement.id);
      if (requirement.required) unresolvedRequiredIds.push(requirement.id);
    }
    gatesWithRequirements.add(requirement.gate_id);
    if ((requirement.status === "accepted_exception") !== acceptedGates.has(requirement.gate_id)
      && requirement.status !== "satisfied") {
      throw new Error("continuation snapshot gate-action envelope has inconsistent exception bindings");
    }
  }
  if ([...acceptedGates].some((gateId) => !gatesWithRequirements.has(gateId))) {
    throw new Error("continuation snapshot gate-action envelope exception has no bound requirements");
  }
  if (!sameUniqueStrings(requirementIds) || !sameSet(requirementIds, value.action.declared_evidence)
    || !sameSet(unresolvedIds, value.gate.unresolved_requirement_ids)
    || !sameSet(unresolvedRequiredIds, value.stop_condition.required.unresolved_evidence_ids)) {
    throw new Error("continuation snapshot gate-action requirement projections are inconsistent");
  }
  const expectedSkillIds = unresolvedRequiredIds.length > 0 ? value.action.skills.map((skill) => skill.id) : [];
  if (!sameSet(expectedSkillIds, value.stop_condition.required.skill_ids)) {
    throw new Error("continuation snapshot gate-action required skills are inconsistent");
  }
  const unresolvedRequired = new Set(unresolvedRequiredIds);
  const expectedArtifacts = value.action.artifact_bindings
    .filter((binding) => binding.expectation_ids.some((id) => unresolvedRequired.has(id)))
    .map((binding) => binding.target);
  if (!sameArtifactTargets(expectedArtifacts, value.stop_condition.required.artifact_refs)) {
    throw new Error("continuation snapshot gate-action required artifacts are inconsistent");
  }
}

function sameArtifactTargets(left: GateActionEnvelope["action"]["declared_artifacts"], right: GateActionEnvelope["action"]["declared_artifacts"]): boolean {
  if (left.length !== right.length) return false;
  const rightByRef = new Map(right.map((target) => [target.ref, target]));
  return rightByRef.size === right.length && left.every((target) => isDeepStrictEqual(target, rightByRef.get(target.ref)));
}

export function validateTurnResult(value: ContinuationTurnResult): ContinuationTurnResult {
  if (!value || typeof value !== "object" || (value.status !== "completed" && value.status !== "wait")) throw new Error("continuation adapter must return status completed or wait");
  if (value.status === "wait") validateBarrier(value.barrier);
  if (value.summary !== undefined && typeof value.summary !== "string") throw new Error("continuation adapter summary must be a string");
  if (value.status === "completed" && value.evidence !== undefined) validateAdapterEvidence(value.evidence);
  if (value.status === "wait" && Object.hasOwn(value, "evidence")) throw new Error("continuation wait results must not include evidence");
  const copy = structuredClone(value);
  if (copy.summary) {
    const characters = Array.from(copy.summary);
    if (characters.length > 2_000) copy.summary = `${characters.slice(0, 1_997).join("")}...`;
  }
  if (Buffer.byteLength(JSON.stringify(copy), "utf8") > MAX_CONTINUATION_TURN_RESULT_BYTES) throw new Error(`continuation adapter result must not exceed ${MAX_CONTINUATION_TURN_RESULT_BYTES} bytes`);
  return copy;
}

function validateAdapterEvidence(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("continuation adapter evidence must be a JSON object");
  let encoded: string;
  try { encoded = JSON.stringify(value); }
  catch { throw new Error("continuation adapter evidence must be JSON-serializable"); }
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_CONTINUATION_ADAPTER_EVIDENCE_BYTES) throw new Error(`continuation adapter evidence must not exceed ${MAX_CONTINUATION_ADAPTER_EVIDENCE_BYTES} bytes`);
  const parsed = JSON.parse(encoded) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("continuation adapter evidence must be a JSON object");
}

export function validateBarrier(barrier: ContinuationBarrier): void {
  if (!barrier || typeof barrier !== "object") throw new Error("continuation wait result requires a barrier");
  if (barrier.kind === "pid") {
    if (!Number.isSafeInteger(barrier.pid) || barrier.pid <= 0) throw new Error("continuation pid barrier requires a positive integer pid");
    return;
  }
  if (barrier.kind === "deadline") {
    if (typeof barrier.at !== "string" || !Number.isFinite(Date.parse(barrier.at))) throw new Error("continuation deadline barrier requires an ISO date-time");
    return;
  }
  throw new Error("continuation barrier kind must be pid or deadline");
}

export function validateState(state: ContinuationDriverState): void {
  if (state.schema_version !== "1.0") throw new Error("continuation driver state schema_version must be 1.0");
  assertMaxTurns(state.max_turns);
  if (state.adapter_command_identity !== null && (typeof state.adapter_command_identity !== "string" || state.adapter_command_identity.length === 0)) throw new Error("continuation driver adapter_command_identity must be a non-empty string or null");
  if (state.context_policy !== undefined && !new Set(["warm", "fresh"]).has(state.context_policy)) throw new Error("continuation driver context_policy must be warm or fresh");
  if (!Number.isSafeInteger(state.turns_started) || state.turns_started < 0 || state.turns_started > state.max_turns) throw new Error("continuation driver turns_started is outside its mission budget");
  if (state.active_turn_step !== undefined && state.active_turn_step !== null && (typeof state.active_turn_step !== "string" || state.active_turn_step.length === 0)) throw new Error("continuation driver active_turn_step must be a non-empty string or null");
  if (state.active_turn_public_key_digest !== undefined && state.active_turn_public_key_digest !== null && (typeof state.active_turn_public_key_digest !== "string" || !/^[a-f0-9]{64}$/.test(state.active_turn_public_key_digest))) throw new Error("continuation driver active_turn_public_key_digest must be a SHA-256 hex digest or null");
  if (state.active_turn_phase !== undefined && state.active_turn_phase !== null && !new Set(["prepared", "started", "measured"]).has(state.active_turn_phase)) throw new Error("continuation driver active_turn_phase must be prepared, started, measured, or null");
  if (state.active_turn_progress) validateProgressSnapshot(state.active_turn_progress);
  if (state.active_turn_capture) validateAcceptedTurn(state.active_turn_capture);
  if (state.active_turn_phase === "measured" && !state.active_turn_capture) throw new Error("continuation measured turn must retain its accepted capture");
  if (state.last_progress) validateProgressSnapshot(state.last_progress);
  if (state.prior_progress) validatePriorProgress(state.prior_progress);
  if (!new Set(["active", "waiting", "done", "failed", "budget_exhausted"]).has(state.status)) throw new Error("continuation driver state status is invalid");
  if (state.status === "budget_exhausted" && state.turns_started !== state.max_turns) throw new Error("continuation driver budget_exhausted state must consume max_turns");
  if (state.pending_barrier) validateBarrier(state.pending_barrier);
}

function validateAcceptedTurn(value: ContinuationAcceptedTurn): void {
  if (!value || typeof value !== "object" || value.schema_version !== "1.0" || typeof value.turn_id !== "string" || !Number.isSafeInteger(value.iteration)
    || value.iteration < 1 || value.request?.iteration !== value.iteration || typeof value.captured_at !== "string" || !Number.isFinite(Date.parse(value.captured_at))) throw new Error("continuation accepted-turn capture is malformed");
  validateTurnResult(value.result);
  if (value.request.context_strategy !== undefined) validateContextStrategy(value.request.context_strategy);
  if (value.progress !== null) validatePriorProgress(value.progress);
}

function validateContextStrategy(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("continuation context strategy is malformed");
  const strategy = value as Record<string, unknown>;
  if (strategy.handoff !== "canonical" || !new Set(["new", "resume"]).has(String(strategy.thread))
    || !new Set(["mission_start", "configured_policy"]).has(String(strategy.reason))
    || Object.keys(strategy).some((key) => !new Set(["thread", "handoff", "reason"]).has(key))) {
    throw new Error("continuation context strategy is malformed");
  }
}

function validateProgressSnapshot(value: GateActionProgressSnapshot): void {
  if (!value || typeof value !== "object" || typeof value.current_step !== "string" || value.current_step.length === 0
    || (value.canonical_status !== undefined && (typeof value.canonical_status !== "string" || value.canonical_status.length === 0))
    || !Array.isArray(value.canonical_evidence) || !value.canonical_evidence.every((entry) => typeof entry === "string")
    || !Array.isArray(value.observed_artifacts) || !value.observed_artifacts.every((entry) => typeof entry === "string")) throw new Error("continuation driver progress snapshot is malformed");
}

function validatePriorProgress(value: GateActionPriorProgress): void {
  if (!value || typeof value !== "object" || typeof value.step_advanced !== "boolean" || typeof value.no_progress !== "boolean"
    || !Array.isArray(value.evidence_added) || !value.evidence_added.every((entry) => typeof entry === "string")
    || !Array.isArray(value.artifact_changes) || !value.artifact_changes.every((entry) => typeof entry === "string")
    || !Number.isSafeInteger(value.consecutive_no_progress) || value.consecutive_no_progress < 0 || !new Set(["none", "possible", "stagnant"]).has(value.stagnation)) throw new Error("continuation driver prior progress is malformed");
}

export function assertMissionIdentity(state: Pick<ContinuationDriverState, "run_id" | "definition_id">, snapshot: ContinuationSnapshot): void {
  if (state.run_id !== snapshot.run_id || state.definition_id !== snapshot.definition_id) throw new Error("continuation driver mission identity does not match the canonical Flow run");
}

export function assertMaxTurns(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CONTINUATION_TURNS) throw new Error(`continuation maxTurns must be an integer from 1 through ${MAX_CONTINUATION_TURNS}`);
}
