import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify, isDeepStrictEqual } from "node:util";
import { requireOwnedArtifactPublisher, openOwnedDirectory, publishOwnedArtifact } from "../adapters/shared/owned-artifacts.js";
import { TrustBundleBuilder } from "@kontourai/surface";
import { inferCategory, inferTitle } from "../adapters/flow-runner/classification.js";

const execute = promisify(execFile);
const definition = fileURLToPath(new URL("../flows/ingest.flow.json", import.meta.url));
const producer = "knowledge.ingest";


function inspectDirectories(root, relative) {
  let current = root;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return null;
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(current) !== current) {
      throw new Error(`UNSAFE_INGEST_PATH: expected an owned non-symlink directory: ${current}`);
    }
  }
  return fs.lstatSync(current);
}

/** One-shot ingest pilot. Flow owns all gate evaluation and cursor changes. */
export class KnowledgeIngestFlow {
  constructor({ store, workspace, runId, flowCommand = ["flow"], pythonCommand = ["python3"], agent = "knowledge-flow-runner" }) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(runId || "")) {
      throw new Error("ingest requires a safe, unique runId");
    }
    this.store = store;
    this.workspace = path.resolve(workspace);
    this.runId = runId;
    this.flowCommand = flowCommand;
    this.pythonCommand = pythonCommand;
    this.agent = agent;
    this.artifactRoot = path.join(this.workspace, ".kontourai", "knowledge", "ingest", runId);
    this.trace = [];
  }

  assertWorkspaceCustody() {
    const root = fs.lstatSync(this.workspace);
    const heldRoot = fs.fstatSync(this.workspaceFd);
    if (root.isSymbolicLink() || !root.isDirectory() || root.dev !== heldRoot.dev || root.ino !== heldRoot.ino) {
      throw new Error("UNSAFE_INGEST_PATH: workspace root custody changed");
    }
  }

  assertArtifactCustody() {
    this.assertWorkspaceCustody();
    const stat = inspectDirectories(this.workspace, path.relative(this.workspace, this.artifactRoot));
    if (!stat || stat.dev !== fs.fstatSync(this.artifactFd).dev || stat.ino !== fs.fstatSync(this.artifactFd).ino) {
      throw new Error("UNSAFE_INGEST_PATH: ingest artifact directory custody changed");
    }
    const trace = fs.lstatSync(path.join(this.artifactRoot, "trace.jsonl"));
    if (!trace.isFile() || trace.isSymbolicLink()) throw new Error("UNSAFE_INGEST_PATH: trace must remain a regular file");
  }

  writeJson(name, value) {
    this.assertArtifactCustody();
    const file = path.join(this.artifactRoot, name);
    const text = `${JSON.stringify(value, null, 2)}\n`;
    const { digest } = publishOwnedArtifact(this.artifactFd, name, text, { pythonCommand: this.pythonCommand });
    this.assertArtifactCustody();
    return { file, digest };
  }

  async command(args, { evaluation = false } = {}) {
    this.assertArtifactCustody();
    const [binary, ...prefix] = this.flowCommand;
    const argv = [...prefix, ...args, "--cwd", this.workspace];
    let result;
    try {
      result = await execute(binary, argv, { maxBuffer: 4 * 1024 * 1024, timeout: 60_000 });
      result.code = 0;
    } catch (error) {
      result = error;
    }
    const entry = { args, exitCode: result.code, stdout: result.stdout || "", stderr: result.stderr || "" };
    this.trace.push(entry);
    this.assertArtifactCustody();
    publishOwnedArtifact(this.artifactFd, "trace.jsonl", `${JSON.stringify(entry)}\n`, { append: true, pythonCommand: this.pythonCommand });
    this.assertArtifactCustody();
    if (result.code !== 0) {
      const error = new Error(`Flow ${args[0]} failed: ${entry.stderr || entry.stdout || result.message}`);
      error.code = evaluation && result.code === 1 ? "FLOW_GATE_BLOCKED" : "FLOW_CLI_FAILURE";
      error.trace = this.trace;
      throw error;
    }
    return entry.stdout;
  }

  async start() {
    requireOwnedArtifactPublisher(this.pythonCommand);
    fs.mkdirSync(this.workspace, { recursive: true, mode: 0o700 });
    const rootStat = fs.lstatSync(this.workspace);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("UNSAFE_INGEST_PATH: workspace must be a real directory");
    this.workspace = fs.realpathSync(this.workspace);
    this.workspaceFd = openOwnedDirectory(this.workspace);
    this.artifactRoot = path.join(this.workspace, ".kontourai", "knowledge", "ingest", this.runId);
    inspectDirectories(this.workspace, path.relative(this.workspace, this.artifactRoot));
    inspectDirectories(this.workspace, path.join(".kontourai", "flow", "runs"));
    inspectDirectories(this.workspace, ".flow");
    const config = fs.lstatSync(path.join(this.workspace, ".flow", "config.json"), { throwIfNoEntry: false });
    if (config && (!config.isFile() || config.isSymbolicLink())) throw new Error("UNSAFE_INGEST_PATH: Flow config must be a regular file");
    const initialize = !config;
    if (initialize) {
      inspectDirectories(this.workspace, path.join(".flow", "definitions"));
      // Flow 5.2 init overwrites these scaffolds. Refuse partial authored layouts first.
      for (const relative of ["README.md", "config.json", path.join("definitions", "agent-dev-flow.json")]) {
        if (fs.lstatSync(path.join(this.workspace, ".flow", relative), { throwIfNoEntry: false })) {
          throw new Error(`FLOW_INIT_COLLISION: existing Flow scaffold would be overwritten: ${relative}`);
        }
      }
    }
    let relative = "";
    for (const component of [".kontourai", "knowledge", "ingest"]) {
      relative = path.join(relative, component);
      inspectDirectories(this.workspace, relative);
      this.assertWorkspaceCustody();
      try { fs.mkdirSync(path.join(this.workspace, relative), { mode: 0o700 }); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      inspectDirectories(this.workspace, relative);
    }
    // A partially executed run is retained for inspection, never retried as a fresh ingest.
    this.assertWorkspaceCustody();
    fs.mkdirSync(this.artifactRoot, { mode: 0o700 });
    this.artifactFd = openOwnedDirectory(this.artifactRoot);
    publishOwnedArtifact(this.artifactFd, "trace.jsonl", "", { pythonCommand: this.pythonCommand });
    if (initialize) await this.command(["init"]);
    await this.command(["start", definition, "--run-id", this.runId]);
  }

  async evaluate(gate) {
    return this.command(["evaluate", this.runId, "--gate", gate, "--exit-code"], { evaluation: true });
  }

  async recordClaim(stage, subjectType, value) {
    const now = new Date().toISOString();
    const { file: sourceFile, digest } = this.writeJson(`${stage}.json`, value);
    const claimId = `${this.runId}:${stage}`;
    const builder = new TrustBundleBuilder({ source: `${producer}:${this.runId}:${stage}` });
    builder.addVerifiedClaim({
      claim: {
        id: claimId, subjectType, subjectId: `${this.runId}:${stage}`,
        claimType: `${producer}.${stage}`, fieldOrBehavior: stage, value,
        createdAt: now, updatedAt: now, verificationPolicyId: `${stage}-policy`,
      },
      evidence: {
        id: `${claimId}:evidence`, evidenceType: "runtime_observation", method: "validation",
        sourceRef: sourceFile, excerptOrSummary: `${stage} operation readback; sha256=${digest}`,
        observedAt: now, collectedBy: producer,
      },
      policy: {
        id: `${stage}-policy`, claimType: `${producer}.${stage}`, requiredEvidence: ["runtime_observation"],
        requiredMethods: ["validation"], acceptanceCriteria: [`${stage} operation completed`],
        reviewAuthority: producer, validityRule: { kind: "manual" }, stalenessTriggers: [],
        conflictRules: [], impactLevel: "medium",
      },
      event: {
        id: `${claimId}:verification`, actor: producer, method: "validation",
        createdAt: now, verifiedAt: now, notes: "Operation verification only; source content is not independently verified.",
      },
    });
    const { file: bundleFile } = this.writeJson(`${stage}.trust.json`, builder.build());
    await this.command(["attach-evidence", this.runId, "--gate", stage === "classification" ? "classify-gate" : stage === "routing" ? "route-gate" : "capture-gate", "--file", bundleFile, "--kind", "trust.bundle", "--producer", producer]);
  }

  close() {
    for (const key of ["artifactFd", "workspaceFd"]) {
      if (this[key] !== undefined) { fs.closeSync(this[key]); this[key] = undefined; }
    }
  }

  async capture(rawText, meta = {}) {
    try { return await this.captureRun(rawText, meta); }
    finally { this.close(); }
  }

  async captureRun(rawText, meta) {
    await this.start();
    if (typeof rawText !== "string" || !rawText.trim()) {
      const error = new Error("capture: rawText must be a non-empty string");
      error.code = "MISSING_EVIDENCE";
      throw error;
    }
    await this.recordClaim("capture", "artifact", { rawText, meta });
    await this.evaluate("capture-gate");

    const category = inferCategory(rawText, meta);
    if (typeof category !== "string" || !/^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/.test(category)) {
      const error = new Error("classify: category must be a valid dot-separated string");
      error.code = "MISSING_EVIDENCE";
      throw error;
    }
    const input = {
      type: "raw", title: inferTitle(rawText, meta), body: rawText, category, tags: meta.tags || [],
      provenance: {
        agent: meta.agent || this.agent,
        ...(meta.session_id ? { session_id: meta.session_id } : {}),
        ...(meta.note ? { note: meta.note } : {}),
      },
    };
    const id = await this.store.create(input);
    const record = await this.store.get(id);
    if (typeof id !== "string" || !id.trim() || id !== id.trim() || !record || record.id !== id || record.type !== "raw" || record.category !== category || record.body !== rawText
      || record.title !== input.title || !isDeepStrictEqual(record.tags, input.tags)
      || !isDeepStrictEqual(record.provenance, input.provenance)) {
      throw new Error("classify: store readback does not match the captured raw record");
    }
    await this.recordClaim("classification", "artifact", { id, record });
    await this.evaluate("classify-gate");

    const routing = meta.routing || "queue-for-compile";
    if (typeof routing !== "string" || !routing.trim()) throw new Error("route: routing decision must be non-empty");
    await this.recordClaim("routing", "decision", { record_id: id, routing_decision: routing });
    await this.evaluate("route-gate");
    return { id, record, routing, runId: this.runId, artifactRoot: this.artifactRoot, trace: this.trace };
  }
}
