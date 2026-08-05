import fs from "node:fs";
import * as path from "node:path";
import { sameStringSet, type KitFlowStepActionEntry } from "./action-metadata.js";

type SkillRoleEntry = { skill_id: string; role: string; flow_id?: string; step_ids: string[]; expectation_ids: string[]; artifacts: string[] };
type FlowExpectation = { id: string; exportKeys: Set<string>; sourceFlowId: string };
type RouteBackMetadata = { onRouteBack: Map<string, string>; routeBackPolicy?: { maxAttempts: number; onExceeded: string } };
type FlowMetadata = { steps: Set<string>; expectationsByStep: Map<string, Map<string, FlowExpectation>>; gateCountByStep: Map<string, number>; routeBackByStep: Map<string, RouteBackMetadata[] | undefined>; gateIds: Set<string>; usesFlowIdsByStep: Map<string, string[]>; listCompositionSteps: Set<string>; invalidCompositionSteps: Set<string>; exports: Set<string> };
type EffectiveFlowStep = { sourceFlowId: string; stepId: string; expectations: Map<string, FlowExpectation>; flowIds: Set<string>; gateCount: number; routeBack?: RouteBackMetadata };
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
  validateCompositionCompatibility(flows, resolve, input.manifestPath, errors);
  validateRoleReferences(input.skillRoles, flows, resolve, input.manifestPath, errors);
  validateSkillArtifactOwnership(input.actions, input.skillRoles, resolve, input.manifest, input.manifestPath, errors);
  const owners = seedSkillOwners(input.skillRoles, resolve);
  validateActions(input.actions, input.skillRoles, flows, resolve, owners, input.manifest, input.manifestPath, errors);
  validateOwnerCardinality(flows, owners, input.manifestPath, errors);
  return errors;
}

function validateSkillArtifactOwnership(actions: KitFlowStepActionEntry[], roles: SkillRoleEntry[], resolve: ReturnType<typeof effectiveStepResolver>, manifest: Record<string, unknown>, manifestPath: string, errors: string[]): void {
  const prefix = `${String(manifest.id)}.`;
  for (const row of roles) {
    if (row.role !== "step" || !row.flow_id) continue;
    const shortId = row.skill_id.replace(prefix, "");
    const declared = actions.flatMap((action) => resolve(action.flow_id, action.step_id)?.flowIds.has(row.flow_id!)
      && row.step_ids.includes(action.step_id)
      && action.skills.includes(shortId)
      ? action.artifacts
      : []);
    const declaredSet = new Set(declared);
    if (row.artifacts.some((artifact) => !declaredSet.has(artifact))) {
      errors.push(`${manifestPath}: skill_roles '${row.skill_id}' artifacts must be a subset of its gate-action artifacts`);
    }
    if (row.artifacts.includes("state.json")) {
      errors.push(`${manifestPath}: skill_roles '${row.skill_id}' cannot own workflow control artifact 'state.json'`);
    }
  }
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
    const usesFlowIdsByStep = new Map<string, string[]>();
    const listCompositionSteps = new Set<string>();
    const invalidCompositionSteps = new Set<string>();
    for (const step of steps) {
      if (typeof step.id !== "string") continue;
      const scalar = step.uses_flow;
      const list = step.uses_flows;
      if (scalar !== undefined && list !== undefined) {
        invalidCompositionSteps.add(step.id);
      } else if (scalar !== undefined) {
        if (typeof scalar !== "string" || !scalar) invalidCompositionSteps.add(step.id);
        else usesFlowIdsByStep.set(step.id, [scalar]);
      } else if (list !== undefined) {
        if (!Array.isArray(list) || list.length === 0 || list.some((value) => typeof value !== "string" || !value) || new Set(list).size !== list.length) invalidCompositionSteps.add(step.id);
        else {
          usesFlowIdsByStep.set(step.id, list);
          listCompositionSteps.add(step.id);
        }
      }
    }
    flows.set(flow.id, { steps: stepIds, usesFlowIdsByStep, listCompositionSteps, invalidCompositionSteps, expectationsByStep: expectationsByStep(definition, flow.id), gateCountByStep: gateCountsByStep(definition), routeBackByStep: routeBackByStep(definition), gateIds: new Set(isRecord(definition.gates) ? Object.keys(definition.gates) : []), exports: new Set(Array.isArray(definition.exports) ? definition.exports.filter((value): value is string => typeof value === "string" && value.length > 0) : []) });
  }
  return flows;
}

