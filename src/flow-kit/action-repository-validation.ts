import fs from "node:fs";
import * as path from "node:path";
import { sameStringSet, type KitFlowStepActionEntry } from "./action-metadata.js";

type SkillRoleEntry = { skill_id: string; role: string; flow_id?: string; step_ids: string[]; expectation_ids: string[] };
type FlowExpectation = { id: string; exportKeys: Set<string> };
type FlowMetadata = { steps: Set<string>; expectationsByStep: Map<string, Map<string, FlowExpectation>>; usesFlowByStep: Map<string, string>; exports: Set<string> };
type EffectiveFlowStep = { sourceFlowId: string; stepId: string; expectations: Map<string, FlowExpectation>; flowIds: Set<string> };
const MAX_FLOW_DEFINITION_BYTES = 1_048_576;

export function validateActionRepositoryMetadata(input: {
  kitDir: string;
  manifestPath: string;
  manifest: Record<string, unknown>;
  actions: KitFlowStepActionEntry[];
  skillRoles: SkillRoleEntry[];
}): string[] {
  const errors: string[] = [];
  validateDeclaredSkills(input.manifest, input.skillRoles, input.manifestPath, errors);
  const flows = loadFlowMetadata(input.kitDir, input.manifest, input.manifestPath, errors);
  const resolve = effectiveStepResolver(flows);
  validateRoleReferences(input.skillRoles, flows, resolve, input.manifestPath, errors);
  const owners = seedSkillOwners(input.skillRoles, resolve);
  validateActions(input.actions, input.skillRoles, flows, resolve, owners, input.manifest, input.manifestPath, errors);
  validateOwnerCardinality(flows, owners, input.manifestPath, errors);
  return errors;
}

function validateDeclaredSkills(manifest: Record<string, unknown>, roles: SkillRoleEntry[], manifestPath: string, errors: string[]): void {
  const declared = new Set(Array.isArray(manifest.skills) ? manifest.skills.flatMap((entry) => typeof entry === "object" && entry !== null && typeof (entry as Record<string, unknown>).id === "string" ? [(entry as Record<string, unknown>).id as string] : []) : []);
  const bound = new Set(roles.map((entry) => entry.skill_id));
  for (const id of declared) if (!bound.has(id)) errors.push(`${manifestPath}: skill_roles is missing declared skill '${id}'`);
  for (const id of bound) if (!declared.has(id)) errors.push(`${manifestPath}: skill_roles references undeclared skill '${id}'`);
}

function loadFlowMetadata(kitDir: string, manifest: Record<string, unknown>, manifestPath: string, errors: string[]): Map<string, FlowMetadata> {
  const flows = new Map<string, FlowMetadata>();
  if (!Array.isArray(manifest.flows)) return flows;
  for (const entry of manifest.flows) {
    if (typeof entry !== "object" || entry === null) continue;
    const flow = entry as Record<string, unknown>;
    if (typeof flow.id !== "string" || typeof flow.path !== "string") continue;
    const safe = readSafeFlowDefinition(kitDir, flow.path);
    if (!safe.definition) { errors.push(`${manifestPath}: flows '${flow.id}' ${safe.error}`); continue; }
    const definition = safe.definition;
    const steps = Array.isArray(definition.steps) ? definition.steps.filter(isRecord) : [];
    const stepIds = new Set(steps.flatMap((step) => typeof step.id === "string" ? [step.id] : []));
    const usesFlowByStep = new Map(steps.flatMap((step) => typeof step.id === "string" && typeof step.uses_flow === "string" ? [[step.id, step.uses_flow] as const] : []));
    flows.set(flow.id, { steps: stepIds, usesFlowByStep, expectationsByStep: expectationsByStep(definition), exports: new Set(Array.isArray(definition.exports) ? definition.exports.filter((value): value is string => typeof value === "string" && value.length > 0) : []) });
  }
  return flows;
}

function expectationsByStep(definition: Record<string, unknown>): Map<string, Map<string, FlowExpectation>> {
  const result = new Map<string, Map<string, FlowExpectation>>();
  if (!isRecord(definition.gates)) return result;
  for (const gate of Object.values(definition.gates)) {
    if (!isRecord(gate) || typeof gate.step !== "string" || !Array.isArray(gate.expects)) continue;
    const expectations = result.get(gate.step) ?? new Map<string, FlowExpectation>();
    for (const value of gate.expects) {
      if (!isRecord(value) || typeof value.id !== "string") continue;
      const exportKeys = new Set([value.id]);
      if (isRecord(value.bundle_claim) && typeof value.bundle_claim.claimType === "string") exportKeys.add(value.bundle_claim.claimType);
      expectations.set(value.id, { id: value.id, exportKeys });
    }
    result.set(gate.step, expectations);
  }
  return result;
}

