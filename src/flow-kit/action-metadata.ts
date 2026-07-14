import * as path from "node:path";
import { PUBLIC_OPERATION_IDS } from "../cli/public-contracts.js";

export interface KitFlowStepActionEntry {
  flow_id: string;
  step_id: string;
  skills: string[];
  operations: string[];
  expectation_ids: string[];
  artifacts: string[];
  implementation_allowed: boolean;
  expectation_bindings: KitFlowStepExpectationBinding[];
  artifact_bindings: KitFlowStepArtifactBinding[];
}

export type KitFlowStepExpectationBinding = {
  expectation_id: string;
  interface: "workflow.evidence" | "workflow.critique" | "operation";
  operation?: string;
};

export type KitFlowStepArtifactBinding = { artifact: string; expectation_ids: string[] };

const MAX_FLOW_STEP_ACTIONS = 128;
const MAX_FLOW_STEP_ACTION_LIST_ITEMS = 32;
const MAX_FLOW_STEP_ACTION_SKILLS = 16;
const MAX_FLOW_OBSERVABLE_ARTIFACTS = 128;
const MAX_FLOW_STEP_ACTION_TEXT = 1024;
const WORKFLOW_TRIGGER_IDENTIFIER_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

export function workflowTriggerIdentifier(value: unknown): value is string {
  return typeof value === "string" && WORKFLOW_TRIGGER_IDENTIFIER_RE.test(value);
}

export function parseKitFlowStepActions(manifest: Record<string, unknown>, manifestPath: string): { entries: KitFlowStepActionEntry[]; errors: string[] } {
  const entries: KitFlowStepActionEntry[] = [];
  const errors: string[] = [];
  const raw = manifest.flow_step_actions;
  if (raw === undefined) return { entries, errors };
  if (!Array.isArray(raw)) return { entries, errors: [`${manifestPath}: .flow_step_actions must be a list`] };
  if (raw.length > MAX_FLOW_STEP_ACTIONS) return { entries, errors: [`${manifestPath}: .flow_step_actions exceeds ${MAX_FLOW_STEP_ACTIONS} entries`] };
  const seen = new Set<string>();
  raw.forEach((rawEntry, index) => {
    const entry = parseFlowStepActionEntry(rawEntry, manifestPath, index, errors);
    if (!entry) return;
    const key = `${entry.flow_id}/${entry.step_id}`;
    if (seen.has(key)) errors.push(`${manifestPath}: flow_step_actions[${index}] duplicates '${key}'`);
    else { seen.add(key); entries.push(entry); }
  });
  validateObservableArtifactBounds(entries, manifestPath, errors);
  return { entries, errors };
}

type FlowStepActionLists = Pick<KitFlowStepActionEntry, "skills" | "operations" | "expectation_ids" | "artifacts">;

function parseFlowStepActionEntry(raw: unknown, manifestPath: string, index: number, errors: string[]): KitFlowStepActionEntry | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    errors.push(`${manifestPath}: flow_step_actions[${index}] must be an object`);
    return null;
  }
  const record = raw as Record<string, unknown>;
  const supported = new Set(["flow_id", "step_id", "skills", "operations", "expectation_ids", "artifacts", "implementation_allowed", "expectation_bindings", "artifact_bindings"]);
  const unsupported = Object.keys(record).filter((key) => !supported.has(key));
  if (unsupported.length) { errors.push(`${manifestPath}: flow_step_actions[${index}] has unsupported field(s): ${unsupported.join(", ")}`); return null; }
  if (!workflowTriggerIdentifier(record.flow_id) || !workflowTriggerIdentifier(record.step_id)) {
    errors.push(`${manifestPath}: flow_step_actions[${index}] must declare valid flow_id and step_id identifiers`);
    return null;
  }
  for (const field of ["expectation_ids", "artifacts", "implementation_allowed", "expectation_bindings", "artifact_bindings"] as const) {
    if (!Object.hasOwn(record, field)) errors.push(`${manifestPath}: flow_step_actions[${index}].${field} must be explicitly declared`);
  }
  const lists = parseFlowStepActionLists(record, manifestPath, index, errors);
  if (!lists || typeof record.implementation_allowed !== "boolean") {
    if (typeof record.implementation_allowed !== "boolean") errors.push(`${manifestPath}: flow_step_actions[${index}].implementation_allowed must be a boolean`);
    return null;
  }
  const expectationBindings = parseExpectationBindings(record.expectation_bindings ?? [], lists.operations, manifestPath, index, errors);
  if (!expectationBindings || !sameStringSet(expectationBindings.map((binding) => binding.expectation_id), lists.expectation_ids)) {
    if (expectationBindings) errors.push(`${manifestPath}: flow_step_actions[${index}].expectation_bindings must bind every expectation_id exactly once`);
    return null;
  }
  const artifactBindings = parseArtifactBindings(record.artifact_bindings ?? [], lists.artifacts, lists.expectation_ids, manifestPath, index, errors);
  return artifactBindings ? { flow_id: record.flow_id, step_id: record.step_id, ...lists, implementation_allowed: record.implementation_allowed, expectation_bindings: expectationBindings, artifact_bindings: artifactBindings } : null;
}

