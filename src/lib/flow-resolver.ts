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

  return resolvedPath;
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
  steps?: Array<{ id: string; next: string | null }>;
  gates?: Record<string, FlowGate>;
};

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
  if (!flowId || !stepId) return null;
  const dotIdx = flowId.indexOf(".");
  if (dotIdx < 1) return null; // flowId must have at least one "." to derive kitId
  const kitId = flowId.slice(0, dotIdx);
  // The flow filename is the part after the first "." (e.g. "build" from "builder.build")
  const flowName = flowId.slice(dotIdx + 1);
  if (!kitId || !flowName) return null;

  // Layer 1 defense: validate stepId too — it is matched against gate.step values but
  // still originates from agent-writable current.json active_step_id.
  if (!SLUG_RE.test(stepId)) return null;

  // Determine the FlowDefinition file path with slug validation + path containment check.
  // Returns null for traversal attempts (e.g. flowName = "../../../.kontourai/flow-agents/fake").
  const flowFilePath = resolveFlowFilePath(kitId, flowName, flowId, repoRoot);
  if (!flowFilePath) return null;

  let flowDef: FlowDefinition;
  try {
    const raw = fs.readFileSync(flowFilePath, "utf8");
    flowDef = JSON.parse(raw) as FlowDefinition;
  } catch {
    return null; // ENOENT, permission error, or parse error → fail-open
  }

  if (!flowDef || typeof flowDef !== "object" || !flowDef.gates) return null;

  // Find the gate whose .step matches stepId.
  for (const [gateId, gate] of Object.entries(flowDef.gates)) {
    if (!gate || gate.step !== stepId) continue;
    const expects = Array.isArray(gate.expects) ? gate.expects : [];
    return { flowId, stepId, gateId, gateExpects: expects };
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
  if (!flowId) return null;
  const dotIdx = flowId.indexOf(".");
  if (dotIdx < 1) return null;
  const kitId = flowId.slice(0, dotIdx);
  const flowName = flowId.slice(dotIdx + 1);
  if (!kitId || !flowName) return null;

  // Layer 1 defense: same slug validation + path containment as resolveFlowStep.
  const flowFilePath = resolveFlowFilePath(kitId, flowName, flowId, repoRoot);
  if (!flowFilePath) return null;

  let flowDef: FlowDefinition;
  try {
    const raw = fs.readFileSync(flowFilePath, "utf8");
    flowDef = JSON.parse(raw) as FlowDefinition;
  } catch {
    return null; // ENOENT, permission error, or parse error → fail-open
  }

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
 * Resolve the active flow step from current.json.
 *
 * Reads active_flow_id and active_step_id from <flowAgentsDir>/current.json.
 * If both are present, delegates to resolveFlowStep. The repoRoot is derived by
 * walking upward from flowAgentsDir to find the nearest ancestor containing kits/,
 * with a fallback to process.cwd(). This handles temp dirs, CI workspaces, and
 * subproject layouts without hardcoding the repo structure.
 *
 * @param flowAgentsDir Path to the runtime artifact root directory (contains current.json).
 * @returns ActiveFlowStep or null when fields are absent or resolution fails.
 */
export function resolveActiveFlowStep(flowAgentsDir: string): ActiveFlowStep | null {
  if (!flowAgentsDir) return null;
  const currentFile = path.join(flowAgentsDir, "current.json");
  let current: Record<string, unknown>;
  try {
    const raw = fs.readFileSync(currentFile, "utf8");
    current = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

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
