/**
 * Flow-Definition resolver — ADR 0016 Abstraction A (Option B), Phase P-a.
 *
 * Shared resolver consumed by both the producer (workflow-sidecar.ts) and,
 * later, the enforcer (stop-goal-fit.js via P-c). This is the SINGLE source
 * of truth for (active_flow_id, active_step_id) → FlowDefinition gate
 * expects[] resolution. Neither consumer duplicates this logic.
 *
 * Design:
 *   - Pure and synchronous — no async, no throws.
 *   - Returns null on ENOENT, parse error, or missing gate (fail-open).
 *   - Kit-agnostic: kitId = flowId.split(".")[0]; no hardcoded kit list.
 *   - Honors FLOW_AGENTS_FLOW_DEFS_DIR env-var override for custom installs.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isWithinRuntimeArtifactRoot } from "./declared-artifact-roots.js";
// #1280 review FIX-1 / FIX-2 (the rules) live in kit-flow-binding.ts (#1316, the location), so
// the RESOLVER — which reads a flow's bytes — and the RUN BINDING — which decides which kit's
// manifest supplies the run's provenance — share ONE answer to "is this tree a kit source" and
// ONE answer to "which ids may this manifest declare". Each branch had grown its own copy; the
// resolver admitting bytes the run binding rejects (or vice versa) is exactly the disagreement
// those rules exist to prevent, and it is the mechanism behind the start-validates-consumer /
// run-binds-package split this merge closes.
import { canonicalKitsRoot, kitManifestFlowDeclarations } from "./kit-flow-binding.js";

// ─── Security: Layer 1 traversal defense ─────────────────────────────────────
//
// Both kitId and flowName originate from agent-writable sources (active_flow_id
// in current.json, and FLOW_AGENTS_FLOW_DEFS_DIR set by the runtime). A crafted
// value like "builder.../../../.kontourai/flow-agents/slug/fake-flow" produces:
//   kitId = "builder"
//   flowName = "../../../.kontourai/flow-agents/slug/fake-flow"
// which resolves OUTSIDE kits/ via path.join traversal.
//
// SLUG_RE closes this: it rejects any value containing path separators, dots,
// or characters outside the safe identifier alphabet. Only [a-zA-Z0-9_-] is
// allowed, making traversal sequences impossible.
//
// Belt-and-suspenders: after building the path we also confirm the resolved
// absolute path stays inside the expected root directory.

/** Strict slug pattern — allows only URL-safe identifier chars. */
const SLUG_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * True when a resolved directory lies inside Flow Agents RUNTIME ARTIFACT STORAGE — the
 * `.kontourai/flow-agents` / `.flow-agents` / `delivery` sub-roots the runtime writes session
 * artifacts into. Delegates to the ONE definition of those roots
 * (`declared-artifact-roots.ts`, the same list the config-protection hook and the sidecar's
 * fixture writer scope themselves to), so a FlowDefinition source can never be judged in-bounds
 * here while the hook treats the same path as protected runtime storage.
 *
 * #1280 review FIX-1: this replaced a local `isAgentWritableDir` that scanned path SEGMENTS for
 * the literals `.flow-agents` / `.kontourai/flow-agents`. Two defects that fixed: it missed
 * `delivery` entirely, and — because it was a flat segment scan on the spelled path with
 * realpath only as a fallback for the WHOLE string — it had no notion of a root's POSITION.
 * The name was also a claim nothing computed: it said "agent-writable" while deriving
 * "matches a name". Writability is not derivable here at all (runtime and agent share a uid),
 * so the honest boundary is containment in runtime storage, and the name now says that.
 * See the contract note on `isWithinRuntimeArtifactRoot` for what is deliberately NOT covered.
 */
function isRuntimeArtifactDir(resolvedDir: string): boolean {
  return isWithinRuntimeArtifactRoot(resolvedDir);
}

