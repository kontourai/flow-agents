#!/usr/bin/env node
import { basename } from "node:path";
import { main as effectiveBacklogSettings } from "./cli/effective-backlog-settings.js";
import { main as buildDocsPreview } from "./cli/docs-preview.js";
import { main as consoleLearningProjection } from "./cli/console-learning-projection.js";
import { main as flowKit } from "./cli/flow-kit.js";
import { main as init } from "./cli/init.js";
import { main as promoteWorkflowArtifact } from "./cli/promote-workflow-artifact.js";
import { main as publishChange } from "./cli/publish-change-helper.js";
import { main as pullWorkProvider } from "./cli/pull-work-provider.js";
import { main as usageFeedback } from "./cli/usage-feedback.js";
import { main as veritasGovernance } from "./cli/veritas-governance.js";
import { main as workflowArtifactCleanupAudit } from "./cli/workflow-artifact-cleanup-audit.js";
import { main as buildBundles } from "./tools/build-universal-bundles.js";
import { main as contextMap } from "./tools/generate-context-map.js";
import { main as filterInstalledPacks } from "./tools/filter-installed-packs.js";
import { main as validateSource } from "./tools/validate-source-tree.js";
import { main as validatePackage } from "./tools/validate-package.js";
import { main as validateHookInfluence } from "./cli/validate-hook-influence.js";
import { main as runtimeAdapter } from "./cli/runtime-adapter.js";

const availableCommands = new Map<string, (argv: string[]) => number | Promise<number>>([
  ["build-bundles", () => buildBundles()],
  ["build-docs-preview", () => buildDocsPreview()],
  ["console-learning-projection", consoleLearningProjection],
  ["context-map", contextMap],
  ["effective-backlog-settings", effectiveBacklogSettings],
  ["filter-installed-packs", filterInstalledPacks],
  ["flow-kit", flowKit],
  ["init", init],
  ["promote-workflow-artifact", promoteWorkflowArtifact],
  ["publish-change", publishChange],
  ["pull-work-provider", pullWorkProvider],
  ["runtime-adapter", runtimeAdapter],
  ["usage-feedback", usageFeedback],
  ["veritas-governance", veritasGovernance],
  ["validate-package", validatePackage],
  ["validate-hook-influence", validateHookInfluence],
  ["validate-source", validateSource],
  ["workflow-artifact-cleanup-audit", workflowArtifactCleanupAudit],
]);

const aliases = new Map<string, string>([
  ["flow-agents-build-bundles", "build-bundles"],
  ["flow-agents-build-docs-preview", "build-docs-preview"],
  ["flow-agents-console-learning-projection", "console-learning-projection"],
  ["flow-agents-context-map", "context-map"],
  ["flow-agents-effective-backlog-settings", "effective-backlog-settings"],
  ["flow-agents-filter-installed-packs", "filter-installed-packs"],
  ["flow-agents-flow-kit", "flow-kit"],
  ["flow-agents-promote-workflow-artifact", "promote-workflow-artifact"],
  ["flow-agents-publish-change", "publish-change"],
  ["flow-agents-pull-work-provider", "pull-work-provider"],
  ["flow-agents-runtime-adapter", "runtime-adapter"],
  ["flow-agents-usage-feedback", "usage-feedback"],
  ["flow-agents-veritas-governance", "veritas-governance"],
  ["flow-agents-validate-hook-influence", "validate-hook-influence"],
  ["flow-agents-validate-source", "validate-source"],
  ["flow-agents-workflow-artifact-cleanup-audit", "workflow-artifact-cleanup-audit"],
]);

function printHelp(): void {
  console.log("Usage: flow-agents <command> [args]");
  console.log("");
  console.log("Available commands:");
  for (const name of availableCommands.keys()) console.log(`  ${name}`);
}

const invokedAs = basename(process.argv[1] ?? "flow-agents");
const commandName = aliases.get(invokedAs) ?? process.argv[2];
const forwardedArgs = aliases.has(invokedAs) ? process.argv.slice(2) : process.argv.slice(3);

async function run(): Promise<number> {
  if (!commandName || commandName === "--help" || commandName === "-h" || commandName === "help") {
    printHelp();
    return 0;
  }

  if (commandName === "commands" || commandName === "list") {
    for (const name of availableCommands.keys()) console.log(name);
    return 0;
  }

  const availableCommand = availableCommands.get(commandName);
  if (availableCommand) return await availableCommand(forwardedArgs);

  console.error(`Unknown flow-agents command: ${commandName}`);
  console.error("Run `flow-agents --help` for registered commands.");
  return 64;
}

process.exit(await run());
