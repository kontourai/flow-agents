/**
 * Knowledge Kit memory claims: the claim shape, the caller-owned extraction
 * schema the Kit hands to Traverse, and the distill step that turns Traverse
 * proposals into claims.
 *
 * Ownership. Traverse stays schema-neutral and proposals-only: it learns the
 * field names from `MEMORY_CLAIM_TARGET_SCHEMA` and returns grounded
 * proposals, nothing else. The host owns the model call, so `distill` takes an
 * `extract` function instead of importing a provider. Review and routing are in
 * `memory-routing.ts`; accumulation (current state per slot) is Surface's.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "@kontourai/relay";
import { canonicalClaimKey } from "@kontourai/surface";
import { MAX_DECISION_DEPTH, MAX_EXTRACTION_RESULT_NODES, MAX_RUN_LIST, jsonSnapshot, jsonSnapshotEach, ownField } from "./memory-json.js";
// Type-only: proves the schema below is an ordinary Traverse TargetFieldSchema without a runtime dependency.
import type { TargetFieldSchema } from "@kontourai/traverse";

export const MEMORY_CLAIM_VERSION = "1.0" as const;
/** The claim type the Kit assigns. A slot includes it (Surface knowledge-accumulation decision); other producers supply their own. */
export const MEMORY_CLAIM_TYPE = "knowledge.memory-claim" as const;
export const MEMORY_CLAIM_POSTURES = ["stated", "proposed", "hypothetical", "retracted"] as const;
export type MemoryClaimPosture = (typeof MEMORY_CLAIM_POSTURES)[number];

export interface MemoryClaimSource {
  /** Stable source identity, for example a sitting id. */
  ref: string;
  /** `chars:<start>-<end>` within the text handed to the extractor. */
  locator: string;
  /** Verbatim quote the extractor grounded the claim in. */
  excerpt: string;
  observedAt: string;
  role?: "user" | "assistant";
  extractor?: string;
}

export interface MemoryClaimSupersession {
  claimId: string;
  kind: "correction" | "succession";
  reason: string;
}

export interface MemoryClaim {
  schema_version: typeof MEMORY_CLAIM_VERSION;
  /** `sha256:` digest of the claim's identity fields; recomputed on read. */
  id: string;
  subject: { type: string; id: string; label?: string };
  /** Surface's `claimType`. Part of the slot. */
  claimType: string;
  /** Surface's `fieldOrBehavior`. */
  property: string;
  /** Surface canonical qualifiers; part of the slot. */
  qualifiers?: Record<string, string>;
  value: unknown;
  /**
   * Half-open interval `[from, until)` of when the value held in the world; absent bounds are
   * unbounded. `until` is exclusive, unlike the inclusive `validUntil` of Surface's authority
   * trace, and is not `expiresAt` (freshness).
   */
  validTime?: { from?: string; until?: string };
  speaker: string;
  source: MemoryClaimSource;
  posture: MemoryClaimPosture;
  supersedes?: MemoryClaimSupersession[];
  /**
   * Who may see the claim, in Surface's visibility lattice (kontourai/surface#350). Absent is not "inherits" and not
   * "everyone": it reads as sealed, the narrowest element, so omission cannot widen access. `distillMemoryClaims`
   * stamps the sitting's visibility on every claim it makes.
   */
  visibility?: MemoryVisibility;
}

/**
 * Surface's `Visibility` (kontourai/surface src/visibility.ts, merged in #356, not yet in a published release): `public`
 * is widest; `restricted` names the audiences that may see it, opaque strings the owning store resolves; `restricted`
 * with none is sealed. A structural mirror of the data shape, so a claim needs no translation when Surface publishes it.
 */
export type MemoryVisibility = { kind: "public" } | { kind: "restricted"; audiences: string[] };

/** Longest audience list read. Over it the list is unreadable, not cut short (Surface's `MAX_AUDIENCES`). */
export const MAX_MEMORY_AUDIENCES = 1024;

