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
 * Returns true when the given resolved absolute path falls within a Flow Agents
 * runtime artifact directory (an agent-writable area). Used to reject FLOW_AGENTS_FLOW_DEFS_DIR
 * overrides that point into agent-controlled storage.
 */
function hasAgentWritableRuntimeSegment(resolvedDir: string): boolean {
  const parts = resolvedDir.split(path.sep);
  if (parts.includes(".flow-agents")) return true;
  return parts.some((part, index) => part === ".kontourai" && parts[index + 1] === "flow-agents");
}

function isAgentWritableDir(resolvedDir: string): boolean {
  if (hasAgentWritableRuntimeSegment(resolvedDir)) return true;
  try {
    return hasAgentWritableRuntimeSegment(fs.realpathSync.native(resolvedDir));
  } catch {
    return false;
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
 * When the override is unsafe, it is ignored and the resolver uses the
 * canonical repoRoot/kits/ source for legitimate flows.
 */
export function resolveFlowFilePath(
  kitId: string,
  flowName: string,
  flowId: string,
  repoRoot: string,
): string | null {
  // Primary defense: reject any slug containing traversal chars or non-identifier chars.
  if (!SLUG_RE.test(kitId) || !SLUG_RE.test(flowName)) return null;

  const override = process.env["FLOW_AGENTS_FLOW_DEFS_DIR"];

  let expectedRoot: string;
  let flowFilePath: string;

  if (override) {
    const resolvedOverride = path.resolve(override);
    if (isAgentWritableDir(resolvedOverride)) {
      // Override targets an agent-writable runtime path; ignore it and use
      // the canonical kit root. The session will resolve the real kit flow.
      expectedRoot = path.resolve(repoRoot, "kits");
      flowFilePath = path.join(repoRoot, "kits", kitId, "flows", `${flowName}.flow.json`);
    } else {
      expectedRoot = resolvedOverride;
      // flowId = kitId + "." + flowName; after slug validation this contains only
      // [a-zA-Z0-9_-.] — no slashes, no traversal.
      flowFilePath = path.join(resolvedOverride, `${flowId}.flow.json`);
    }
  } else {
    expectedRoot = path.resolve(repoRoot, "kits");
    flowFilePath = path.join(repoRoot, "kits", kitId, "flows", `${flowName}.flow.json`);
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
  // into an out-of-root file read through a symlinked FlowDefinition.
  try {
    const realExpectedRoot = fs.existsSync(expectedRoot) ? fs.realpathSync.native(expectedRoot) : expectedRoot;
    const realPath = fs.realpathSync.native(resolvedPath);
    if (!realPath.startsWith(realExpectedRoot + path.sep) && realPath !== realExpectedRoot) {
      return null;
    }
    return realPath;
  } catch {
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
  /** When resolved through a parent step's uses_flow edge, names the child FlowDefinition that owns the gate. */
  sourceFlowId?: string;
};

/** Shape of a gate entry in the FlowDefinition JSON. */
type FlowGate = {
  step: string;
  expects?: GateExpectation[];
  /** Reason-to-step mapping for route-back transitions (e.g. {"implementation_defect": "execute"}). */
  on_route_back?: Record<string, string>;
  /** Policy governing route-back attempt limits. */
  route_back_policy?: { max_attempts: number; on_exceeded: string };
};

/** Shape of a FlowDefinition JSON file. */
type FlowDefinition = {
  id: string;
  version: string;
  /** Kit-owned phase→step mapping (ADR 0016 Abstraction A P-d). Maps lifecycle phase names
   *  (e.g. "execution") to step ids (e.g. "execute") so advance-state can write active_step_id
   *  without hardcoding any vocabulary in the core. */
  phase_map?: Record<string, string>;
  steps?: Array<{ id: string; next: string | null; uses_flow?: string }>;
  gates?: Record<string, FlowGate>;
  /** Optional claim types or expectation ids this flow intentionally exposes to parent/composed flows. */
  exports?: string[];
};

type InternalActiveFlowStep = ActiveFlowStep & { flowExports?: string[] };

function flowIdParts(flowId: string): { kitId: string; flowName: string } | null {
  if (!flowId) return null;
  const dotIdx = flowId.indexOf(".");
  if (dotIdx < 1) return null;
  const kitId = flowId.slice(0, dotIdx);
  const flowName = flowId.slice(dotIdx + 1);
  if (!kitId || !flowName) return null;
  return { kitId, flowName };
}

function readFlowDefinition(flowId: string, repoRoot: string): FlowDefinition | null {
  const parts = flowIdParts(flowId);
  if (!parts) return null;
  const flowFilePath = resolveFlowFilePath(parts.kitId, parts.flowName, flowId, repoRoot);
  if (!flowFilePath) return null;

  try {
    const raw = fs.readFileSync(flowFilePath, "utf8");
    return JSON.parse(raw) as FlowDefinition;
  } catch {
    return null; // ENOENT, permission error, or parse error → fail-open
  }
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

  // Find the gate whose .step matches stepId.
  if (flowDef.gates) {
    for (const [gateId, gate] of Object.entries(flowDef.gates)) {
      if (!gate || gate.step !== stepId) continue;
      const expects = Array.isArray(gate.expects) ? gate.expects : [];
      return { flowId, stepId, gateId, gateExpects: expects, flowExports: flowDef.exports };
    }
  }

  const composedStep = Array.isArray(flowDef.steps)
    ? flowDef.steps.find((step) => step && step.id === stepId && typeof step.uses_flow === "string" && step.uses_flow.trim())
    : null;
  if (composedStep?.uses_flow) {
    const child = resolveFlowStepInternal(composedStep.uses_flow, stepId, repoRoot, seen);
    if (child) {
      const childGateExpects = exportedExpectations(child.gateExpects, child.flowExports);
      if (!childGateExpects) return null;
      return {
        flowId,
        stepId,
        gateId: `${child.flowId}:${child.gateId}`,
        gateExpects: childGateExpects,
        sourceFlowId: child.flowId,
        flowExports: flowDef.exports,
      };
    }
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
 * the nearest ancestor that contains a `kits/` subdirectory. If none is found,
 * falls back to `process.cwd()` so the default "run from repo root" case still works.
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
