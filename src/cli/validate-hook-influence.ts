import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { readKitInventory } from "../runtime-adapters.js";
import { root } from "../tools/common.js";

const validTiers = new Set(["adapter", "design-target", "installed-command", "live-acceptance", "documented-runtime-gap"]);
const validRuntimes = new Set(["codex", "claude-code", "kiro-cli"]);
const validHooks = new Set(["workflow-steering", "stop-goal-fit"]);
const validEvents = new Set(["UserPromptSubmit", "PostToolUse", "Stop"]);
const engineRequiredCases: Record<string, { description: string; tier: string; hook?: string; event?: string; must_include?: string[]; agent_must_do?: string[] }> = {
  "dev-verify-fail-preserves-trace-before-rework": { description: "verify failure route-back with preserved FAIL evidence", tier: "design-target", must_include: ["If verdict=FAIL: record the FAIL artifact"], agent_must_do: ["write the FAIL artifact before routing back", "route to plan"] },
  "codex-claude-strict-stop-adapter-contract": { description: "Goal Fit stop adapter behavior", tier: "adapter", hook: "stop-goal-fit", event: "Stop", must_include: ["Goal Fit warning"], agent_must_do: ["treat strict Stop guidance as a blocker"] },
  "codex-live-context-gap": { description: "Codex documented runtime gap", tier: "documented-runtime-gap", must_include: ["STATE:", "not_verified"], agent_must_do: ["record NOT_VERIFIED for live influence"] },
  "installed-command-protocol-guidance": { description: "installed-command evidence lane", tier: "installed-command", must_include: ["STATE:", "CRITIQUE:", "CONTEXT MAP:"], agent_must_do: ["treat hook guidance as additional context"] },
};

function requiredCases(): Record<string, { description: string; tier: string; hook?: string; event?: string; must_include?: string[]; agent_must_do?: string[] }> {
  const dest = process.env.FLOW_AGENTS_HOOK_INFLUENCE_DEST ?? root;
  const sourceRoot = process.env.FLOW_AGENTS_HOOK_INFLUENCE_SOURCE_ROOT ?? root;
  const inventory = readKitInventory(sourceRoot, dest);
  if (inventory.errors.length) {
    fail(`kit hook influence metadata is invalid:\n${inventory.errors.join("\n")}`);
  }
  const kitCases: Record<string, { description: string; tier: string; hook?: string; event?: string; must_include?: string[]; agent_must_do?: string[] }> = {};
  for (const expectation of inventory.hook_influence_expectations) {
    const namespacedId = `kit:${expectation.kit_id}:${expectation.id}`;
    if (engineRequiredCases[expectation.id]) {
      fail(`${expectation.kit_id}: hook influence expectation id collides with engine-required case id: ${expectation.id}`);
    }
    if (engineRequiredCases[namespacedId]) {
      fail(`${expectation.kit_id}: namespaced hook influence expectation id collides with engine-required case id: ${namespacedId}`);
    }
    if (kitCases[namespacedId]) {
      fail(`${expectation.kit_id}: duplicate namespaced hook influence expectation id: ${namespacedId}`);
    }
    kitCases[namespacedId] = {
      description: expectation.description,
      tier: expectation.tier,
      ...(expectation.hook ? { hook: expectation.hook } : {}),
      ...(expectation.event ? { event: expectation.event } : {}),
      must_include: expectation.must_include_guidance,
      agent_must_do: expectation.must_include_actions,
    };
  }
  return { ...engineRequiredCases, ...kitCases };
}

function fail(message: string): never {
  throw new Error(message);
}

function stringList(caseId: string, payload: Record<string, unknown>, key: string, minimum = 1): string[] {
  const value = payload[key];
  if (!Array.isArray(value) || value.length < minimum) fail(`${caseId}: ${key} must contain at least ${minimum} item(s)`);
  value.forEach((item, index) => {
    if (typeof item !== "string" || !item.trim()) fail(`${caseId}: ${key}[${index}] must be a non-empty string`);
  });
  return value as string[];
}