function expectationsByStep(definition: Record<string, unknown>, sourceFlowId: string): Map<string, Map<string, FlowExpectation>> {
  const result = new Map<string, Map<string, FlowExpectation>>();
  if (!isRecord(definition.gates)) return result;
  for (const gate of Object.values(definition.gates)) {
    if (!isRecord(gate) || typeof gate.step !== "string" || !Array.isArray(gate.expects)) continue;
    const expectations = result.get(gate.step) ?? new Map<string, FlowExpectation>();
    for (const value of gate.expects) {
      if (!isRecord(value) || typeof value.id !== "string") continue;
      const exportKeys = new Set([value.id]);
      if (isRecord(value.bundle_claim) && typeof value.bundle_claim.claimType === "string") exportKeys.add(value.bundle_claim.claimType);
      expectations.set(value.id, { id: value.id, exportKeys, sourceFlowId });
    }
    result.set(gate.step, expectations);
  }
  return result;
}

function gateCountsByStep(definition: Record<string, unknown>): Map<string, number> {
  const result = new Map<string, number>();
  if (!isRecord(definition.gates)) return result;
  for (const gate of Object.values(definition.gates)) {
    if (!isRecord(gate) || typeof gate.step !== "string") continue;
    result.set(gate.step, (result.get(gate.step) ?? 0) + 1);
  }
  return result;
}

function routeBackByStep(definition: Record<string, unknown>): Map<string, RouteBackMetadata[] | undefined> {
  const result = new Map<string, RouteBackMetadata[] | undefined>();
  if (!isRecord(definition.gates)) return result;
  for (const gate of Object.values(definition.gates)) {
    if (!isRecord(gate) || typeof gate.step !== "string") continue;
    const entries = result.get(gate.step);
    if (entries === undefined && result.has(gate.step)) continue;
    const metadata = readRouteBackMetadata(gate);
    if (!metadata) result.set(gate.step, undefined);
    else result.set(gate.step, [...(entries ?? []), metadata]);
  }
  return result;
}

function readRouteBackMetadata(gate: Record<string, unknown>): RouteBackMetadata | undefined {
  const rawRoutes = gate.on_route_back;
  const rawPolicy = gate.route_back_policy;
  if (rawRoutes === undefined && rawPolicy === undefined) return { onRouteBack: new Map() };
  if (!isRecord(rawRoutes)) return undefined;
  const onRouteBack = new Map<string, string>();
  for (const [reason, target] of Object.entries(rawRoutes)) {
    if (!reason || typeof target !== "string" || !target) return undefined;
    onRouteBack.set(reason, target);
  }
  if (rawPolicy === undefined) return { onRouteBack };
  const maxAttempts = isRecord(rawPolicy) ? rawPolicy.max_attempts : undefined;
  const onExceeded = isRecord(rawPolicy) ? rawPolicy.on_exceeded : undefined;
  if (typeof maxAttempts !== "number" || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || typeof onExceeded !== "string" || !onExceeded) return undefined;
  return { onRouteBack, routeBackPolicy: { maxAttempts, onExceeded } };
}

function mergeRouteBackMetadata(entries: RouteBackMetadata[]): RouteBackMetadata | undefined {
  const onRouteBack = new Map<string, string>();
  let routeBackPolicy: RouteBackMetadata["routeBackPolicy"];
  let policyPresence: boolean | undefined;
  for (const entry of entries) {
    const hasPolicy = entry.routeBackPolicy !== undefined;
    if (policyPresence === undefined) policyPresence = hasPolicy;
    else if (policyPresence !== hasPolicy) return undefined;
    if (hasPolicy) {
      if (routeBackPolicy && (routeBackPolicy.maxAttempts !== entry.routeBackPolicy!.maxAttempts || routeBackPolicy.onExceeded !== entry.routeBackPolicy!.onExceeded)) return undefined;
      routeBackPolicy = entry.routeBackPolicy;
    }
    for (const [reason, target] of entry.onRouteBack) {
      if (onRouteBack.has(reason) && onRouteBack.get(reason) !== target) return undefined;
      onRouteBack.set(reason, target);
    }
  }
  if (routeBackPolicy && onRouteBack.size === 0) return undefined;
  return { onRouteBack, ...(routeBackPolicy ? { routeBackPolicy } : {}) };
}

