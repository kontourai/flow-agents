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
import type { ReviewDecision, ReviewItem, ReviewSessionEvent } from "@kontourai/survey";
import {
  MEMORY_ROUTING_VERSION, buildMemoryReviewItem, deriveMemoryRunMetrics, recomputeMemoryRouting, routeMemoryChanges,
  type MemoryChange, type MemoryRoutingDecision, type MemoryRoutingPolicy, type MemoryRunMetrics,
} from "./memory-routing.js";

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

// Flow's run lock is not re-entrant, so check-then-attach cannot run inside it. Within one process the two steps are
// serialised here, which makes them exact. Across processes a lost race can leave a duplicate of an identical routing
// batch (readers dedupe by decision id) or two live metrics entries (readers take the last); it cannot lose or corrupt one.
const tails = new Map<string, Promise<unknown>>();
function serialized<T>(where: Location, work: () => Promise<T>): Promise<T> {
  const key = `${path.resolve(where.cwd ?? process.cwd())}\0${where.runId}`;
  const run = (tails.get(key) ?? Promise.resolve()).then(work, work);
  const tail = run.catch(() => undefined);
  tails.set(key, tail);
  void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
  return run;
}

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
export function recordMemoryRoutingEvidence(input: Location & { decisions: readonly MemoryRoutingDecision[] }): Promise<FlowEvidenceEntry> {
  return serialized(input, () => recordRouting(input));
}
async function recordRouting(input: Location & { decisions: readonly MemoryRoutingDecision[] }): Promise<FlowEvidenceEntry> {
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
export function recordMemoryMetricsEvidence(input: Location & { metrics: MemoryRunMetrics }): Promise<FlowEvidenceEntry> {
  return serialized(input, () => recordMetrics(input));
}
async function recordMetrics(input: Location & { metrics: MemoryRunMetrics }): Promise<FlowEvidenceEntry> {
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

/** The run's current metrics: the last live entry, so two live entries from a cross-process race still read as one answer. */
export async function readLatestMemoryMetrics(runId: string, cwd?: string): Promise<StoredMemoryEvidence<MemoryRunMetrics> | undefined> {
  return (await readMemoryMetricsEvidence(runId, cwd)).filter(entry => !entry.superseded).at(-1);
}

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

/** The host's review queue. Survey leaves queue storage to the host; the key makes a retried publish a no-op. */
export interface MemoryReviewQueue { publish(item: ReviewItem, idempotencyKey: string): Promise<void> }

export interface MemoryRoutingRun {
  decisions: MemoryRoutingDecision[];
  /** Survey review items for the routed claim changes, in decision order. */
  items: ReviewItem[];
  /** Survey entity proposals the host must review itself: Survey owns that item. */
  entityProposals: string[];
  /** Item names handed to the queue. Empty when no queue was given: the items exist but nobody has been asked. */
  published: string[];
  routing: FlowEvidenceEntry;
  metrics: FlowEvidenceEntry;
}

/**
 * One run's routing, end to end: decide each change, record the decisions as Flow evidence, hand the review items to
 * the host's queue, and record the run's metrics. Decisions are recorded before anything is queued, so a queued item
 * always has a recorded reason; a retry is safe because both the evidence and the queue publish are idempotent.
 * Metrics cover every decision recorded for the run so far, not only this batch.
 */
export async function runMemoryRouting(input: Location & {
  changes: readonly MemoryChange[];
  policy?: Partial<MemoryRoutingPolicy>;
  queue?: MemoryReviewQueue;
}): Promise<MemoryRoutingRun> {
  const decisions = routeMemoryChanges(input.changes, input.policy);
  const routing = await recordMemoryRoutingEvidence({ runId: input.runId, gate: input.gate, cwd: input.cwd, decisions });
  const items: ReviewItem[] = [], entityProposals: string[] = [], published: string[] = [];
  for (const decision of decisions) {
    if (decision.outcome !== "routed") continue;
    if (decision.input.type === "entity") { entityProposals.push(decision.input.proposalRef); continue; }
    const item = buildMemoryReviewItem(decision)!;
    items.push(item);
    if (input.queue) { await input.queue.publish(item, decision.id); published.push(item.metadata.name); }
  }
  const metrics = await refreshMemoryRunMetrics({ runId: input.runId, gate: input.gate, cwd: input.cwd });
  return { decisions, items, entityProposals, published, routing, metrics };
}

/**
 * Recomputes the run's metrics from its recorded decisions and the Survey review so far, and records them as the
 * run's current metrics. Call it as reviewers decide.
 */
export async function refreshMemoryRunMetrics(input: Location & { reviewDecisions?: readonly ReviewDecision[]; reviewEvents?: readonly ReviewSessionEvent[] }): Promise<FlowEvidenceEntry> {
  const decisions = await readMemoryRoutingDecisions(input.runId, input.cwd);
  const metrics = deriveMemoryRunMetrics({ runId: input.runId, decisions, reviewDecisions: input.reviewDecisions, reviewEvents: input.reviewEvents });
  return recordMemoryMetricsEvidence({ runId: input.runId, gate: input.gate, cwd: input.cwd, metrics });
}