/**
 * Surface's `readAudienceList`: an array of at most `MAX_MEMORY_AUDIENCES`, every index an OWN non-empty string. Read by
 * index, never by iterator, so a hole that would inherit a value (`Array.prototype[1]`) or an overridden iterator cannot
 * change the answer; one unreadable entry makes the whole list unreadable.
 */
export function readAudienceList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_MEMORY_AUDIENCES) return undefined;
  const audiences: string[] = [];
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) return undefined;
    const audience: unknown = value[index];
    if (typeof audience !== "string" || audience.length === 0) return undefined;
    audiences.push(audience);
  }
  return audiences;
}

/**
 * Reads a visibility from untrusted data for a CLAIM: exactly one of the two forms and nothing else, or undefined. This is
 * stricter than Surface's total reader (which ignores extra keys) because a claim that carries something else is malformed,
 * not merely narrow; the order (`memoryVisibilityWithin`) is Surface's own total `meetVisibility`.
 */
export function readMemoryVisibility(value: unknown): MemoryVisibility | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { kind, audiences, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length) return undefined;
  if (kind === "public") return audiences === undefined ? { kind: "public" } : undefined;
  if (kind !== "restricted") return undefined;
  const named = readAudienceList(audiences);
  return named === undefined ? undefined : { kind: "restricted", audiences: [...new Set(named)].sort() };
}

export class MemoryClaimError extends Error {
  constructor(readonly code: "invalid" | "id-mismatch" | "posture-missing", detail: string) {
    super(`Memory claim ${code}: ${detail}`);
    this.name = "MemoryClaimError";
  }
}

/**
 * Structural twin of Traverse's `TargetFieldSchema`. The Kit does not import
 * Traverse for it: the schema is plain data the host passes straight through.
 */
export interface MemoryTargetField {
  path: string;
  type: "string" | "number" | "boolean" | "date" | "enum" | "array" | "object";
  enumValues?: string[];
  description?: string;
  required?: boolean;
  inferenceType?: "explicit" | "inferred";
}

const TARGET_FIELDS = [
  { path: "claims[].subject", type: "string", required: true, inferenceType: "explicit", description: "What the claim is about, as the text names it (a person, project, service, document)." },
  { path: "claims[].subjectType", type: "string", required: true, inferenceType: "inferred", description: "One lowercase word for the kind of subject: person, organization, project, service, document, other." },
  { path: "claims[].property", type: "string", required: true, inferenceType: "inferred", description: "The attribute asserted about the subject, as a short lowercase noun phrase (for example 'primary database' or 'employer')." },
  { path: "claims[].value", type: "string", required: true, inferenceType: "explicit", description: "The asserted value, copied verbatim from the text." },
  { path: "claims[].speaker", type: "string", inferenceType: "explicit", description: "Who asserted it, as the text names them. Omit when the speaker of the turn is the one asserting." },
  { path: "claims[].posture", type: "enum", required: true, enumValues: [...MEMORY_CLAIM_POSTURES], inferenceType: "inferred", description: "stated: asserted as true now. proposed: suggested as a plan or decision not yet in effect. hypothetical: conditional, 'if' or 'what if'. retracted: the speaker withdraws an earlier assertion." },
  { path: "claims[].validFrom", type: "date", inferenceType: "inferred", description: "ISO 8601 instant the value starts to hold in the world, only when the text says or clearly implies it. Never today's date by default." },
  { path: "claims[].validUntil", type: "date", inferenceType: "inferred", description: "ISO 8601 instant the value stops holding (exclusive: it does not hold at this instant), only when the text says so." },
  { path: "claims[].replacesPrior", type: "boolean", inferenceType: "inferred", description: "True only when the speaker presents this value as replacing an earlier value of the same property ('we moved to', 'it is now'), not merely stating a value." },
] satisfies TargetFieldSchema[];