function installedPackageRoot(): string | null {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (fs.existsSync(path.join(directory, "package.json")) && fs.existsSync(path.join(directory, "kits"))) {
      return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function packagedFlowFile(kitId: string, flowName: string, consumerRoot: string): string | null {
  const packageRoot = installedPackageRoot();
  if (!packageRoot || path.resolve(packageRoot) === path.resolve(consumerRoot)) return null;
  const kitsRoot = canonicalKitsRoot(packageRoot);
  if (!kitsRoot) return null;
  const candidate = path.resolve(kitsRoot, kitId, "flows", `${flowName}.flow.json`);
  if (!candidate.startsWith(kitsRoot + path.sep)) return null;
  try {
    const realCandidate = fs.realpathSync.native(candidate);
    return realCandidate.startsWith(kitsRoot + path.sep) ? realCandidate : null;
  } catch {
    return null;
  }
}

/**
 * Build and validate the FlowDefinition file path.
 *
 * Returns the validated absolute file path, or null when:
 *  - kitId or flowName contains chars outside SLUG_RE (rejects traversal)
 *  - FLOW_AGENTS_FLOW_DEFS_DIR resolves into a runtime artifact directory
 *  - The resolved path escapes the expected root (belt-and-suspenders)
 *
 * An unsafe explicit override fails closed. Package fallback applies only to
 * canonical lookup when no override was supplied.
 */
export function resolveFlowFilePath(
  kitId: string,
  flowName: string,
  flowId: string,
  repoRoot: string,
  allowOverride = true,
): string | null {
  // Primary defense: reject any slug containing traversal chars or non-identifier chars.
  if (!SLUG_RE.test(kitId) || !SLUG_RE.test(flowName)) return null;

  const override = allowOverride ? process.env["FLOW_AGENTS_FLOW_DEFS_DIR"] : undefined;

  let expectedRoot: string;
  let flowFilePath: string;
  let canonicalLookup = false;

  if (override) {
    const resolvedOverride = path.resolve(override);
    if (isRuntimeArtifactDir(resolvedOverride)) {
      return null;
    } else {
      expectedRoot = resolvedOverride;
      // flowId = kitId + "." + flowName; after slug validation this contains only
      // [a-zA-Z0-9_-.] — no slashes, no traversal.
      flowFilePath = path.join(resolvedOverride, `${flowId}.flow.json`);
    }
  } else {
    // #1280 review FIX-1: the expected root is the REALPATH of `<repoRoot>/kits`, refused
    // outright when that realpath escapes the repo root or lands in runtime artifact storage.
    // Deriving the boundary from the same link that is being followed is not a boundary.
    const kitsRoot = canonicalKitsRoot(repoRoot);
    if (!kitsRoot) return null;
    expectedRoot = kitsRoot;
    flowFilePath = path.join(kitsRoot, kitId, "flows", `${flowName}.flow.json`);
    canonicalLookup = true;
  }

  // Belt-and-suspenders: confirm the resolved path stays within the expected root.
  // After slug validation this is theoretically unreachable, but defense-in-depth
  // verifies the invariant rather than merely asserting it.
  const resolvedPath = path.resolve(flowFilePath);
  if (!resolvedPath.startsWith(expectedRoot + path.sep) && resolvedPath !== expectedRoot) {
    return null; // traversal still detected — paranoid fallback
  }

  // If the file exists, resolve final symlinks before returning a readable path.
  // `readFileSync` follows symlinks; this keeps lexical containment from turning
  // into an out-of-root file read through a symlinked FlowDefinition. For the canonical
  // lookup `expectedRoot` is ALREADY a realpath (canonicalKitsRoot), so this comparison is
  // against a boundary the tree owner controls, not one a symlink under test chose.
  try {
    const realExpectedRoot = canonicalLookup
      ? expectedRoot
      : (fs.existsSync(expectedRoot) ? fs.realpathSync.native(expectedRoot) : expectedRoot);
    const realPath = fs.realpathSync.native(resolvedPath);
    if (!realPath.startsWith(realExpectedRoot + path.sep) && realPath !== realExpectedRoot) {
      return null;
    }
    return realPath;
  } catch {
    if (canonicalLookup) {
      const packaged = packagedFlowFile(kitId, flowName, repoRoot);
      if (packaged) return packaged;
    }
    return resolvedPath;
  }
}

// ─── Public types ─────────────────────────────────────────────────────────────

/** A single gate expectation from a FlowDefinition expects[] entry. */
export type GateExpectation = {
  id: string;
  kind: string;
  required: boolean;
  bundle_claim: {
    claimType: string;
    subjectType: string;
    accepted_statuses: string[];
  };
};

/** The resolved result from the active flow step. */
export type ActiveFlowStep = {
  flowId: string;
  stepId: string;
  gateId: string;
  gateExpects: GateExpectation[];
  routeBackReasons: string[];
  /** When resolved through a parent step's uses_flow edge, names the child FlowDefinition that owns the gate. */
  sourceFlowId?: string;
  /** Ordered child FlowDefinitions that contribute a composed multi-child gate. */
  sourceFlowIds?: string[];
};

/** Shape of a gate entry in the FlowDefinition JSON. */
type FlowGate = {
  step: string;
  expects?: GateExpectation[];
  /** Reason-to-step mapping for route-back transitions (e.g. {"implementation_defect": "execute"}). */
  on_route_back?: Record<string, string>;
  /** Policy governing route-back attempt limits. */
  route_back_policy?: { max_attempts: number; on_exceeded: string };
  /**
   * #1302: a cursor-advancing gate that declares this refuses to accept a passing claim while
   * canonical review/verification evidence is stale for the current workspace — enforced at the
   * evidence writer by the SAME predicate the publish preflight runs (one predicate, quoted
   * everywhere; a paraphrase here would recreate the #1299/#1300 divergence class).
   */
  requires_current_verification?: boolean;
};

type FlowStep = { id: string; next: string | null; uses_flow?: string; uses_flows?: string[] };

type RouteBackMetadata = {
  onRouteBack?: Record<string, string>;
  routeBackPolicy?: { max_attempts: number; on_exceeded: string };
};

/** Shape of a FlowDefinition JSON file. */
type FlowDefinition = {
  id: string;
  version: string;
  /** Kit-owned phase→step mapping (ADR 0016 Abstraction A P-d). Maps lifecycle phase names
   *  (e.g. "execution") to step ids (e.g. "execute") so advance-state can write active_step_id
   *  without hardcoding any vocabulary in the core. */
  phase_map?: Record<string, string>;
  steps?: FlowStep[];
  gates?: Record<string, FlowGate>;
  /** Optional claim types or expectation ids this flow intentionally exposes to parent/composed flows. */
  exports?: string[];
  /** Resolver-emitted provenance for gates imported through uses_flows. */
  flow_agents_contributions?: Array<{ flow_id: string; gate_id: string; step_id: string; expectation_ids: string[] }>;
};

type InternalActiveFlowStep = ActiveFlowStep & { flowExports?: string[]; routeBack?: RouteBackMetadata };

function flowIdParts(flowId: string): { kitId: string; flowName: string } | null {
  if (!flowId) return null;
  const dotIdx = flowId.indexOf(".");
  if (dotIdx < 1) return null;
  const kitId = flowId.slice(0, dotIdx);
  const flowName = flowId.slice(dotIdx + 1);
  if (!kitId || !flowName) return null;
  return { kitId, flowName };
}

/**
 * Enumerate the flow ids the installed kits DECLARE — the derivation the public
 * `workflow start` verb consults instead of enumerating flow identifiers in core (#1280).
 *
 * Sources mirror resolveFlowFilePath's resolution order exactly, so the derived list never
 * names a flow the resolver would look up somewhere else:
 *   - FLOW_AGENTS_FLOW_DEFS_DIR override (when set and outside runtime artifact storage):
 *     every `<flowId>.flow.json` file in that directory. The override replaces canonical kit
 *     lookup wholesale, so it replaces discovery too. An override inside runtime artifact
 *     storage yields an empty list — the same fail-closed posture resolveFlowFilePath takes.
 *   - Canonical: each kit directory under `<repoRoot>/kits/*` (that root resolved, and refused
 *     when it escapes the repo root or lands in runtime storage), plus the executing package's
 *     own `kits/*` (the same package fallback canonical resolution applies). A kit's
 *     declaration surface is its `kit.json` `flows[].id` list when the manifest declares
 *     one — the packaged, digest-covered artifact — else its `flows/*.flow.json` directory.
 *
 * Ids without the `<kit>.<flow>` slug shape the resolver requires are excluded: a refusal
 * that recommends an id the resolver can never resolve would be worse than none. This
 * enumerates EXISTENCE only; conformance stays with resolveEffectiveFlowDefinition.
 */
export function declaredKitFlowIds(repoRoot: string): string[] {
  const ids = new Set<string>();
  const override = process.env["FLOW_AGENTS_FLOW_DEFS_DIR"];
  if (override) {
    const resolvedOverride = path.resolve(override);
    if (isRuntimeArtifactDir(resolvedOverride)) return [];
    for (const entry of listDirents(resolvedOverride)) {
      if (!entry.isFile() || !entry.name.endsWith(".flow.json")) continue;
      const id = entry.name.slice(0, -".flow.json".length);
      if (slugFlowIdParts(id)) ids.add(id);
    }
    return [...ids].sort();
  }
  const kitsRoots: string[] = [];
  const consumerKitsRoot = canonicalKitsRoot(repoRoot);
  if (consumerKitsRoot) kitsRoots.push(consumerKitsRoot);
  const packageRoot = installedPackageRoot();
  if (packageRoot && path.resolve(packageRoot) !== path.resolve(repoRoot)) {
    const packagedKitsRoot = canonicalKitsRoot(packageRoot);
    if (packagedKitsRoot && !kitsRoots.includes(packagedKitsRoot)) kitsRoots.push(packagedKitsRoot);
  }
  for (const kitsRoot of kitsRoots) {
    for (const kitEntry of listDirents(kitsRoot)) {
      if (!kitEntry.isDirectory() || !SLUG_RE.test(kitEntry.name)) continue;
      const declared = kitManifestFlowDeclarations(kitsRoot, kitEntry.name);
      if (declared) {
        for (const declaration of declared) ids.add(declaration.flowId);
        continue;
      }
      for (const flowEntry of listDirents(path.join(kitsRoot, kitEntry.name, "flows"))) {
        if (!flowEntry.isFile() || !flowEntry.name.endsWith(".flow.json")) continue;
        const id = `${kitEntry.name}.${flowEntry.name.slice(0, -".flow.json".length)}`;
        if (slugFlowIdParts(id)) ids.add(id);
      }
    }
  }
  return [...ids].sort();
}

function listDirents(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** flowIdParts, plus the SLUG_RE contract `resolveFlowFilePath` actually enforces on both parts.
 *  A declaration whose id the resolver could never resolve is not a declaration. */
function slugFlowIdParts(flowId: string): { kitId: string; flowName: string } | null {
  const parts = flowIdParts(flowId);
  if (!parts) return null;
  return SLUG_RE.test(parts.kitId) && SLUG_RE.test(parts.flowName) ? parts : null;
}


/**
 * The identifier contract THIS RESOLVER enforces at read time, applied as a start-time
 * conformance check (#1280 review FIX-5).
 *
 * `validateDefinition` from `@kontourai/flow` is the base contract and is deliberately looser:
 * it accepts any non-empty string as a step id. The resolver is stricter — `resolveFlowStep`
 * returns null for any `stepId` outside SLUG_RE (see resolveFlowStepInternal), and
 * `resolveFlowFilePath` returns null for a flow id whose parts fall outside it. A definition
 * that passes only the base contract can therefore be published as an active step and then
 * resolve to NOTHING, at which point the Stop hook silently falls back to generic `workflow.*`
 * enforcement — a governance downgrade produced by a definition the start accepted. Callers
 * that admit a definition into a session must apply this too, so what start validates and what
 * runtime can resolve are the same set.
 *
 * Returns a list of human-readable issues; empty means the definition satisfies the resolver's
 * own identifier contract.
 *
 * DELIBERATELY NOT CHECKED HERE (disclosed rather than implied — a third-party definition still
 * influences these, and no further check stands between the declaration and the behavior):
 *   - `phase_map`: a kit-owned phase→step mapping consumed by `advance-state` to write
 *     `active_step_id`; a kit chooses its own lifecycle projection.
 *   - `expects[].bundle_claim` (claimType / subjectType / accepted_statuses): selects which
 *     Stop-hook claim satisfies a gate; a kit chooses its own claim vocabulary.
 *   - `on_route_back` / `route_back_policy`: route-back targets and attempt limits consumed by
 *     `advance-state`; structurally validated by `routeBackMetadataForGate`, but the declared
 *     targets and limits themselves are the kit's.
 *   - `requires_current_verification`: enforced at the canonical Builder evaluation seam, so it
 *     has no effect for a flow with no canonical run.
 *   - producer-binding completeness: whether a step's expectations have a producer that can
 *     actually satisfy them is not knowable from the definition alone (see
 *     `expectedGateProducer`, which resolves producers from a kit manifest, not the definition).
 */
export function flowDefinitionResolverContractIssues(definition: unknown): string[] {
  const issues: string[] = [];
  if (!isRecord(definition)) return ["definition must be an object"];
  const id = definition["id"];
  if (typeof id !== "string" || !slugFlowIdParts(id)) {
    issues.push(`definition id ${JSON.stringify(String(id))} must be "<kit>.<flow>" with both parts matching ${SLUG_RE}`);
  }
  const steps = definition["steps"];
  const stepIds = new Set<string>();
  if (Array.isArray(steps)) {
    for (const step of steps) {
      const stepId = isRecord(step) ? step["id"] : undefined;
      if (typeof stepId !== "string") continue;
      stepIds.add(stepId);
      if (!SLUG_RE.test(stepId)) {
        issues.push(`step id ${JSON.stringify(stepId)} must match ${SLUG_RE}; the resolver cannot resolve a gate for it`);
      }
    }
  }
  const gates = definition["gates"];
  if (isRecord(gates)) {
    for (const [gateId, gate] of Object.entries(gates)) {
      const step = isRecord(gate) ? gate["step"] : undefined;
      if (typeof step !== "string") continue;
      if (!SLUG_RE.test(step)) {
        issues.push(`gate ${JSON.stringify(gateId)} names step ${JSON.stringify(step)}, which must match ${SLUG_RE}`);
      } else if (steps !== undefined && !stepIds.has(step)) {
        issues.push(`gate ${JSON.stringify(gateId)} names step ${JSON.stringify(step)}, which the definition does not declare`);
      }
    }
  }
  return issues;
}

function readFlowDefinition(flowId: string, repoRoot: string, allowOverride = true): FlowDefinition | null {
  const parts = flowIdParts(flowId);
  if (!parts) return null;
  const flowFilePath = resolveFlowFilePath(parts.kitId, parts.flowName, flowId, repoRoot, allowOverride);
  if (!flowFilePath) return null;

  try {
    const raw = fs.readFileSync(flowFilePath, "utf8");
    return JSON.parse(raw) as FlowDefinition;
  } catch {
    return null; // ENOENT, permission error, or parse error → fail-open
  }
}

function childFlowIdsForStep(step: FlowStep): string[] | null {
  const scalar = step.uses_flow;
  const list = step.uses_flows;
  if (scalar !== undefined && list !== undefined) return null;
  // A present scalar declaration must be a single non-empty id.  Treating an
  // array (or an empty value) as "no composition" would silently erase the
  // legacy fan-in attempt instead of failing closed.
  if (scalar !== undefined) return typeof scalar === "string" && scalar.trim() ? [scalar] : null;
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length === 0 || list.some((flowId) => typeof flowId !== "string" || !flowId.trim())) return null;
  if (new Set(list).size !== list.length) return null;
  return list;
}

const AGGREGATE_GATE_PREFIX = "flow-agents.aggregate.";

function aggregateGateId(stepId: string): string {
  return `${AGGREGATE_GATE_PREFIX}${stepId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Route-back metadata participates in the aggregate gate's observable runtime
 * behavior, so malformed or partial declarations are not safe to ignore.
 */
function routeBackMetadataForGate(gate: FlowGate): RouteBackMetadata | null {
  const rawRoutes = gate.on_route_back;
  const rawPolicy = gate.route_back_policy;
  if (rawRoutes === undefined && rawPolicy === undefined) return {};
  if (!isRecord(rawRoutes)) return null;
  const onRouteBack: Record<string, string> = {};
  for (const [reason, target] of Object.entries(rawRoutes)) {
    if (!reason || typeof target !== "string" || !target) return null;
    onRouteBack[reason] = target;
  }
  if (rawPolicy === undefined) return { onRouteBack };
  if (!isRecord(rawPolicy)
    || !Number.isSafeInteger(rawPolicy.max_attempts)
    || rawPolicy.max_attempts < 1
    || typeof rawPolicy.on_exceeded !== "string"
    || !rawPolicy.on_exceeded) return null;
  return {
    onRouteBack,
    routeBackPolicy: { max_attempts: rawPolicy.max_attempts, on_exceeded: rawPolicy.on_exceeded },
  };
}

/** Return null when children would give the aggregate contradictory retry semantics. */
function mergeRouteBackMetadata(metadata: RouteBackMetadata[]): RouteBackMetadata | null {
  const onRouteBack: Record<string, string> = {};
  let routeBackPolicy: RouteBackMetadata["routeBackPolicy"] | undefined;
  let policyPresence: boolean | undefined;
  for (const entry of metadata) {
    const hasPolicy = entry.routeBackPolicy !== undefined;
    if (policyPresence === undefined) policyPresence = hasPolicy;
    else if (policyPresence !== hasPolicy) return null;
    if (hasPolicy) {
      if (routeBackPolicy
        && (routeBackPolicy.max_attempts !== entry.routeBackPolicy!.max_attempts
          || routeBackPolicy.on_exceeded !== entry.routeBackPolicy!.on_exceeded)) return null;
      routeBackPolicy = entry.routeBackPolicy;
    }
    for (const [reason, target] of Object.entries(entry.onRouteBack ?? {})) {
      if (onRouteBack[reason] !== undefined && onRouteBack[reason] !== target) return null;
      onRouteBack[reason] = target;
    }
  }
  if (routeBackPolicy && Object.keys(onRouteBack).length === 0) return null;
  return {
    ...(Object.keys(onRouteBack).length > 0 ? { onRouteBack } : {}),
    ...(routeBackPolicy ? { routeBackPolicy } : {}),
  };
}

function routeBackGateFields(metadata: RouteBackMetadata): Pick<FlowGate, "on_route_back" | "route_back_policy"> {
  return {
    ...(metadata.onRouteBack ? { on_route_back: metadata.onRouteBack } : {}),
    ...(metadata.routeBackPolicy ? { route_back_policy: metadata.routeBackPolicy } : {}),
  };
}

/**
 * Resolve the gate expects[] for a specific (flowId, stepId) pair.
 *
 * @param flowId   e.g. "builder.build" — kitId is extracted as the prefix before the first ".".
 * @param stepId   e.g. "verify" — matched against gate.step values in the FlowDefinition.
 * @param repoRoot Absolute path to the repository root (kits/ lives here).
 *                 Honored only when FLOW_AGENTS_FLOW_DEFS_DIR is not set.
 * @returns ActiveFlowStep with the matched gate's expects[], or null on any error.
 */
export function resolveFlowStep(flowId: string, stepId: string, repoRoot: string): ActiveFlowStep | null {
  const resolved = resolveFlowStepInternal(flowId, stepId, repoRoot, new Set<string>());
  if (!resolved) return null;
  const { flowExports: _flowExports, ...publicStep } = resolved;
  return publicStep;
}

/**
 * Compile Flow Agents' `uses_flow` kit extension into one effective definition
 * that the Flow runtime can evaluate without understanding agent-layer composition.
 */
export function resolveEffectiveFlowDefinition(flowId: string, repoRoot: string, options: { allowOverride?: boolean } = {}): Record<string, unknown> | null {
  return resolveEffectiveFlowDefinitionInternal(flowId, repoRoot, new Set<string>(), options.allowOverride !== false);
}

function resolveEffectiveFlowDefinitionInternal(flowId: string, repoRoot: string, seen: Set<string>, allowOverride: boolean): Record<string, unknown> | null {
  if (seen.has(flowId)) return null;
  const nextSeen = new Set(seen);
  nextSeen.add(flowId);
  const source = readFlowDefinition(flowId, repoRoot, allowOverride);
  if (!source || !Array.isArray(source.steps)) return null;
  const effective = JSON.parse(JSON.stringify(source)) as FlowDefinition;
  effective.gates = { ...(effective.gates ?? {}) };
  const contributions: NonNullable<FlowDefinition["flow_agents_contributions"]> = [];

  for (let index = 0; index < source.steps.length; index += 1) {
    const sourceStep: FlowStep = source.steps[index]!;
    const childFlowIds = childFlowIdsForStep(sourceStep);
    if (childFlowIds === null) return null;
    if (childFlowIds.length === 0) continue;
    if (Object.values(effective.gates).some((gate) => gate?.step === sourceStep.id)) return null;

    // Keep scalar composition byte-compatible: its one child gate remains
    // namespaced exactly as before rather than becoming an aggregate.
    if (typeof sourceStep.uses_flow === "string") {
      const child = resolveEffectiveFlowDefinitionInternal(childFlowIds[0]!, repoRoot, nextSeen, allowOverride) as FlowDefinition | null;
      if (!child || !child.gates) return null;
      const childGateEntry = Object.entries(child.gates).find(([, gate]) => gate?.step === sourceStep.id);
      if (!childGateEntry) return null;
      const [childGateId, childGate] = childGateEntry;
      const childExpects = Array.isArray(childGate.expects) ? childGate.expects : [];
      const exported = exportedExpectations(childExpects, child.exports);
      if (!exported) return null;
      effective.gates[`${sourceStep.uses_flow}:${childGateId}`] = {
        ...childGate,
        expects: exported,
      };
      const { uses_flow: _usesFlow, ...compiledStep } = effective.steps![index]!;
      effective.steps![index] = compiledStep;
      continue;
    }

    const imports: Array<{ flowId: string; gateId: string; expects: GateExpectation[]; routeBack: RouteBackMetadata; requiresCurrentVerification: boolean }> = [];
    const expectationIds = new Set<string>();
    for (const childFlowId of childFlowIds) {
      const child = resolveEffectiveFlowDefinitionInternal(childFlowId, repoRoot, nextSeen, allowOverride) as FlowDefinition | null;
      if (!child || !child.gates) return null;
      const childGateEntries: Array<[string, FlowGate]> = Object.entries(child.gates).filter(([, gate]) => gate?.step === sourceStep.id);
      // A list contributor must resolve to one gate, matching live resolution.
      if (childGateEntries.length !== 1) return null;
      const [childGateId, childGate] = childGateEntries[0]!;
      const childExpects = Array.isArray(childGate.expects) ? childGate.expects : [];
      const exported = exportedExpectations(childExpects, child.exports);
      const routeBack = routeBackMetadataForGate(childGate);
      if (!exported || !routeBack || exported.some((expectation) => expectationIds.has(expectation.id))) return null;
      for (const expectation of exported) expectationIds.add(expectation.id);
      imports.push({ flowId: childFlowId, gateId: childGateId, expects: exported, routeBack, requiresCurrentVerification: childGate.requires_current_verification === true });
    }
    const routeBack = mergeRouteBackMetadata(imports.map((entry) => entry.routeBack));
    const gateId = aggregateGateId(sourceStep.id);
    if (!routeBack || effective.gates[gateId]) return null;
    effective.gates[gateId] = {
      step: sourceStep.id,
      expects: imports.flatMap((entry) => entry.expects),
      ...routeBackGateFields(routeBack),
      // #1302: a freshness turnstile declared by ANY contributor governs the whole aggregate —
      // dropping it here would silently disarm the guard for list-composed flows.
      ...(imports.some((entry) => entry.requiresCurrentVerification) ? { requires_current_verification: true } : {}),
    };
    for (const imported of imports) contributions.push({ flow_id: imported.flowId, gate_id: imported.gateId, step_id: sourceStep.id, expectation_ids: imported.expects.map((expectation) => expectation.id) });
    const { uses_flows: _usesFlows, ...compiledStep } = effective.steps![index]!;
    effective.steps![index] = compiledStep;
  }
  if (contributions.length > 0) effective.flow_agents_contributions = contributions;
  else delete effective.flow_agents_contributions;
  const effectiveSteps = effective.steps!;
  const gatedSteps = new Set(Object.values(effective.gates).flatMap((gate) =>
    typeof gate?.step === "string" ? [gate.step] : []));
  const referencedSteps = new Set(effectiveSteps.flatMap((step) =>
    typeof step.next === "string" ? [step.next] : []));
  const terminalSentinels = new Set(effectiveSteps
    .filter((step) => step.next === null && !gatedSteps.has(step.id) && referencedSteps.has(step.id))
    .map((step) => step.id));
  if (terminalSentinels.size > 0) {
    effective.steps = effectiveSteps
      .filter((step) => !terminalSentinels.has(step.id))
      .map((step) => typeof step.next === "string" && terminalSentinels.has(step.next)
        ? { ...step, next: null }
        : step);
  }
  return effective as unknown as Record<string, unknown>;
}

/**
 * A single (stepId, gateId) → expects[] tuple, as part of the FULL enumeration of every gate in
 * a FlowDefinition (across every step — see resolveAllFlowGateExpects below), not just the
 * currently-active one.
 */
export type FlowGateExpectsEntry = {
  stepId: string;
  gateId: string;
  gateExpects: GateExpectation[];
};

/**
 * Enumerate the gate expects[] for EVERY step in a FlowDefinition (#270 CRITICAL/HIGH fix) —
 * not just the currently-active step. This is what lets a stamped gate-claim's
 * (expectation_id, claim_type, subject_type, step_id) tuple be validated against the FULL,
 * declared shape of the flow, instead of only against whatever step happens to be active at
 * validation time (which is a DIFFERENT, and usually wrong, question: the stamp names the step
 * it was ORIGINALLY recorded at, which by design may not be the currently-active one — see
 * buildTrustBundle's #270(a)/(c) step_id-freezing comments in workflow-sidecar.ts).
 *
 * Walks flowDef.steps[] (in declaration order) and resolves each step's gate via the same
 * resolveFlowStepInternal used by resolveFlowStep/resolveActiveFlowStep — including the
 * uses_flow composed-step case, so a gate that lives in a child FlowDefinition (e.g.
 * builder.publish-learn's pr-open-gate, composed into builder.build's "pr-open" step) is
 * enumerated too, exports-filtered exactly as a live resolution would be.
 *
 * Pure and synchronous — no throws, fail-open (returns []) on any error, mirroring every other
 * resolver in this module.
 *
 * Callers MUST distinguish the two null-ish outcomes (#270 MEDIUM fix, iteration 3):
 *   - `null`  → the FlowDefinition could not be LOADED at all (missing file, unreadable, invalid
 *     JSON, or no `steps[]` array) — the caller has no basis to validate anything against this
 *     flow and must fail closed with a dedicated "cannot be loaded" message, never the "stamp
 *     does not match any expects[]" (forged/corrupt) message; those are different failure
 *     classes with different remedies (a load failure means "fix/restore the FlowDefinition
 *     file or the flowId", not "this stamp was forged").
 *   - `[]`    → the FlowDefinition LOADED successfully but genuinely declares no steps with
 *     matching gates (or no gates at all) — a real, if unusual, flow shape, not an error.
 *
 * @param flowId   e.g. "builder.build" — kitId is extracted as the prefix before the first ".".
 * @param repoRoot Absolute path to the repository root (kits/ lives here).
 *                 Honored only when FLOW_AGENTS_FLOW_DEFS_DIR is not set.
 * @returns Every (stepId, gateId, gateExpects) tuple in the flow; `[]` when the flow loads but
 *   declares no matching gates; `null` when the FlowDefinition cannot be loaded/parsed at all.
 */
export function resolveAllFlowGateExpects(flowId: string, repoRoot: string): FlowGateExpectsEntry[] | null {
  const flowDef = readFlowDefinition(flowId, repoRoot);
  if (!flowDef || typeof flowDef !== "object" || !Array.isArray(flowDef.steps)) return null;
  const out: FlowGateExpectsEntry[] = [];
  const seenGateIds = new Set<string>();
  for (const step of flowDef.steps) {
    if (!step || typeof step.id !== "string" || !step.id) continue;
    const resolved = resolveFlowStepInternal(flowId, step.id, repoRoot, new Set<string>());
    if (!resolved) continue;
    // A gate can be reached by more than one step declaration in degenerate/duplicate step
    // lists; de-dupe by gateId so callers never see the same expects[] entries twice.
    const dedupeKey = `${resolved.gateId}`;
    if (seenGateIds.has(dedupeKey)) continue;
    seenGateIds.add(dedupeKey);
    out.push({ stepId: resolved.stepId, gateId: resolved.gateId, gateExpects: resolved.gateExpects });
  }
  return out;
}

function expectationExportKeys(expectation: GateExpectation): string[] {
  const keys: string[] = [];
  if (typeof expectation.id === "string" && expectation.id) keys.push(expectation.id);
  const claimType = expectation.bundle_claim?.claimType;
  if (typeof claimType === "string" && claimType) keys.push(claimType);
  return keys;
}

function exportedExpectations(expectations: GateExpectation[], exportsList: unknown): GateExpectation[] | null {
  if (!Array.isArray(exportsList)) return null;
  const exported = new Set(exportsList.filter((item): item is string => typeof item === "string" && item.length > 0));
  const allowed = expectations.filter((expectation) => expectationExportKeys(expectation).some((key) => exported.has(key)));
  return allowed.length === expectations.length ? allowed : null;
}

function resolveFlowStepInternal(flowId: string, stepId: string, repoRoot: string, seen: Set<string>): InternalActiveFlowStep | null {
  if (!flowId || !stepId) return null;
  if (!flowIdParts(flowId)) return null;

  // Layer 1 defense: validate stepId too — it is matched against gate.step values but
  // still originates from agent-writable current.json active_step_id.
  if (!SLUG_RE.test(stepId)) return null;
  const seenKey = `${flowId}:${stepId}`;
  if (seen.has(seenKey)) return null;
  seen.add(seenKey);

  const flowDef = readFlowDefinition(flowId, repoRoot);
  if (!flowDef) return null;

  if (!flowDef || typeof flowDef !== "object") return null;

  const composedStep = Array.isArray(flowDef.steps) ? flowDef.steps.find((step) => step?.id === stepId) : undefined;
  const childFlowIds = composedStep ? childFlowIdsForStep(composedStep) : [];
  if (childFlowIds === null) return null;

  const directGateEntry = flowDef.gates
    ? Object.entries(flowDef.gates).find(([, gate]) => gate?.step === stepId)
    : undefined;
  if (directGateEntry) {
    if (childFlowIds.length > 0) return null;
    const [gateId, gate] = directGateEntry;
    const routeBack = routeBackMetadataForGate(gate);
    if (!routeBack) return null;
    return { flowId, stepId, gateId, gateExpects: Array.isArray(gate.expects) ? gate.expects : [], routeBackReasons: Object.keys(routeBack.onRouteBack ?? {}), flowExports: flowDef.exports, routeBack };
  }

  if (childFlowIds.length === 1 && typeof composedStep?.uses_flow === "string") {
    const child = resolveFlowStepInternal(childFlowIds[0]!, stepId, repoRoot, seen);
    if (!child) return null;
    const childGateExpects = exportedExpectations(child.gateExpects, child.flowExports);
    if (!childGateExpects) return null;
    return {
      flowId,
      stepId,
      gateId: `${child.flowId}:${child.gateId}`,
      gateExpects: childGateExpects,
      routeBackReasons: child.routeBackReasons,
      sourceFlowId: child.flowId,
      flowExports: flowDef.exports,
      routeBack: child.routeBack,
    };
  }

  if (childFlowIds.length > 0) {
    const gateExpects: GateExpectation[] = [];
    const expectationIds = new Set<string>();
    const routeBackEntries: RouteBackMetadata[] = [];
    if (flowDef.gates?.[aggregateGateId(stepId)]) return null;
    for (const childFlowId of childFlowIds) {
      // Match effective compilation: a list contributor must compile to one
      // gate at this step, not merely have a first gate live resolution finds.
      const effectiveChild = resolveEffectiveFlowDefinitionInternal(childFlowId, repoRoot, new Set([flowId]), true) as FlowDefinition | null;
      const effectiveChildGates = effectiveChild?.gates
        ? Object.entries(effectiveChild.gates).filter(([, gate]) => gate?.step === stepId)
        : [];
      if (effectiveChildGates.length !== 1) return null;
      const child = resolveFlowStepInternal(childFlowId, stepId, repoRoot, new Set(seen));
      if (!child) return null;
      const childGateExpects = exportedExpectations(child.gateExpects, child.flowExports);
      if (!childGateExpects || !child.routeBack || childGateExpects.some((expectation) => expectationIds.has(expectation.id))) return null;
      for (const expectation of childGateExpects) expectationIds.add(expectation.id);
      gateExpects.push(...childGateExpects);
      routeBackEntries.push(child.routeBack);
    }
    const routeBack = mergeRouteBackMetadata(routeBackEntries);
    if (!routeBack) return null;
    return {
      flowId,
      stepId,
      gateId: aggregateGateId(stepId),
      gateExpects,
      routeBackReasons: Object.keys(routeBack.onRouteBack ?? {}),
      sourceFlowIds: [...childFlowIds],
      flowExports: flowDef.exports,
      routeBack,
    };
  }

  return null; // no gate matched the given stepId
}


/**
 * Resolve the phase→step mapping from a FlowDefinition's phase_map field.
 *
 * Returns the phase_map object (e.g. {"execution":"execute","planning":"plan",...})
 * or null when the flow file cannot be loaded, the phase_map field is absent, or
 * the field is not a plain Record<string,string>.
 *
 * Pure and synchronous — no throws, fail-open on any error.
 *
 * @param flowId   e.g. "builder.build" — kitId is the prefix before the first ".".
 * @param repoRoot Absolute path to the repository root (kits/ lives here).
 *                 Honored only when FLOW_AGENTS_FLOW_DEFS_DIR is not set.
 * @returns Record<string,string> phase→stepId map, or null on absence/error.
 */
export function resolvePhaseMap(flowId: string, repoRoot: string): Record<string, string> | null {
  const flowDef = readFlowDefinition(flowId, repoRoot);
  if (!flowDef) return null;

  if (!flowDef || typeof flowDef !== "object") return null;
  const pm = flowDef.phase_map;
  if (!pm || typeof pm !== "object" || Array.isArray(pm)) return null;
  // Validate: all values must be strings
  for (const v of Object.values(pm)) {
    if (typeof v !== "string") return null;
  }
  return pm as Record<string, string>;
}

/**
 * Find the repository root from a starting directory by walking upward to locate
 * the nearest ancestor that contains a `kits/` subdirectory. A canonical `.kontourai`
 * artifact path falls back to its owning project; other layouts fall back to cwd.
 *
 * This is required because the runtime artifact directory can live anywhere (temp dirs,
 * subprojects, CI workspaces) while the kits/ directory is always at the repo root.
 */
function findRepoRoot(startDir: string): string {
  // Walk up from startDir looking for a kits/ directory
  let dir = startDir;
  for (let i = 0; i < 16; i++) {
    if (fs.existsSync(path.join(dir, "kits"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  // A canonical product artifact root identifies its owning project even when that
  // consumer has no source-tree kits/. resolveFlowFilePath can then use the installed
  // package fallback without consulting an unrelated ambient cwd.
  if (path.basename(startDir) === ".kontourai") return path.dirname(startDir);
  // Fallback: process.cwd() covers the common "run from repo root" case
  return process.cwd();
}

/**
 * Delegate to the shared pure-CJS per-actor current-pointer reader
 * (scripts/hooks/lib/current-pointer.js), mirroring the exact createRequire idiom
 * workflow-sidecar.ts already uses for its own cross-boundary CJS helper reuse (Wave 2 Task 2.2,
 * #291). Deliberately NO inline duplicate fallback — this is the single choke point for the
 * per-actor-first/legacy-fallback compat-shim rule; a second hand-rolled reader here would let it
 * drift from every other consumer.
 */
function loadCurrentPointerHelper(): {
  readCurrentPointer: (flowAgentsDir: string, actorKey?: string) => { payload: Record<string, unknown> | null; source: "per-actor" | "legacy" | "none"; file: string | null };
} {
  const _req = createRequire(import.meta.url);
  const helperPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/hooks/lib/current-pointer.js");
  return _req(helperPath) as {
    readCurrentPointer: (flowAgentsDir: string, actorKey?: string) => { payload: Record<string, unknown> | null; source: "per-actor" | "legacy" | "none"; file: string | null };
  };
}

/**
 * Resolve the active flow step from current.json.
 *
 * Reads active_flow_id and active_step_id via the shared per-actor current-pointer helper
 * (#291 Wave 2 Task 2.2): when `actorKey` is a resolved actor with its own
 * `current/<actor>.json` projection, that file is preferred; otherwise (no actorKey, an
 * unresolved actor, or no per-actor file yet) this falls straight back to the legacy global
 * `<flowAgentsDir>/current.json` — IDENTICAL to this function's pre-#291 behavior for every
 * caller that does not pass `actorKey`. The repoRoot is derived by walking upward from
 * flowAgentsDir to find the nearest ancestor containing kits/, with a fallback to
 * process.cwd(). This handles temp dirs, CI workspaces, and subproject layouts without
 * hardcoding the repo structure.
 *
 * @param flowAgentsDir Path to the runtime artifact root directory (contains current.json).
 * @param actorKey Optional resolved actor identity (Wave 2 Task 2.1's `writeCurrent()` dual-write
 *   key) — when omitted, behavior is unchanged (legacy-file-only, exactly as before #291).
 * @returns ActiveFlowStep or null when fields are absent or resolution fails.
 */
export function resolveActiveFlowStep(flowAgentsDir: string, actorKey?: string): ActiveFlowStep | null {
  if (!flowAgentsDir) return null;
  const pointer = loadCurrentPointerHelper().readCurrentPointer(flowAgentsDir, actorKey);
  if (pointer.source === "none" || !pointer.payload) return null;
  const current = pointer.payload;

  const flowId = typeof current["active_flow_id"] === "string" ? current["active_flow_id"] : null;
  const stepId = typeof current["active_step_id"] === "string" ? current["active_step_id"] : null;
  if (!flowId || !stepId) return null;

  // Find repoRoot: walk up from flowAgentsDir to find kits/, fallback to cwd
  const repoRoot = findRepoRoot(path.dirname(flowAgentsDir));
  return resolveFlowStep(flowId, stepId, repoRoot);
}

/** The resolved route-back policy for a phase transition. */
export type RouteBackPolicy = {
  /** Maximum allowed route-back attempts for this transition key. */
  maxAttempts: number;
  /** Action when attempts are exceeded (e.g. "block"). */
  onExceeded: string;
  /** The step id whose gate declared this policy (e.g. "verify"). */
  fromStepId: string;
};

/**
 * Resolve the route-back policy for a phase transition, if the active FlowDefinition
 * declares one on the source phase's gate.
 *
 * A route-back is a transition where the source phase's gate declares both
 * `route_back_policy` and `on_route_back`, and the target phase maps to a step
 * listed as a route-back target in `on_route_back` values.
 *
 * This is the FlowDefinition-driven replacement for the hardcoded
 * `flow === "builder.build" && prev.phase === "verification" && phase === "execution"`
 * guard in advance-state. Any flow that declares `route_back_policy` on a gate
 * automatically gets route-back enforcement without code changes.
 *
 * @param flowId    e.g. "builder.build" — kitId is the prefix before the first ".".
 * @param fromPhase Lifecycle phase leaving (e.g. "verification").
 * @param toPhase   Lifecycle phase entering (e.g. "execution").
 * @param repoRoot  Absolute path to the repository root (kits/ lives here).
 * @returns RouteBackPolicy when the transition is a declared route-back, null otherwise.
 */
export function resolveRouteBackPolicy(
  flowId: string,
  fromPhase: string,
  toPhase: string,
  repoRoot: string,
): RouteBackPolicy | null {
  if (!flowId || !fromPhase || !toPhase) return null;
  const dotIdx = flowId.indexOf(".");
  if (dotIdx < 1) return null;
  const kitId = flowId.slice(0, dotIdx);
  const flowName = flowId.slice(dotIdx + 1);
  if (!kitId || !flowName) return null;

  const flowFilePath = resolveFlowFilePath(kitId, flowName, flowId, repoRoot);
  if (!flowFilePath) return null;

  let flowDef: FlowDefinition;
  try {
    const raw = fs.readFileSync(flowFilePath, "utf8");
    flowDef = JSON.parse(raw) as FlowDefinition;
  } catch {
    return null; // ENOENT, permission error, or parse error — fail-open
  }

  if (!flowDef || typeof flowDef !== "object") return null;
  const phaseMap = flowDef.phase_map;
  if (!phaseMap || typeof phaseMap !== "object" || Array.isArray(phaseMap)) return null;

  const fromStep = phaseMap[fromPhase];
  const toStep = phaseMap[toPhase];
  if (!fromStep || !toStep) return null; // phases not in this flow

  // List composition emits one gate only in the effective runtime definition;
  // consult that gate so retry accounting uses the same merged policy as live
  // gate evaluation. Scalar composition keeps the historical raw-flow path.
  const sourceStep = Array.isArray(flowDef.steps) ? flowDef.steps.find((step) => step?.id === fromStep) : undefined;
  if (sourceStep?.uses_flows !== undefined) {
    const effective = resolveEffectiveFlowDefinition(flowId, repoRoot) as FlowDefinition | null;
    const aggregate = effective?.gates?.[aggregateGateId(fromStep)];
    if (!aggregate) return null;
    const metadata = routeBackMetadataForGate(aggregate);
    if (!metadata?.routeBackPolicy || !metadata.onRouteBack || !Object.values(metadata.onRouteBack).includes(toStep)) return null;
    return {
      maxAttempts: metadata.routeBackPolicy.max_attempts,
      onExceeded: metadata.routeBackPolicy.on_exceeded,
      fromStepId: fromStep,
    };
  }

  if (!flowDef.gates) return null;
  for (const gate of Object.values(flowDef.gates)) {
    if (!gate || gate.step !== fromStep) continue;
    if (!gate.route_back_policy || !gate.on_route_back) return null;
    // Check if toStep is a valid route-back target declared in on_route_back
    const routeBackTargets = Object.values(gate.on_route_back);
    if (!routeBackTargets.includes(toStep)) return null;
    const maxAttempts =
      typeof gate.route_back_policy.max_attempts === "number"
        ? gate.route_back_policy.max_attempts
        : 3;
    return {
      maxAttempts,
      onExceeded: gate.route_back_policy.on_exceeded ?? "block",
      fromStepId: fromStep,
    };
  }
  return null;
}