function parseFlowStepActionLists(record: Record<string, unknown>, manifestPath: string, index: number, errors: string[]): FlowStepActionLists | null {
  const skills = record.skills;
  const operations = record.operations ?? [];
  const expectationIds = record.expectation_ids ?? [];
  const artifacts = record.artifacts ?? [];
  const label = `${manifestPath}: flow_step_actions[${index}]`;
  if ([skills, operations, expectationIds, artifacts].some((list) => Array.isArray(list) && list.length > MAX_FLOW_STEP_ACTION_LIST_ITEMS)) return fail(errors, `${label} list exceeds ${MAX_FLOW_STEP_ACTION_LIST_ITEMS} entries`);
  if (!Array.isArray(skills) || !skills.every(workflowTriggerIdentifier) || new Set(skills).size !== skills.length) return fail(errors, `${label}.skills must be an identifier list without duplicates`);
  if (skills.length > MAX_FLOW_STEP_ACTION_SKILLS) return fail(errors, `${label}.skills exceeds ${MAX_FLOW_STEP_ACTION_SKILLS} entries`);
  if (!Array.isArray(operations) || !operations.every(workflowTriggerIdentifier) || new Set(operations).size !== operations.length || operations.some((operation) => !PUBLIC_OPERATION_IDS.has(operation))) return fail(errors, `${label}.operations must be unique identifiers from the canonical public operation catalog`);
  if (!Array.isArray(expectationIds) || !expectationIds.every(workflowTriggerIdentifier) || new Set(expectationIds).size !== expectationIds.length) return fail(errors, `${label}.expectation_ids must be a unique identifier list`);
  if (!Array.isArray(artifacts) || !artifacts.every(isSafeBuilderArtifactRef) || new Set(artifacts).size !== artifacts.length) return fail(errors, `${label}.artifacts must be unique safe session-relative paths or trust.bundle#<safe-id> refs`);
  if ([...skills, ...operations, ...expectationIds, ...artifacts].some((entry) => entry.length > MAX_FLOW_STEP_ACTION_TEXT)) return fail(errors, `${label} values must not exceed ${MAX_FLOW_STEP_ACTION_TEXT} characters`);
  return { skills, operations, expectation_ids: expectationIds, artifacts };
}

function fail(errors: string[], message: string): null { errors.push(message); return null; }

function validateObservableArtifactBounds(entries: KitFlowStepActionEntry[], manifestPath: string, errors: string[]): void {
  const observableByFlow = new Map<string, Set<string>>();
  for (const action of entries) {
    const observed = observableByFlow.get(action.flow_id) ?? new Set<string>();
    for (const artifact of action.artifacts) if (isObservableBuilderArtifactRef(artifact)) observed.add(artifact);
    observableByFlow.set(action.flow_id, observed);
  }
  for (const [flowId, artifacts] of observableByFlow) if (artifacts.size > MAX_FLOW_OBSERVABLE_ARTIFACTS) errors.push(`${manifestPath}: flow_step_actions for '${flowId}' exceed ${MAX_FLOW_OBSERVABLE_ARTIFACTS} distinct observable file artifacts`);
}