function effectiveStepResolver(flows: Map<string, FlowMetadata>): (flowId: string, stepId: string, seen?: Set<string>) => EffectiveFlowStep | undefined {
  const resolve = (flowId: string, stepId: string, seen = new Set<string>()): EffectiveFlowStep | undefined => {
    const cycleKey = `${flowId}\0${stepId}`;
    if (seen.has(cycleKey)) return undefined;
    seen.add(cycleKey);
    const flow = flows.get(flowId);
    if (!flow) return undefined;
    const direct = flow.expectationsByStep.get(stepId);
    if (direct) return { sourceFlowId: flowId, stepId, expectations: direct, flowIds: new Set([flowId]) };
    const childFlowId = flow.usesFlowByStep.get(stepId);
    if (!childFlowId) return { sourceFlowId: flowId, stepId, expectations: new Map(), flowIds: new Set([flowId]) };
    const child = resolve(childFlowId, stepId, seen);
    const childFlow = flows.get(childFlowId);
    if (!child || !childFlow || [...child.expectations.values()].some((expectation) => ![...expectation.exportKeys].some((key) => childFlow.exports.has(key)))) return undefined;
    child.flowIds.add(flowId);
    return child;
  };
  return resolve;
}

function validateRoleReferences(roles: SkillRoleEntry[], flows: Map<string, FlowMetadata>, resolve: ReturnType<typeof effectiveStepResolver>, manifestPath: string, errors: string[]): void {
  for (const row of roles) {
    if (!row.flow_id) continue;
    const flow = flows.get(row.flow_id);
    if (!flow) { errors.push(`${manifestPath}: skill_roles '${row.skill_id}' references unknown flow '${row.flow_id}'`); continue; }
    for (const stepId of row.step_ids) if (!flow.steps.has(stepId)) errors.push(`${manifestPath}: skill_roles '${row.skill_id}' references unknown step '${row.flow_id}/${stepId}'`);
    const allowed = new Set(row.step_ids.flatMap((stepId) => [...(resolve(row.flow_id!, stepId)?.expectations.keys() ?? [])]));
    for (const expectationId of row.expectation_ids) if (!allowed.has(expectationId)) errors.push(`${manifestPath}: skill_roles '${row.skill_id}' expectation '${expectationId}' is not owned by its bound step(s)`);
  }
}

function seedSkillOwners(roles: SkillRoleEntry[], resolve: ReturnType<typeof effectiveStepResolver>): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const row of roles) {
    if (row.role !== "step" || !row.flow_id) continue;
    for (const stepId of row.step_ids) {
      const effective = resolve(row.flow_id, stepId);
      if (!effective) continue;
      for (const expectationId of row.expectation_ids) if (effective.expectations.has(expectationId)) {
        const key = `${effective.sourceFlowId}\0${effective.stepId}\0${expectationId}`;
        owners.set(key, [...(owners.get(key) ?? []), `skill:${row.skill_id}`]);
      }
    }
  }
  return owners;
}