/** The caller-owned schema the Kit passes to Traverse. Checked above to be a plain `TargetFieldSchema[]`. */
export const MEMORY_CLAIM_TARGET_SCHEMA: readonly MemoryTargetField[] = Object.freeze(TARGET_FIELDS);

export const MEMORY_CLAIM_GUIDANCE =
  "Extract durable, first-person-checkable facts, decisions and preferences as claims. One claim per fact. " +
  "Never turn a question, a hypothetical, or the assistant's own suggestion into a stated fact. Copy values verbatim.";

/** Case-folded, whitespace-collapsed form used for identity and comparison. */
export function foldMemoryText(text: string): string {
  return text.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Structural JSON equality, the semantics the Surface knowledge-accumulation decision assumes. Case and spacing are values. */
export const memoryValuesEqual = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

/**
 * The field a claim competes in, apart from whose it is: Surface's `canonicalClaimKey` (field, qualifiers) with `claimType`
 * added, as the knowledge-accumulation decision specifies. Surface compares `claimType` exactly (`fact` and `FACT` are two
 * slots), so it is not folded here. The subject is a placeholder: two subjects an admitted identity mapping joins share a field.
 */
export const memoryFieldKey = (claim: Pick<MemoryClaim, "property" | "claimType" | "qualifiers">): string =>
  canonicalJson([claim.claimType, canonicalClaimKey({ subjectType: "subject", subjectId: "subject", fieldOrBehavior: claim.property, ...(claim.qualifiers ? { qualifiers: claim.qualifiers } : {}) })]);

/** The slot a claim competes in: its field (see `memoryFieldKey`) and its own subject. Surface owns the normalisation. */
export const memorySlotKey = (claim: Pick<MemoryClaim, "subject" | "property" | "claimType" | "qualifiers">): string =>
  canonicalJson([claim.claimType, canonicalClaimKey({ subjectType: claim.subject.type, subjectId: claim.subject.id, fieldOrBehavior: claim.property, ...(claim.qualifiers ? { qualifiers: claim.qualifiers } : {}) })]);

const INSTANT = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
/**
 * Parses an ISO 8601 date or zoned date-time (a bare date is midnight UTC) to millisecond precision; undefined for anything
 * else, including prose Date.parse would guess at and fractions finer than a millisecond, which it would silently drop.
 */
export function memoryInstant(value: string | undefined): number | undefined {
  if (value === undefined || !INSTANT.test(value)) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return undefined;
  // Date.parse rolls 2026-02-30 over to March 2. Refuse a date that is not on the calendar instead.
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day); // Date.UTC would read years 0-99 as 1900-1999
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return undefined;
  // A zoned time near the edge of the supported years can convert to a UTC year below 0000 or above 9999; ISO 8601 as Surface
  // parses it has four-digit years, so such an instant is not one.
  return /^\d{4}-/.test(new Date(ms).toISOString()) ? ms : undefined;
}

/** `[from, until)` overlap; an absent bound is unbounded. Throws on a malformed interval so callers fail closed. */
export function memoryIntervalsOverlap(a: MemoryClaim["validTime"], b: MemoryClaim["validTime"]): boolean {
  const bounds = (interval: MemoryClaim["validTime"]) => {
    const from = interval?.from === undefined ? -Infinity : memoryInstant(interval.from);
    const until = interval?.until === undefined ? Infinity : memoryInstant(interval.until);
    if (from === undefined || until === undefined || from >= until) throw new MemoryClaimError("invalid", "valid time is not a non-empty half-open interval");
    return { from, until };
  };
  const x = bounds(a), y = bounds(b);
  return x.from < y.until && y.from < x.until;
}

/**
 * The id is the digest of every other field, provenance included: the same id means the same content, so an edited
 * excerpt or timestamp is a different claim, not a tampered copy of this one. Sets are ordered first.
 */
