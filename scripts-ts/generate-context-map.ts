#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { exists, loadJson, markdownTable, oneLine, readText, rel, root, writeText } from "./common.js";

const defaultOutput = path.join(root, "docs/context-map.md");
const dirDescriptions: Record<string, string> = {
  agents: "Canonical agent specs and routing prompts.",
  "agent-cards": "Install/discovery cards that point at canonical agents.",
  context: "Shared contracts, routing notes, templates, and reusable guidance.",
  docs: "Long-lived project documentation and GitHub Pages content.",
  evals: "Static, integration, install, and behavioral eval fixtures.",
  powers: "Optional MCP/tool integration packs.",
  prompts: "Reusable prompt entry points.",
  schemas: "JSON Schema contracts for machine-readable workflow artifacts.",
  scripts: "Build, validation, hook, telemetry, workflow, and import/export utilities.",
  skills: "On-demand capability instructions and workflow primitives.",
};
const workflowSkills = new Set(["idea-to-backlog", "pull-work", "plan-work", "execute-plan", "review-work", "verify-work", "evidence-gate", "release-readiness", "learning-review", "deliver", "fix-bug", "tdd-workflow"]);
const commands = [
  ["Source tree", "npm run validate:source"],
  ["Static suite", "bash evals/run.sh static"],
  ["Integration suite", "bash evals/run.sh integration"],
  ["Workflow artifacts", "npm run workflow-artifacts -- --require-sidecars --require-critique .agents/flow-agents/<slug>"],
  ["Workflow sidecars", "npm run workflow-sidecar -- --help"],
  ["Context map drift", "npm run context-map:check"],
  ["Bundle build", "npm run build:bundles"],
];

function frontmatter(text: string): Record<string, string> {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end < 0) return {};
  const fields: Record<string, string> = {};
  const lines = text.slice(3, end).split(/\r?\n/);
  for (let index = 0; index < lines.length;) {
    const match = /^([A-Za-z0-9_-]+):\s*(.+)$/.exec(lines[index].trim());
    if (!match) {
      index += 1;
      continue;
    }
    const key = match[1];
    const value = match[2].trim();
    index += 1;
    if ([">", ">-", "|", "|-"].includes(value)) {
      const block: string[] = [];
      while (index < lines.length && (lines[index].startsWith(" ") || !lines[index].trim())) {
        if (lines[index].trim()) block.push(lines[index].trim());
        index += 1;
      }
      fields[key] = block.join(" ");
    } else {
      const parts = [value.replace(/^"|"$/g, "")];
      while (index < lines.length && (lines[index].startsWith(" ") || !lines[index].trim())) {
        if (lines[index].trim()) parts.push(lines[index].trim().replace(/^"|"$/g, ""));
        index += 1;
      }
      fields[key] = parts.join(" ");
    }
  }
  return fields;
}

function repoShape(manifest: Record<string, unknown>): string[][] {
  const canonical = new Set(Array.isArray(manifest.canonical_copy_dirs) ? manifest.canonical_copy_dirs.map(String) : []);
  const dirs = [...new Set([...canonical, ...Object.keys(dirDescriptions)])].sort();
  const rows = dirs.filter((dir) => exists(path.join(root, dir))).map((dir) => [dir, canonical.has(dir) ? "canonical copy" : "source", dirDescriptions[dir] ?? "Project directory."]);
  for (const dir of Array.isArray(manifest.optional_copy_dirs) ? manifest.optional_copy_dirs.map(String) : []) {
    rows.push([dir, "optional", "Optional local/user pack copied when present."]);
  }
  rows.push(["dist", "generated", "Generated bundle exports. Do not edit by hand."]);
  rows.push([".agents/flow-agents", "runtime", "Cross-session workflow artifacts and sidecars. Not committed by default."]);
  return rows;
}

function listSkillRows(): [string[][], string[][]] {
  const workflowRows: string[][] = [];
  const supportRows: string[][] = [];
  const skillsDir = path.join(root, "skills");
  for (const name of fs.readdirSync(skillsDir).sort()) {
    const skillPath = path.join(skillsDir, name, "SKILL.md");
    if (!exists(skillPath)) continue;
    const meta = frontmatter(readText(skillPath));
    const row = [meta.name ?? name, rel(skillPath), oneLine(meta.description ?? "")];
    if (workflowSkills.has(row[0])) workflowRows.push(row);
    else supportRows.push(row);
  }
  return [workflowRows, supportRows];
}

function agents(): string[][] {
  const dir = path.join(root, "agents");
  return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort().map((name) => {
    const file = path.join(dir, name);
    const data = loadJson<Record<string, unknown>>(file);
    const tools = Array.isArray(data.tools) ? data.tools : Array.isArray(data.allowedTools) ? data.allowedTools : [];
    return [String(data.name ?? path.basename(name, ".json")), String(data.model ?? ""), String(tools.length), oneLine(String(data.description ?? ""))];
  });
}

function schemas(): string[][] {
  const dir = path.join(root, "schemas");
  return fs.readdirSync(dir).filter((name) => name.endsWith(".schema.json")).sort().map((name) => {
    const data = loadJson<Record<string, unknown>>(path.join(dir, name));
    return [name, oneLine(String(data.title ?? "")), oneLine(String(data.$id ?? ""))];
  });
}

