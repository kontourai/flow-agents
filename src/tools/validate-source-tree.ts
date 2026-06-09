#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadJson, readText, rel, root, walkFiles } from "./common.js";

class Reporter {
  errors: string[] = [];
  fail(message: string): void { this.errors.push(message); }
  check(condition: boolean, message: string): void { if (!condition) this.fail(message); }
}
const manifestPath = path.join(root, "packaging/manifest.json");
const packsPath = path.join(root, "packaging/packs.json");
const kitsCatalogPath = path.join(root, "kits/catalog.json");
const flowRoot = process.env.FLOW_CLI_ROOT ? path.resolve(process.env.FLOW_CLI_ROOT) : "";
const flowSchemaPath = flowRoot ? path.join(flowRoot, "schemas", "flow-definition.schema.json") : "";
const kitIdRe = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;
const kitAssetSections = new Set(["skills", "docs", "adapters", "evals", "assets"]);
const kitTopLevelKeys = new Set(["schema_version", "id", "name", "product_name", "description", "flows", ...kitAssetSections]);
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
    "// Supports FLOW_AGENTS_PACKS through the TypeScript bundle builder.",
    'import("../build/src/tools/build-universal-bundles.js").then(({ main }) => process.exit(main()));',
  ] }],
  ["scripts/build-docs-preview.js", { target: "../build/src/cli/docs-preview.js", significantLines: ['import("../build/src/cli/docs-preview.js").then(({ main }) => process.exit(main()));'] }],
  ["scripts/filter-installed-packs.js", { target: "../build/src/tools/filter-installed-packs.js", significantLines: ['import("../build/src/tools/filter-installed-packs.js").then(({ main }) => process.exit(main(process.argv.slice(2))));'] }],
  ["scripts/generate-context-map.js", { target: "../build/src/tools/generate-context-map.js", significantLines: ['import("../build/src/tools/generate-context-map.js").then(({ main }) => process.exit(main(process.argv.slice(2))));'] }],
  ["scripts/flow-kit.js", { target: "../build/src/cli/flow-kit.js", significantLines: ['import("../build/src/cli/flow-kit.js").then(({ main }) => process.exit(main()));'] }],
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
const requiredUsageFeedbackFiles = [
  "package.json", "tsconfig.json", "scripts/usage-feedback.js", "src/cli/usage-feedback.ts", "docs/agent-usage-feedback-loop.md",
  "scripts/hooks/stop-goal-fit.js", "scripts/promote-workflow-artifact.js", "evals/integration/test_goal_fit_hook.sh",
];
const pythonInventoryExcludes = new Set([".git", ".flow-agents", "node_modules", ".venv", "dist", "__pycache__", ".pytest_cache", ".cache", "build"]);
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
  for (const dir of manifest.optional_copy_dirs ?? []) if (!fs.existsSync(path.join(root, dir))) console.log(`warning: ${rel(manifestPath)} optional_copy_dirs entry absent: ${dir}`);
  for (const agent of manifest.codex?.excluded_agents ?? []) reporter.check(agentNames.has(agent), `${rel(manifestPath)}: codex excluded agent '${agent}' does not exist`);
}
function validatePacksManifest(reporter: Reporter, agentNames: Set<string>): void {
  const data = tryLoadJson(packsPath, reporter);
  if (!data || typeof data !== "object") return;
  reporter.check(data.schema_version === "1.0", `${rel(packsPath)}: schema_version must be 1.0`);
  reporter.check(Array.isArray(data.packs) && data.packs.length > 0, `${rel(packsPath)}: packs must be a non-empty list`);
  const skillNames = new Set(fs.readdirSync(path.join(root, "skills")).filter((name) => fs.existsSync(path.join(root, "skills", name, "SKILL.md"))));
  const powerNames = new Set(fs.readdirSync(path.join(root, "powers")).filter((name) => fs.existsSync(path.join(root, "powers", name, "POWER.md"))));
  const names = new Set<string>(); const defaults = new Set<string>(); const assigned = { skills: new Set<string>(), agents: new Set<string>(), powers: new Set<string>() };
  (Array.isArray(data.packs) ? data.packs : []).forEach((pack: any, index: number) => {
    const name = pack?.name;
    if (typeof name !== "string" || !/^[a-z][a-z0-9-]*$/.test(name)) { reporter.fail(`${rel(packsPath)}: packs[${index}].name must be a kebab-case string`); return; }
    if (names.has(name)) reporter.fail(`${rel(packsPath)}: duplicate pack name '${name}'`);
    names.add(name); if (pack.default === true) defaults.add(name);
    reporter.check(typeof pack.description === "string" && !!pack.description, `${rel(packsPath)}: pack '${name}' missing description`);
    for (const [field, available] of [["skills", skillNames], ["agents", agentNames], ["powers", powerNames]] as const) {
      const values = pack[field] ?? [];
      reporter.check(Array.isArray(values), `${rel(packsPath)}: pack '${name}' .${field} must be a list`);
      const seen = new Set<string>();
      for (const value of Array.isArray(values) ? values : []) {
        if (typeof value !== "string") { reporter.fail(`${rel(packsPath)}: pack '${name}' .${field} entry is not a string`); continue; }
        if (seen.has(value)) reporter.fail(`${rel(packsPath)}: pack '${name}' has duplicate ${field} entry '${value}'`);
        seen.add(value); assigned[field].add(value);
        reporter.check(available.has(value), `${rel(packsPath)}: pack '${name}' references missing ${field.slice(0, -1)} '${value}'`);
      }
    }
  });
  reporter.check(defaults.has("core"), `${rel(packsPath)}: core pack must be default`);
  const missingSkills = [...skillNames].filter((name) => !assigned.skills.has(name)).sort();
  reporter.check(missingSkills.length === 0, `${rel(packsPath)}: skills missing from all packs: ${missingSkills.join(", ")}`);
}
function safeLocalPath(baseDir: string, pathText: unknown, label: string, reporter: Reporter): string | undefined {
  if (typeof pathText !== "string" || !pathText) { reporter.fail(`${label} must be a non-empty relative path`); return undefined; }
  if (path.isAbsolute(pathText)) { reporter.fail(`${label} must be relative; absolute paths are not allowed`); return undefined; }
  if (pathText.split(/[\\/]/).includes("..")) { reporter.fail(`${label} must stay inside the kit directory; '..' path traversal is not allowed`); return undefined; }
  return path.join(baseDir, pathText);
}
function validateFlowDefinitionShape(file: string, data: any, reporter: Reporter): void {
  const localCli = flowRoot ? path.join(flowRoot, "src/cli.js") : "";
  if (fs.existsSync(localCli)) {
    const result = spawnSync("node", [localCli, "validate-definition", file, "--json"], { encoding: "utf8" });
    if (result.status !== 0) reporter.fail(`${rel(file)}: Flow validation failed: ${(result.stderr || result.stdout).trim()}`);
    return;
  }
  if (!data || typeof data !== "object") { reporter.fail(`${rel(file)}: Flow Definition must be an object`); return; }
  for (const key of ["id", "version", "steps", "gates"]) reporter.check(key in data, `${rel(file)}: missing .${key}`);
}
function validateKitRepository(kitDir: string, reporter: Reporter): void {
  if (!fs.existsSync(kitDir) || !fs.statSync(kitDir).isDirectory()) { reporter.fail(`${rel(kitDir)}: kit directory does not exist`); return; }
  const kitJson = path.join(kitDir, "kit.json");
  reporter.check(fs.existsSync(kitJson), `${rel(kitDir)}: missing kit.json at repository root`);
  if (!fs.existsSync(kitJson)) return;
  const data = tryLoadJson(kitJson, reporter);
  if (!data || typeof data !== "object") return;
  const unknownKeys = Object.keys(data).filter((key) => !kitTopLevelKeys.has(key)).sort();
  if (unknownKeys.length) reporter.fail(`${rel(kitJson)}: unsupported fields ${unknownKeys.join(", ")}; remove them or add them to the Flow Kit Repository contract`);
  reporter.check(data.schema_version === "1.0", `${rel(kitJson)}: .schema_version must be "1.0"`);
  reporter.check(typeof data.id === "string" && kitIdRe.test(data.id), `${rel(kitJson)}: .id must be a stable kebab-case string`);
  reporter.check(typeof data.name === "string" && !!data.name.trim(), `${rel(kitJson)}: .name must be a non-empty string`);
  for (const section of [...kitAssetSections].sort()) if (section in data) {
    if (!Array.isArray(data[section])) { reporter.fail(`${rel(kitJson)}: .${section} must be a list of relative asset paths or objects with path`); continue; }
    const seenPaths = new Set<string>(); const seenIds = new Set<string>();
    data[section].forEach((entry: any, index: number) => {
      const pathValue = typeof entry === "string" ? entry : entry?.path;
      const assetId = typeof entry === "object" ? entry.id : undefined;
      if (typeof entry === "object") {
        const unknown = Object.keys(entry).filter((key) => !["id", "path", "description"].includes(key)).sort();
        if (unknown.length) reporter.fail(`${rel(kitJson)}: ${section}[${index}] has unsupported fields ${unknown.join(", ")}; use id, path, or description`);
      }
      if (assetId !== undefined && (typeof assetId !== "string" || !kitIdRe.test(assetId))) reporter.fail(`${rel(kitJson)}: ${section}[${index}].id must be a stable dot/kebab-case string`);
      const assetPath = safeLocalPath(kitDir, pathValue, `${rel(kitJson)}: ${section}[${index}].path`, reporter);
      if (!assetPath) return;
      if (seenPaths.has(String(pathValue))) reporter.fail(`${rel(kitJson)}: ${section}[${index}].path duplicates '${pathValue}'; declare each asset once`);
      seenPaths.add(String(pathValue));
      if (typeof assetId === "string") { if (seenIds.has(assetId)) reporter.fail(`${rel(kitJson)}: ${section}[${index}].id duplicates '${assetId}'; use a unique asset id`); seenIds.add(assetId); }
      reporter.check(fs.existsSync(assetPath), `${rel(kitJson)}: ${section}[${index}].path points at missing asset: ${pathValue}; add the file or remove the entry`);
    });
  }
  if (!Array.isArray(data.flows) || !data.flows.length) { reporter.fail(`${rel(kitJson)}: .flows must be a non-empty list; add at least one Flow Definition entry`); return; }
  const seenIds = new Set<string>(); const seenPaths = new Set<string>();
  data.flows.forEach((flow: any, index: number) => {
    if (!flow || typeof flow !== "object") { reporter.fail(`${rel(kitJson)}: flows[${index}] must be an object with id and path`); return; }
    if (typeof flow.id !== "string" || !kitIdRe.test(flow.id)) reporter.fail(`${rel(kitJson)}: flows[${index}].id must be a stable dot/kebab-case string`);
    else if (seenIds.has(flow.id)) reporter.fail(`${rel(kitJson)}: flows[${index}].id duplicates '${flow.id}'; use a unique Flow id`);
    else seenIds.add(flow.id);
    const flowPath = safeLocalPath(kitDir, flow.path, `${rel(kitJson)}: flows[${index}].path`, reporter);
    if (!flowPath) return;
    if (seenPaths.has(String(flow.path))) { reporter.fail(`${rel(kitJson)}: flows[${index}].path duplicates '${flow.path}'; declare each Flow Definition once`); return; }
    seenPaths.add(String(flow.path));
    reporter.check(fs.existsSync(flowPath), `${rel(kitJson)}: flows[${index}].path points at missing Flow Definition: ${flow.path}; add the file or fix the path`);
    if (fs.existsSync(flowPath)) validateFlowDefinitionShape(flowPath, tryLoadJson(flowPath, reporter), reporter);
  });
}
function validateKits(reporter: Reporter): void {
  reporter.check(fs.existsSync(path.join(root, "kits")), "kits directory missing");
  const catalog = tryLoadJson(kitsCatalogPath, reporter);
  const kits = catalog?.kits;
  reporter.check(Array.isArray(kits) && kits.length > 0, `${rel(kitsCatalogPath)}: .kits must be a non-empty list`);
  if (!Array.isArray(kits)) return;
  const localCli = flowRoot ? path.join(flowRoot, "src/cli.js") : "";
  if (flowSchemaPath && fs.existsSync(flowSchemaPath)) console.log(fs.existsSync(localCli) ? `info: validating kit Flow Definitions with Flow CLI at ${localCli}` : `warning: Flow validator unavailable; source-tree check only verifies Flow Definition top-level shape`);
  else console.log("warning: Flow schema not configured; source-tree check only verifies Flow Definition top-level shape. Set FLOW_CLI_ROOT to enable Flow CLI validation.");
  kits.forEach((entry: any, index: number) => {
    const kitText = typeof entry === "string" ? entry : ["path", "directory", "dir", "id", "name"].map((key) => entry?.[key]).find((value) => typeof value === "string" && value);
    if (!kitText) { reporter.fail(`${rel(kitsCatalogPath)}: kits[${index}] missing path, directory, dir, id, or name`); return; }
    const kitRef = String(kitText).startsWith("kits/") ? path.join(root, kitText) : path.join(root, "kits", kitText);
    const kitDir = path.basename(kitRef) === "kit.json" ? path.dirname(kitRef) : kitRef;
    reporter.check(fs.existsSync(kitDir) && fs.statSync(kitDir).isDirectory(), `${rel(kitsCatalogPath)}: kits[${index}] points at missing kit folder: ${kitText}`);
    validateKitRepository(kitDir, reporter);
  });
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
  for (const file of walkFiles(path.join(root, "evals")).sort()) {
    if (!textRefExtensions.has(path.extname(file))) continue;
    const parts = path.relative(path.join(root, "evals"), file).split(path.sep);
    if (parts.includes("results") || parts.some((part) => ignoredRefDirs.has(part))) continue;
    const text = readText(file);
    for (const match of text.matchAll(legacyRefRe)) {
      const ref = match[0].replace(/[.,)'"\]]+$/, "");
      if (/[{}$]/.test(ref)) continue;
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
export function main(argv = process.argv.slice(2)): number {
  const kitIndex = argv.indexOf("--kit");
  if (kitIndex >= 0) {
    const kitDir = argv[kitIndex + 1];
    if (!kitDir) { console.error("usage: validate-source-tree --kit DIR"); return 2; }
    const reporter = new Reporter();
    const localCli = flowRoot ? path.join(flowRoot, "src/cli.js") : "";
    if (flowSchemaPath && fs.existsSync(flowSchemaPath) && fs.existsSync(localCli)) console.log(`info: validating kit Flow Definitions with Flow CLI at ${localCli}`);
    else console.log("warning: Flow validation surface unavailable; local kit check uses the minimal Flow Definition fallback");
    validateKitRepository(path.resolve(kitDir), reporter);
    if (reporter.errors.length) { console.log("Flow Kit repository validation failed:"); for (const error of reporter.errors) console.log(` - ${error}`); return 1; }
    console.log("Flow Kit repository validation passed."); return 0;
  }
  const reporter = new Reporter();
  const manifest = tryLoadJson(manifestPath, reporter) ?? {};
  const agentNames = validateAgents(reporter);
  validateAgentCards(reporter, agentNames);
  validatePowers(reporter);
  validateManifest(reporter, manifest, agentNames);
  validatePacksManifest(reporter, agentNames);
  validateKits(reporter);
  validateAgentPaths(reporter, manifest);
  validateLegacyRefs(reporter);
  validateMirrors(reporter);
  validateUsageFeedbackFiles(reporter);
  validatePublicScriptWrappers(reporter);
  validateNoFirstPartyPythonFiles(reporter);
  validateNoFirstPartyPythonCommands(reporter);
  if (reporter.errors.length) { console.log("Source tree validation failed:"); for (const error of reporter.errors) console.log(` - ${error}`); return 1; }
  console.log("Source tree validation passed.");
  return 0;
}
if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