function identityDigest(claim: MemoryClaim): string {
  const { id: _id, ...content } = claim;
  const canonical = {
    ...content,
    ...(content.supersedes ? { supersedes: [...content.supersedes].sort((x, y) => x.claimId.localeCompare(y.claimId)) } : {}),
    ...(content.visibility ? { visibility: readMemoryVisibility(content.visibility) ?? content.visibility } : {}),
  };
  return `sha256:${createHash("sha256").update(canonicalJson(canonical)).digest("hex")}`;
}

/** Builds a claim and assigns its id. Does not validate or copy (a trusted-data constructor); use `assertMemoryClaim` for that. */
export function memoryClaim(fields: Omit<MemoryClaim, "id" | "schema_version">): MemoryClaim {
  const claim = { schema_version: MEMORY_CLAIM_VERSION, id: "", ...fields } as MemoryClaim;
  claim.id = identityDigest(claim);
  return claim;
}

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const KNOWN_KEYS = new Set(["schema_version", "id", "subject", "claimType", "property", "qualifiers", "value", "validTime", "speaker", "source", "posture", "supersedes", "visibility"]);

/** Validates a claim and checks that its id is the digest of its content. Reads the claim as given: copy untrusted data first. */
export function assertMemoryClaim(value: unknown): asserts value is MemoryClaim {
  if (!isObject(value)) throw new MemoryClaimError("invalid", "not an object");
  for (const key of Object.keys(value)) if (!KNOWN_KEYS.has(key)) throw new MemoryClaimError("invalid", `unknown field ${key}`);
  if (value.schema_version !== MEMORY_CLAIM_VERSION) throw new MemoryClaimError("invalid", "unsupported schema_version");
  const { subject, source } = value;
  if (!isObject(subject) || !nonEmpty(subject.type) || !nonEmpty(subject.id)) throw new MemoryClaimError("invalid", "subject needs a type and id");
  if (!nonEmpty(value.property) || !nonEmpty(value.speaker) || !nonEmpty(value.claimType)) throw new MemoryClaimError("invalid", "claimType, property and speaker are required");
  // Optional text fields are text when present: a label that is an object would pass every check here and then fail wherever it is printed.
  if (subject.label !== undefined && typeof subject.label !== "string") throw new MemoryClaimError("invalid", "a subject label must be text");
  if (value.qualifiers !== undefined && (!isObject(value.qualifiers) || !Object.values(value.qualifiers).every(item => typeof item === "string"))) throw new MemoryClaimError("invalid", "qualifiers must map names to strings");
  if (!("value" in value) || value.value === undefined) throw new MemoryClaimError("invalid", "value is required");
  if (value.posture === undefined) throw new MemoryClaimError("posture-missing", "every claim carries its posture");
  if (!(MEMORY_CLAIM_POSTURES as readonly unknown[]).includes(value.posture)) throw new MemoryClaimError("invalid", "unknown posture");
  if (!isObject(source) || !["ref", "locator", "excerpt", "observedAt"].every(key => nonEmpty(source[key]))) throw new MemoryClaimError("invalid", "source needs ref, locator, excerpt and observedAt");
  for (const key of ["extractor", "role"]) if (source[key] !== undefined && typeof source[key] !== "string") throw new MemoryClaimError("invalid", `source ${key} must be text`);
  if (value.visibility !== undefined && readMemoryVisibility(value.visibility) === undefined) throw new MemoryClaimError("invalid", "visibility must be public or restricted to named audiences");
  if (value.supersedes !== undefined && (!Array.isArray(value.supersedes) || value.supersedes.length === 0 || !value.supersedes.every(edge =>
    isObject(edge) && /^sha256:[0-9a-f]{64}$/.test(String(edge.claimId)) && (edge.kind === "correction" || edge.kind === "succession") && nonEmpty(edge.reason)))) {
    throw new MemoryClaimError("invalid", "supersedes edges need a claim id, kind and reason");
  }
  if (value.supersedes !== undefined && value.posture !== "stated" && value.posture !== "retracted") throw new MemoryClaimError("invalid", "only a stated or retracted claim can supersede another: a plan or a what-if asserts nothing about the present");
  if (value.validTime !== undefined) {
    if (!isObject(value.validTime)) throw new MemoryClaimError("invalid", "validTime must be an object");
    memoryIntervalsOverlap(value.validTime as MemoryClaim["validTime"], undefined);
  }
  if (value.id !== identityDigest(value as unknown as MemoryClaim)) throw new MemoryClaimError("id-mismatch", "id is not the digest of the claim");
}

