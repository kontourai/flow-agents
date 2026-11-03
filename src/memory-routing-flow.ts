/**
 * Records memory routing as Flow evidence, and reads it back for recomputation.
 *
 * A host flow owns the gate. This module attaches custom-kind evidence entries
 * to a gate the host names: a batch of routing decisions (each self-contained
 * and digest-addressed) and the run's metrics. Flow stamps the attachment time
 * and the file digest; nothing here has a clock.
 *
 * Flow 5.4 gate expectations accept only `trust.bundle`, so these entries are
 * recorded and recomputable but a gate cannot yet require them.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { attachEvidence, loadRun, type FlowEvidenceEntry } from "@kontourai/flow";
import { canonicalJson } from "@kontourai/relay";
import { MemoryClaimError } from "./memory-claims.js";
import { MEMORY_ROUTING_VERSION, recomputeMemoryRouting, type MemoryRoutingDecision, type MemoryRunMetrics } from "./memory-routing.js";

export const MEMORY_ROUTING_EVIDENCE_KIND = "memory.routing-decisions";
export const MEMORY_METRICS_EVIDENCE_KIND = "memory.run-metrics";
const PRODUCER = "knowledge.memory-routing";

/** The evidence file for the routing kind: one batch of a run's decisions. */
export interface MemoryRoutingRecord {
  schema_version: typeof MEMORY_ROUTING_VERSION;
  runId: string;
  decisions: MemoryRoutingDecision[];
}

interface Location { runId: string; gate: string; cwd?: string }

const bytesOf = (body: unknown) => `${canonicalJson(body)}\n`;
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const isLive = (entry: FlowEvidenceEntry) => typeof entry.superseded_by !== "string";

async function attachJson(where: Location, kind: string, body: unknown, supersede?: string[]): Promise<FlowEvidenceEntry> {
  const dir = await mkdtemp(path.join(tmpdir(), "memory-routing-evidence-"));
  try {
    const file = path.join(dir, `${kind}.json`);
    await writeFile(file, bytesOf(body), { mode: 0o600 });
    return await attachEvidence(where.runId, {
      ...(where.cwd ? { cwd: where.cwd } : {}), gate: where.gate, file, kind, producer: PRODUCER,
      ...(supersede?.length ? { supersede } : {}),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function liveEntries(where: Location, kind: string): Promise<FlowEvidenceEntry[]> {
  const run = await loadRun(where.runId, where.cwd);
  return (run.manifest.evidence as FlowEvidenceEntry[]).filter(entry => entry.requested_kind === kind && entry.gate_id === where.gate && isLive(entry));
}

/**
 * Attaches a batch of routing decisions to `gate`. Every decision must
 * recompute from its own input and policy, or nothing is attached: the run
 * never holds evidence that disagrees with its own rules. Attaching the same
 * batch again returns the entry already there, so a retry after a lost reply
 * does not double-record.
 */
export async function recordMemoryRoutingEvidence(input: Location & { decisions: readonly MemoryRoutingDecision[] }): Promise<FlowEvidenceEntry> {
  for (const decision of input.decisions) {
    const check = recomputeMemoryRouting(decision);
    if (!check.ok) throw new MemoryClaimError("invalid", `routing decision ${decision.id} does not recompute: ${check.mismatches.join("; ")}`);
  }
  const ids = input.decisions.map(decision => decision.id);
  if (new Set(ids).size !== ids.length) throw new MemoryClaimError("invalid", "a batch names the same routing decision twice");
  const record: MemoryRoutingRecord = { schema_version: MEMORY_ROUTING_VERSION, runId: input.runId, decisions: [...input.decisions] };
  const digest = sha256(bytesOf(record));
  const existing = (await liveEntries(input, MEMORY_ROUTING_EVIDENCE_KIND)).find(entry => entry.sha256 === digest);
  return existing ?? attachJson(input, MEMORY_ROUTING_EVIDENCE_KIND, record);
}

/**
 * Attaches the run's metrics to `gate`, superseding the run's previous metrics
 * entry so the latest figures are the live ones and earlier figures stay in the
 * manifest. Identical metrics are not attached twice.
 */
export async function recordMemoryMetricsEvidence(input: Location & { metrics: MemoryRunMetrics }): Promise<FlowEvidenceEntry> {
  if (input.metrics.runId !== input.runId) throw new MemoryClaimError("invalid", "metrics belong to a different run");
  const digest = sha256(bytesOf(input.metrics));
  const live = await liveEntries(input, MEMORY_METRICS_EVIDENCE_KIND);
  return live.find(entry => entry.sha256 === digest) ?? attachJson(input, MEMORY_METRICS_EVIDENCE_KIND, input.metrics, live.map(entry => entry.id));
}

export interface StoredMemoryEvidence<T> { evidenceId: string; superseded: boolean; value: T }

async function readStored<T>(runId: string, cwd: string | undefined, kind: string): Promise<StoredMemoryEvidence<T>[]> {
  const run = await loadRun(runId, cwd);
  const out: StoredMemoryEvidence<T>[] = [];
  for (const entry of run.manifest.evidence as FlowEvidenceEntry[]) {
    if (entry.requested_kind !== kind || typeof entry.stored_path !== "string") continue;
    const bytes = await readFile(path.join(run.dir, entry.stored_path));
    if (sha256(bytes) !== entry.sha256) throw new MemoryClaimError("invalid", `evidence ${entry.id} no longer matches its recorded digest`);
    out.push({ evidenceId: entry.id, superseded: !isLive(entry), value: JSON.parse(bytes.toString("utf8")) as T });
  }
  return out;
}

export const readMemoryRoutingEvidence = (runId: string, cwd?: string) => readStored<MemoryRoutingRecord>(runId, cwd, MEMORY_ROUTING_EVIDENCE_KIND);
export const readMemoryMetricsEvidence = (runId: string, cwd?: string) => readStored<MemoryRunMetrics>(runId, cwd, MEMORY_METRICS_EVIDENCE_KIND);

/** Every routing decision recorded for a run, across batches, once each, in the order recorded. */
export async function readMemoryRoutingDecisions(runId: string, cwd?: string): Promise<MemoryRoutingDecision[]> {
  const seen = new Set<string>();
  const decisions: MemoryRoutingDecision[] = [];
  for (const { value } of await readMemoryRoutingEvidence(runId, cwd)) {
    for (const decision of value.decisions) if (!seen.has(decision.id)) { seen.add(decision.id); decisions.push(decision); }
  }
  return decisions;
}

/**
 * Recomputes every stored routing decision of a run from its own input and
 * policy. A digest mismatch on a stored file throws; a decision whose outcome
 * no longer follows from its input is returned as a mismatch.
 */
export async function recomputeRecordedMemoryRouting(runId: string, cwd?: string): Promise<{ decisions: number; mismatches: { decisionId: string; mismatches: string[] }[] }> {
  const decisions = await readMemoryRoutingDecisions(runId, cwd);
  const mismatches: { decisionId: string; mismatches: string[] }[] = [];
  for (const decision of decisions) {
    const check = recomputeMemoryRouting(decision);
    if (!check.ok) mismatches.push({ decisionId: decision.id, mismatches: check.mismatches });
  }
  return { decisions: decisions.length, mismatches };
}