function commandTarget(command: string): string | undefined {
  const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^['"]|['"]$/g, "")) ?? [];
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i] === "bash" && parts[i + 1]) return parts[i + 1];
    if (parts[i].startsWith("evals/") || parts[i].startsWith("scripts/")) return parts[i];
  }
  return undefined;
}

function validateEvidenceCommand(caseId: string, runtimes: string[], evidence: Record<string, unknown>): void {
  const command = String(evidence.command);
  const tier = String(evidence.tier);
  const target = commandTarget(command);
  if (!target) fail(`${caseId}: evidence.command must reference a local eval or script path`);
  if (!fs.existsSync(target)) fail(`${caseId}: evidence.command target does not exist: ${target}`);
  const runtimeSet = new Set(runtimes);
  if (tier === "live-acceptance") {
    if (target.includes("evals/acceptance/test_kiro_harness.sh") && (runtimeSet.size !== 1 || !runtimeSet.has("kiro-cli"))) fail(`${caseId}: Kiro live acceptance cannot prove runtimes: ${runtimes.sort().join(", ")}`);
    if (target.includes("evals/acceptance/test_claude_harness.sh") && (runtimeSet.size !== 1 || !runtimeSet.has("claude-code"))) fail(`${caseId}: Claude live acceptance cannot prove runtimes: ${runtimes.sort().join(", ")}`);
    if (target.includes("evals/acceptance/test_codex_harness.sh") && (runtimeSet.size !== 1 || !runtimeSet.has("codex"))) fail(`${caseId}: Codex live acceptance cannot prove runtimes: ${runtimes.sort().join(", ")}`);
    if (!target.includes("evals/acceptance/") && !target.includes("/acceptance/")) fail(`${caseId}: live-acceptance evidence must point to an acceptance harness`);
  } else if (tier === "installed-command" && !target.includes("evals/integration/test_bundle_install.sh")) fail(`${caseId}: installed-command evidence must point to bundle install integration coverage`);
  else if (tier === "adapter" && !target.includes("evals/integration/")) fail(`${caseId}: adapter evidence must point to an integration adapter test`);
  else if (tier === "documented-runtime-gap" && !target.includes("acceptance") && !target.includes("integration")) fail(`${caseId}: documented runtime gaps must still point to an eval boundary`);
}