/** The part of a Traverse proposal the Kit reads. */
export interface ExtractionProposalLike {
  fieldPath: string;
  candidateValue: unknown;
  provenance: { excerpt: string; locator: string };
  extractor?: string;
  pathIndices?: number[];
}
export interface ExtractionResultLike { proposals: ExtractionProposalLike[]; error?: string; warnings?: string[] }

export interface AssembleContext {
  sourceRef: string;
  /** Where a locator falls in the source: when it was said and by whom. Undefined means it falls nowhere. */
  locate(locator: string): { observedAt: string; role?: "user" | "assistant" } | undefined;
  /** Claims already current, so a claim that replaces or retracts one carries a supersedes edge to it. */
  current?: readonly MemoryClaim[];
  /** The visibility of the source; stamped on every claim made from it. */
  visibility?: MemoryVisibility;
}
export interface RejectedProposalGroup { index: number; reason: string }

const FIELD = /^claims\[\]\.(\w+)$/;

/**
 * Groups one extraction's proposals into claims, one per array index. A group
 * that is incomplete, ungrounded, malformed, or too large to route is rejected with its
 * reason and is never proposed; the caller sees the rejection.
 *
 * Trusted-data precondition: this, `memoryClaim` and `assertMemoryClaim` are constructors and validators for data the caller
 * owns; they read it as given and do not copy it. The entry points that take data from elsewhere (`distillMemoryClaims`,
 * `routeMemoryChange`, `presentMemoryClaims`, the evidence recorders) copy it as plain JSON first.
 */
export function assembleMemoryClaims(result: ExtractionResultLike, context: AssembleContext): { claims: MemoryClaim[]; rejected: RejectedProposalGroup[] } {
  const groups = new Map<number, Record<string, ExtractionProposalLike>>();
  let unindexed = 0;
  for (const proposal of result.proposals) {
    const field = FIELD.exec(proposal.fieldPath)?.[1];
    if (field === undefined) continue;
    const index = proposal.pathIndices?.[0];
    if (index === undefined) { unindexed++; continue; }
    const group = groups.get(index) ?? {};
    // Two proposals for one field of one claim: keep the first, which is the provider's primary answer.
    group[field] ??= proposal;
    groups.set(index, group);
  }
  const claims: MemoryClaim[] = [], rejected: RejectedProposalGroup[] = [];
  // A claim field with no claim index cannot be grouped into a claim; say so rather than let it vanish.
  if (unindexed) rejected.push({ index: -1, reason: `${unindexed} claim field proposal(s) carry no claim index and cannot be grouped` });
  for (const [index, fields] of [...groups].sort((x, y) => x[0] - y[0])) {
    try {
      const claim = assemble(fields, context);
      // A claim the Kit could not then copy (too large, too deep, not plain data) could not be routed or presented either; it is
      // rejected here, with the reason, instead of being returned as a claim nothing downstream will accept.
      try { jsonSnapshot(claim, "claim"); } catch (error) { throw new MemoryClaimError("invalid", `the claim cannot be routed or presented: ${error instanceof Error ? error.message : String(error)}`); }
      claims.push(claim);
    } catch (error) {
      rejected.push({ index, reason: error instanceof MemoryClaimError ? error.message : String(error) });
    }
  }
  return { claims, rejected };
}

