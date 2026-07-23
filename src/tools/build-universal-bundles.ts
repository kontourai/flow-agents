#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildSync } from "esbuild";
import { loadJson, readText, root, walkFiles, writeText } from "./common.js";
import { CODEX_REASONING_EFFORTS, codexAgentRoutingErrors } from "./codex-agent-routing.js";
import { DURABLE_FLOW_AGENTS_DIR, FLOW_AGENTS_RUNTIME_DIR } from "../lib/local-artifact-root.js";

type Agent = Record<string, unknown> & { name: string; prompt: string };
const dist = process.env.FLOW_AGENTS_DIST_DIR ? path.resolve(process.env.FLOW_AGENTS_DIST_DIR) : path.join(root, "dist");
const manifest = loadJson<Record<string, any>>(path.join(root, "packaging/manifest.json"));
const pkgVersion: string = (loadJson<Record<string, unknown>>(path.join(root, "package.json")) as Record<string, string>)["version"] ?? "0.0.0";
const runtimeTaskDir = FLOW_AGENTS_RUNTIME_DIR;
const durableInstallRecordRel = `${DURABLE_FLOW_AGENTS_DIR}/install.json`;
const textExtensions = new Set([".css", ".html", ".js", ".json", ".md", ".sh", ".toml", ".txt", ".yaml", ".yml", ".ts"]);
const dropDiagnostics: string[] = [];
// Set by collectAllSkills() when two kits (or a kit and the top-level skills/
// dir) declare the same skill directory name. Reported via the same
// console.error + process.exitCode diagnostic idiom as the rest of this file
// (see main()) instead of an uncaught thrown Error / stack trace.
let skillCollisionDiagnostic: string | null = null;
const printDiagnostics = !["0", "false", "no"].includes(String(process.env.FLOW_AGENTS_EXPORT_DIAGNOSTICS ?? "1").toLowerCase());

/**
 * Collect all skill source paths across skills/ and kit-owned skills.
 * Returns an array of {name, src} pairs where name is the install name
 * (same as the directory name) and src is the absolute SKILL.md path.
 * Kit-owned skills are discovered by reading kit.json `skills` arrays;
 * each entry's `path` is resolved relative to the kit directory.
 */
