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
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { attachEvidence, loadRun, type FlowEvidenceEntry } from "@kontourai/flow";
import { canonicalJson } from "@kontourai/relay";
import { MemoryClaimError } from "./memory-claims.js";
import { jsonSnapshotList } from "./memory-json.js";
import type { ReviewDecision, ReviewItem, ReviewSessionEvent } from "@kontourai/survey";
import {
  MEMORY_ROUTING_VERSION, buildMemoryReviewItem, deriveMemoryRunMetrics, recomputeMemoryRouting, routeMemoryChanges,
  type MemoryChange, type MemoryEntityChange, type MemoryRoutingDecision, type MemoryRoutingPolicy, type MemoryRunMetrics, type SurveyEntityProposal,
} from "./memory-routing.js";

export const MEMORY_ROUTING_EVIDENCE_KIND = "memory.routing-decisions";
export const MEMORY_METRICS_EVIDENCE_KIND = "memory.run-metrics";
export const MEMORY_REVIEW_EVIDENCE_KIND = "memory.review-record";
const PRODUCER = "knowledge.memory-routing";

/** The evidence file for the routing kind: one batch of a run's decisions. */
export interface MemoryRoutingRecord {
  schema_version: typeof MEMORY_ROUTING_VERSION;
  runId: string;
  decisions: MemoryRoutingDecision[];
}

/** The Survey review state that fed a run's metrics: decisions and session events, as Survey wrote them. */
export interface MemoryReviewRecord {
  schema_version: typeof MEMORY_ROUTING_VERSION;
  runId: string;
  decisions: ReviewDecision[];
  events: ReviewSessionEvent[];
}

interface Location { runId: string; gate: string; cwd?: string }

// Flow's run lock is not re-entrant, so check-then-attach cannot run inside it. Within one process the two steps are
// serialised here, which makes them exact. Across processes a lost race can leave a duplicate of an identical routing
// batch (readers dedupe by decision id) or two live metrics entries (readers take the last); it cannot lose or corrupt one.
const tails = new Map<string, Promise<unknown>>();
/**
 * The real path of a directory, so two spellings of it (/var and /private/var) share a chain. A directory that does
 * not exist yet is resolved through its nearest existing ancestor, so an alias made later still maps to the same key.
 */