function effectiveStepResolver(flows: Map<string, FlowMetadata>): (flowId: string, stepId: string, seen?: Set<string>) => EffectiveFlowStep | undefined {
  const resolve = (flowId: string, stepId: string, seen = new Set<string>()): EffectiveFlowStep | undefined => {
    const cycleKey = `${flowId}\0${stepId}`;
    if (seen.has(cycleKey)) return undefined;
    seen.add(cycleKey);
    const flow = flows.get(flowId);
    if (!flow) return undefined;
    const direct = flow.expectationsByStep.get(stepId);
    if (direct) return flow.invalidCompositionSteps.has(stepId) || flow.usesFlowIdsByStep.has(stepId) ? undefined : { sourceFlowId: flowId, stepId, expectations: direct, flowIds: new Set([flowId]), gateCount: flow.gateCountByStep.get(stepId) ?? 0, routeBack: flow.routeBackByStep.get(stepId)?.[0] };
    if (flow.invalidCompositionSteps.has(stepId)) return undefined;
    const childFlowIds = flow.usesFlowIdsByStep.get(stepId);
    if (!childFlowIds) return { sourceFlowId: flowId, stepId, expectations: new Map(), flowIds: new Set([flowId]), gateCount: 0 };
    const expectations = new Map<string, FlowExpectation>();
    const flowIds = new Set<string>([flowId]);
    const isListComposition = flow.listCompositionSteps.has(stepId);
    if (isListComposition && flow.gateIds.has(`flow-agents.aggregate.${stepId}`)) return undefined;
    let gateCount = isListComposition ? 1 : 0;
    const routeBackEntries: RouteBackMetadata[] = [];
    for (const childFlowId of childFlowIds) {
      const child = resolve(childFlowId, stepId, new Set(seen));
      const childFlow = flows.get(childFlowId);
      // `uses_flows` emits one aggregate runtime gate; a contributor with more
      // than one gate at the same step would diverge from live resolution.
      if (!child || !childFlow
        || (isListComposition && child.gateCount !== 1)
        || [...child.expectations.values()].some((expectation) => ![...expectation.exportKeys].some((key) => childFlow.exports.has(key)))
        || [...child.expectations.keys()].some((id) => expectations.has(id))
        || (isListComposition && !child.routeBack)) return undefined;
      if (!isListComposition) gateCount = child.gateCount;
      for (const [id, expectation] of child.expectations) expectations.set(id, expectation);
      for (const id of child.flowIds) flowIds.add(id);
      if (isListComposition) routeBackEntries.push(child.routeBack!);
    }
    const routeBack = isListComposition ? mergeRouteBackMetadata(routeBackEntries) : undefined;
    if (isListComposition && !routeBack) return undefined;
    return { sourceFlowId: childFlowIds[0]!, stepId, expectations, flowIds, gateCount, routeBack };
  };
  return resolve;
}

function validateCompositionCompatibility(flows: Map<string, FlowMetadata>, resolve: ReturnType<typeof effectiveStepResolver>, manifestPath: string, errors: string[]): void {
  for (const [flowId, flow] of flows) for (const stepId of new Set([...flow.usesFlowIdsByStep.keys(), ...flow.invalidCompositionSteps])) {
    if (!resolve(flowId, stepId)) errors.push(`${manifestPath}: flow '${flowId}/${stepId}' has incompatible composed route-back or gate metadata`);
  }
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
        const key = `${effective.expectations.get(expectationId)?.sourceFlowId ?? effective.sourceFlowId}\0${effective.stepId}\0${expectationId}`;
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
      const key = `${effective.expectations.get(expectationId)?.sourceFlowId ?? effective.sourceFlowId}\0${effective.stepId}\0${expectationId}`;
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