function validateActions(actions: KitFlowStepActionEntry[], roles: SkillRoleEntry[], flows: Map<string, FlowMetadata>, resolve: ReturnType<typeof effectiveStepResolver>, owners: Map<string, string[]>, manifest: Record<string, unknown>, manifestPath: string, errors: string[]): void {
  const roleByShortId = new Map(roles.map((entry) => [entry.skill_id.replace(`${String(manifest.id)}.`, ""), entry]));
  for (const action of actions) {
    const flow = flows.get(action.flow_id);
    if (!flow || !flow.steps.has(action.step_id)) { errors.push(`${manifestPath}: flow_step_actions '${action.flow_id}/${action.step_id}' references an unknown flow step`); continue; }
    const effective = resolve(action.flow_id, action.step_id);
    if (!effective) { errors.push(`${manifestPath}: flow_step_actions '${action.flow_id}/${action.step_id}' cannot resolve its composed Flow step`); continue; }
    for (const id of action.expectation_ids) if (!effective.expectations.has(id)) errors.push(`${manifestPath}: flow_step_actions '${action.flow_id}/${action.step_id}' operation expectation '${id}' is not owned by its resolved Flow step`);
    if (!sameStringSet(action.expectation_ids, [...effective.expectations.keys()])) errors.push(`${manifestPath}: flow_step_actions '${action.flow_id}/${action.step_id}' expectation_ids must exactly equal its resolved Flow expectation set`);
    for (const skill of action.skills) {
      const row = roleByShortId.get(skill);
      if (!row || row.role !== "step" || !row.flow_id || !effective.flowIds.has(row.flow_id) || !row.step_ids.includes(action.step_id)) errors.push(`${manifestPath}: flow_step_actions '${action.flow_id}/${action.step_id}' skill '${skill}' must match one step-role binding`);
    }
    for (const expectationId of effective.expectations.keys()) {
      const binding = action.expectation_bindings.find((entry) => entry.expectation_id === expectationId);
      if (binding?.interface !== "operation") continue;
      const key = `${effective.sourceFlowId}\0${effective.stepId}\0${expectationId}`;
      owners.set(key, [...(owners.get(key) ?? []), `operation:${action.flow_id}/${action.step_id}`]);
    }
  }
}

function validateOwnerCardinality(flows: Map<string, FlowMetadata>, owners: Map<string, string[]>, manifestPath: string, errors: string[]): void {
  for (const [flowId, flow] of flows) for (const [stepId, expectations] of flow.expectationsByStep) for (const expectationId of expectations.keys()) {
    const found = owners.get(`${flowId}\0${stepId}\0${expectationId}`) ?? [];
    if (found.length !== 1) errors.push(`${manifestPath}: flow expectation '${flowId}/${stepId}/${expectationId}' must have exactly one producer owner; found ${found.length}`);
  }
}

function readSafeFlowDefinition(kitDir: string, relativePath: string): { definition?: Record<string, unknown>; error?: string } {
  const root = path.resolve(kitDir);
  if (path.isAbsolute(relativePath)) return { error: "path must be relative" };
  const lexical = path.resolve(root, relativePath);
  if (lexical === root || !lexical.startsWith(`${root}${path.sep}`)) return { error: "path must stay inside the kit directory" };
  let fd: number | undefined;
  try {
    const realRoot = fs.realpathSync(root);
    const initial = lstatSafePath(realRoot, relativePath);
    if (!initial.file || !initial.stat) return { error: initial.error };
    if (!initial.stat.isFile()) return { error: "path must reference a regular file" };
    if (initial.stat.size > MAX_FLOW_DEFINITION_BYTES) return { error: `file exceeds ${MAX_FLOW_DEFINITION_BYTES} bytes` };
    if (typeof fs.constants.O_NOFOLLOW !== "number") return { error: "O_NOFOLLOW is unavailable" };
    fd = fs.openSync(initial.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || !sameIdentity(initial.stat, opened)) return { error: "flow definition identity changed while opening" };
    const verified = lstatSafePath(realRoot, relativePath);
    if (!verified.stat || !sameIdentity(opened, verified.stat)) return { error: "flow definition identity changed while opening" };
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) { const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (read === 0) break; offset += read; }
    const after = fs.fstatSync(fd);
    if (offset !== opened.size || after.size !== opened.size || !sameIdentity(opened, after)) return { error: "file changed while being read" };
    return { definition: JSON.parse(bytes.toString("utf8")) as Record<string, unknown> };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") return { error: "path must not reference a symbolic link" };
    return { error: `path is not readable: ${(error as Error).message}` };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function lstatSafePath(root: string, relativePath: string): { file?: string; stat?: fs.Stats; error?: string } {
  const parts = relativePath.split(path.sep);
  let current = root;
  for (const [index, part] of parts.entries()) {
    if (!part || part === "." || part === "..") return { error: "path must stay inside the kit directory" };
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) return { error: "path must not traverse a symbolic link" };
    if (index < parts.length - 1 && !stat.isDirectory()) return { error: "path component must be a directory" };
    if (index === parts.length - 1) return { file: current, stat };
  }
  return { error: "path must reference a regular file" };
}

function sameIdentity(left: fs.Stats, right: fs.Stats): boolean { return left.dev === right.dev && left.ino === right.ino; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