const failVisibility = (): never => { throw new MemoryClaimError("invalid", "visibility must be public or restricted to named audiences"); };
const failIfUnreadable = (visibility: unknown): void => { if (readMemoryVisibility(visibility) === undefined) failVisibility(); };

function assemble(fields: Record<string, ExtractionProposalLike>, context: AssembleContext): MemoryClaim {
  const text = (name: string) => {
    const raw = fields[name]?.candidateValue;
    return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
  };
  const subject = text("subject"), property = text("property"), posture = text("posture");
  const anchor = fields.value;
  if (!subject || !property || anchor === undefined || anchor.candidateValue === undefined || anchor.candidateValue === null || anchor.candidateValue === "") throw new MemoryClaimError("invalid", "claim lacks a subject, property or value");
  if (!posture || !(MEMORY_CLAIM_POSTURES as readonly string[]).includes(posture)) throw new MemoryClaimError("posture-missing", "claim has no recognised posture");
  const where = /^chars:(\d+)-(\d+)$/.exec(anchor.provenance.locator);
  const located = where ? context.locate(anchor.provenance.locator) : undefined;
  if (!located) throw new MemoryClaimError("invalid", "value is not grounded in a known turn of the source");
  const validTime: NonNullable<MemoryClaim["validTime"]> = {};
  for (const [name, key] of [["validFrom", "from"], ["validUntil", "until"]] as const) {
    const raw = text(name);
    if (raw === undefined) continue;
    const instant = memoryInstant(raw);
    if (instant === undefined) throw new MemoryClaimError("invalid", `${name} is not an ISO 8601 instant`);
    validTime[key] = new Date(instant).toISOString(); // `...T00:00Z` and `...T00:00+00:00` are one instant, so one claim
  }
  const hasTime = validTime.from !== undefined || validTime.until !== undefined;
  if (hasTime) memoryIntervalsOverlap(validTime, undefined);

  const subjectType = text("subjectType") ?? "other";
  const base = {
    subject: { type: subjectType, id: foldMemoryText(subject), label: subject },
    claimType: MEMORY_CLAIM_TYPE,
    property,
    value: anchor.candidateValue,
    ...(hasTime ? { validTime } : {}),
    speaker: text("speaker") ?? located.role ?? "unknown",
    source: {
      ref: context.sourceRef, locator: anchor.provenance.locator, excerpt: anchor.provenance.excerpt,
      observedAt: located.observedAt, ...(located.role ? { role: located.role } : {}), ...(anchor.extractor ? { extractor: anchor.extractor } : {}),
    },
    posture: posture as MemoryClaimPosture,
    ...(context.visibility ? { visibility: readMemoryVisibility(context.visibility) ?? failVisibility() } : {}),
  };
  const supersedes = supersessionEdges({ ...base, replacesPrior: fields.replacesPrior?.candidateValue === true }, context.current ?? []);
  return memoryClaim({ ...base, ...(supersedes.length ? { supersedes } : {}) });
}

/**
 * Edges from a new claim to the current claims it replaces or retracts. A
 * succession needs the speaker to say so (`replacesPrior`) AND a start time, and
 * only counts where the two values' valid times overlap; anything else stays a
 * plain claim, so a conflicting value is never silently relabelled a succession.
 */
function supersessionEdges(draft: Omit<MemoryClaim, "id" | "schema_version" | "supersedes"> & { replacesPrior: boolean }, current: readonly MemoryClaim[]): MemoryClaimSupersession[] {
  const slot = memorySlotKey(draft as Pick<MemoryClaim, "subject" | "property" | "claimType" | "qualifiers">);
  // A claim may revise its own speaker's earlier claim. Replacing someone else's needs an authority decision the
  // Kit cannot make, so that stays a plain claim and routing sees the conflict (Surface: a third party's edge is pending).
  const sameSlot = current.filter(claim => claim.posture === "stated" && memorySlotKey(claim) === slot && claim.speaker === draft.speaker);
  const edges: MemoryClaimSupersession[] = [];
  if (draft.posture === "retracted") {
    for (const claim of sameSlot) if (memoryValuesEqual(claim.value, draft.value)) edges.push({ claimId: claim.id, kind: "correction", reason: "the speaker retracted this assertion" });
  } else if (draft.posture === "stated" && draft.replacesPrior && draft.validTime?.from !== undefined) {
    for (const claim of sameSlot) {
      if (!memoryValuesEqual(claim.value, draft.value) && memoryIntervalsOverlap(claim.validTime, draft.validTime)) {
        edges.push({ claimId: claim.id, kind: "succession", reason: "the speaker presented the value as replacing the earlier one" });
      }
    }
  }
  return edges.sort((x, y) => x.claimId.localeCompare(y.claimId));
}

