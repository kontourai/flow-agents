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
};

/** Shape of a FlowDefinition JSON file. */
type FlowDefinition = {
  id: string;
  version: string;
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

  // Determine the FlowDefinition file path.
  // Honor FLOW_AGENTS_FLOW_DEFS_DIR for custom/override installs.
  const override = process.env["FLOW_AGENTS_FLOW_DEFS_DIR"];
  const flowFilePath = override
    ? path.join(override, `${flowId}.flow.json`)
    : path.join(repoRoot, "kits", kitId, "flows", `${flowName}.flow.json`);

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
 * Find the repository root from a starting directory by walking upward to locate
 * the nearest ancestor that contains a `kits/` subdirectory. If none is found,
 * falls back to `process.cwd()` so the default "run from repo root" case still works.
 *
 * This is required because the .flow-agents directory can live anywhere (temp dirs,
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
 * @param flowAgentsDir Path to the .flow-agents directory (contains current.json).
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
