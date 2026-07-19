#!/usr/bin/env node
import { basename } from "node:path";
import { main as effectiveBacklogSettings } from "./cli/effective-backlog-settings.js";
import { main as effectiveAssignmentProviderSettings } from "./cli/effective-assignment-provider-settings.js";
import { main as assignmentProvider } from "./cli/assignment-provider.js";
import { main as builderRun } from "./cli/builder-run.js";
import { main as consoleLearningProjection } from "./cli/console-learning-projection.js";
import { main as kit } from "./cli/kit.js";
import { main as fixtureRetirementAudit } from "./cli/fixture-retirement-audit.js";
import { main as init } from "./cli/init.js";
import { main as promoteWorkflowArtifact } from "./cli/promote-workflow-artifact.js";
import { main as publishChange } from "./cli/publish-change-helper.js";
import { main as pullWorkProvider } from "./cli/pull-work-provider.js";
import { main as narrativeRender } from "./cli/narrative-render.js";
import { main as narrativeSources } from "./cli/narrative-sources.js";
import { main as telemetryDoctor } from "./cli/telemetry-doctor.js";
import { main as usageFeedback } from "./cli/usage-feedback.js";
import { main as workflowArtifactCleanupAudit } from "./cli/workflow-artifact-cleanup-audit.js";
import { main as workflow } from "./cli/workflow.js";
import { main as buildBundles } from "./tools/build-universal-bundles.js";
import { main as capabilityMatrix } from "./tools/generate-capability-matrix.js";
import { main as contextMap } from "./tools/generate-context-map.js";
import { main as validateSource } from "./tools/validate-source-tree.js";
import { main as validatePackage } from "./tools/validate-package.js";
import { main as validateHookInfluence } from "./cli/validate-hook-influence.js";
import { main as runtimeAdapter } from "./cli/runtime-adapter.js";
import { main as skillDriftCheck } from "./cli/skill-drift-check.js";
import { main as utteranceCheck } from "./cli/utterance-check.js";
import { main as verify } from "./cli/verify.js";

const availableCommands = new Map<string, (argv: string[]) => number | Promise<number>>([
  ["build-bundles", () => buildBundles()],
  ["builder-run", builderRun],
  ["capability-matrix", capabilityMatrix],
  ["console-learning-projection", consoleLearningProjection],
  ["context-map", contextMap],
  ["assignment-provider", assignmentProvider],
  ["effective-assignment-provider-settings", effectiveAssignmentProviderSettings],
  ["effective-backlog-settings", effectiveBacklogSettings],
  ["fixture-retirement-audit", fixtureRetirementAudit],
  ["kit", kit],
  ["narrative-render", narrativeRender],
  ["narrative-sources", narrativeSources],
  ["init", init],
  ["promote-workflow-artifact", promoteWorkflowArtifact],
  ["publish-change", publishChange],
  ["pull-work-provider", pullWorkProvider],
  ["runtime-adapter", runtimeAdapter],
  ["skill-drift-check", skillDriftCheck],
  ["utterance-check", utteranceCheck],
  ["telemetry-doctor", telemetryDoctor],
  ["usage-feedback", usageFeedback],
  ["validate-package", validatePackage],
  ["validate-hook-influence", validateHookInfluence],
  ["verify", verify],
  ["workflow", workflow],
  ["validate-source", validateSource],
  ["workflow-artifact-cleanup-audit", workflowArtifactCleanupAudit],
]);

const aliases = new Map<string, string>([
  ["flow-agents-build-bundles", "build-bundles"],
  ["flow-agents-capability-matrix", "capability-matrix"],
  ["flow-agents-console-learning-projection", "console-learning-projection"],
  ["flow-agents-context-map", "context-map"],
  ["flow-agents-assignment-provider", "assignment-provider"],
  ["flow-agents-effective-assignment-provider-settings", "effective-assignment-provider-settings"],
  ["flow-agents-effective-backlog-settings", "effective-backlog-settings"],
  ["flow-agents-fixture-retirement-audit", "fixture-retirement-audit"],
  ["flow-agents-kit", "kit"],
  ["flow-agents-narrative-render", "narrative-render"],
  ["flow-agents-promote-workflow-artifact", "promote-workflow-artifact"],
  ["flow-agents-publish-change", "publish-change"],
  ["flow-agents-pull-work-provider", "pull-work-provider"],
  ["flow-agents-runtime-adapter", "runtime-adapter"],
  ["flow-agents-skill-drift-check", "skill-drift-check"],
  ["flow-agents-telemetry-doctor", "telemetry-doctor"],
  ["flow-agents-usage-feedback", "usage-feedback"],
  ["flow-agents-validate-hook-influence", "validate-hook-influence"],
  ["flow-agents-utterance-check", "utterance-check"],
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