export interface DistillTurn { role: "user" | "assistant"; text: string; at: string }
/** The runtime-session residue shape (kontourai/flow-agents#669), read structurally. */
export interface DistillSitting {
  sittingId: string;
  turns: readonly DistillTurn[];
}
export interface MemoryExtractionRequest {
  content: string;
  contentType: "text";
  sourceRef: string;
  targetSchema: readonly MemoryTargetField[];
  guidance: string;
}
export type MemoryExtract = (request: MemoryExtractionRequest) => Promise<ExtractionResultLike>;
export interface MemoryAgreement { passes: number; agreeing: number }
export interface DistillResult {
  claims: MemoryClaim[];
  /** Per claim id: how many extraction passes produced it. Passes that failed count as passes that did not. */
  agreement: Record<string, MemoryAgreement>;
  rejected: (RejectedProposalGroup & { pass: number })[];
  warnings: string[];
}

/** One turn per line, whitespace collapsed, so Traverse's text passthrough keeps offsets equal to ours. */
export function formatSittingForExtraction(turns: readonly DistillTurn[]): { content: string; spans: { start: number; end: number; turn: DistillTurn }[] } {
  let content = "";
  const spans: { start: number; end: number; turn: DistillTurn }[] = [];
  for (const turn of turns) {
    const line = `[${turn.role} ${turn.at}] ${turn.text.replace(/\s+/g, " ").trim()}`;
    spans.push({ start: content.length, end: content.length + line.length, turn });
    content += `${line}\n`;
  }
  return { content, spans };
}

export const DEFAULT_DISTILL_PASSES = 2;

/**
 * Two claims are the same finding for agreement when they share a slot, a posture, a speaker, a valid time and a
 * value up to case and spacing. Anything that would change what the claim says is part of the finding: passes that
 * disagree on a start date disagree. Only spelling is forgiven; identity (`id`) is stricter still.
 */
const agreementKey = (claim: MemoryClaim): string =>
  canonicalJson([memorySlotKey(claim), claim.posture, foldMemoryText(claim.speaker), claim.validTime ?? null, (claim.supersedes ?? []).map(edge => [edge.claimId, edge.kind]).sort(), typeof claim.value === "string" ? foldMemoryText(claim.value) : claim.value]);

/**
 * Runs `passes` independent extractions over one sitting and assembles the
 * claims they agree or disagree on. A claim found by any pass is proposed;
 * `agreement` records how many passes found it, which routing reads.
 */
