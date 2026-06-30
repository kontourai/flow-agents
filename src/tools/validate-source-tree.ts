#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { validateKitRepository as validateFlowKitRepository } from "../flow-kit/validate.js";
import { loadJson, readText, rel, root, walkFiles } from "./common.js";

class Reporter {
  errors: string[] = [];
  fail(message: string): void { this.errors.push(message); }
  check(condition: boolean, message: string): void { if (!condition) this.fail(message); }
}
const manifestPath = path.join(root, "packaging/manifest.json");
const kitsCatalogPath = path.join(root, "kits/catalog.json");
const flowRoot = process.env.FLOW_CLI_ROOT ? path.resolve(process.env.FLOW_CLI_ROOT) : "";
const flowSchemaPath = flowRoot ? path.join(flowRoot, "schemas", "flow-definition.schema.json") : "";
const flowCliPath = flowRoot ? ["dist/cli.js", "src/cli.js"].map((candidate) => path.join(flowRoot, candidate)).find((candidate) => fs.existsSync(candidate)) ?? path.join(flowRoot, "dist/cli.js") : "";
const textRefExtensions = new Set([".md", ".yaml", ".yml", ".json", ".sh", ".js", ".toml"]);
const ignoredRefDirs = new Set(["node_modules", "__pycache__", ".pytest_cache", ".cache"]);
const legacyRefRe = /(?<![A-Za-z0-9_.-])(?:agents|agent-cards|context|evals|lib|powers|prompts|scripts|skills)\/[A-Za-z0-9_./@:+-]+/g;
const mirroredFiles = new Map<string, { mirror: string; allowedDifferences: Array<[string, string]> }>([
  ["scripts/telemetry/telemetry.sh", { mirror: "context/scripts/telemetry/telemetry.sh", allowedDifferences: [] }],
  ["scripts/telemetry/lib/config.sh", { mirror: "context/scripts/telemetry/lib/config.sh", allowedDifferences: [] }],
  ["scripts/telemetry/telemetry.conf", { mirror: "context/scripts/telemetry/telemetry.conf", allowedDifferences: [] }],
  ["scripts/telemetry/console-presets.sh", { mirror: "context/scripts/telemetry/console-presets.sh", allowedDifferences: [] }],
  ["scripts/telemetry/install-console-config.sh", { mirror: "context/scripts/telemetry/install-console-config.sh", allowedDifferences: [] }],
  ["scripts/discover-agents.sh", { mirror: "context/scripts/discover-agents.sh", allowedDifferences: [['ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"', 'ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"']] }],
]);
const publicScriptWrappers = new Map<string, { target: string; significantLines: string[] }>([
  ["scripts/build-universal-bundles.js", { target: "../build/src/tools/build-universal-bundles.js", significantLines: [
    'import("../build/src/tools/build-universal-bundles.js").then(({ main }) => process.exit(main()));',
  ] }],
  ["scripts/generate-context-map.js", { target: "../build/src/tools/generate-context-map.js", significantLines: ['import("../build/src/tools/generate-context-map.js").then(({ main }) => process.exit(main(process.argv.slice(2))));'] }],
  ["scripts/kit.js", { target: "../build/src/cli/kit.js", significantLines: ['import("../build/src/cli/kit.js").then(({ main }) => main().then((code) => process.exit(code)));'] }],
  ["scripts/pull-work-provider.js", { target: "../build/src/cli/pull-work-provider.js", significantLines: ['import("../build/src/cli/pull-work-provider.js").then(({ main }) => process.exit(main()));'] }],
  ["scripts/effective-backlog-settings.js", { target: "../build/src/cli/effective-backlog-settings.js", significantLines: ['import("../build/src/cli/effective-backlog-settings.js").then(({ main }) => process.exit(main()));'] }],
  ["scripts/publish-change-helper.js", { target: "../build/src/cli/publish-change-helper.js", significantLines: ['import("../build/src/cli/publish-change-helper.js").then(({ main }) => process.exit(main()));'] }],
  ["scripts/promote-workflow-artifact.js", { target: "../build/src/cli/promote-workflow-artifact.js", significantLines: ['import("../build/src/cli/promote-workflow-artifact.js").then(({ main }) => process.exit(main()));'] }],
  ["scripts/usage-feedback.js", { target: "../build/src/cli/usage-feedback.js", significantLines: ['import("../build/src/cli/usage-feedback.js").then(({ main }) => process.exit(main()));'] }],
  ["scripts/validate-hook-influence-cases.js", { target: "../build/src/cli/validate-hook-influence.js", significantLines: ['import("../build/src/cli/validate-hook-influence.js").then(({ main }) => process.exit(main(process.argv.slice(2))));'] }],
  ["scripts/validate-source-tree.js", { target: "validate:source", significantLines: [
    'import("node:child_process").then(({ spawnSync }) => {',
    'const result = spawnSync("npm", ["run", "validate:source", "--silent", "--", ...process.argv.slice(2)], {',
    'cwd: new URL("..", import.meta.url),',
    'encoding: "utf8",',
    'stdio: "inherit",',
    '});',
    'process.exit(result.status ?? 1);',
    '});',
  ] }],
]);
const hookFilePolicies = new Map<string, { category: string; requiredNeedles: string[] }>([
  ["scripts/hooks/claude-hook-adapter.js", { category: "runtime adapter", requiredNeedles: ["claude", "run-hook.js"] }],
  ["scripts/hooks/codex-hook-adapter.js", { category: "runtime adapter", requiredNeedles: ["codex", "run-hook.js"] }],
  ["scripts/hooks/claude-telemetry-hook.js", { category: "telemetry shim", requiredNeedles: ["claude", "telemetry"] }],
  ["scripts/hooks/codex-telemetry-hook.js", { category: "telemetry shim", requiredNeedles: ["codex", "telemetry"] }],
  ["scripts/hooks/run-hook.js", { category: "hook runner", requiredNeedles: ["isHookEnabled", "Path traversal rejected"] }],
  ["scripts/hooks/config-protection.js", { category: "policy hook", requiredNeedles: ["Config Protection Hook"] }],
  ["scripts/hooks/evidence-capture.js", { category: "policy hook", requiredNeedles: ["Evidence Capture Hook"] }],
  ["scripts/hooks/governance-audit.sh", { category: "policy hook", requiredNeedles: ["governance-audit.sh", "audit_emit"] }],
  ["scripts/hooks/opencode-hook-adapter.js", { category: "runtime adapter", requiredNeedles: ["opencode", "run-hook.js"] }],
  ["scripts/hooks/opencode-telemetry-hook.js", { category: "telemetry shim", requiredNeedles: ["opencode", "telemetry"] }],
  ["scripts/hooks/pi-hook-adapter.js", { category: "runtime adapter", requiredNeedles: ["pi", "run-hook.js"] }],
  ["scripts/hooks/pi-telemetry-hook.js", { category: "telemetry shim", requiredNeedles: ["pi", "telemetry"] }],
  ["scripts/hooks/post-edit-accumulator.js", { category: "policy hook", requiredNeedles: ["Post-Edit"] }],
  ["scripts/hooks/pre-commit-quality.js", { category: "repo guardrail hook", requiredNeedles: ["staged"] }],
  ["scripts/hooks/quality-gate.js", { category: "policy hook", requiredNeedles: ["Quality"] }],
  ["scripts/hooks/report-only-guard.js", { category: "policy hook", requiredNeedles: ["Report-Only Guard Hook"] }],
  ["scripts/hooks/stop-format-typecheck.js", { category: "policy hook", requiredNeedles: ["Stop Hook", "typecheck"] }],
  ["scripts/hooks/stop-goal-fit.js", { category: "policy hook", requiredNeedles: ["Stop Hook", "Goal Fit"] }],
  ["scripts/hooks/utterance-check.js", { category: "policy hook", requiredNeedles: ["Utterance Check Hook", "FLOW_AGENTS_UTTERANCE_CHECK_ENABLED"] }],
  ["scripts/hooks/workflow-steering.js", { category: "policy hook", requiredNeedles: ["Workflow Steering Hook"] }],
  ["scripts/hooks/desktop-notify.sh", { category: "local notification helper", requiredNeedles: ["desktop-notify.sh", "osascript"] }],
  ["scripts/hooks/lib/audit-transport.sh", { category: "shared hook library", requiredNeedles: ["audit_emit"] }],
  ["scripts/hooks/lib/hook-flags.js", { category: "shared hook library", requiredNeedles: ["isHookEnabled"] }],
  ["scripts/hooks/lib/liveness-read.js", { category: "shared hook library", requiredNeedles: ["freshHolders", "readLivenessEvents"] }],
  ["scripts/hooks/lib/local-artifact-paths.js", { category: "shared hook library", requiredNeedles: ["flowAgentsArtifactRoot", "defaultArtifactRootForRead"] }],
  ["scripts/hooks/lib/patterns.sh", { category: "shared hook library", requiredNeedles: ["_detect_secrets"] }],
  ["scripts/hooks/lib/resolve-formatter.js", { category: "shared hook library", requiredNeedles: ["resolveFormatter"] }],
]);
const fixtureOwnerPolicies = new Map<string, { owners: string[]; classification: string }>([
  ["evals/fixtures/backlog-provider-settings", { owners: ["evals/integration/test_effective_backlog_settings.sh"], classification: "settings precedence fixtures" }],
  ["evals/fixtures/builder-kit-workflow-state", { owners: ["evals/static/test_workflow_skills.sh"], classification: "Builder Kit workflow-state fixtures" }],
  ["evals/fixtures/console-learning-projection", { owners: ["evals/integration/test_console_learning_projection.sh"], classification: "console learning projection fixtures" }],
  ["evals/fixtures/flow-kit-repository", { owners: ["evals/integration/test_flow_kit_repository.sh", "evals/integration/test_local_flow_kit_install.sh", "evals/integration/test_runtime_adapter_activation.sh", "evals/integration/test_activate_npx_context.sh", "evals/integration/test_flow_kit_install_git.sh", "evals/static/test_workflow_skills.sh"], classification: "Flow Kit repository contract fixtures" }],
  ["evals/fixtures/kit-conformance-levels", { owners: ["evals/integration/test_kit_conformance_levels.sh"], classification: "K-level conformance and consumer-target derivation fixtures" }],
  ["evals/fixtures/hook-influence", { owners: ["evals/integration/test_hook_influence_cases.sh", "evals/static/test_workflow_skills.sh", "scripts/validate-hook-influence-cases.js"], classification: "hook influence behavioral cases" }],
  ["evals/fixtures/pull-work-provider", { owners: ["evals/integration/test_pull_work_provider.sh"], classification: "work item provider normalization fixtures" }],
  ["evals/fixtures/pull-work-wip-shepherding", { owners: ["evals/static/test_workflow_skills.sh"], classification: "WIP shepherding state fixtures" }],
  ["evals/fixtures/surface-trust", { owners: ["evals/integration/test_workflow_sidecar_writer.sh"], classification: "Surface trust evidence fixtures" }],
  ["evals/fixtures/usage-feedback", { owners: ["evals/integration/test_usage_feedback_import.sh", "evals/integration/test_usage_feedback_outcomes.sh", "evals/integration/test_usage_feedback_report.sh"], classification: "usage feedback import/outcome fixtures" }],
  ["evals/fixtures/veritas-governance-adapter", { owners: ["evals/integration/test_veritas_governance_adapter.sh"], classification: "Veritas governance adapter fixtures" }],
]);
const requiredUsageFeedbackFiles = [
  "package.json", "tsconfig.json", "scripts/usage-feedback.js", "src/cli/usage-feedback.ts", "docs/agent-usage-feedback-loop.md",
  "scripts/hooks/stop-goal-fit.js", "scripts/promote-workflow-artifact.js", "evals/integration/test_goal_fit_hook.sh",
];
const fixtureOwnershipSelfAuditRefs = new Set([
  "evals/integration/test_fixture_retirement_audit.sh",
]);
const pythonInventoryExcludes = new Set([".git", ".flow-agents", ".kontourai", "node_modules", ".venv", "dist", "__pycache__", ".pytest_cache", ".cache", "build", "integrations"]);
const pythonCommandScanRoots = ["README.md", "docs", "context", "skills", "prompts", "agents", "evals", "scripts", "packaging", "package.json"];
const allowedPythonCommandFiles = [
  /^agents\/tool-explore-deps\.json$/,
  /^evals\/results\//,
  /^evals\/lib\/python\.sh$/,
  /(^|\/)telemetry\/lib\/enrich\.sh$/,
];

