#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { requireOwnedArtifactPublisher } from "../adapters/shared/owned-artifacts.js";
import { KnowledgeIngestFlow } from "./index.js";
import { DefaultKnowledgeStore } from "../adapters/default-store/index.js";

const flags = {};
const allowed = new Set(["input", "workspace", "store-root", "run-id", "flow-bin", "python-bin"]);
try {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.slice(2);
    if (!args[i]?.startsWith("--") || !allowed.has(key) || !args[i + 1] || flags[key]) {
      throw new Error("Usage: node ingest/cli.js --input capture.json --workspace PATH --store-root PATH --run-id ID [--flow-bin PATH] [--python-bin PATH]");
    }
    flags[key] = args[i + 1];
  }
  for (const key of ["input", "workspace", "store-root", "run-id"]) {
    if (!flags[key]) throw new Error(`--${key} is required`);
  }
  const input = JSON.parse(fs.readFileSync(flags.input, "utf8"));
  requireOwnedArtifactPublisher([flags["python-bin"] || "python3"]);
  const pilot = new KnowledgeIngestFlow({
    store: new DefaultKnowledgeStore({ storeRoot: path.resolve(flags["store-root"]) }),
    workspace: flags.workspace, runId: flags["run-id"], pythonCommand: [flags["python-bin"] || "python3"], flowCommand: [flags["flow-bin"] || "flow"],
  });
  console.log(JSON.stringify(await pilot.capture(input.rawText, input.meta), null, 2));
} catch (error) {
  console.error(`${error.code || "INGEST_FAILED"}: ${error.message}`);
  process.exitCode = 1;
}