export async function distillMemoryClaims(input: {
  sitting: DistillSitting;
  extract: MemoryExtract;
  passes?: number;
  current?: readonly MemoryClaim[];
  /** The sitting's visibility. Without it the claims are sealed (see `MemoryClaim.visibility`). */
  visibility?: MemoryVisibility;
}): Promise<DistillResult> {
  // Each field of the request is read once, before the first await, with nothing the caller defined running, and the
  // sitting and the current claims are copied as plain JSON. Extraction is asynchronous: reading the sitting again after it
  // would let the claims name a source reference and a time that are not the ones the model was given.
  const field = (record: unknown, key: string) => ownField(record, key, `distill input ${key}`);
  const sittingInput = field(input, "sitting");
  const sitting: DistillSitting = { sittingId: field(sittingInput, "sittingId") as string, turns: jsonSnapshotEach(field(sittingInput, "turns"), "distill sitting turns") as DistillTurn[] };
  const extract = field(input, "extract") as MemoryExtract;
  const passesInput = field(input, "passes");
  const current = jsonSnapshotEach(field(input, "current"), "distill current claims") as MemoryClaim[];
  const visibilityInput = field(input, "visibility");
  const visibility = visibilityInput === undefined ? undefined : jsonSnapshot(visibilityInput, "distill visibility") as MemoryVisibility;
  const passes = (passesInput ?? DEFAULT_DISTILL_PASSES) as number;
  if (!Number.isInteger(passes) || passes < 1 || passes > 8) throw new MemoryClaimError("invalid", "passes must be an integer from 1 to 8");
  if (typeof sitting.sittingId !== "string" || !sitting.sittingId.trim()) throw new MemoryClaimError("invalid", "a sitting needs a sittingId");
  if (visibility !== undefined) failIfUnreadable(visibility); // host configuration: refuse once, up front
  if (sitting.turns.length === 0) return { claims: [], agreement: {}, rejected: [], warnings: [] };
  const { content, spans } = formatSittingForExtraction(sitting.turns);
  const locate = (locator: string) => {
    const start = Number(/^chars:(\d+)-/.exec(locator)?.[1]);
    const span = spans.find(candidate => start >= candidate.start && start < candidate.end);
    return span ? { observedAt: span.turn.at, role: span.turn.role } : undefined;
  };
  const request: MemoryExtractionRequest = { content, contentType: "text", sourceRef: sitting.sittingId, targetSchema: MEMORY_CLAIM_TARGET_SCHEMA, guidance: MEMORY_CLAIM_GUIDANCE };

  const found = new Map<string, { claim: MemoryClaim; passes: Set<number> }>(); // by agreementKey
  const rejected: DistillResult["rejected"] = [], warnings: string[] = [];
  for (let pass = 0; pass < passes; pass++) {
    let result: ExtractionResultLike;
    try {
      // The response is copied as plain JSON the moment it arrives: an extractor that reuses and edits an object it returned
      // (or hands back a getter) cannot change a proposal after it has been checked and while it is being stored.
      result = jsonSnapshot(await extract(request), `pass ${pass + 1} extraction result`, { maxNodes: MAX_EXTRACTION_RESULT_NODES, maxDepth: MAX_DECISION_DEPTH }) as ExtractionResultLike;
    } catch (error) {
      warnings.push(`pass ${pass + 1} failed: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (result.error) warnings.push(`pass ${pass + 1} reported: ${result.error}`);
    warnings.push(...(result.warnings ?? []).map(warning => `pass ${pass + 1}: ${warning}`));
    const assembled = assembleMemoryClaims(result, { sourceRef: sitting.sittingId, locate, current, visibility });
    rejected.push(...assembled.rejected.map(item => ({ ...item, pass })));
    for (const claim of assembled.claims) {
      const key = agreementKey(claim);
      const entry = found.get(key) ?? { claim, passes: new Set<number>() };
      entry.passes.add(pass);
      found.set(key, entry);
    }
  }
  const claims = [...found.values()].map(entry => entry.claim);
  // Every pass may find different claims, so a long sitting over many passes can return more than any one request list carries
  // (routing, recall and the evidence recorders each take at most MAX_RUN_LIST). It is refused here, whole, not cut short: split
  // the sitting into chunks.
  if (claims.length > MAX_RUN_LIST) throw new MemoryClaimError("invalid", `this sitting yielded ${claims.length} claims over ${passes} passes, more than the ${MAX_RUN_LIST} one request carries; distill it in chunks`);
  return { claims, agreement: Object.fromEntries([...found.values()].map(entry => [entry.claim.id, { passes, agreeing: entry.passes.size }])), rejected, warnings };
}