function collectAllSkills(): Array<{ name: string; src: string }> {
  const results: Array<{ name: string; src: string }> = [];
  const seen = new Map<string, string>(); // skill name -> source description of first declaration
  const collisions: string[] = [];

  // Compiled host bundles ship skills flat at .claude/skills/<name>/SKILL.md etc., so
  // the install name (skill directory name) must be globally unique across skills/ and
  // every kit. A duplicate is a build-FAILING collision, never a silent drop — the
  // previous Set-based dedupe silently kept only the first and discarded the rest.
  const recordSkill = (name: string, src: string, source: string): void => {
    const prior = seen.get(name);
    if (prior !== undefined) {
      collisions.push(`  - '${name}' is declared by both ${prior} and ${source}`);
      return;
    }
    seen.set(name, source);
    results.push({ name, src });
  };

  // 1. Top-level skills/ directory (tools pending reclassification).
  const skillsDir = path.join(root, "skills");
  if (fs.existsSync(skillsDir)) {
    for (const skill of fs.readdirSync(skillsDir).sort()) {
      const skillPath = path.join(skillsDir, skill, "SKILL.md");
      if (fs.existsSync(skillPath)) recordSkill(skill, skillPath, "skills/");
    }
  }

  // 2. Kit-owned skills declared in kits/<kit>/kit.json `skills` arrays.
  const kitsDir = path.join(root, "kits");
  if (fs.existsSync(kitsDir)) {
    for (const kitName of fs.readdirSync(kitsDir).sort()) {
      const kitJson = path.join(kitsDir, kitName, "kit.json");
      if (!fs.existsSync(kitJson)) continue;
      let kitManifest: Record<string, unknown>;
      try { kitManifest = loadJson<Record<string, unknown>>(kitJson); } catch { continue; }
      const skills = Array.isArray(kitManifest["skills"]) ? kitManifest["skills"] as unknown[] : [];
      for (const entry of skills) {
        if (typeof entry !== "object" || entry === null) continue;
        const skillEntry = entry as Record<string, unknown>;
        const relPath = typeof skillEntry["path"] === "string" ? skillEntry["path"] : null;
        if (!relPath) continue;
        // Derive install name from the directory containing SKILL.md (one level up).
        const absPath = path.resolve(path.join(kitsDir, kitName), relPath);
        const skillName = path.basename(path.dirname(absPath));
        if (fs.existsSync(absPath)) recordSkill(skillName, absPath, `kits/${kitName}`);
      }
    }
  }

  if (collisions.length) {
    skillCollisionDiagnostic =
      "flow-agents: skill name collision — skill directory names must be unique across " +
      "skills/ and all kits/*/kit.json:\n" +
      collisions.join("\n") +
      "\nRename one of the colliding skill directories so every compiled bundle skill has a unique install name.";
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

function resetDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function sourceRootPatterns(): RegExp[] {
  return manifest.source_root_aliases.map((alias: string) => new RegExp(alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"));
}

function applySubstitutions(text: string, substitutions: Array<{ from: string; to: string }>): string {
  let result = text;
  for (const item of substitutions ?? []) result = result.split(item.from).join(item.to);
  return result;
}

function sanitizeText(text: string, target: string, rootReplacement: string, proseSubstitutions = true): string {
  let result = text;
  for (const pattern of sourceRootPatterns()) result = result.replace(pattern, rootReplacement);
  if (target === "claude-code" || target === "codex") result = applySubstitutions(result, manifest.target_substitutions.common);
  if (!proseSubstitutions) return result;
  if (target === "claude-code") result = applySubstitutions(result, manifest.target_substitutions.claude_code);
  if (target === "codex") result = applySubstitutions(result, manifest.target_substitutions.codex);
  return result;
}

function isCodeAsset(src: string, relPath: string): boolean {
  return path.basename(src) === "scripts" || relPath.split(path.sep).includes("scripts");
}

function copyTree(src: string, dest: string, target: string, rootReplacement: string): void {
  if (!fs.existsSync(src)) return;
  for (const file of walkFiles(src)) {
    const relPath = path.relative(src, file);
    if (path.basename(src) === "evals" && relPath.split(path.sep)[0] === "results") continue;
    const out = path.join(dest, relPath);
    if (textExtensions.has(path.extname(file).toLowerCase())) {
      writeText(out, sanitizeText(readText(file), target, rootReplacement, !isCodeAsset(src, relPath)));
    } else {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.copyFileSync(file, out);
    }
  }
}

const skillResourcePattern = /(?:^|[`("'\s])(context\/contracts\/[A-Za-z0-9._/-]+\.md)(?=$|[`),"'\s])/gm;

/** Export a skill as a self-contained package. Shared instruction resources
 * retain the relative paths used by SKILL.md so runtime resolution is local. */
function exportSkillPackage(src: string, dest: string, target: string): void {
  const sourceDir = path.dirname(src);
  copyTree(sourceDir, dest, target, "<bundle-root>");
  const skillText = readText(src);
  const resources = new Set<string>();
  for (const match of skillText.matchAll(skillResourcePattern)) resources.add(match[1]);
  for (const rel of [...resources].sort()) {
    if (path.isAbsolute(rel) || rel.split("/").includes("..")) {
      throw new Error(`skill '${path.basename(sourceDir)}': unsafe local resource '${rel}'`);
    }
    const source = path.resolve(root, rel);
    const output = path.resolve(dest, rel);
    if (!source.startsWith(`${path.resolve(root)}${path.sep}`) || !output.startsWith(`${path.resolve(dest)}${path.sep}`)) {
      throw new Error(`skill '${path.basename(sourceDir)}': local resource escapes package '${rel}'`);
    }
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
      throw new Error(`skill '${path.basename(sourceDir)}': missing local resource '${rel}'`);
    }
    if (fs.existsSync(output)) {
      const existing = fs.readFileSync(output);
      const incoming = fs.readFileSync(source);
      if (!existing.equals(incoming)) throw new Error(`skill '${path.basename(sourceDir)}': resource collision '${rel}'`);
      continue;
    }
    writeText(output, sanitizeText(readText(source), target, "<bundle-root>"));
  }
}

function validateExportedSkillPackages(skillsRoot: string): void {
  if (!fs.existsSync(skillsRoot)) return;
  for (const skillName of fs.readdirSync(skillsRoot).sort()) {
    const skillDir = path.join(skillsRoot, skillName);
    const skillFile = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(skillFile)) continue;
    for (const match of readText(skillFile).matchAll(skillResourcePattern)) {
      const rel = match[1];
      const resolved = path.resolve(skillDir, rel);
      if (!resolved.startsWith(`${path.resolve(skillDir)}${path.sep}`) || !fs.existsSync(resolved)) {
        throw new Error(`skill '${skillName}': unresolved exported resource '${rel}'`);
      }
    }
  }
}

function resolveSourcePath(pathText: string): string {
  let normalized = pathText;
  for (const alias of manifest.source_root_aliases) normalized = normalized.split(alias).join(root);
  normalized = normalized.replace(/^~/, process.env.HOME ?? "");
  return path.isAbsolute(normalized) ? normalized : path.join(root, normalized);
}

function candidatePaths(value: string): string[] {
  return value.split(/\s+/).flatMap((raw) => {
    const part = raw.replace(/^["']|["']$/g, "");
    if (part.includes("=")) {
      const maybePath = part.split("=", 2)[1];
      return maybePath.startsWith("/") ? [maybePath] : [];
    }
    return part.startsWith("/") ? [part] : [];
  });
}

function portableAbsolutePath(value: string): boolean {
  const candidate = resolveSourcePath(value);
  if (manifest.source_root_aliases.some((alias: string) => value.startsWith(alias))) return fs.existsSync(candidate);
  return fs.existsSync(candidate) && candidate.startsWith(root);
}

function sanitizeAgentJson(spec: Agent): Agent {
  const cleaned = JSON.parse(JSON.stringify(spec)) as Agent;
  const agentName = String(cleaned.name ?? "unknown");
  const resources = Array.isArray(cleaned.resources) ? cleaned.resources : [];
  cleaned.resources = resources.filter((resource: any) => {
    const source = typeof resource === "object" ? resource.source : resource;
    if (typeof source !== "string" || !source.startsWith("file://") || source.includes("*")) return true;
    const keep = fs.existsSync(resolveSourcePath(source.slice("file://".length)));
    if (!keep) dropDiagnostics.push(`${agentName}: dropped missing resource ${source}`);
    return keep;
  });
  if (cleaned.hooks && typeof cleaned.hooks === "object") {
    const hooks: Record<string, any[]> = {};
    for (const [hookName, entries] of Object.entries(cleaned.hooks as Record<string, any[]>)) {
      const kept = (Array.isArray(entries) ? entries : []).filter((entry) => candidatePaths(String(entry.command ?? "")).every(portableAbsolutePath));
      if (kept.length) hooks[hookName] = kept;
      else if (Array.isArray(entries) && entries.length) dropDiagnostics.push(`${agentName}: no portable entries remain for hook ${hookName}`);
    }
    cleaned.hooks = hooks;
  }
  return cleaned;
}

function modelPrefix(value: string): string {
  if (value.startsWith("claude-opus")) return "claude-opus";
  if (value.startsWith("claude-sonnet")) return "claude-sonnet";
  return value;
}
function mapped(mapName: string, value: unknown): string {
  const map = manifest[mapName];
  return map[modelPrefix(String(value ?? ""))] ?? map.default;
}
function codexAgentOverride(spec: Agent): Record<string, unknown> | undefined {
  const override = manifest.codex_agent_map?.[spec.name];
  if (override === undefined) return undefined;
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    throw new Error(`packaging/manifest.json: codex_agent_map.${spec.name} must be an object`);
  }
  const keys = Object.keys(override).sort();
  if (keys.join(",") !== "model,reasoning_effort") {
    throw new Error(`packaging/manifest.json: codex_agent_map.${spec.name} must contain exactly model and reasoning_effort`);
  }
  return override;
}
function validateCodexModel(model: string, context: string): string {
  const allowed = new Set(manifest.codex?.allowed_agent_models ?? []);
  if (!allowed.has(model)) throw new Error(`packaging/manifest.json: ${context} uses unsupported Codex agent model '${model}'`);
  return model;
}
function resolveCodexModel(spec: Agent): string {
  const override = codexAgentOverride(spec)?.model;
  if (typeof override === "string" && override) return validateCodexModel(override, `codex_agent_map.${spec.name}.model`);
  const fallback = ["tool-agent-delegate", "tool-agent-handoff"].includes(spec.name) ? "gpt-5.4-mini" : mapped("codex_model_map", spec.model);
  return validateCodexModel(fallback, `resolved model for ${spec.name}`);
}
function resolveCodexReasoningEffort(spec: Agent): string {
  const override = codexAgentOverride(spec)?.reasoning_effort;
  const effort = typeof override === "string" && override ? override : mapped("codex_reasoning_map", spec.model);
  if (!CODEX_REASONING_EFFORTS.has(effort)) {
    throw new Error(`packaging/manifest.json: resolved reasoning effort for ${spec.name} is invalid: '${effort}'`);
  }
  return effort;
}
function normalizeCodexText(text: string): string {
  const replacements: Record<string, string> = { "—": "-", "–": "-", "→": "->", "←": "<-", "’": "'", "“": '"', "”": '"', "⚡": "[quick]", "🖥️": "[interactive]" };
  let normalized = text;
  for (const [from, to] of Object.entries(replacements)) normalized = normalized.split(from).join(to);
  return normalized.normalize("NFKD").replace(/[^\x00-\x7F]/g, "");
}
function appendExportNote(body: string, note: string): string {
  return `${body.trimEnd()}\n\n## Export Notes\n\n${note}\n`;
}
function generatedAgentsSummary(agents: Agent[]): string {
  return agents.slice().sort((a, b) => a.name.localeCompare(b.name)).map((spec) => `- \`${spec.name}\` — ${String(spec.description ?? "").trim()}`).join("\n");
}
type BundleCapability = {
  label: string;
  installHint: string;
  instructionPath?: "AGENTS.md" | "CLAUDE.md";
  taskDir: string;
};

const BUNDLE_CAPABILITIES = {
  "base": { label: "Base", installHint: "bash install.sh /path/to/workspace", instructionPath: "AGENTS.md", taskDir: runtimeTaskDir },
  "kiro": { label: "Kiro", installHint: "bash install.sh $HOME/.flow-agents", instructionPath: "AGENTS.md", taskDir: runtimeTaskDir },
  "claude-code": { label: "Claude Code", installHint: "bash install.sh /path/to/workspace", instructionPath: "CLAUDE.md", taskDir: manifest.claude_code.task_dir },
  "codex": { label: "Codex", installHint: "bash install.sh /path/to/workspace", taskDir: manifest.codex.task_dir },
  "opencode": { label: "opencode", installHint: "bash install.sh /path/to/workspace", instructionPath: "AGENTS.md", taskDir: manifest.opencode.task_dir },
  "pi": { label: "pi", installHint: "bash install.sh /path/to/workspace", instructionPath: "AGENTS.md", taskDir: manifest.pi.task_dir },
} satisfies Record<string, BundleCapability>;

function renderOperationalInstructions(capability: BundleCapability): string {
  return `# Flow Agents\n\nUse the installed Flow Agents skills and runtime integrations for delivery work. Keep cross-session task artifacts under \`${capability.taskDir}\`.\n`;
}
const CODEX_LIVE_HOOKS_README = `\n## Running with hooks active (live)\n\n\`install.sh\` lays the bundle into a workspace, but a live Codex session needs a \`CODEX_HOME\` that has both the bundle's hooks/scripts AND your real credentials. Use the dedicated installer, which defaults to \`CODEX_HOME\` when set and otherwise \`~/.codex\`, flattens the config to the home root, and copies your auth from \`~/.codex\` when installing elsewhere:\n\n\`\`\`bash\nbash scripts/install-codex-home.sh\ncodex exec --dangerously-bypass-hook-trust -C /path/to/project \"<prompt>\"\n\`\`\`\n\nPass a positional destination to install into an explicit alternate Codex home.\n\nThe goal-fit Stop hook then enforces by default (\`FLOW_AGENTS_GOAL_FIT_MODE=block\`); set it to \`warn\` or \`off\` to override.\n`;
function exportTargetReadme(label: string, installHint: string, extra = ""): string {
  return `# ${label} Bundle\n\nGenerated from the canonical source in this repository.\n\n## Install\n\n\`\`\`bash\n${installHint}\n\`\`\`\n\nThe install ships the full standalone base (skills, agents, powers) plus the\nFlow Kits. Kit depth is activated through the Kit Catalog, not at install time.\n\n## Contents\n\n- Harness-specific agents\n- Shared skills\n- Shared context, powers, prompts, scripts, and evals\n${extra}`;
}

function renderBundleReadme(capability: BundleCapability, agents: Agent[], extra = ""): string {
  const inventory = `\n## Exported agents\n\nThe following agent definitions were generated from the canonical agent specifications in this repository. This inventory is documentation, not agent instructions.\n\n${generatedAgentsSummary(agents)}\n`;
  return exportTargetReadme(capability.label, capability.installHint, `${inventory}${extra}`);
}

function writeBundlePolicy(bundle: string, capability: BundleCapability, agents: Agent[], readmeExtra = ""): void {
  writeText(path.join(bundle, "README.md"), renderBundleReadme(capability, agents, readmeExtra));
  if (capability.instructionPath) writeText(path.join(bundle, capability.instructionPath), renderOperationalInstructions(capability));
}

function mapClaudeTools(allowedTools: unknown): string[] {
  const ordered: string[] = [];
  for (const tool of Array.isArray(allowedTools) ? allowedTools : []) {
    const mappedTool = manifest.tool_name_map[String(tool)];
    if (mappedTool && !ordered.includes(mappedTool)) ordered.push(mappedTool);
  }
  return ordered.length ? ordered : ["Read", "Bash"];
}
function exportClaudeAgent(spec: Agent): string {
  const prompt = appendExportNote(sanitizeText(spec.prompt, "claude-code", "<bundle-root>"), "Kiro hook wiring and JSON-only runtime fields were omitted. If this agent mentions Kiro-specific scheduler or hook behavior, treat that as optional operational guidance rather than a hard dependency.");
  return `---\nname: ${spec.name}\ndescription: ${String(spec.description ?? "").trim()}\ntools: ${JSON.stringify(mapClaudeTools(spec.allowedTools))}\nmodel: ${mapped("claude_model_map", spec.model)}\n---\n\n${prompt}`;
}
function codexNicknames(agentName: string): string[] {
  const base = agentName.replace(/^tool-/, "");
  return [...new Set([agentName, base, base.replace(/[-_]/g, " ")].map((item) => item.trim()).filter(Boolean))];
}
function exportCodexAgent(spec: Agent): string {
  const prompt = appendExportNote(normalizeCodexText(sanitizeText(spec.prompt, "codex", "<bundle-root>")), "Exported from a Kiro agent spec. Hooks, resource auto-loading, and tool allowlists were converted into prompt guidance only. Any explicit Kiro scheduler commands are preserved as optional shell workflows.");
  const description = normalizeCodexText(String(spec.description ?? "")).replace(/"/g, "'");
  return `# exported from agents/${spec.name}.json\nname = "${spec.name}"\nnickname_candidates = ${JSON.stringify(codexNicknames(spec.name))}\ndescription = "${description}"\nmodel = "${resolveCodexModel(spec)}"\nmodel_reasoning_effort = "${resolveCodexReasoningEffort(spec)}"\ndeveloper_instructions = ${JSON.stringify(prompt)}\n`;
}
function tomlValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map((item) => tomlValue(item)).join(", ")}]`;
  return JSON.stringify(value);
}
function exportCodexConfig(): string {
  const lines = ["# Generated from packaging/manifest.json. Edit the manifest, not this file.", ""];
  const settings = manifest.codex.settings ?? {};
  for (const [key, value] of Object.entries(settings)) lines.push(`${key} = ${tomlValue(value)}`);
  if (Object.keys(settings).length) lines.push("");
  if (manifest.codex.tui) {
    lines.push("[tui]");
    for (const [key, value] of Object.entries(manifest.codex.tui)) lines.push(`${key} = ${tomlValue(value)}`);
    lines.push("");
  }
  lines.push("[features]");
  for (const [key, value] of Object.entries(manifest.codex.features ?? {})) lines.push(`${key} = ${tomlValue(value)}`);
  lines.push("");
  for (const [providerName, providerRaw] of Object.entries(manifest.codex.model_providers ?? {})) {
    const provider = providerRaw as Record<string, unknown>;
    const scalars = Object.entries(provider).filter(([, value]) => typeof value !== "object" || value === null);
    if (scalars.length) {
      lines.push(`[model_providers.${providerName}]`);
      for (const [key, value] of scalars) lines.push(`${key} = ${tomlValue(value)}`);
      lines.push("");
    }
    for (const [childName, childRaw] of Object.entries(provider).filter(([, value]) => typeof value === "object" && value !== null)) {
      lines.push(`[model_providers.${providerName}.${childName}]`);
      for (const [key, value] of Object.entries(childRaw as Record<string, unknown>)) lines.push(`${key} = ${tomlValue(value)}`);
      lines.push("");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
function exportCodexProfileConfig(profile: Record<string, unknown>, settings: Record<string, unknown>): string {
  const lines = ["# Generated from packaging/manifest.json. Edit the manifest, not this file.", ""];
  if ("approvals_reviewer" in settings && !("approvals_reviewer" in profile)) lines.push(`approvals_reviewer = ${tomlValue(settings.approvals_reviewer)}`);
  for (const [key, value] of Object.entries(profile)) if (typeof value !== "object" || value === null) lines.push(`${key} = ${tomlValue(value)}`);
  return `${lines.join("\n").trimEnd()}\n`;
}
function shellHook(command: string, timeout = 10, statusMessage?: string): Record<string, unknown> {
  const hook: Record<string, unknown> = { type: "command", command, timeout };
  if (statusMessage) hook.statusMessage = statusMessage;
  return hook;
}
function claudeTelemetry(event: string): string {
  return `bash -lc 'root="\${CLAUDE_PROJECT_DIR:-$(pwd)}"; node "$root/scripts/hooks/claude-telemetry-hook.js" ${event} dev'`;
}
function claudePolicy(event: string, script: string, envPrefix = ""): string {
  return `bash -lc 'root="\${CLAUDE_PROJECT_DIR:-$(pwd)}"; ${envPrefix}node "$root/scripts/hooks/claude-hook-adapter.js" ${event} ${script.replace(/\.js$/, "")} ${script} default'`;
}
function codexRoot(scriptPath: string): string {
  return `root="\${CODEX_HOME:-}"; if [ -z "$root" ] || [ ! -f "$root/${scriptPath}" ]; then root=$(git rev-parse --show-toplevel 2>/dev/null || pwd); fi; if [ ! -f "$root/${scriptPath}" ] && [ -f "$HOME/.codex/${scriptPath}" ]; then root="$HOME/.codex"; fi; if [ ! -f "$root/${scriptPath}" ]; then echo "flow-agents: hook script not found at $root/${scriptPath} (checked \\$CODEX_HOME, git toplevel/cwd, and \\$HOME/.codex) - skipping hook" >&2; exit 0; fi`;
}
function codexTelemetry(event: string): string {
  if (event === "PermissionRequest") return `bash -lc '${codexRoot("scripts/telemetry/telemetry.sh")}; bash "$root/scripts/telemetry/telemetry.sh" permissionRequest dev'`;
  return `bash -lc '${codexRoot("scripts/hooks/codex-telemetry-hook.js")}; node "$root/scripts/hooks/codex-telemetry-hook.js" ${event} dev'`;
}
function codexPolicy(script: string, envPrefix = ""): string {
  return `bash -lc '${codexRoot("scripts/hooks/codex-hook-adapter.js")}; ${envPrefix}node "$root/scripts/hooks/codex-hook-adapter.js" ${script.replace(/\.js$/, "")} ${script} default'`;
}
// Shipped L2 runtimes enforce goal fit by default (mode=block), while remaining
// operator-overridable via the FLOW_AGENTS_GOAL_FIT_MODE environment variable.
// The canonical engine default stays warn so the conformance contract is honest.
const GOAL_FIT_MODE_PREFIX = 'FLOW_AGENTS_GOAL_FIT_MODE="${FLOW_AGENTS_GOAL_FIT_MODE:-block}" ';
function exportClaudeSettings(): string {
  const hooks: Record<string, Array<Record<string, unknown>>> = {};
  for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop", "SessionEnd"]) {
    hooks[event] = [{ hooks: [shellHook(claudeTelemetry(event), 10, "Recording Flow Agents telemetry")] }];
  }
  hooks.Stop.push({ hooks: [shellHook(claudePolicy("Stop", "stop-goal-fit.js", GOAL_FIT_MODE_PREFIX), 30, "Running Flow Agents hook policy")] });
  hooks.SessionStart.push({ hooks: [shellHook(claudePolicy("SessionStart", "workflow-steering.js"), 30, "Running Flow Agents hook policy")] });
  hooks.UserPromptSubmit.push({ hooks: [shellHook(claudePolicy("UserPromptSubmit", "workflow-steering.js"), 30, "Running Flow Agents hook policy")] });
  hooks.PostToolUse.push({ hooks: [shellHook(claudePolicy("PostToolUse", "quality-gate.js"), 30, "Running Flow Agents hook policy")] });
  hooks.PostToolUse.push({ hooks: [shellHook(claudePolicy("PostToolUse", "evidence-capture.js"), 30, "Capturing Flow Agents command evidence")] });
  hooks.PreToolUse.push({ hooks: [shellHook(claudePolicy("PreToolUse", "config-protection.js"), 30, "Running Flow Agents hook policy")] });
  return `${JSON.stringify({
    statusLine: { type: "command", command: 'bash -lc \'root="${CLAUDE_PROJECT_DIR:-$(pwd)}"; node "$root/scripts/statusline/flow-agents-statusline.js"\'' },
    permissions: manifest.claude_code.permissions ?? {},
    skipDangerousModePermissionPrompt: manifest.claude_code.skipDangerousModePermissionPrompt ?? true,
    hooks,
  }, null, 2)}\n`;
}
function exportCodexHooks(): string {
  const hooks: Record<string, Array<Record<string, unknown>>> = {};
  for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop"]) {
    hooks[event] = [{ hooks: [shellHook(codexTelemetry(event), 10, "Recording Flow Agents telemetry")] }];
  }
  hooks.Stop.push({ hooks: [shellHook(codexPolicy("stop-goal-fit.js", GOAL_FIT_MODE_PREFIX), 30, "Running Flow Agents hook policy")] });
  hooks.SessionStart.push({ hooks: [shellHook(codexPolicy("workflow-steering.js"), 30, "Running Flow Agents hook policy")] });
  hooks.UserPromptSubmit.push({ hooks: [shellHook(codexPolicy("workflow-steering.js"), 30, "Running Flow Agents hook policy")] });
  hooks.PostToolUse.push({ hooks: [shellHook(codexPolicy("evidence-capture.js"), 30, "Capturing Flow Agents command evidence")] });
  return `${JSON.stringify({ hooks }, null, 2)}\n`;
}

function copySharedContent(targetRoot: string, targetName: string, token: string): void {
  const dirs = [...manifest.canonical_copy_dirs];
  if (fs.existsSync(path.join(root, "kits")) && !dirs.includes("kits")) dirs.push("kits");
  for (const dir of dirs) copyTree(path.join(root, dir), path.join(targetRoot, dir), targetName, token);
  for (const file of manifest.root_copy_files ?? []) {
    const source = path.join(root, file);
    if (!fs.existsSync(source)) throw new Error(`manifest root_copy_files entry missing: ${file}`);
    const target = path.join(targetRoot, file);
    if (textExtensions.has(path.extname(source).toLowerCase())) writeText(target, sanitizeText(readText(source), targetName, token));
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
  }
  for (const dir of manifest.optional_copy_dirs ?? []) copyTree(path.join(root, dir), path.join(targetRoot, dir), targetName, token);
  writeText(path.join(targetRoot, "build/package.json"), `${JSON.stringify({
    name: "@kontourai/flow-agents",
    version: pkgVersion,
    type: "module",
  }, null, 2)}\n`);
  const commonBuilt = path.join(root, "build/src/tools/common.js");
  if (fs.existsSync(commonBuilt)) writeText(path.join(targetRoot, "scripts/common.mjs"), readText(commonBuilt));
  copyTree(path.join(root, "build/src"), path.join(targetRoot, "build/src"), targetName, token);
  writeBundledFlowValidator(targetRoot);
  // #620: ship the build-only capability-declarations JSON inside each bundle so an
  // installed economics-record emitter (and hooks) can read it at build/generated/
  // relative to the bundle root. It is generated unconditionally by `npm run build`
  // (the tsc build's --json-only step) and is never committed (build/ is gitignored).
  const capabilityDeclJson = path.join(root, "build/generated/capability-declarations.json");
  if (fs.existsSync(capabilityDeclJson)) {
    writeText(path.join(targetRoot, "build/generated/capability-declarations.json"), readText(capabilityDeclJson));
  }
}

/**
 * Stop hooks run from universal bundles without an npm installation. Bundle the
 * exact Flow consistency validator and its schemas so installed hooks retain
 * Flow's complete schema, lifecycle, amendment-ledger, and retry-history checks
 * without resolving code from the consumer checkout.
 */
function writeBundledFlowValidator(targetRoot: string): void {
  const flowSchemas = path.join(root, "node_modules/@kontourai/flow/schemas");
  const stateSchema = loadJson<Record<string, unknown>>(path.join(flowSchemas, "flow-run.schema.json"));
  const manifestSchema = loadJson<Record<string, unknown>>(path.join(flowSchemas, "gate-evidence.schema.json"));
  const temporaryFlowRoot = path.join(targetRoot, "build/.flow-validator-source");
  const temporaryFlowDist = path.join(temporaryFlowRoot, "dist");
  let outputText: string | null = null;
  try {
    fs.cpSync(path.join(root, "node_modules/@kontourai/flow/dist"), temporaryFlowDist, { recursive: true });
    for (const dependency of ["ajv", "ajv-formats", "fast-deep-equal", "fast-uri", "json-schema-traverse", "require-from-string"]) {
      const destination = path.join(temporaryFlowRoot, "node_modules", dependency);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.cpSync(path.join(root, "node_modules", dependency), destination, { recursive: true });
    }
    const validatorSource = path.join(temporaryFlowRoot, "flow-run-validator.mjs");
    writeText(validatorSource, `
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { validateRunLifecycle } from ${JSON.stringify(path.join(temporaryFlowDist, "runtime/flow-run-lifecycle.js"))};
const stateSchema = ${JSON.stringify(stateSchema)};
const manifestSchema = ${JSON.stringify(manifestSchema)};
let validateState;
let validateManifest;
function compileSchema(schema) {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  return ajv.compile(schema);
}
function schemaError(validate, contract) {
  const details = (validate.errors ?? []).slice(0, 5)
    .map((error) => \`${"${error.instancePath || '/'}"} ${"${error.message ?? 'is invalid'}"}\`).join("; ");
  return new Error(\`${"${contract}"}: ${"${details}"}\`);
}
export function validateRunStateSchema(state) {
  validateState ??= compileSchema(stateSchema);
  if (validateState(state)) return validateRunLifecycle(state);
  throw schemaError(validateState, "run state does not satisfy flow-run.schema.json");
}
export function validateEvidenceManifestSchema(manifest) {
  validateManifest ??= compileSchema(manifestSchema);
  if (validateManifest(manifest)) return manifest;
  throw schemaError(validateManifest, "evidence manifest does not satisfy gate-evidence.schema.json");
}
`);
    const temporaryAmendment = path.join(temporaryFlowDist, "runtime/flow-run-definition-amendment.js");
    const amendmentSource = readText(temporaryAmendment);
    const validatorImport = 'from "./flow-run-validator.js"';
    if (!amendmentSource.includes(validatorImport)) {
      throw new Error("installed Flow amendment runtime no longer imports the expected run-state validator");
    }
    writeText(temporaryAmendment, amendmentSource.replace(
      validatorImport,
      `from ${JSON.stringify(validatorSource)}`,
    ));
    const result = buildSync({
      absWorkingDir: temporaryFlowRoot,
      stdin: {
        contents: `
import { validateRunStateSchema } from ${JSON.stringify(validatorSource)};
import { normalizeRunStateLifecycle, validateDefinition } from ${JSON.stringify(path.join(temporaryFlowDist, "definition/flow-definition.js"))};
import { definitionDigest, resolveEffectiveDefinition } from ${JSON.stringify(temporaryAmendment)};
import { validateRetryAuthorizationHistory } from ${JSON.stringify(path.join(temporaryFlowDist, "runtime/flow-run-retry-proof.js"))};
export { definitionDigest };
export function validateRunStateConsistency(startDefinitionValue, stateValue, options = {}) {
  const startDefinition = validateDefinition(startDefinitionValue);
  validateRunStateSchema(stateValue);
  const state = normalizeRunStateLifecycle(stateValue);
  const definition = resolveEffectiveDefinition(startDefinition, state);
  const runId = options.runId ?? state.run_id;
  if (state.run_id !== runId) throw new Error(\`run state run_id mismatch: expected ${"${runId}"}, got ${"${state.run_id}"}\`);
  if (state.definition_id !== definition.id) throw new Error(\`run state definition_id mismatch: expected ${"${definition.id}"}, got ${"${state.definition_id}"}\`);
  if (state.definition_version !== definition.version) throw new Error(\`run state definition_version mismatch: expected ${"${definition.version}"}, got ${"${state.definition_version}"}\`);
  validateRetryAuthorizationHistory(definition, state);
  return { startDefinition, definition, state };
}
`,
        resolveDir: temporaryFlowRoot,
        sourcefile: "flow-validator-entry.mjs",
      },
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      minifyWhitespace: true,
      legalComments: "none",
      write: false,
    });
    const output = result.outputFiles?.[0];
    if (!output) throw new Error("flow validator bundle produced no output");
    outputText = output.text;
  } finally {
    fs.rmSync(temporaryFlowRoot, { recursive: true, force: true });
  }
  if (outputText === null) throw new Error("flow validator bundle produced no output");
  writeText(path.join(targetRoot, "build/src/vendor/flow-validator.cjs"), outputText);
}
function installScript(label: string, capability: BundleCapability, defaultDestDisplay: string, token?: string, destFallbackShell?: string, mergeConfig?: { configRelPath: string; managedConfigRelPath: string; runtime: string; version: string }, stampConfig?: { runtime: string; version: string }): string {
  const replaceBlock = token ? `\nexport DEST\nfind "$DEST" \\( -path "$DEST/AGENTS.md" -o -path "$DEST/CLAUDE.md" \\) -prune -o -type f \\( -name '*.json' -o -name '*.md' -o -name '*.sh' -o -name '*.js' -o -name '*.ts' -o -name '*.yaml' -o -name '*.yml' \\) -print0 | xargs -0 perl -0pi -e 's#${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}#$ENV{DEST}#g'` : "";
  const destFallback = destFallbackShell ? `\nif [[ -z "$DEST" ]]; then\n  DEST="${destFallbackShell}"\nfi` : "";
  const destRequired = !destFallbackShell;
  const requiredCheck = `${destRequired ? `if [[ -z "$DEST" ]]; then\n  usage\n  exit 2\nfi\n` : ""}while [[ "$DEST" != "/" && "$DEST" == */ ]]; do\n  DEST="\${DEST%/}"\ndone\n`;
  const usageDest = destRequired ? "/path/to/workspace" : defaultDestDisplay;
  const mergeBlock = mergeConfig
    ? `\nif command -v node >/dev/null 2>&1; then\n  node "$DEST/scripts/install-merge.js" --config "$DEST/${mergeConfig.configRelPath}" --managed-hooks "$SRC/${mergeConfig.managedConfigRelPath}" --version "${mergeConfig.version}" --install-record "$DEST/${durableInstallRecordRel}" --runtime "${mergeConfig.runtime}" || true\nfi`
    : stampConfig
    ? `\nif command -v node >/dev/null 2>&1; then\n  node "$DEST/scripts/install-merge.js" --stamp-only --version "${stampConfig.version}" --install-record "$DEST/${durableInstallRecordRel}" --runtime "${stampConfig.runtime}" || true\nfi`
    : "";
  // Excluding both discovery filenames protects any existing filesystem
  // object, including during Kiro's --delete sync. Required guidance is then
  // published with a no-overwrite hard link from a destination-local temp file.
  const instructionBlock = capability.instructionPath
    ? `\nif [[ ! -e "$DEST/${capability.instructionPath}" && ! -L "$DEST/${capability.instructionPath}" ]]; then\n  instruction_tmp="$(mktemp "$DEST/.flow-agents-instructions.XXXXXX")"\n  cp "$SRC/${capability.instructionPath}" "$instruction_tmp"\n  if ! ln "$instruction_tmp" "$DEST/${capability.instructionPath}" 2>/dev/null; then\n    if [[ ! -e "$DEST/${capability.instructionPath}" && ! -L "$DEST/${capability.instructionPath}" ]]; then\n      rm -f "$instruction_tmp"\n      echo "install.sh: could not safely install ${capability.instructionPath}" >&2\n      exit 1\n    fi\n  fi\n  rm -f "$instruction_tmp"\nfi`
    : "";
  return `#!/usr/bin/env bash\nset -euo pipefail\n\nusage() {\n  cat >&2 <<'EOF'\nusage: bash install.sh ${usageDest} [options]\n\nOptions:\n  --telemetry-sink NAME   local-files, local-kontour-console,\n                          kontour-hosted-console, user-hosted-console,\n                          or legacy aliases. May be repeated.\n  --console-url URL       Persist Console telemetry base URL.\n  --console-endpoint URL  Persist full Console telemetry records endpoint URL.\n  --console-token-file PATH\n                          Read Console telemetry bearer token from a file.\n  --console-tenant ID     Persist Console tenant identifier.\nEOF\n}\n\nDEST=""\nDEST_SET=0\nCONSOLE_CONFIG_ARGS=()\nwhile [[ $# -gt 0 ]]; do\n  case "$1" in\n    --telemetry-sink|--telemetry-sinks|--console-url|--console-endpoint|--console-endpoint-url|--console-token-file|--console-tenant|--console-tenant-id)\n      [[ $# -ge 2 ]] || { echo "install.sh: $1 requires a value" >&2; exit 2; }\n      CONSOLE_CONFIG_ARGS+=("$1" "$2")\n      shift 2\n      ;;\n    --help|-h)\n      usage\n      exit 0\n      ;;\n    -*)\n      echo "install.sh: unknown option: $1" >&2\n      usage\n      exit 2\n      ;;\n    *)\n      if [[ "$DEST_SET" -eq 1 ]]; then\n        echo "install.sh: unexpected argument: $1" >&2\n        usage\n        exit 2\n      fi\n      DEST="$1"\n      DEST_SET=1\n      shift\n      ;;\n  esac\ndone${destFallback}\n${requiredCheck}SRC="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"\n\nmkdir -p "$DEST"\nrsync -a ${token ? "--delete " : ""}--exclude='/AGENTS.md' --exclude='/CLAUDE.md' ${mergeConfig ? `--exclude="${mergeConfig.configRelPath}" ` : ""}"$SRC"/ "$DEST"/${instructionBlock}${replaceBlock}${mergeBlock}\nif [[ \${#CONSOLE_CONFIG_ARGS[@]} -gt 0 || -n "\${FLOW_AGENTS_TELEMETRY_SINK:-}" || -n "\${FLOW_AGENTS_TELEMETRY_SINKS:-}" || -n "\${FLOW_AGENTS_CONSOLE_URL:-}" || -n "\${CONSOLE_TELEMETRY_URL:-}" || -n "\${CONSOLE_URL:-}" || -n "\${FLOW_AGENTS_CONSOLE_TOKEN_FILE:-}" || -n "\${CONSOLE_TELEMETRY_TOKEN_FILE:-}" ]]; then\n  bash "$DEST/scripts/telemetry/install-console-config.sh" "$DEST/scripts/telemetry/telemetry.conf" "\${CONSOLE_CONFIG_ARGS[@]}"\nfi\necho "Installed ${label} bundle ${token ? "to" : "into"} $DEST"\n`;
}

function buildBase(agents: Agent[]): void {
  const capability = BUNDLE_CAPABILITIES["base"];
  const bundle = path.join(dist, "base");
  resetDir(bundle);
  copySharedContent(bundle, "base", "<bundle-root>");
  writeText(path.join(bundle, runtimeTaskDir, ".gitkeep"), "");
  writeBundlePolicy(bundle, capability, agents);
  writeText(path.join(bundle, "install.sh"), installScript("Base", capability, "/path/to/workspace", undefined, undefined, undefined, { runtime: "base", version: pkgVersion }));
  fs.chmodSync(path.join(bundle, "install.sh"), 0o755);
}

function buildKiro(agents: Agent[]): void {
  const capability = BUNDLE_CAPABILITIES["kiro"];
  const bundle = path.join(dist, "kiro");
  const token = manifest.kiro.path_token;
  resetDir(bundle);
  copySharedContent(bundle, "kiro", token);
  for (const spec of agents) writeText(path.join(bundle, "agents", `${spec.name}.json`), sanitizeText(`${JSON.stringify(sanitizeAgentJson(spec), null, 2)}\n`, "kiro", token));
  writeBundlePolicy(bundle, capability, agents);
  writeText(path.join(bundle, "install.sh"), installScript("Kiro", capability, "$HOME/.flow-agents", token, '${FLOW_AGENTS_DEST:-$HOME/.flow-agents}', undefined, { runtime: "kiro", version: pkgVersion }));
  fs.chmodSync(path.join(bundle, "install.sh"), 0o755);
}
function buildClaudeCode(agents: Agent[]): void {
  const capability = BUNDLE_CAPABILITIES["claude-code"];
  const bundle = path.join(dist, "claude-code");
  resetDir(bundle);
  copySharedContent(bundle, "claude-code", "<bundle-root>");
  writeText(path.join(bundle, manifest.claude_code.task_dir, ".gitkeep"), "");
  for (const spec of agents) writeText(path.join(bundle, ".claude/agents", `${spec.name}.md`), exportClaudeAgent(spec));
  for (const { name, src } of collectAllSkills()) {
    writeText(path.join(bundle, ".claude/skills", name, "SKILL.md"), sanitizeText(readText(src), "claude-code", "<bundle-root>"));
  }
  writeText(path.join(bundle, ".claude/settings.json"), exportClaudeSettings());
  writeBundlePolicy(bundle, capability, agents);
  writeText(path.join(bundle, "install.sh"), installScript("Claude Code", capability, "/path/to/workspace", undefined, undefined, { configRelPath: ".claude/settings.json", managedConfigRelPath: ".claude/settings.json", runtime: "claude-code", version: pkgVersion }));
  fs.chmodSync(path.join(bundle, "install.sh"), 0o755);
}
function buildCodex(agents: Agent[]): void {
  const capability = BUNDLE_CAPABILITIES["codex"];
  const bundle = path.join(dist, "codex");
  const excluded = new Set(manifest.codex.excluded_agents ?? []);
  const targetAgents = agents.filter((spec) => !excluded.has(spec.name));
  resetDir(bundle);
  copySharedContent(bundle, "codex", "<bundle-root>");
  writeText(path.join(bundle, manifest.codex.task_dir, ".gitkeep"), "");
  writeText(path.join(bundle, ".codex/config.toml"), exportCodexConfig());
  const settings = manifest.codex.settings ?? {};
  for (const [profileName, profile] of Object.entries(manifest.codex.profiles ?? {})) writeText(path.join(bundle, ".codex", `${profileName}.config.toml`), exportCodexProfileConfig(profile as Record<string, unknown>, settings));
  writeText(path.join(bundle, ".codex/hooks.json"), exportCodexHooks());
  for (const spec of targetAgents) writeText(path.join(bundle, ".codex/agents", `${spec.name}.toml`), exportCodexAgent(spec));
  const skillsRoot = path.join(bundle, ".agents/skills");
  for (const { name, src } of collectAllSkills()) exportSkillPackage(src, path.join(skillsRoot, name), "codex");
  validateExportedSkillPackages(skillsRoot);
  writeBundlePolicy(bundle, capability, targetAgents, CODEX_LIVE_HOOKS_README);
  writeText(path.join(bundle, "install.sh"), installScript("Codex", capability, "/path/to/workspace", undefined, undefined, { configRelPath: ".codex/hooks.json", managedConfigRelPath: ".codex/hooks.json", runtime: "codex", version: pkgVersion }));
  fs.chmodSync(path.join(bundle, "install.sh"), 0o755);
}
function exportOpencodeAgent(spec: Agent): string {
  // Determine agent mode: orchestrator-like agents -> primary, others -> subagent
  const primaryAgents = new Set(["dev"]);
  const mode = primaryAgents.has(spec.name) ? "primary" : "subagent";
  const prompt = appendExportNote(sanitizeText(spec.prompt, "opencode", "<bundle-root>"), "Kiro hook wiring and JSON-only runtime fields were omitted. If this agent mentions Kiro-specific scheduler or hook behavior, treat that as optional operational guidance rather than a hard dependency.");
  const lines: string[] = ["---"];
  lines.push(`description: ${String(spec.description ?? "").trim()}`);
  lines.push(`mode: ${mode}`);
  lines.push(`model: ${mapped("claude_model_map", spec.model)}`);
  lines.push("---");
  lines.push("");
  lines.push(prompt);
  return lines.join("\n");
}
function exportOpencodePlugin(): string {
  // Generate the Flow Agents opencode plugin.
  // opencode plugins are auto-loaded from .opencode/plugins/*.js at startup.
  //
  // NOTE: opencode has no direct user-prompt-submit hook. For prompt-submit
  // workflow steering, we wire the steering command behind session.created
  // (for session-start steering context) and tool.execute.before (for
  // policy). This is the closest reasonable approximation — documented here
  // as an honest gap matching the codex live-hook-influence caveat pattern.
  //
  // KNOWN GAP (verified 2026-06-11, opencode v1.16.2): session.created is NOT
  // delivered to plugin event handlers in opencode  (non-interactive) mode.
  // The session IS created server-side but the event fires before the plugin
  // hook dispatch loop is active. As a result, agentSpawn telemetry (session.start)
  // is never emitted in run-mode sessions — only tool.invoke/tool.result appear.
  // This is an opencode runtime limitation, not a bug in this plugin.
  // Session.start telemetry carries L1 conformance but is unavailable in run mode.
  // See docs/spec/runtime-hook-surface.md opencode mapping row for the full gap note.
  return `/**
 * Flow Agents opencode plugin.
 *
 * Auto-loaded from .opencode/plugins/flow-agents.js at opencode startup.
 * Delegates policy and telemetry decisions to shared scripts in scripts/hooks/
 * using the same payload contract as the claude/codex adapters.
 *
 * EVENT MAPPING NOTE: opencode has no direct user-prompt-submit hook.
 * Workflow steering (workflow-steering.js) is wired to session.created
 * (session-start context) and tool.execute.before (per-tool policy).
 * This approximates the UserPromptSubmit behavior in other runtimes but
 * cannot intercept mid-session user messages before they are processed.
 * This is an accepted gap documented here analogously to the codex
 * live-hook-influence caveat.
 *
 * KNOWN GAP: session.created is NOT delivered to plugin handlers in opencode
 * run (non-interactive) mode (verified v1.16.2, 2026-06-11). agentSpawn
 * telemetry (session.start) is therefore absent from run-mode sessions.
 * tool.invoke and tool.result events (L1) are still recorded normally.
 * This is an opencode runtime limitation; no workaround is available without
 * a different hook surface. See docs/spec/runtime-hook-surface.md for details.
 */

import { spawnSync } from 'node:child_process';
import { join, basename, dirname, resolve } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// opencode runs plugins inside its own compiled (Bun-based) binary, so
// process.execPath points at opencode itself — spawning it with a script
// path silently does nothing (caught by live acceptance smoke 2026-06-11).
// Resolve a real node binary instead; fall back to PATH lookup.
const NODE_BIN = basename(process.execPath).startsWith('node') ? process.execPath : 'node';
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));

export const FlowAgentsPlugin = async ({ project, client, $, directory, worktree }) => {
  const root = directory || process.cwd();
  const projectBundleRoot = resolve(PLUGIN_DIR, '..', '..');
  const globalRuntimeRoot = join(resolve(PLUGIN_DIR, '..'), '.flow-agents', 'runtime');
  const runtimeRoot = existsSync(join(globalRuntimeRoot, 'scripts', 'hooks'))
    ? globalRuntimeRoot
    : projectBundleRoot;

  // Deterministic load marker. opencode invokes this factory at startup but
  // does not reliably surface plugin console output to its log file, and its
  // internal "loading plugin" message was dropped in opencode 1.17.x. Write a
  // marker into the workspace telemetry dir so acceptance tests can confirm the
  // plugin loaded without depending on opencode internals. Best-effort only.
  try {
    const telemetryDir = join(root, '.telemetry');
    mkdirSync(telemetryDir, { recursive: true });
    writeFileSync(join(telemetryDir, 'opencode-plugin.loaded'), 'flow-agents');
  } catch (_err) {
    // Marker is diagnostic only; never block plugin load on a write failure.
  }

  // The hook scripts read the event payload from stdin; an empty stdin makes
  // the telemetry pipeline silently skip the emit (fail-open), so every spawn
  // must pass a payload (caught by live acceptance smoke 2026-06-11).
  function hookPayload(eventName, detail) {
    return JSON.stringify({ hook_event_name: eventName, cwd: root, ...(detail || {}) });
  }

  function runAdapter(adapterScript, eventName, detail, ...args) {
    const adapterPath = join(runtimeRoot, 'scripts', 'hooks', adapterScript);
    const result = spawnSync(NODE_BIN, [adapterPath, eventName, ...args], {
      input: hookPayload(eventName, detail),
      encoding: 'utf8',
      cwd: root,
      env: { ...process.env, FLOW_AGENTS_HOOK_RUNTIME: 'opencode' },
      timeout: 30000,
    });
    try {
      return JSON.parse(result.stdout || '{}');
    } catch {
      return { allow: true };
    }
  }

  function runTelemetry(eventName, detail) {
    const telemetryPath = join(runtimeRoot, 'scripts', 'hooks', 'opencode-telemetry-hook.js');
    spawnSync(NODE_BIN, [telemetryPath, eventName, 'dev'], {
      input: hookPayload(eventName, detail),
      encoding: 'utf8',
      cwd: root,
      env: { ...process.env, FLOW_AGENTS_TELEMETRY_RUNTIME: 'opencode' },
      timeout: 10000,
    });
  }

  return {
    'session.created': async (_input, _output) => {
      runTelemetry('session.created');
      // Wire workflow steering on session start for context injection
      runAdapter('opencode-hook-adapter.js', 'session.created', null, 'workflow-steering', 'workflow-steering.js', 'default');
    },
    'tool.execute.before': async (input, output) => {
      const detail = { tool: input && input.tool, args: output && output.args };
      runTelemetry('tool.execute.before', detail);
      const policyResult = runAdapter('opencode-hook-adapter.js', 'tool.execute.before', detail, 'config-protection', 'config-protection.js', 'default');
      if (policyResult && policyResult.allow === false) {
        throw new Error(policyResult.reason || 'Blocked by Flow Agents hook policy.');
      }
    },
    'tool.execute.after': async (input, output) => {
      const detail = { tool: input && input.tool };
      runTelemetry('tool.execute.after', detail);
      runAdapter('opencode-hook-adapter.js', 'tool.execute.after', detail, 'quality-gate', 'quality-gate.js', 'default');
      runAdapter('opencode-hook-adapter.js', 'tool.execute.after', detail, 'evidence-capture', 'evidence-capture.js', 'default');
    },
    'session.idle': async (_input, _output) => {
      runTelemetry('session.idle');
      runAdapter('opencode-hook-adapter.js', 'session.idle', null, 'stop-goal-fit', 'stop-goal-fit.js', 'default');
    },
    'session.error': async (_input, _output) => {
      runTelemetry('session.error');
    },
    'session.compacted': async (_input, _output) => {
      runTelemetry('session.compacted');
    },
    'permission.asked': async (_input, _output) => {
      runTelemetry('permission.asked');
    },
    'file.edited': async (_input, _output) => {
      runTelemetry('file.edited');
    },
  };
};
`;
}
function exportOpencodeConfig(): string {
  // opencode's config schema requires `instructions` to be an ARRAY of
  // instruction file paths/globs (a bare string fails validation and aborts
  // startup). AGENTS.md is loaded natively by opencode, so the config stays
  // minimal rather than double-including it.
  return `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
  }, null, 2)}\n`;
}
function buildOpencode(agents: Agent[]): void {
  const capability = BUNDLE_CAPABILITIES["opencode"];
  const bundle = path.join(dist, "opencode");
  resetDir(bundle);
  copySharedContent(bundle, "opencode", "<bundle-root>");
  writeText(path.join(bundle, manifest.opencode.task_dir, ".gitkeep"), "");
  for (const spec of agents) {
    writeText(path.join(bundle, ".opencode/agents", `${spec.name}.md`), exportOpencodeAgent(spec));
  }
  for (const { name, src } of collectAllSkills()) {
    writeText(path.join(bundle, ".opencode/skills", name, "SKILL.md"), sanitizeText(readText(src), "opencode", "<bundle-root>"));
  }
  writeText(path.join(bundle, ".opencode/plugins/flow-agents.js"), exportOpencodePlugin());
  writeText(path.join(bundle, "opencode.json"), exportOpencodeConfig());
  writeBundlePolicy(bundle, capability, agents);
  writeText(path.join(bundle, "install.sh"), installScript("opencode", capability, "/path/to/workspace", undefined, undefined, { configRelPath: "opencode.json", managedConfigRelPath: "opencode.json", runtime: "opencode", version: pkgVersion }));
  fs.chmodSync(path.join(bundle, "install.sh"), 0o755);
}
function exportPiExtension(): string {
  // Generate the Flow Agents pi extension.
  // pi extensions are auto-discovered from .pi/extensions/*.ts (needs project trust).
  // pi has no named-subagent registry; agents are not exported. The extension
  // provides workflow steering (via before_agent_start context injection),
  // tool-call policy (via tool_call event), and telemetry delegation to shared scripts.
  return `/**
 * Flow Agents pi extension.
 *
 * Auto-discovered from .pi/extensions/flow-agents.ts at startup (needs project trust).
 * Delegates policy and telemetry to shared scripts/hooks/ using spawnSync,
 * mirroring the payload contract used by the claude/codex adapters.
 *
 * NOTE: pi has no named-subagent registry. Agents are not exported for pi.
 * Rely on AGENTS.md + skills + this extension for workflow guidance.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { join, basename } from "node:path";

// pi may run extensions under a non-node runtime (Bun), where process.execPath
// is not a node binary and spawning it with a script path silently fails.
// Same failure class the opencode live smoke caught on 2026-06-11.
const NODE_BIN = basename(process.execPath).startsWith("node") ? process.execPath : "node";

export default function (pi: ExtensionAPI) {
  const root = process.cwd();

  function runAdapter(adapterScript: string, eventName: string, hookId: string, relScript: string): { allow: boolean; context?: string; reason?: string } {
    const adapterPath = join(root, "scripts", "hooks", adapterScript);
    const payload = JSON.stringify({ hook_event_name: eventName, cwd: root });
    const result = spawnSync(NODE_BIN, [adapterPath, eventName, hookId, relScript, "default"], {
      input: payload,
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, FLOW_AGENTS_HOOK_RUNTIME: "pi" },
      timeout: 30000,
    });
    try {
      return JSON.parse(result.stdout || "{}") as { allow: boolean; context?: string; reason?: string };
    } catch {
      return { allow: true };
    }
  }

  function runTelemetry(eventName: string): void {
    const telemetryPath = join(root, "scripts", "hooks", "pi-telemetry-hook.js");
    const payload = JSON.stringify({ hook_event_name: eventName, cwd: root });
    spawnSync(NODE_BIN, [telemetryPath, eventName, "dev"], {
      input: payload,
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, FLOW_AGENTS_TELEMETRY_RUNTIME: "pi" },
      timeout: 10000,
    });
  }

  pi.on("session_start", async (_event, _ctx) => {
    runTelemetry("session_start");
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    // Telemetry for agentSpawn is emitted by session_start above; do not repeat it here
    // to avoid duplicate session.start events in the telemetry log.
    // Inject workflow steering context at agent start
    const result = runAdapter("pi-hook-adapter.js", "before_agent_start", "workflow-steering", "workflow-steering.js");
    if (result.context) {
      return {
        systemPrompt: event.systemPrompt + "\\n\\n" + result.context,
      };
    }
  });

  pi.on("tool_call", async (event, _ctx) => {
    runTelemetry("tool_call");
    const result = runAdapter("pi-hook-adapter.js", "tool_call", "config-protection", "config-protection.js");
    if (result && result.allow === false) {
      return { block: true, reason: result.reason || "Blocked by Flow Agents hook policy." };
    }
  });

  pi.on("tool_result", async (_event, _ctx) => {
    runTelemetry("tool_result");
    runAdapter("pi-hook-adapter.js", "tool_result", "quality-gate", "quality-gate.js");
    runAdapter("pi-hook-adapter.js", "tool_result", "evidence-capture", "evidence-capture.js");
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    runTelemetry("session_shutdown");
    runAdapter("pi-hook-adapter.js", "session_shutdown", "stop-goal-fit", "stop-goal-fit.js");
  });
}
`;
}
function buildPi(agents: Agent[]): void {
  const capability = BUNDLE_CAPABILITIES["pi"];
  const bundle = path.join(dist, "pi");
  resetDir(bundle);
  copySharedContent(bundle, "pi", "<bundle-root>");
  writeText(path.join(bundle, manifest.pi.task_dir, ".gitkeep"), "");
  // pi has no named-subagent registry; agents are left canonical/unexported.
  // Skills are exported to .pi/skills/ (direct .md files supported in that dir).
  for (const { name, src } of collectAllSkills()) {
    writeText(path.join(bundle, ".pi/skills", name, "SKILL.md"), sanitizeText(readText(src), "pi", "<bundle-root>"));
  }
  writeText(path.join(bundle, ".pi/extensions/flow-agents.ts"), exportPiExtension());
  writeBundlePolicy(bundle, capability, agents);
  writeText(path.join(bundle, "install.sh"), installScript("pi", capability, "/path/to/workspace", undefined, undefined, undefined, { runtime: "pi", version: pkgVersion }));
  fs.chmodSync(path.join(bundle, "install.sh"), 0o755);
}
function buildCatalog(agents: Agent[]): Record<string, unknown> {
  const kitsCatalog = path.join(root, "kits/catalog.json");
  return {
    source_root: ".",
    agents: agents.slice().sort((a, b) => a.name.localeCompare(b.name)).map((spec) => spec.name),
    skills: collectAllSkills().map(({ name }) => name),
    powers: fs.readdirSync(path.join(root, "powers")).filter((name) => fs.existsSync(path.join(root, "powers", name, "mcp.json"))).sort(),
    kits: fs.existsSync(kitsCatalog) ? loadJson<Record<string, unknown>>(kitsCatalog).kits ?? [] : [],
  };
}
export function main(): number {
  fs.mkdirSync(dist, { recursive: true });
  // Populate (and, on collision, set) skillCollisionDiagnostic before any
  // build step writes output -- fail fast with a clear diagnostic instead of
  // partially building bundles from a deduped/ambiguous skill set.
  collectAllSkills();
  if (skillCollisionDiagnostic) {
    console.error(skillCollisionDiagnostic);
    return 1;
  }
  const agents = fs.readdirSync(path.join(root, "agents")).filter((name) => name.endsWith(".json")).sort().map((name) => loadJson<Agent>(path.join(root, "agents", name)));
  const routingErrors = codexAgentRoutingErrors(manifest, agents.map((agent) => agent.name));
  if (routingErrors.length) {
    for (const error of routingErrors) console.error(`flow-agents: packaging/manifest.json: ${error}`);
    return 1;
  }
  buildBase(agents);
  buildKiro(agents);
  buildClaudeCode(agents);
  buildCodex(agents);
  buildOpencode(agents);
  buildPi(agents);
  writeText(path.join(dist, "catalog.json"), `${JSON.stringify(buildCatalog(agents), null, 2)}\n`);
  writeText(path.join(dist, "README.md"), "# Universal Bundles\n\nRun `npm run build:bundles` from the repo root to regenerate these bundles.\n");
  console.log("Built bundles:");
  console.log(" - dist/base");
  console.log(" - dist/kiro");
  console.log(" - dist/claude-code");
  console.log(" - dist/codex");
  console.log(" - dist/opencode");
  console.log(" - dist/pi");
  if (printDiagnostics && dropDiagnostics.length) {
    console.error("Export sanitization diagnostics:");
    for (const item of dropDiagnostics) console.error(` - ${item}`);
  }
  return 0;
}
// Use process.exitCode (not process.exit) to allow stdout to be flushed before exit.
// Resolve real paths to handle symlinks (e.g. /tmp -> /private/tmp on macOS) so the
// entry-point guard fires correctly when the module is loaded directly as a script.
const _selfRealPath = (() => { try { return fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return fileURLToPath(import.meta.url); } })();
const _argv1RealPath = (() => { try { return fs.realpathSync(process.argv[1]); } catch { return process.argv[1]; } })();
if (_selfRealPath === _argv1RealPath) { process.exitCode = main(); }