function powers(): string[][] {
  const dir = path.join(root, "powers");
  return fs.readdirSync(dir).sort().flatMap((name) => exists(path.join(dir, name, "POWER.md")) ? [[name, rel(path.join(dir, name, "POWER.md"))]] : []);
}

function packs(): string[][] {
  const data = loadJson<{ packs?: Array<Record<string, unknown>> }>(path.join(root, "packaging/packs.json"));
  return (data.packs ?? []).map((pack) => [
    String(pack.name ?? ""),
    pack.default ? "yes" : "no",
    String(Array.isArray(pack.skills) ? pack.skills.length : 0),
    String(Array.isArray(pack.agents) ? pack.agents.length : 0),
    String(Array.isArray(pack.powers) ? pack.powers.length : 0),
    oneLine(String(pack.description ?? "")),
  ]);
}

function latestRuntimeStates(includeRuntime: boolean): string[] {
  if (!includeRuntime) {
    return [
      "Runtime workflow state is excluded from the committed map.",
      "Regenerate locally with `npm run context-map -- --include-runtime` to include recent `.agents/flow-agents` state.",
    ];
  }
  const workflowDir = path.join(root, ".agents/flow-agents");
  if (!exists(workflowDir)) return ["No local workflow state found under `.agents/flow-agents`."];
  const states = fs.readdirSync(workflowDir).map((name) => path.join(workflowDir, name, "state.json")).filter(exists).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!states.length) return ["No local workflow state found under `.agents/flow-agents`."];
  const rows = states.slice(0, 8).map((file) => {
    const data = loadJson<Record<string, unknown>>(file);
    const next = typeof data.next_action === "object" && data.next_action ? data.next_action as Record<string, unknown> : {};
    return [String(data.task_slug ?? path.basename(path.dirname(file))), String(data.status ?? ""), String(data.phase ?? ""), oneLine(String(next.summary ?? ""))];
  });
  return markdownTable(["Task", "Status", "Phase", "Next Action"], rows);
}

function render(includeRuntime: boolean): string {
  const manifest = loadJson<Record<string, unknown>>(path.join(root, "packaging/manifest.json"));
  const [workflowRows, supportRows] = listSkillRows();
  return [
    "---", "title: Context Map", "---", "", "# Context Map", "",
    "Generated by `npm run context-map`. Regenerate after changing agents, skills, schemas, workflow contracts, or core commands.", "",
    "## How To Use This", "",
    "- Start here when a session is long, resumed, or context-constrained.",
    "- Load only the specific skill, contract, schema, or doc that matches the task.",
    "- Treat `.agents/flow-agents` as runtime state and `dist/` as generated output.", "",
    "## Repository Shape", "", ...markdownTable(["Path", "Role", "Purpose"], repoShape(manifest)), "",
    "## Core Commands", "", ...markdownTable(["Use", "Command"], commands), "",
    "## Workflow Sidecars", "",
    "Machine-readable workflow state lives beside Markdown artifacts in `.agents/flow-agents/<slug>/`.", "",
    ...markdownTable(["Schema", "Title", "ID"], schemas()), "",
    "Primary tools: `npm run workflow-sidecar`, `npm run workflow-artifacts`, `scripts/hooks/stop-goal-fit.js`, and `scripts/hooks/workflow-steering.js`.", "",
    "## Workflow Skills", "", ...markdownTable(["Skill", "Source", "When To Load"], workflowRows), "",
    "## Support Skills", "", ...markdownTable(["Skill", "Source", "When To Load"], supportRows), "",
    "## Agents", "", ...markdownTable(["Agent", "Model", "Tools", "Role"], agents()), "",
    "## Optional Powers", "", ...markdownTable(["Power", "Source"], powers()), "",
    "## Packs", "",
    "Pack composition is defined in `packaging/packs.json`. The current builder exports pack metadata in bundle catalogs, and generated install scripts support opt-in `FLOW_AGENTS_PACKS` filtering while leaving all packs installed by default.", "",
    ...markdownTable(["Pack", "Default", "Skills", "Agents", "Powers", "Purpose"], packs()), "",
    "## Current Workflow State", "", ...latestRuntimeStates(includeRuntime), "",
    "## Context Loading Rules", "",
    "- For delivery work, load `deliver`, then the specific primitive skill for the current phase.",
    "- For planning, verification, release, learning, or artifact validation, load `context/contracts/artifact-contract.md` plus the phase contract.",
    "- For unknown external APIs or libraries, use `search-first` before implementation.",
    "- For large or noisy sessions, prefer sidecars and this map over rereading broad docs.",
    "- For generated exports, edit source files and rebuild instead of editing `dist/`.", "",
  ].join("\n");
}

export function main(argv = process.argv.slice(2)): number {
  const args = argv;
  const check = args.includes("--check");
  const includeRuntime = args.includes("--include-runtime");
  const outputIndex = args.indexOf("--output");
  const output = outputIndex >= 0 && args[outputIndex + 1] ? path.resolve(args[outputIndex + 1]) : defaultOutput;
  const text = render(includeRuntime);
  if (check) {
    const current = exists(output) ? readText(output) : "";
    if (current !== text) {
      console.error(`${rel(output)} is stale; run npm run context-map`);
      return 1;
    }
    console.log(`${rel(output)} is current.`);
    return 0;
  }
  writeText(output, text);
  console.log(`Wrote ${rel(output)}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
