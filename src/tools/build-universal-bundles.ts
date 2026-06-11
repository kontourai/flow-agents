#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { loadJson, readText, root, walkFiles, writeText } from "./common.js";

type Agent = Record<string, unknown> & { name: string; prompt: string };
const dist = process.env.FLOW_AGENTS_DIST_DIR ? path.resolve(process.env.FLOW_AGENTS_DIST_DIR) : path.join(root, "dist");
const manifest = loadJson<Record<string, any>>(path.join(root, "packaging/manifest.json"));
const packs = loadJson<Record<string, any>>(path.join(root, "packaging/packs.json"));
const textExtensions = new Set([".css", ".html", ".js", ".json", ".md", ".sh", ".toml", ".txt", ".yaml", ".yml", ".ts"]);
const dropDiagnostics: string[] = [];
const printDiagnostics = !["0", "false", "no"].includes(String(process.env.FLOW_AGENTS_EXPORT_DIAGNOSTICS ?? "1").toLowerCase());

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
function resolveCodexModel(spec: Agent): string {
  return ["tool-agent-delegate", "tool-agent-handoff"].includes(spec.name) ? "gpt-5.4-mini" : mapped("codex_model_map", spec.model);
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
function exportRootAgentsMd(label: string, agents: Agent[], taskDir: string): string {
  return `# Universal Agent Bundle (${label})\n\nThis bundle was generated from the canonical source in this repo. Treat the repo root as the source of truth and regenerate the bundle instead of editing exported agent files by hand.\n\n## Shared Conventions\n\n- \`skills/\`, \`context/\`, \`powers/\`, \`prompts/\`, \`scripts/\`, and \`evals/\` were copied from the canonical source.\n- Cross-session task artifacts should live under \`${taskDir}\`.\n- Kiro-only hook wiring was stripped from exported non-Kiro agents to keep the package portable.\n\n## Exported Agents\n\n${generatedAgentsSummary(agents)}\n`;
}
function exportTargetReadme(label: string, installHint: string): string {
  return `# ${label} Bundle\n\nGenerated from the canonical source in this repository.\n\n## Install\n\n\`\`\`bash\n${installHint}\n\`\`\`\n\nOptional pack filtering is available at install time with \`FLOW_AGENTS_PACKS\`.\nThe default pack is always included:\n\n\`\`\`bash\nFLOW_AGENTS_PACKS=development,knowledge ${installHint}\n\`\`\`\n\n## Contents\n\n- Harness-specific agents\n- Shared skills\n- Shared context, powers, prompts, scripts, and evals\n`;
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
  return `# exported from agents/${spec.name}.json\nname = "${spec.name}"\nnickname_candidates = ${JSON.stringify(codexNicknames(spec.name))}\ndescription = "${description}"\nmodel = "${resolveCodexModel(spec)}"\nmodel_reasoning_effort = "${mapped("codex_reasoning_map", spec.model)}"\ndeveloper_instructions = ${JSON.stringify(prompt)}\n`;
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
function claudePolicy(event: string, script: string): string {
  return `bash -lc 'root="\${CLAUDE_PROJECT_DIR:-$(pwd)}"; node "$root/scripts/hooks/claude-hook-adapter.js" ${event} ${script.replace(/\.js$/, "")} ${script} default'`;
}
function codexRoot(scriptPath: string): string {
  return `root="\${CODEX_HOME:-}"; if [ -z "$root" ] || [ ! -f "$root/${scriptPath}" ]; then root=$(git rev-parse --show-toplevel 2>/dev/null || pwd); fi`;
}
function codexTelemetry(event: string): string {
  if (event === "PermissionRequest") return `bash -lc '${codexRoot("scripts/telemetry/telemetry.sh")}; bash "$root/scripts/telemetry/telemetry.sh" permissionRequest dev'`;
  return `bash -lc '${codexRoot("scripts/hooks/codex-telemetry-hook.js")}; node "$root/scripts/hooks/codex-telemetry-hook.js" ${event} dev'`;
}
function codexPolicy(script: string): string {
  return `bash -lc '${codexRoot("scripts/hooks/codex-hook-adapter.js")}; node "$root/scripts/hooks/codex-hook-adapter.js" ${script.replace(/\.js$/, "")} ${script} default'`;
}
function exportClaudeSettings(): string {
  const hooks: Record<string, Array<Record<string, unknown>>> = {};
  for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop", "SessionEnd"]) {
    hooks[event] = [{ hooks: [shellHook(claudeTelemetry(event), 10, "Recording Flow Agents telemetry")] }];
  }
  hooks.Stop.push({ hooks: [shellHook(claudePolicy("Stop", "stop-goal-fit.js"), 30, "Running Flow Agents hook policy")] });
  hooks.UserPromptSubmit.push({ hooks: [shellHook(claudePolicy("UserPromptSubmit", "workflow-steering.js"), 30, "Running Flow Agents hook policy")] });
  hooks.PostToolUse.push({ hooks: [shellHook(claudePolicy("PostToolUse", "quality-gate.js"), 30, "Running Flow Agents hook policy")] });
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
  hooks.Stop.push({ hooks: [shellHook(codexPolicy("stop-goal-fit.js"), 30, "Running Flow Agents hook policy")] });
  hooks.UserPromptSubmit.push({ hooks: [shellHook(codexPolicy("workflow-steering.js"), 30, "Running Flow Agents hook policy")] });
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
  writeText(path.join(targetRoot, "build/package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`);
  const filterBuilt = path.join(root, "build/src/tools/filter-installed-packs.js");
  const commonBuilt = path.join(root, "build/src/tools/common.js");
  if (fs.existsSync(filterBuilt)) writeText(path.join(targetRoot, "scripts/filter-installed-packs.mjs"), readText(filterBuilt).replace("./common.js", "./common.mjs"));
  if (fs.existsSync(commonBuilt)) writeText(path.join(targetRoot, "scripts/common.mjs"), readText(commonBuilt));
  copyTree(path.join(root, "build/src"), path.join(targetRoot, "build/src"), targetName, token);
}
function installScript(label: string, defaultDestDisplay: string, token?: string, destFallbackShell?: string): string {
  const replaceBlock = token ? `\nexport DEST\nfind "$DEST" -type f \\( -name '*.json' -o -name '*.md' -o -name '*.sh' -o -name '*.js' -o -name '*.ts' -o -name '*.yaml' -o -name '*.yml' \\) -print0 | xargs -0 perl -0pi -e 's#${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}#$ENV{DEST}#g'` : "";
  const destFallback = destFallbackShell ? `\nif [[ -z "$DEST" ]]; then\n  DEST="${destFallbackShell}"\nfi` : "";
  const destRequired = !destFallbackShell;
  const requiredCheck = destRequired ? `if [[ -z "$DEST" ]]; then\n  usage\n  exit 2\nfi\n` : "";
  const usageDest = destRequired ? "/path/to/workspace" : defaultDestDisplay;
  return `#!/usr/bin/env bash\nset -euo pipefail\n\nusage() {\n  cat >&2 <<'EOF'\nusage: bash install.sh ${usageDest} [options]\n\nOptions:\n  --telemetry-sink NAME   local-files, local-kontour-console,\n                          kontour-hosted-console, user-hosted-console,\n                          or legacy aliases. May be repeated.\n  --console-url URL       Persist Console telemetry base URL.\n  --console-endpoint URL  Persist full Console telemetry records endpoint URL.\n  --console-token-file PATH\n                          Read Console telemetry bearer token from a file.\n  --console-tenant ID     Persist Console tenant identifier.\nEOF\n}\n\nDEST=""\nDEST_SET=0\nCONSOLE_CONFIG_ARGS=()\nwhile [[ $# -gt 0 ]]; do\n  case "$1" in\n    --telemetry-sink|--telemetry-sinks|--console-url|--console-endpoint|--console-endpoint-url|--console-token-file|--console-tenant|--console-tenant-id)\n      [[ $# -ge 2 ]] || { echo "install.sh: $1 requires a value" >&2; exit 2; }\n      CONSOLE_CONFIG_ARGS+=("$1" "$2")\n      shift 2\n      ;;\n    --help|-h)\n      usage\n      exit 0\n      ;;\n    -*)\n      echo "install.sh: unknown option: $1" >&2\n      usage\n      exit 2\n      ;;\n    *)\n      if [[ "$DEST_SET" -eq 1 ]]; then\n        echo "install.sh: unexpected argument: $1" >&2\n        usage\n        exit 2\n      fi\n      DEST="$1"\n      DEST_SET=1\n      shift\n      ;;\n  esac\ndone${destFallback}\n${requiredCheck}SRC="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"\n\nmkdir -p "$DEST"\nrsync -a ${token ? "--delete " : ""}"$SRC"/ "$DEST"/\nif [[ -n "\${FLOW_AGENTS_PACKS:-}" ]]; then\n  node "$DEST/scripts/filter-installed-packs.mjs" "$DEST" --packs "$FLOW_AGENTS_PACKS"\nfi${replaceBlock}\nif [[ \${#CONSOLE_CONFIG_ARGS[@]} -gt 0 || -n "\${FLOW_AGENTS_TELEMETRY_SINK:-}" || -n "\${FLOW_AGENTS_TELEMETRY_SINKS:-}" || -n "\${FLOW_AGENTS_CONSOLE_URL:-}" || -n "\${CONSOLE_TELEMETRY_URL:-}" || -n "\${CONSOLE_URL:-}" || -n "\${FLOW_AGENTS_CONSOLE_TOKEN_FILE:-}" || -n "\${CONSOLE_TELEMETRY_TOKEN_FILE:-}" ]]; then\n  bash "$DEST/scripts/telemetry/install-console-config.sh" "$DEST/scripts/telemetry/telemetry.conf" "\${CONSOLE_CONFIG_ARGS[@]}"\nfi\necho "Installed ${label} bundle ${token ? "to" : "into"} $DEST"\n`;
}

function buildBase(agents: Agent[]): void {
  const bundle = path.join(dist, "base");
  resetDir(bundle);
  copySharedContent(bundle, "base", "<bundle-root>");
  writeText(path.join(bundle, ".flow-agents", ".gitkeep"), "");
  writeText(path.join(bundle, "AGENTS.md"), exportRootAgentsMd("Base", agents, ".flow-agents"));
  writeText(path.join(bundle, "README.md"), exportTargetReadme("Base", "bash install.sh /path/to/workspace"));
  writeText(path.join(bundle, "install.sh"), installScript("Base", "/path/to/workspace"));
  fs.chmodSync(path.join(bundle, "install.sh"), 0o755);
}

function buildKiro(agents: Agent[]): void {
  const bundle = path.join(dist, "kiro");
  const token = manifest.kiro.path_token;
  resetDir(bundle);
  copySharedContent(bundle, "kiro", token);
  for (const spec of agents) writeText(path.join(bundle, "agents", `${spec.name}.json`), sanitizeText(`${JSON.stringify(sanitizeAgentJson(spec), null, 2)}\n`, "kiro", token));
  writeText(path.join(bundle, "AGENTS.md"), exportRootAgentsMd("Kiro", agents, ".flow-agents"));
  writeText(path.join(bundle, "README.md"), exportTargetReadme("Kiro", "bash install.sh $HOME/.flow-agents"));
  writeText(path.join(bundle, "install.sh"), installScript("Kiro", "$HOME/.flow-agents", token, '${FLOW_AGENTS_DEST:-$HOME/.flow-agents}'));
  fs.chmodSync(path.join(bundle, "install.sh"), 0o755);
}
function buildClaudeCode(agents: Agent[]): void {
  const bundle = path.join(dist, "claude-code");
  resetDir(bundle);
  copySharedContent(bundle, "claude-code", "<bundle-root>");
  writeText(path.join(bundle, manifest.claude_code.task_dir, ".gitkeep"), "");
  for (const spec of agents) writeText(path.join(bundle, ".claude/agents", `${spec.name}.md`), exportClaudeAgent(spec));
  for (const skill of fs.readdirSync(path.join(root, "skills"))) {
    const skillPath = path.join(root, "skills", skill, "SKILL.md");
    if (fs.existsSync(skillPath)) writeText(path.join(bundle, ".claude/skills", skill, "SKILL.md"), sanitizeText(readText(skillPath), "claude-code", "<bundle-root>"));
  }
  writeText(path.join(bundle, ".claude/settings.json"), exportClaudeSettings());
  writeText(path.join(bundle, "AGENTS.md"), exportRootAgentsMd("Claude Code", agents, manifest.claude_code.task_dir));
  writeText(path.join(bundle, "README.md"), exportTargetReadme("Claude Code", "bash install.sh /path/to/workspace"));
  writeText(path.join(bundle, "install.sh"), installScript("Claude Code", "/path/to/workspace"));
  fs.chmodSync(path.join(bundle, "install.sh"), 0o755);
}
function buildCodex(agents: Agent[]): void {
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
  for (const skill of fs.readdirSync(path.join(root, "skills"))) {
    const skillPath = path.join(root, "skills", skill, "SKILL.md");
    if (fs.existsSync(skillPath)) writeText(path.join(bundle, ".codex/skills", skill, "SKILL.md"), sanitizeText(readText(skillPath), "codex", "<bundle-root>"));
  }
  writeText(path.join(bundle, "AGENTS.md"), exportRootAgentsMd("Codex", targetAgents, manifest.codex.task_dir));
  writeText(path.join(bundle, "README.md"), exportTargetReadme("Codex", "bash install.sh /path/to/workspace"));
  writeText(path.join(bundle, "install.sh"), installScript("Codex", "/path/to/workspace"));
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
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export const FlowAgentsPlugin = async ({ project, client, $, directory, worktree }) => {
  const root = directory || process.cwd();

  function runAdapter(adapterScript, ...args) {
    const adapterPath = join(root, 'scripts', 'hooks', adapterScript);
    const result = spawnSync(process.execPath, [adapterPath, ...args], {
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

  function runTelemetry(eventName) {
    const telemetryPath = join(root, 'scripts', 'hooks', 'opencode-telemetry-hook.js');
    spawnSync(process.execPath, [telemetryPath, eventName, 'dev'], {
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
      runAdapter('opencode-hook-adapter.js', 'session.created', 'workflow-steering', 'workflow-steering.js', 'default');
    },
    'tool.execute.before': async (input, output) => {
      runTelemetry('tool.execute.before');
      const policyResult = runAdapter('opencode-hook-adapter.js', 'tool.execute.before', 'config-protection', 'config-protection.js', 'default');
      if (policyResult && policyResult.allow === false) {
        throw new Error(policyResult.reason || 'Blocked by Flow Agents hook policy.');
      }
    },
    'tool.execute.after': async (input, output) => {
      runTelemetry('tool.execute.after');
      runAdapter('opencode-hook-adapter.js', 'tool.execute.after', 'quality-gate', 'quality-gate.js', 'default');
    },
    'session.idle': async (_input, _output) => {
      runTelemetry('session.idle');
      runAdapter('opencode-hook-adapter.js', 'session.idle', 'stop-goal-fit', 'stop-goal-fit.js', 'default');
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
  const bundle = path.join(dist, "opencode");
  resetDir(bundle);
  copySharedContent(bundle, "opencode", "<bundle-root>");
  writeText(path.join(bundle, manifest.opencode.task_dir, ".gitkeep"), "");
  for (const spec of agents) {
    writeText(path.join(bundle, ".opencode/agents", `${spec.name}.md`), exportOpencodeAgent(spec));
  }
  for (const skill of fs.readdirSync(path.join(root, "skills"))) {
    const skillPath = path.join(root, "skills", skill, "SKILL.md");
    if (fs.existsSync(skillPath)) writeText(path.join(bundle, ".opencode/skills", skill, "SKILL.md"), sanitizeText(readText(skillPath), "opencode", "<bundle-root>"));
  }
  writeText(path.join(bundle, ".opencode/plugins/flow-agents.js"), exportOpencodePlugin());
  writeText(path.join(bundle, "opencode.json"), exportOpencodeConfig());
  writeText(path.join(bundle, "AGENTS.md"), exportRootAgentsMd("opencode", agents, manifest.opencode.task_dir));
  writeText(path.join(bundle, "README.md"), exportTargetReadme("opencode", "bash install.sh /path/to/workspace"));
  writeText(path.join(bundle, "install.sh"), installScript("opencode", "/path/to/workspace"));
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
import { join } from "node:path";

export default function (pi: ExtensionAPI) {
  const root = process.cwd();

  function runAdapter(adapterScript: string, eventName: string, hookId: string, relScript: string): { allow: boolean; context?: string; reason?: string } {
    const adapterPath = join(root, "scripts", "hooks", adapterScript);
    const payload = JSON.stringify({ hook_event_name: eventName, cwd: root });
    const result = spawnSync(process.execPath, [adapterPath, eventName, hookId, relScript, "default"], {
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
    spawnSync(process.execPath, [telemetryPath, eventName, "dev"], {
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
    runTelemetry("before_agent_start");
    // Inject workflow steering context at agent start
    const result = runAdapter("pi-hook-adapter.js", "before_agent_start", "workflow-steering", "workflow-steering.js");
    if (result.context) {
      return {
        systemPrompt: event.systemPrompt + "\n\n" + result.context,
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
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    runTelemetry("session_shutdown");
    runAdapter("pi-hook-adapter.js", "session_shutdown", "stop-goal-fit", "stop-goal-fit.js");
  });
}
`;
}
function buildPi(agents: Agent[]): void {
  const bundle = path.join(dist, "pi");
  resetDir(bundle);
  copySharedContent(bundle, "pi", "<bundle-root>");
  writeText(path.join(bundle, manifest.pi.task_dir, ".gitkeep"), "");
  // pi has no named-subagent registry; agents are left canonical/unexported.
  // Skills are exported to .pi/skills/ (direct .md files supported in that dir).
  for (const skill of fs.readdirSync(path.join(root, "skills"))) {
    const skillPath = path.join(root, "skills", skill, "SKILL.md");
    if (fs.existsSync(skillPath)) writeText(path.join(bundle, ".pi/skills", skill, "SKILL.md"), sanitizeText(readText(skillPath), "pi", "<bundle-root>"));
  }
  writeText(path.join(bundle, ".pi/extensions/flow-agents.ts"), exportPiExtension());
  writeText(path.join(bundle, "AGENTS.md"), exportRootAgentsMd("pi", agents, manifest.pi.task_dir));
  writeText(path.join(bundle, "README.md"), exportTargetReadme("pi", "bash install.sh /path/to/workspace"));
  writeText(path.join(bundle, "install.sh"), installScript("pi", "/path/to/workspace"));
  fs.chmodSync(path.join(bundle, "install.sh"), 0o755);
}
function buildCatalog(agents: Agent[]): Record<string, unknown> {
  const kitsCatalog = path.join(root, "kits/catalog.json");
  return {
    source_root: ".",
    agents: agents.slice().sort((a, b) => a.name.localeCompare(b.name)).map((spec) => spec.name),
    skills: fs.readdirSync(path.join(root, "skills")).filter((name) => fs.existsSync(path.join(root, "skills", name, "SKILL.md"))).sort(),
    powers: fs.readdirSync(path.join(root, "powers")).filter((name) => fs.existsSync(path.join(root, "powers", name, "mcp.json"))).sort(),
    packs: packs.packs ?? [],
    kits: fs.existsSync(kitsCatalog) ? loadJson<Record<string, unknown>>(kitsCatalog).kits ?? [] : [],
  };
}
export function main(): number {
  fs.mkdirSync(dist, { recursive: true });
  const agents = fs.readdirSync(path.join(root, "agents")).filter((name) => name.endsWith(".json")).sort().map((name) => loadJson<Agent>(path.join(root, "agents", name)));
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
if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
