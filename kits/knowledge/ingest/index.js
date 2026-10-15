import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify, isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { TrustBundleBuilder } from "@kontourai/surface";
import { inferCategory, inferTitle } from "../adapters/flow-runner/classification.js";

const execute = promisify(execFile);
const definition = fileURLToPath(new URL("../flows/ingest.flow.json", import.meta.url));
const producer = "knowledge.ingest";

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

/** One-shot ingest pilot. Flow owns all gate evaluation and cursor changes. */
export class KnowledgeIngestFlow {
  constructor({ store, workspace, runId, flowCommand = ["flow"], agent = "knowledge-flow-runner" }) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(runId || "")) {
      throw new Error("ingest requires a safe, unique runId");
    }
    this.store = store;
    this.workspace = path.resolve(workspace);
    this.runId = runId;
    this.flowCommand = flowCommand;
    this.agent = agent;
    this.artifactRoot = path.join(this.workspace, ".kontourai", "knowledge", "ingest", runId);
    this.trace = [];
  }

  async command(args, { evaluation = false } = {}) {
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
    fs.appendFileSync(path.join(this.artifactRoot, "trace.jsonl"), `${JSON.stringify(entry)}\n`);
    if (result.code !== 0) {
      const error = new Error(`Flow ${args[0]} failed: ${entry.stderr || entry.stdout || result.message}`);
      error.code = evaluation && result.code === 1 ? "FLOW_GATE_BLOCKED" : "FLOW_CLI_FAILURE";
      error.trace = this.trace;
      throw error;
    }
    return entry.stdout;
  }

  async start() {
    fs.mkdirSync(path.dirname(this.artifactRoot), { recursive: true });
    // A partially executed run is retained for inspection, never retried as a fresh ingest.
    fs.mkdirSync(this.artifactRoot);
    await this.command(["init"]);
    await this.command(["start", definition, "--run-id", this.runId]);
  }

  async evaluate(gate) {
    return this.command(["evaluate", this.runId, "--gate", gate, "--exit-code"], { evaluation: true });
  }

  async recordClaim(stage, subjectType, value) {
    const now = new Date().toISOString();
    const sourceFile = path.join(this.artifactRoot, `${stage}.json`);
    writeJson(sourceFile, value);
    const digest = createHash("sha256").update(fs.readFileSync(sourceFile)).digest("hex");
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
    const bundleFile = path.join(this.artifactRoot, `${stage}.trust.json`);
    writeJson(bundleFile, builder.build());
    await this.command(["attach-evidence", this.runId, "--gate", stage === "classification" ? "classify-gate" : stage === "routing" ? "route-gate" : "capture-gate", "--file", bundleFile, "--kind", "trust.bundle", "--producer", producer]);
  }

  async capture(rawText, meta = {}) {
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
    if (!record || record.type !== "raw" || record.category !== category || record.body !== rawText
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