function parseExpectationBindings(value: unknown, operations: string[], manifestPath: string, actionIndex: number, errors: string[]): KitFlowStepExpectationBinding[] | null {
  if (!Array.isArray(value) || value.length > MAX_FLOW_STEP_ACTION_LIST_ITEMS) return fail(errors, `${manifestPath}: flow_step_actions[${actionIndex}].expectation_bindings must be a bounded list`);
  const bindings: KitFlowStepExpectationBinding[] = [];
  for (const [bindingIndex, entry] of value.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return fail(errors, `${manifestPath}: flow_step_actions[${actionIndex}].expectation_bindings[${bindingIndex}] must be an object`);
    const record = entry as Record<string, unknown>;
    const unsupported = Object.keys(record).filter((key) => key !== "expectation_id" && key !== "interface" && key !== "operation");
    if (unsupported.length) return fail(errors, `${manifestPath}: flow_step_actions[${actionIndex}].expectation_bindings[${bindingIndex}] has unsupported field(s): ${unsupported.join(", ")}`);
    if (!workflowTriggerIdentifier(record.expectation_id) || !new Set(["workflow.evidence", "workflow.critique", "operation"]).has(String(record.interface))) return fail(errors, `${manifestPath}: flow_step_actions[${actionIndex}].expectation_bindings[${bindingIndex}] must declare a valid expectation_id and interface`);
    if (record.interface === "operation") {
      if (!workflowTriggerIdentifier(record.operation) || !operations.includes(record.operation) || !PUBLIC_OPERATION_IDS.has(record.operation)) return fail(errors, `${manifestPath}: flow_step_actions[${actionIndex}].expectation_bindings[${bindingIndex}].operation must name a declared canonical public operation`);
    } else if (record.operation !== undefined) return fail(errors, `${manifestPath}: flow_step_actions[${actionIndex}].expectation_bindings[${bindingIndex}].operation is allowed only for operation bindings`);
    bindings.push({ expectation_id: record.expectation_id as string, interface: record.interface as KitFlowStepExpectationBinding["interface"], ...(typeof record.operation === "string" ? { operation: record.operation } : {}) });
  }
  if (new Set(bindings.map((binding) => binding.expectation_id)).size !== bindings.length) return fail(errors, `${manifestPath}: flow_step_actions[${actionIndex}].expectation_bindings must not duplicate expectation ids`);
  return bindings;
}

function parseArtifactBindings(value: unknown, artifacts: string[], expectationIds: string[], manifestPath: string, actionIndex: number, errors: string[]): KitFlowStepArtifactBinding[] | null {
  if (!Array.isArray(value) || value.length > MAX_FLOW_STEP_ACTION_LIST_ITEMS) return fail(errors, `${manifestPath}: flow_step_actions[${actionIndex}].artifact_bindings must be a bounded list`);
  const bindings: KitFlowStepArtifactBinding[] = [];
  for (const [bindingIndex, entry] of value.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return fail(errors, `${manifestPath}: flow_step_actions[${actionIndex}].artifact_bindings[${bindingIndex}] must be an object`);
    const record = entry as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== "artifact" && key !== "expectation_ids") || typeof record.artifact !== "string" || !artifacts.includes(record.artifact)
      || !Array.isArray(record.expectation_ids) || !record.expectation_ids.every((id) => typeof id === "string" && expectationIds.includes(id)) || new Set(record.expectation_ids).size !== record.expectation_ids.length) return fail(errors, `${manifestPath}: flow_step_actions[${actionIndex}].artifact_bindings[${bindingIndex}] must bind one declared artifact to declared expectation_ids`);
    if (record.artifact.startsWith("trust.bundle#") && record.expectation_ids.length === 0) return fail(errors, `${manifestPath}: flow_step_actions[${actionIndex}].artifact_bindings[${bindingIndex}] trust slice must own at least one expectation to derive its recording interface`);
    bindings.push({ artifact: record.artifact, expectation_ids: record.expectation_ids as string[] });
  }
  if (!sameStringSet(bindings.map((binding) => binding.artifact), artifacts)) return fail(errors, `${manifestPath}: flow_step_actions[${actionIndex}].artifact_bindings must bind every artifact exactly once`);
  return bindings;
}

export function isSafeBuilderArtifactRef(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || value.includes("\\")) return false;
  if (value.startsWith("trust.bundle#")) return /^trust\.bundle#[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value);
  if (value.includes("#") || path.posix.isAbsolute(value)) return false;
  const expanded = value.replaceAll("<slug>", "slug");
  return expanded !== "." && !expanded.split("/").some((part) => part === "" || part === "." || part === "..");
}

export function isObservableBuilderArtifactRef(value: string): boolean { return !value.includes("#") && path.posix.normalize(value) !== "state.json"; }
export function sameStringSet(left: string[], right: string[]): boolean { return left.length === right.length && new Set(left).size === left.length && left.every((entry) => right.includes(entry)); }