function tryLoadJson(file: string, reporter: Reporter): any {
  try { return loadJson(file); } catch (error) { reporter.fail(`${rel(file)}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`); return undefined; }
}
function sourcePath(pathText: string, manifest: any): string {
  let normalized = pathText;
  for (const alias of manifest.source_root_aliases ?? []) normalized = normalized.split(alias).join(root);
  normalized = normalized.replace(/^~/, process.env.HOME ?? "");
  return path.isAbsolute(normalized) ? normalized : path.join(root, normalized);
}
function validateAgents(reporter: Reporter): Set<string> {
  const names = new Set<string>();
  const files = fs.readdirSync(path.join(root, "agents")).filter((name) => name.endsWith(".json")).sort();
  const allStems = new Set(files.map((name) => path.basename(name, ".json")));
  for (const name of files) {
    const file = path.join(root, "agents", name);
    const data = tryLoadJson(file, reporter);
    if (!data || typeof data !== "object") continue;
    const agentName = data.name;
    reporter.check(typeof agentName === "string" && !!agentName, `${rel(file)}: missing .name`);
    if (typeof agentName !== "string" || !agentName) continue;
    names.add(agentName);
    reporter.check(path.basename(file, ".json") === agentName, `${rel(file)}: filename must match agent name '${agentName}'`);
    reporter.check(/^[a-z][a-z0-9-]*$/.test(agentName), `${rel(file)}: invalid agent name '${agentName}'`);
    for (const key of ["description", "prompt", "model"]) reporter.check(typeof data[key] === "string" && !!data[key], `${rel(file)}: missing .${key}`);
    if ("allowedTools" in data) reporter.check(Array.isArray(data.allowedTools), `${rel(file)}: .allowedTools must be a list`);
    for (const pattern of data.toolsSettings?.subagent?.availableAgents ?? []) {
      if (typeof pattern !== "string") { reporter.fail(`${rel(file)}: subagent pattern is not a string`); continue; }
      const regex = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*")}$`);
      reporter.check([...new Set([...names, ...allStems])].some((candidate) => regex.test(candidate)), `${rel(file)}: subagent pattern '${pattern}' matches no canonical agents`);
    }
  }
  return names;
}
function validateAgentCards(reporter: Reporter, agentNames: Set<string>): void {
  for (const file of walkFiles(path.join(root, "agent-cards")).filter((item) => item.endsWith(".json")).sort()) {
    const data = tryLoadJson(file, reporter);
    if (!data || typeof data !== "object") continue;
    reporter.check(typeof data.name === "string" && !!data.name, `${rel(file)}: missing .name`);
    reporter.check(typeof data.agent === "string" && !!data.agent, `${rel(file)}: missing .agent`);
    if (typeof data.agent === "string") reporter.check(agentNames.has(data.agent), `${rel(file)}: agent '${data.agent}' has no canonical agents/${data.agent}.json`);
  }
}
function validatePowers(reporter: Reporter): void {
  for (const file of walkFiles(path.join(root, "powers")).filter((item) => item.endsWith("/mcp.json")).sort()) {
    const data = tryLoadJson(file, reporter);
    reporter.check(fs.existsSync(path.join(path.dirname(file), "POWER.md")), `${rel(path.dirname(file))}: missing POWER.md`);
    const servers = data?.mcpServers;
    reporter.check(Boolean(servers && typeof servers === "object" && Object.keys(servers).length > 0), `${rel(file)}: missing .mcpServers`);
    for (const [serverName, server] of Object.entries(servers ?? {})) {
      reporter.check(Boolean(server && typeof server === "object"), `${rel(file)}: mcpServers.${serverName} must be an object`);
      reporter.check(typeof (server as any)?.command === "string" && !!(server as any).command, `${rel(file)}: mcpServers.${serverName} missing .command`);
    }
  }
}
function validateManifest(reporter: Reporter, manifest: any, agentNames: Set<string>): void {
  for (const key of ["canonical_copy_dirs", "source_root_aliases", "target_substitutions"]) reporter.check(key in manifest, `${rel(manifestPath)}: missing .${key}`);
  for (const dir of manifest.canonical_copy_dirs ?? []) reporter.check(fs.existsSync(path.join(root, dir)), `${rel(manifestPath)}: canonical_copy_dirs entry missing: ${dir}`);
  for (const file of manifest.root_copy_files ?? []) {
    reporter.check(typeof file === "string" && !path.isAbsolute(file) && !file.split(/[\\/]/).includes(".."), `${rel(manifestPath)}: root_copy_files entry must be a safe relative path: ${file}`);
    if (typeof file === "string" && !path.isAbsolute(file) && !file.split(/[\\/]/).includes("..")) {
      reporter.check(fs.existsSync(path.join(root, file)), `${rel(manifestPath)}: root_copy_files entry missing: ${file}`);
    }
  }
  for (const dir of manifest.optional_copy_dirs ?? []) if (!fs.existsSync(path.join(root, dir))) console.log(`warning: ${rel(manifestPath)} optional_copy_dirs entry absent: ${dir}`);
  for (const agent of manifest.codex?.excluded_agents ?? []) reporter.check(agentNames.has(agent), `${rel(manifestPath)}: codex excluded agent '${agent}' does not exist`);
}
async function validateKitRepository(kitDir: string, reporter: Reporter): Promise<void> {
  if (!fs.existsSync(kitDir) || !fs.statSync(kitDir).isDirectory()) { reporter.fail(`${rel(kitDir)}: kit directory does not exist`); return; }
  const kitJson = path.join(kitDir, "kit.json");
  reporter.check(fs.existsSync(kitJson), `${rel(kitDir)}: missing kit.json at repository root`);
  if (!fs.existsSync(kitJson)) return;
  for (const error of await validateFlowKitRepository(kitDir)) reporter.fail(error);
}
async function validateKits(reporter: Reporter): Promise<void> {
  reporter.check(fs.existsSync(path.join(root, "kits")), "kits directory missing");
  const catalog = tryLoadJson(kitsCatalogPath, reporter);
  const kits = catalog?.kits;
  reporter.check(Array.isArray(kits) && kits.length > 0, `${rel(kitsCatalogPath)}: .kits must be a non-empty list`);
  if (!Array.isArray(kits)) return;
  const localCli = flowCliPath;
  if (flowSchemaPath && fs.existsSync(flowSchemaPath)) console.log(fs.existsSync(localCli) ? `info: validating kit Flow Definitions with Flow CLI at ${localCli}` : `warning: Flow validator unavailable; source-tree check only verifies Flow Definition top-level shape`);
  else console.log("warning: Flow schema not configured; source-tree check only verifies Flow Definition top-level shape. Set FLOW_CLI_ROOT to enable Flow CLI validation. Container validation (kit.json core fields) will delegate to 'flow validate-kit' from @kontourai/flow when FLOW_CLI_ROOT is available.");
  for (const [index, entry] of kits.entries()) {
    const kitText = typeof entry === "string" ? entry : ["path", "directory", "dir", "id", "name"].map((key) => entry?.[key]).find((value) => typeof value === "string" && value);
    if (!kitText) { reporter.fail(`${rel(kitsCatalogPath)}: kits[${index}] missing path, directory, dir, id, or name`); continue; }
    const kitRef = String(kitText).startsWith("kits/") ? path.join(root, kitText) : path.join(root, "kits", kitText);
    const kitDir = path.basename(kitRef) === "kit.json" ? path.dirname(kitRef) : kitRef;
    reporter.check(fs.existsSync(kitDir) && fs.statSync(kitDir).isDirectory(), `${rel(kitsCatalogPath)}: kits[${index}] points at missing kit folder: ${kitText}`);
    await validateKitRepository(kitDir, reporter);
  }
}
function validateAgentPaths(reporter: Reporter, manifest: any): void {
  for (const file of walkFiles(path.join(root, "agents")).filter((item) => item.endsWith(".json"))) {
    const data = tryLoadJson(file, reporter);
    for (const [idx, resource] of (data?.resources ?? []).entries()) {
      const source = typeof resource === "object" ? resource.source : resource;
      if (typeof source !== "string" || !source.startsWith("file://") || source.includes("*")) continue;
      reporter.check(fs.existsSync(sourcePath(source.slice("file://".length), manifest)), `${rel(file)}: resources[${idx}] points at missing path: ${source.slice("file://".length)}`);
    }
    for (const entry of data?.toolsSettings?.write?.allowedPaths ?? []) {
      if (typeof entry !== "string" || entry.startsWith(".")) continue;
      reporter.check(fs.existsSync(sourcePath(entry.replace("**/*", ""), manifest)), `${rel(file)}: allowedPaths entry points at missing path: ${entry}`);
    }
  }
}
function validateLegacyRefs(reporter: Reporter): void {
  // Collect all kit-owned asset relative paths so legacy-ref scanning can skip matches
  // that are subpaths of kit-owned assets. E.g. legacyRefRe matches "skills/plan-work/SKILL.md"
  // within "kits/builder/skills/plan-work/SKILL.md"; the kit declares and validates these.
  const kitOwnedSubPaths = new Set<string>();
  const kitsDir = path.join(root, "kits");
  if (fs.existsSync(kitsDir)) {
    for (const kitName of fs.readdirSync(kitsDir)) {
      const kitJson = path.join(kitsDir, kitName, "kit.json");
      if (!fs.existsSync(kitJson)) continue;
      try {
        const kitManifest = loadJson<Record<string, unknown>>(kitJson);
        for (const section of ["skills", "docs", "adapters", "evals", "assets"]) {
          const entries = Array.isArray(kitManifest[section]) ? kitManifest[section] as unknown[] : [];
          for (const entry of entries) {
            if (typeof entry !== "object" || entry === null) continue;
            const relPath = (entry as Record<string, unknown>)["path"];
            if (typeof relPath === "string" && relPath) kitOwnedSubPaths.add(relPath);
          }
        }
      } catch { /* skip invalid kit.json */ }
    }
  }
  for (const file of walkFiles(path.join(root, "evals")).sort()) {
    if (!textRefExtensions.has(path.extname(file))) continue;
    const parts = path.relative(path.join(root, "evals"), file).split(path.sep);
    if (parts.includes("results") || parts.some((part) => ignoredRefDirs.has(part))) continue;
    const text = readText(file);
    for (const match of text.matchAll(legacyRefRe)) {
      const ref = match[0].replace(/[.,)'"\]]+$/, "");
      if (/[{}$]/.test(ref)) continue;
      if (ref.split(/[\\/]/).includes("node_modules")) continue;
      // Skip refs that are declared kit-owned asset paths or their parent directories
      // (e.g. "skills/plan-work/SKILL.md" or "skills/plan-work" matched inside
      // "kits/builder/skills/plan-work/SKILL.md" in eval files).
      if (kitOwnedSubPaths.has(ref) || [...kitOwnedSubPaths].some((p) => p.startsWith(ref + "/"))) continue;
      const candidates = [path.join(root, ref), ...(ref.startsWith("evals/") ? [] : [path.join(root, "evals", ref)])];
      if (!candidates.some(fs.existsSync)) reporter.fail(`${rel(file)}: references missing source path: ${ref}`);
    }
  }
}
function validateMirrors(reporter: Reporter): void {
  for (const [rootRel, policy] of mirroredFiles) {
    const rootFile = path.join(root, rootRel); const mirror = path.join(root, policy.mirror);
    reporter.check(fs.existsSync(rootFile), `${rootRel}: mirrored root file missing`);
    reporter.check(fs.existsSync(mirror), `${policy.mirror}: mirrored context file missing`);
    if (!fs.existsSync(rootFile) || !fs.existsSync(mirror)) continue;
    let left = readText(rootFile); let right = readText(mirror);
    for (const [rootLine, mirrorLine] of policy.allowedDifferences) { left = left.replace(rootLine, "__ALLOWED_ROOT_DIR_LINE__"); right = right.replace(mirrorLine, "__ALLOWED_ROOT_DIR_LINE__"); }
    reporter.check(left === right, `${rootRel} and ${policy.mirror} differ outside allowed mirror policy`);
  }
}
function validateUsageFeedbackFiles(reporter: Reporter): void {
  for (const file of requiredUsageFeedbackFiles) reporter.check(fs.existsSync(path.join(root, file)), `required usage feedback artifact missing: ${file}`);
}
function significantScriptLines(text: string): string[] {
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#!"));
}
function validatePublicScriptWrappers(reporter: Reporter): void {
  const readme = readText(path.join(root, "scripts/README.md"));
  for (const [file, policy] of publicScriptWrappers) {
    const abs = path.join(root, file);
    reporter.check(fs.existsSync(abs), `${file}: public script wrapper is missing`);
    reporter.check(readme.includes(path.basename(file)), `scripts/README.md: public wrapper table is missing ${path.basename(file)}`);
    if (!fs.existsSync(abs)) continue;
    const text = readText(abs);
    const significantLines = significantScriptLines(text);
    reporter.check(JSON.stringify(significantLines) === JSON.stringify(policy.significantLines), `${file}: public wrapper must match the exact thin launcher body for ${policy.target}`);
  }
}
function validateAdrNumbers(reporter: Reporter): void {
  // Each ADR (a docs/adr file with an `# ADR NNNN:` heading) must own a unique
  // number, and its filename prefix must match that number. Companion/index docs
  // without an ADR heading (e.g. a numbered skill-audit tied to an ADR) are
  // intentionally skipped. Guards against concurrent number collisions like the
  // duplicate ADR 0014 from PRs #180/#172.
  const adrDir = path.join(root, "docs/adr");
  if (!fs.existsSync(adrDir)) return;
  const byNumber = new Map<string, string[]>();
  for (const file of walkFiles(adrDir)) {
    if (path.extname(file) !== ".md") continue;
    const heading = readText(file).match(/^#\s+ADR\s+(\d{4}):/m);
    if (!heading) continue; // not an ADR decision doc
    const num = heading[1];
    reporter.check(
      path.basename(file).startsWith(`${num}-`),
      `${rel(file)}: ADR heading number ${num} does not match the filename prefix`,
    );
    const list = byNumber.get(num) ?? [];
    list.push(rel(file));
    byNumber.set(num, list);
  }
  for (const [num, files] of byNumber) {
    reporter.check(
      files.length === 1,
      `docs/adr: duplicate ADR number ${num} — ${files.join(", ")}. ADR numbers must be unique; renumber one.`,
    );
  }
}
function validateHookInventory(reporter: Reporter): void {
  const readme = readText(path.join(root, "scripts/README.md"));
  const hookFiles = walkFiles(path.join(root, "scripts/hooks"))
    .filter((file) => [".js", ".sh"].includes(path.extname(file)))
    .map((file) => rel(file))
    .sort();
  const expected = [...hookFilePolicies.keys()].sort();
  reporter.check(JSON.stringify(hookFiles) === JSON.stringify(expected), `scripts/hooks: hook file inventory changed; update validate-source-tree hookFilePolicies and scripts/README.md`);
  for (const [file, policy] of hookFilePolicies) {
    const abs = path.join(root, file);
    reporter.check(fs.existsSync(abs), `${file}: ${policy.category} missing`);
    reporter.check(readme.includes(path.basename(file)), `scripts/README.md: hook inventory is missing ${path.basename(file)}`);
    reporter.check(readme.includes(policy.category), `scripts/README.md: hook inventory is missing category '${policy.category}'`);
    if (!fs.existsSync(abs)) continue;
    const text = readText(abs);
    for (const needle of policy.requiredNeedles) reporter.check(text.toLowerCase().includes(needle.toLowerCase()), `${file}: expected ${policy.category} marker '${needle}'`);
  }
}
function validateFixtureOwnership(reporter: Reporter): void {
  const doc = readText(path.join(root, "docs/fixture-ownership.md"));
  const ownerScanFiles = ["evals/static", "evals/integration", "scripts"]
    .flatMap((entry) => walkFiles(path.join(root, entry)))
    .filter((file) => textRefExtensions.has(path.extname(file)))
    .sort();
  const fixtureDirs = fs.readdirSync(path.join(root, "evals/fixtures"))
    .filter((name) => fs.statSync(path.join(root, "evals/fixtures", name)).isDirectory())
    .map((name) => `evals/fixtures/${name}`)
    .sort();
  const expected = [...fixtureOwnerPolicies.keys()].sort();
  reporter.check(JSON.stringify(fixtureDirs) === JSON.stringify(expected), `evals/fixtures: fixture directory inventory changed; update fixtureOwnerPolicies and docs/fixture-ownership.md`);
  for (const [dir, policy] of fixtureOwnerPolicies) {
    reporter.check(fs.existsSync(path.join(root, dir)), `${dir}: fixture directory missing`);
    reporter.check(doc.includes(dir), `docs/fixture-ownership.md: missing fixture directory ${dir}`);
    reporter.check(doc.includes(policy.classification), `docs/fixture-ownership.md: missing fixture classification '${policy.classification}'`);
    for (const owner of policy.owners) {
      reporter.check(fs.existsSync(path.join(root, owner)), `${dir}: fixture owner missing: ${owner}`);
      reporter.check(doc.includes(owner), `docs/fixture-ownership.md: ${dir} missing owner ${owner}`);
    }
    const directRefs = ownerScanFiles
      .filter((file) => readText(file).includes(dir))
      .map((file) => rel(file))
      .filter((file) => !file.startsWith("evals/fixtures/"))
      .filter((file) => !fixtureOwnershipSelfAuditRefs.has(file))
      .sort();
    const missingOwners = directRefs.filter((file) => !policy.owners.includes(file));
    reporter.check(missingOwners.length === 0, `${dir}: direct fixture references missing from owner inventory: ${missingOwners.join(", ")}`);
  }
}
function validatePackageCommandSurface(reporter: Reporter): void {
  const pkg = tryLoadJson(path.join(root, "package.json"), reporter);
  if (!pkg || typeof pkg !== "object") return;
  const cli = readText(path.join(root, "src/cli.ts"));
  reporter.check(!cli.includes("pendingCommands"), "src/cli.ts: pending command migration scaffolding must not return; add real commands or remove stale registrations");
  const availableBlock = /const availableCommands = new Map[\s\S]*?\n\]\);/.exec(cli)?.[0] ?? "";
  const aliasesBlock = /const aliases = new Map[\s\S]*?\n\]\);/.exec(cli)?.[0] ?? "";
  reporter.check(Boolean(availableBlock), "src/cli.ts: availableCommands map not found");
  reporter.check(Boolean(aliasesBlock), "src/cli.ts: aliases map not found");
  const availableCommands = new Set([...availableBlock.matchAll(/\["([^"]+)",/g)].map((match) => match[1]));
  const aliases = new Map([...aliasesBlock.matchAll(/\["(flow-agents-[^"]+)",\s*"([^"]+)"\]/g)].map((match) => [match[1], match[2]]));

  const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts as Record<string, unknown> : {};
  for (const [name, value] of Object.entries(scripts)) {
    if (typeof value !== "string") continue;
    const command = /node build\/src\/cli\.js ([a-z0-9:-]+)/.exec(value)?.[1];
    if (command) reporter.check(availableCommands.has(command), `package.json scripts.${name}: command '${command}' is not registered in src/cli.ts`);
  }

  const bins = pkg.bin && typeof pkg.bin === "object" ? pkg.bin as Record<string, unknown> : {};
  for (const [name, value] of Object.entries(bins)) {
    if (typeof value !== "string") continue;
    if (value === "build/src/cli.js" && name !== "flow-agents") {
      reporter.check(aliases.has(name), `package.json bin '${name}' points at build/src/cli.js but has no src/cli.ts alias`);
      const target = aliases.get(name);
      if (target) reporter.check(availableCommands.has(target), `package.json bin '${name}' aliases missing command '${target}'`);
      continue;
    }
    if (value.startsWith("build/src/cli/")) {
      const source = value.replace(/^build\//, "").replace(/\.js$/, ".ts");
      reporter.check(fs.existsSync(path.join(root, source)), `package.json bin '${name}' points at missing TypeScript source ${source}`);
    }
  }
}
function isExcludedPythonPath(file: string): boolean {
  return path.relative(root, file).split(path.sep).some((part) => pythonInventoryExcludes.has(part));
}
function validateNoFirstPartyPythonFiles(reporter: Reporter): void {
  for (const file of walkFiles(root).filter((item) => item.endsWith(".py")).sort()) {
    if (!isExcludedPythonPath(file)) reporter.fail(`${rel(file)}: first-party Python source is not allowed; use TypeScript tooling`);
  }
}
function validateNoFirstPartyPythonCommands(reporter: Reporter): void {
  const commandRe = /(?<![A-Za-z0-9_./-])(?:python3?|uv run python)\b/;
  const firstPartyPythonCommandRe = /(?<![A-Za-z0-9_./-])(?:python3?|uv run python)\b[^\n]*(?:^|[\s"'])(?:\.\/)?(?:scripts|context\/scripts|evals|skills)\/[A-Za-z0-9_./-]+\.py\b/m;
  const files: string[] = [];
  for (const entry of pythonCommandScanRoots) {
    const abs = path.join(root, entry);
    if (!fs.existsSync(abs)) continue;
    if (fs.statSync(abs).isDirectory()) files.push(...walkFiles(abs));
    else files.push(abs);
  }
  for (const file of files.sort()) {
    const relative = rel(file);
    if (allowedPythonCommandFiles.some((pattern) => pattern.test(relative))) continue;
    if (!textRefExtensions.has(path.extname(file)) && relative !== "package.json") continue;
    if (isExcludedPythonPath(file)) continue;
    const text = readText(file);
    if (!commandRe.test(text)) continue;
    if (relative.startsWith("evals/") && !firstPartyPythonCommandRe.test(text)) continue;
    reporter.fail(`${relative}: direct first-party Python command reference is not allowed; use npm/flow-agents TypeScript commands`);
  }
}
export async function main(argv = process.argv.slice(2)): Promise<number> {
  const kitIndex = argv.indexOf("--kit");
  if (kitIndex >= 0) {
    const kitDir = argv[kitIndex + 1];
    if (!kitDir) { console.error("usage: validate-source-tree --kit DIR"); return 2; }
    const reporter = new Reporter();
    const localCli = flowCliPath;
    if (flowSchemaPath && fs.existsSync(flowSchemaPath) && fs.existsSync(localCli)) console.log(`info: validating kit Flow Definitions with Flow CLI at ${localCli}`);
    else console.log("warning: Flow validation surface unavailable; local kit check uses the minimal Flow Definition fallback");
    await validateKitRepository(path.resolve(kitDir), reporter);
    if (reporter.errors.length) { console.log("Flow Kit repository validation failed:"); for (const error of reporter.errors) console.log(` - ${error}`); return 1; }
    console.log("Flow Kit repository validation passed."); return 0;
  }
  const reporter = new Reporter();
  const manifest = tryLoadJson(manifestPath, reporter) ?? {};
  const agentNames = validateAgents(reporter);
  validateAgentCards(reporter, agentNames);
  validatePowers(reporter);
  validateManifest(reporter, manifest, agentNames);
  await validateKits(reporter);
  validateAgentPaths(reporter, manifest);
  validateLegacyRefs(reporter);
  validateMirrors(reporter);
  validateUsageFeedbackFiles(reporter);
  validatePublicScriptWrappers(reporter);
  validateHookInventory(reporter);
  validateAdrNumbers(reporter);
  validateFixtureOwnership(reporter);
  validatePackageCommandSurface(reporter);
  validateNoFirstPartyPythonFiles(reporter);
  validateNoFirstPartyPythonCommands(reporter);
  if (reporter.errors.length) { console.log("Source tree validation failed:"); for (const error of reporter.errors) console.log(` - ${error}`); return 1; }
  console.log("Source tree validation passed.");
  return 0;
}
// Use process.exitCode (not process.exit) to allow stdout to be flushed before exit.
// Resolve real paths to handle symlinks (e.g. /tmp -> /private/tmp on macOS) so the
// entry-point guard fires correctly when the module is loaded directly as a script.
const _selfRealPath = (() => { try { return fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return fileURLToPath(import.meta.url); } })();
const _argv1RealPath = (() => { try { return fs.realpathSync(process.argv[1]); } catch { return process.argv[1]; } })();
if (_selfRealPath === _argv1RealPath) { main().then((code) => { process.exitCode = code; }); }