export function main(argv = process.argv.slice(2)): number {
  try {
    const file = argv[0] ?? "evals/fixtures/hook-influence/cases.json";
    const required = requiredCases();
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    if (data.schema_version !== "1.0") fail("schema_version must be 1.0");
    if (!Array.isArray(data.cases) || !data.cases.length) fail("cases must be a non-empty list");
    const ids = new Set<string>();
    const casesById = new Map<string, Record<string, unknown>>();
    const byTier = new Set<string>();
    const runtimeCoverage = new Set<string>();
    data.cases.forEach((raw, index) => {
      if (typeof raw !== "object" || raw === null) fail(`cases[${index}] must be an object`);
      const item = raw as Record<string, unknown>;
      const caseId = typeof item.id === "string" ? item.id : "";
      if (!caseId.trim()) fail(`cases[${index}]: id must be a non-empty string`);
      if (ids.has(caseId)) fail(`${caseId}: duplicate id`);
      ids.add(caseId);
      casesById.set(caseId, item);
      const runtimes = stringList(caseId, item, "runtime_scope");
      const unknownRuntimes = runtimes.filter((runtime) => !validRuntimes.has(runtime)).sort();
      if (unknownRuntimes.length) fail(`${caseId}: unknown runtime_scope value(s): ${unknownRuntimes.join(", ")}`);
      runtimes.forEach((runtime) => runtimeCoverage.add(runtime));
      if (!validHooks.has(String(item.hook))) fail(`${caseId}: hook must be one of ${[...validHooks].sort().join(", ")}`);
      if (!validEvents.has(String(item.event))) fail(`${caseId}: event must be one of ${[...validEvents].sort().join(", ")}`);
      if (typeof item.fixture_state !== "object" || item.fixture_state === null || !Object.keys(item.fixture_state).length) fail(`${caseId}: fixture_state must be a non-empty object`);
      const guidance = stringList(caseId, item, "guidance_must_include", 2);
      const actions = stringList(caseId, item, "agent_must_do", 2);
      if (typeof item.evidence !== "object" || item.evidence === null) fail(`${caseId}: evidence must be an object`);
      const evidence = item.evidence as Record<string, unknown>;
      const tier = String(evidence.tier);
      if (!validTiers.has(tier)) fail(`${caseId}: evidence.tier must be one of ${[...validTiers].sort().join(", ")}`);
      byTier.add(tier);
      ["command", "status"].forEach((key) => { if (typeof evidence[key] !== "string" || !String(evidence[key]).trim()) fail(`${caseId}: evidence.${key} must be a non-empty string`); });
      validateEvidenceCommand(caseId, runtimes, evidence);
      const req = required[caseId];
      if (req) {
        if (tier !== req.tier) fail(`${caseId}: ${req.description} must use ${req.tier} evidence tier`);
        if (req.hook && item.hook !== req.hook) fail(`${caseId}: ${req.description} must use ${req.hook} hook`);
        if (req.event && item.event !== req.event) fail(`${caseId}: ${req.description} must use ${req.event} event`);
        const guidanceText = guidance.join("\n");
        const actionText = actions.join("\n");
        const missingGuidance = (req.must_include ?? []).filter((needle) => !guidanceText.includes(needle));
        const missingActions = (req.agent_must_do ?? []).filter((needle) => !actionText.includes(needle));
        if (missingGuidance.length) fail(`${caseId}: missing required guidance text for ${req.description}: ${missingGuidance.join(", ")}`);
        if (missingActions.length) fail(`${caseId}: missing required agent action for ${req.description}: ${missingActions.join(", ")}`);
      }
    });
    const missingRuntimes = [...validRuntimes].filter((runtime) => !runtimeCoverage.has(runtime)).sort();
    if (missingRuntimes.length) fail(`missing runtime coverage: ${missingRuntimes.join(", ")}`);
    for (const tier of ["adapter", "installed-command", "live-acceptance", "documented-runtime-gap"]) if (!byTier.has(tier)) fail(`missing required #62 evidence tier(s): ${tier}`);
    for (const id of Object.keys(required)) if (!casesById.has(id)) fail(`missing required #62 case for ${required[id].description}: ${id}`);
    const codexGap = casesById.get("codex-live-context-gap")!;
    const codexRuntimes = codexGap.runtime_scope as string[];
    const codexEvidence = codexGap.evidence as Record<string, unknown>;
    if (codexRuntimes.length !== 1 || codexRuntimes[0] !== "codex") fail("codex-live-context-gap must be scoped only to codex");
    if (!String(codexEvidence.status).includes("acceptance-covers-routing-not-live-hook-influence")) fail("codex-live-context-gap must not overclaim live model-context influence");
    console.log(`Hook influence cases valid: ${data.cases.length} case(s).`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

// Use process.exitCode (not process.exit) to allow stdout to be flushed before exit.
// Resolve real paths to handle symlinks (e.g. /tmp -> /private/tmp on macOS) so the
// entry-point guard fires correctly when the module is loaded directly as a script.
const _selfRealPath = (() => { try { return fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return fileURLToPath(import.meta.url); } })();
const _argv1RealPath = (() => { try { return fs.realpathSync(process.argv[1]); } catch { return process.argv[1]; } })();
if (_selfRealPath === _argv1RealPath) { process.exitCode = main(); }