export function canonicalRunPath(dir: string): string {
  try { return realpathSync(dir); } catch {
    const parent = path.dirname(dir);
    return parent === dir ? dir : path.join(canonicalRunPath(parent), path.basename(dir));
  }
}
function serialized<T>(where: Location, work: () => Promise<T>): Promise<T> {
  const key = `${canonicalRunPath(path.resolve(where.cwd ?? process.cwd()))}\0${where.runId}`;
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
export async function recordMemoryRoutingEvidence(input: Location & { decisions: readonly MemoryRoutingDecision[] }): Promise<FlowEvidenceEntry> {
  return (await serialized(input, async () => {
    const recorded = await recordRouting(input);
    // Metrics are derived from what is recorded, so recording refreshes them in the same unit. It does so even when the
    // routing batch was already there: a retry after a failure between the two writes must repair the metrics, not
    // report success over stale ones. Identical metrics are not recorded again.
    await refreshMetrics(input);
    return recorded;
  })).entry;
}
async function recordRouting(input: Location & { decisions: readonly MemoryRoutingDecision[] }): Promise<{ entry: FlowEvidenceEntry; created: boolean }> {
  for (const decision of input.decisions) {
    const check = recomputeMemoryRouting(decision);
    if (!check.ok) throw new MemoryClaimError("invalid", `routing decision ${decision.id} does not recompute: ${check.mismatches.join("; ")}`);
  }
  const ids = input.decisions.map(decision => decision.id);
  if (new Set(ids).size !== ids.length) throw new MemoryClaimError("invalid", "a batch names the same routing decision twice");
  const record: MemoryRoutingRecord = { schema_version: MEMORY_ROUTING_VERSION, runId: input.runId, decisions: [...input.decisions] };
  const digest = sha256(bytesOf(record));
  const existing = (await liveEntries(input, MEMORY_ROUTING_EVIDENCE_KIND)).find(entry => entry.sha256 === digest);
  return existing ? { entry: existing, created: false } : { entry: await attachJson(input, MEMORY_ROUTING_EVIDENCE_KIND, record), created: true };
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
  /**
   * The Survey entity proposals the routing sent to review, as given. Survey owns their review item: pass each to
   * Survey's `entityProposalToReviewItem`, and record the outcome with its `entityOutcomeFromDecision`.
   */
  entityProposals: SurveyEntityProposal[];
  /** Item names handed to the queue. Empty when no queue was given: the items exist but nobody has been asked. */
  published: string[];
  routing: FlowEvidenceEntry;
  metrics: FlowEvidenceEntry;
}

/**
 * One run's routing, end to end: decide each change, record the decisions and the run's metrics as one unit, then
 * hand each routed claim's review item to the host's queue. Decisions are recorded before anything is queued, so a
 * queued item always has a recorded reason; a retry is safe because the evidence is content-addressed and the queue
 * publish carries a stable key.
 *
 * Metrics are derived from the evidence recorded for the run: every routing decision and every Survey review decision
 * and event handed in so far. Review state passed in is recorded first, so a later call that passes none (an identical
 * retry, or a new batch) still counts the review already recorded instead of overwriting it with a run that has none.
 */
export async function runMemoryRouting(input: Location & {
  changes: readonly MemoryChange[];
  policy?: Partial<MemoryRoutingPolicy>;
  queue?: MemoryReviewQueue;
  reviewDecisions?: readonly ReviewDecision[];
  reviewEvents?: readonly ReviewSessionEvent[];
}): Promise<MemoryRoutingRun> {
  const decisions = routeMemoryChanges(input.changes, input.policy);
  // Review input is validated before the first write: a bad one must not leave routing recorded behind a refusal.
  const review = prepareReview(input);
  const { routing, metrics } = await serialized(input, async () => {
    const recorded = await recordRouting({ runId: input.runId, gate: input.gate, cwd: input.cwd, decisions });
    return { routing: recorded.entry, metrics: await refreshMetrics({ runId: input.runId, gate: input.gate, cwd: input.cwd, review }) };
  });
  const items: ReviewItem[] = [], entityProposals: SurveyEntityProposal[] = [], published: string[] = [];
  for (const [index, decision] of decisions.entries()) {
    if (decision.outcome !== "routed") continue;
    if (decision.input.type === "entity") { entityProposals.push((input.changes[index] as MemoryEntityChange).proposal); continue; }
    const item = buildMemoryReviewItem(decision)!;
    items.push(item);
    if (input.queue) { await input.queue.publish(item, decision.id); published.push(item.metadata.name); }
  }
  return { decisions, items, entityProposals, published, routing, metrics };
}

/** Review state taken once as strict plain data and validated: this snapshot, not the caller's object, is what is recorded. */
export interface PreparedReview { decisions: ReviewDecision[]; events: ReviewSessionEvent[] }
type ReviewInput = { reviewDecisions?: readonly ReviewDecision[]; reviewEvents?: readonly ReviewSessionEvent[] };

/**
 * Snapshots and validates Survey review input before anything is written. The snapshot is plain JSON data: a getter,
 * a non-finite number, a class instance or a cycle is refused, so what was validated is exactly what is attached and a
 * value that changes between reads cannot pass validation and then poison the evidence.
 */
function prepareReview(input: ReviewInput): PreparedReview {
  // The whole list is snapshotted by index: a caller-supplied `.map` or a hole in the list cannot change what is recorded.
  const decisions = jsonSnapshotList(input.reviewDecisions, "review input") as ReviewDecision[];
  const events = jsonSnapshotList(input.reviewEvents, "review input") as ReviewSessionEvent[];
  decisions.forEach(assertReviewDecision);
  events.forEach(assertReviewEvent);
  return { decisions, events };
}

/** Records review state not yet recorded. A decision or event already in the run's evidence is not recorded twice. */
async function recordReview(input: Location & { review: PreparedReview }): Promise<void> {
  const known = await readReview(input.runId, input.cwd);
  const seen = new Set([...known.decisions, ...known.events].map(item => canonicalJson(item)));
  const fresh = <T extends object>(items: readonly T[]): T[] => items.filter(item => {
    const key = canonicalJson(item);
    if (seen.has(key)) return false;
    seen.add(key); // a repeat inside this batch is a repeat too
    return true;
  });
  const decisions = fresh(input.review.decisions), events = fresh(input.review.events);
  if (decisions.length === 0 && events.length === 0) return;
  const record: MemoryReviewRecord = { schema_version: MEMORY_ROUTING_VERSION, runId: input.runId, decisions, events };
  await attachJson(input, MEMORY_REVIEW_EVIDENCE_KIND, record);
}

const isRecord = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const goodInstant = (value: unknown): boolean => typeof value === "string" && Number.isFinite(Date.parse(value));
const bad = (what: string): never => { throw new MemoryClaimError("invalid", `review input: ${what}`); };
/** The shape of a Survey ReviewDecision the metrics read: its item, a status Survey defines, and a time. */
function assertReviewDecision(value: unknown): void {
  if (!isRecord(value) || value.kind !== "ReviewDecision" || !isRecord(value.spec) || !isRecord(value.metadata)) return bad("not a Survey ReviewDecision");
  const { spec, metadata } = value;
  if (typeof metadata.name !== "string" || !metadata.name || typeof spec.reviewItemName !== "string" || !spec.reviewItemName) return bad("a decision needs a name and the review item it decides");
  if (!["verified", "assumed", "rejected", "proposed"].includes(spec.status)) return bad(`a decision has a status Survey does not define: ${String(spec.status)}`);
  if (!goodInstant(spec.reviewedAt)) return bad("a decision needs a reviewedAt that is a date-time");
}
/** The shape of a Survey ReviewSessionEvent the review-time figure reads. */
function assertReviewEvent(value: unknown): void {
  if (!isRecord(value) || value.kind !== "ReviewSessionEvent" || !isRecord(value.spec)) return bad("not a Survey ReviewSessionEvent");
  const { spec } = value;
  if (typeof spec.sessionName !== "string" || !spec.sessionName || !Number.isInteger(spec.sequence) || typeof spec.eventType !== "string" || !goodInstant(spec.occurredAt)) return bad("an event needs a session, an integer sequence, a type and an occurredAt that is a date-time");
}

/** All review state recorded for a run, across batches, once each. */
async function readReview(runId: string, cwd?: string): Promise<{ decisions: ReviewDecision[]; events: ReviewSessionEvent[] }> {
  const decisions = new Map<string, ReviewDecision>(), events = new Map<string, ReviewSessionEvent>();
  for (const { value } of await readStored<MemoryReviewRecord>(runId, cwd, MEMORY_REVIEW_EVIDENCE_KIND)) {
    if (value.schema_version !== MEMORY_ROUTING_VERSION || value.runId !== runId) throw new MemoryClaimError("invalid", "a review record belongs to another run or an unsupported version");
    for (const decision of value.decisions) decisions.set(canonicalJson(decision), decision);
    for (const event of value.events) events.set(canonicalJson(event), event);
  }
  return { decisions: [...decisions.values()], events: [...events.values()] };
}
export const readMemoryReviewRecords = (runId: string, cwd?: string) => readReview(runId, cwd);

async function refreshMetrics(input: Location & { review?: PreparedReview }): Promise<FlowEvidenceEntry> {
  if (input.review) await recordReview({ runId: input.runId, gate: input.gate, cwd: input.cwd, review: input.review });
  const decisions = await readMemoryRoutingDecisions(input.runId, input.cwd);
  const review = await readReview(input.runId, input.cwd);
  const metrics = deriveMemoryRunMetrics({ runId: input.runId, decisions, reviewDecisions: review.decisions, reviewEvents: review.events });
  return recordMetrics({ runId: input.runId, gate: input.gate, cwd: input.cwd, metrics });
}

/**
 * Records any new Survey review state, recomputes the run's metrics from everything recorded, and records them as the
 * run's current metrics. Reading and writing are one unit, so a concurrent recording cannot leave the figures
 * describing fewer decisions than are recorded. Call it as reviewers decide, passing what is new (or everything: what
 * is already recorded is not recorded twice).
 */
export async function refreshMemoryRunMetrics(input: Location & ReviewInput): Promise<FlowEvidenceEntry> {
  const review = prepareReview(input); // before anything is written, and before waiting for the run
  return serialized(input, () => refreshMetrics({ runId: input.runId, gate: input.gate, cwd: input.cwd, review }));
}
