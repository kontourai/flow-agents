import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Ajv } from "ajv";
import { validateExtractionTaskSpec, createExtractionTaskSpec } from "@kontourai/traverse";
import {
  MEMORY_CLAIM_POSTURES, MEMORY_CLAIM_TARGET_SCHEMA, MemoryClaimError,
  assembleMemoryClaims, assertMemoryClaim, distillMemoryClaims, memoryClaim, memoryIntervalsOverlap,
} from "@kontourai/flow-agents/memory-claims";
import { SCHEMAS, distillFixtureSitting, loadSittings, matchesFixture, readJson, scriptedProvider, traverseExtract } from "./memory-claims-support.mjs";

const claimSchema = readJson(SCHEMAS, "memory-claim.schema.json");
const validateSchema = new Ajv({ strict: false, allErrors: true }).compile(claimSchema);
const asDocument = value => JSON.parse(JSON.stringify(value));

async function fixtureClaims() {
  const earlier = await distillFixtureSitting(0);
  const later = await distillFixtureSitting(1, { current: earlier.result.claims });
  return { earlier, later };
}

test("the claim schema is an ordinary caller-owned Traverse TargetFieldSchema with typed fields", () => {
  const schema = MEMORY_CLAIM_TARGET_SCHEMA.map(field => ({ ...field }));
  // Traverse accepts it as a task's schema without knowing a single field name.
  const task = createExtractionTaskSpec({ version: "1", targetSchema: schema, guidance: "g" });
  assert.equal(validateExtractionTaskSpec(task, schema), undefined);
  const byPath = Object.fromEntries(schema.map(field => [field.path, field]));
  for (const typed of ["subject", "subjectType", "property", "value", "speaker", "posture", "validFrom", "validUntil"]) {
    assert.ok(byPath[`claims[].${typed}`], `schema types ${typed}`);
  }
  assert.deepEqual(byPath["claims[].posture"].enumValues, ["stated", "proposed", "hypothetical", "retracted"]);
  assert.equal(byPath["claims[].posture"].type, "enum");
  assert.equal(byPath["claims[].validFrom"].type, "date");
  for (const required of ["subject", "property", "value", "posture"]) assert.equal(byPath[`claims[].${required}`].required, true);
  // The extractor is never asked for visibility: who may see a claim is the host's decision, not a model's.
  assert.equal(schema.some(field => /audience|visib/i.test(field.path)), false);
  assert.deepEqual([...MEMORY_CLAIM_POSTURES], byPath["claims[].posture"].enumValues);
});

test("fixtures: the real distill path (runtime-session residue -> Traverse extract -> claims) reproduces the committed claims", async () => {
  const { earlier, later } = await fixtureClaims();
  for (const [name, value] of [
    ["claims-sitting-0.json", { claims: earlier.result.claims, agreement: earlier.result.agreement }],
    ["claims-sitting-1.json", { claims: later.result.claims, agreement: later.result.agreement }],
  ]) {
    const { expected, actual } = matchesFixture(name, value);
    assert.equal(actual, expected, `${name} drifted; rerun with UPDATE_MEMORY_FIXTURES=1 and review the diff`);
  }
});

test("fixtures: every distilled claim validates against the published schema and recomputes its id", async () => {
  const { earlier, later } = await fixtureClaims();
  const all = [...earlier.result.claims, ...later.result.claims];
  assert.ok(all.length >= 8);
  for (const claim of all) {
    assert.equal(validateSchema(asDocument(claim)), true, JSON.stringify(validateSchema.errors));
    assert.doesNotThrow(() => assertMemoryClaim(claim));
    assert.match(claim.id, /^sha256:[0-9a-f]{64}$/);
  }
  // Every posture the schema names is exercised by the real path, not just declared.
  assert.deepEqual([...new Set(all.map(claim => claim.posture))].sort(), ["hypothetical", "retracted", "stated"]);
});

test("the sitting fixture is runtime-session residue in the shape the #669 producer writes", () => {
  const sittings = loadSittings();
  assert.equal(sittings.length, 2);
  for (const sitting of sittings) {
    assert.deepEqual(Object.keys(sitting).sort(), ["complete", "contentHash", "provenance", "sittingId", "source", "turns"]);
    assert.equal(sitting.source, "runtime-session");
    assert.match(sitting.sittingId, /^(claude-code|codex):[^:]+:(0|[1-9][0-9]*)$/);
    assert.match(sitting.contentHash, /^sha256:[0-9a-f]{64}$/);
    for (const turn of sitting.turns) assert.deepEqual(Object.keys(turn).sort(), ["at", "role", "text"]);
  }
});

test("the sitting fixture validates against the #669 residue schema as soon as that schema is on this branch", t => {
  const file = path.resolve(import.meta.dirname, "..", "..", "schemas", "knowledge", "residue.schema.json");
  if (!fs.existsSync(file)) {
    t.skip("schemas/knowledge/residue.schema.json is not on this branch yet (kontourai/flow-agents#669); the fixture was produced by that lane's real ingestRuntimeSessions");
    return;
  }
  const validate = new Ajv({ strict: false, allErrors: true }).compile(readJson(file));
  for (const sitting of loadSittings()) assert.equal(validate(sitting), true, JSON.stringify(validate.errors));
});

test("claims keep their grounding: the excerpt is verbatim in the sitting and the locator falls in the turn that said it", async () => {
  const { later } = await fixtureClaims();
  const [, sitting] = loadSittings();
  const retry = later.result.claims.find(claim => claim.property === "retry budget");
  assert.equal(retry.source.ref, sitting.sittingId);
  assert.ok(sitting.turns.some(turn => turn.text.includes(retry.source.excerpt)));
  assert.equal(retry.source.observedAt, "2026-10-30T14:02:00.000Z");
  assert.equal(retry.source.role, "user");
  assert.equal(retry.speaker, "user");
  assert.match(retry.source.locator, /^chars:\d+-\d+$/);
});

test("supersedes edges: a succession needs the speaker to say it replaces AND a start time; a retraction corrects the matching claim", async () => {
  const { earlier, later } = await fixtureClaims();
  const old = earlier.result.claims.find(claim => claim.property === "primary database");
  const next = later.result.claims.find(claim => claim.property === "primary database");
  assert.deepEqual(next.supersedes.map(edge => [edge.claimId, edge.kind]), [[old.id, "succession"]]);
  assert.deepEqual(next.validTime, { from: "2026-10-30T00:00:00.000Z" }, "a bare date is midnight UTC, stored as that instant");
  const owner = earlier.result.claims.find(claim => claim.property === "on-call owner");
  const retraction = later.result.claims.find(claim => claim.property === "on-call owner");
  assert.equal(retraction.posture, "retracted");
  assert.deepEqual(retraction.supersedes.map(edge => [edge.claimId, edge.kind]), [[owner.id, "correction"]]);
  // "Actually it is 8" says replace but gives no start time: it stays a plain claim, which routing will see as a conflict.
  assert.equal(later.result.claims.find(claim => claim.property === "retry budget").supersedes, undefined);
  // Hypothetical and unrelated claims never carry edges.
  assert.equal(later.result.claims.find(claim => claim.posture === "hypothetical").supersedes, undefined);
});

/** Proposals for one claim in Traverse's normalised shape (declared path form plus the stripped index). */
function proposalsFor(fields, quote = "x") {
  return Object.entries(fields).map(([name, candidateValue]) => ({ fieldPath: `claims[].${name}`, candidateValue, pathIndices: [0], provenance: { excerpt: quote, locator: "chars:0-1" }, extractor: "test" }));
}
const assembleOne = (fields, context = {}) => assembleMemoryClaims({ proposals: proposalsFor(fields) }, { sourceRef: "s", locate: () => ({ observedAt: "2026-11-01T00:00:00.000Z", role: "user" }), ...context });
const WIDGET = { subject: "widget service", subjectType: "service", property: "primary database", posture: "stated" };

test("supersedes edges are only drawn where all of the evidence is present", async () => {
  const { earlier } = await fixtureClaims();
  const old = earlier.result.claims.find(claim => claim.property === "primary database"); // PostgreSQL 15, no valid time
  const owner = earlier.result.claims.find(claim => claim.property === "on-call owner");
  const current = earlier.result.claims;
  const edges = fields => assembleOne({ ...WIDGET, ...fields }, { current }).claims[0].supersedes;

  assert.deepEqual(edges({ value: "PostgreSQL 16", validFrom: "2026-10-30", replacesPrior: true })?.map(edge => edge.claimId), [old.id], "the control: all evidence present");
  assert.equal(edges({ value: "PostgreSQL 16", validFrom: "2026-10-30" }), undefined, "no speaker intent: a different value is a conflict, not a succession");
  assert.equal(edges({ value: "PostgreSQL 16", replacesPrior: true }), undefined, "no start time");
  assert.equal(edges({ value: "PostgreSQL 15", validFrom: "2026-10-30", replacesPrior: true }), undefined, "the same value replaces nothing");
  assert.equal(edges({ value: "PostgreSQL 16", validFrom: "2026-10-30", replacesPrior: true, subject: "billing service" }), undefined, "another subject");

  // The predecessor is bounded and ended before the successor starts: nothing to supersede.
  const ended = memoryClaim({ ...old, validTime: { until: "2026-10-01" } });
  assert.equal(assembleOne({ ...WIDGET, value: "PostgreSQL 16", validFrom: "2026-10-30", replacesPrior: true }, { current: [ended] }).claims[0].supersedes, undefined, "valid times that do not overlap");
  // A predecessor that was itself only a plan is not superseded by a statement.
  const planned = memoryClaim({ ...old, posture: "proposed" });
  assert.equal(assembleOne({ ...WIDGET, value: "PostgreSQL 16", validFrom: "2026-10-30", replacesPrior: true }, { current: [planned] }).claims[0].supersedes, undefined);

  // A claim revises its own speaker's earlier claim; replacing someone else's needs an authority decision the Kit cannot make.
  assert.equal(edges({ value: "PostgreSQL 16", validFrom: "2026-10-30", replacesPrior: true, speaker: "Maya Chen" }), undefined, "another speaker's claim is not replaced by an edge");

  const retract = fields => assembleOne({ subject: "widget service", subjectType: "service", property: "on-call owner", posture: "retracted", ...fields }, { current }).claims[0].supersedes;
  assert.deepEqual(retract({ value: "Maya Chen" })?.map(edge => [edge.claimId, edge.kind]), [[owner.id, "correction"]], "the control");
  assert.equal(retract({ value: "Someone Else" }), undefined, "retracting a value nobody held corrects nothing");
});

test("a value the extractor cannot place in a turn of the source is not a claim", () => {
  const out = assembleOne({ ...WIDGET, value: "PostgreSQL 16" }, { locate: () => undefined });
  assert.equal(out.claims.length, 0);
  assert.match(out.rejected[0].reason, /not grounded in a known turn/);
  const unscoped = assembleMemoryClaims({ proposals: proposalsFor({ ...WIDGET, value: "x" }).map(p => ({ ...p, provenance: { excerpt: "x", locator: "somewhere" } })) }, { sourceRef: "s", locate: () => ({ observedAt: "t" }) });
  assert.equal(unscoped.claims.length, 0, "a locator that is not chars:<start>-<end> is not a grounding");
});

test("agreement counts passes that found the same claim; a pass that did not is a pass that disagreed", async () => {
  const { earlier, later } = await fixtureClaims();
  const budget = earlier.result.claims.find(claim => claim.property === "retry budget");
  assert.deepEqual(earlier.result.agreement[budget.id], { passes: 2, agreeing: 1 });
  const lead = later.result.claims.find(claim => claim.property === "lead");
  assert.deepEqual(later.result.agreement[lead.id], { passes: 2, agreeing: 1 });
  const db = later.result.claims.find(claim => claim.property === "primary database");
  assert.deepEqual(later.result.agreement[db.id], { passes: 2, agreeing: 2 });
});

test("passes that spell one finding differently still agree, while identity stays exact", async () => {
  const sitting = loadSittings()[0];
  const quote = "The widget service uses PostgreSQL 15 as its primary database.";
  const finding = value => ({ quote, subject: "widget service", subjectType: "service", property: "primary database", value, posture: "stated" });
  const result = await distillMemoryClaims({ sitting, passes: 2, extract: traverseExtract(scriptedProvider([[finding("PostgreSQL 15")], [finding("postgresql 15")]])) });
  assert.equal(result.claims.length, 1, "one finding, reported once, as the first pass spelled it");
  assert.equal(result.claims[0].value, "PostgreSQL 15");
  assert.deepEqual(result.agreement[result.claims[0].id], { passes: 2, agreeing: 2 });
  // A different value is a different finding.
  const other = await distillMemoryClaims({ sitting, passes: 2, extract: traverseExtract(scriptedProvider([[finding("PostgreSQL 15")], [finding("PostgreSQL 16")]])) });
  assert.deepEqual(other.claims.map(claim => other.agreement[claim.id].agreeing), [1, 1]);
});

test("passes that disagree on what the claim says do not collapse into agreement, and neither claim is lost", async () => {
  const sitting = loadSittings()[0];
  const quote = "The widget service uses PostgreSQL 15 as its primary database.";
  const finding = extra => ({ quote, subject: "widget service", subjectType: "service", property: "primary database", value: "PostgreSQL 15", posture: "stated", ...extra });
  const earlier = (await fixtureClaims()).earlier.result.claims;
  for (const [name, a, b, withCurrent] of [
    ["a different start date", { validFrom: "2026-01-01" }, { validFrom: "2027-01-01" }],
    ["start date in one pass only", { validFrom: "2026-01-01" }, {}],
    ["a different end date", { validUntil: "2026-12-01" }, { validUntil: "2027-12-01" }],
    ["a different posture", { posture: "stated" }, { posture: "hypothetical" }],
    ["a different speaker", { speaker: "Maya Chen" }, { speaker: "Dana Reyes" }],
    ["one pass saw the speaker say it replaces the earlier value, the other did not", { value: "PostgreSQL 16", validFrom: "2026-10-30", replacesPrior: true }, { value: "PostgreSQL 16", validFrom: "2026-10-30" }, true],
  ]) {
    const result = await distillMemoryClaims({ sitting, passes: 2, ...(withCurrent ? { current: earlier } : {}), extract: traverseExtract(scriptedProvider([[finding(a)], [finding(b)]])) });
    assert.equal(result.claims.length, 2, `${name}: both findings are kept`);
    assert.deepEqual(result.claims.map(claim => result.agreement[claim.id].agreeing), [1, 1], name);
  }
});

test("equivalent spellings of one instant are one value; early years and leap days are real dates", async () => {
  const sitting = loadSittings()[0];
  const quote = "The widget service uses PostgreSQL 15 as its primary database.";
  const finding = extra => ({ quote, subject: "widget service", subjectType: "service", property: "primary database", value: "PostgreSQL 15", posture: "stated", ...extra });
  const spelled = await distillMemoryClaims({ sitting, passes: 2, extract: traverseExtract(scriptedProvider([[finding({ validFrom: "2026-01-01T00:00Z" })], [finding({ validFrom: "2026-01-01T00:00:00+00:00" })]])) });
  assert.equal(spelled.claims.length, 1);
  assert.deepEqual(spelled.agreement[spelled.claims[0].id], { passes: 2, agreeing: 2 });
  assert.deepEqual(spelled.claims[0].validTime, { from: "2026-01-01T00:00:00.000Z" });
  const offset = await distillMemoryClaims({ sitting, passes: 1, extract: traverseExtract(scriptedProvider([[finding({ validFrom: "2026-01-01T02:00:00+02:00" })]])) });
  assert.deepEqual(offset.claims[0].validTime, { from: "2026-01-01T00:00:00.000Z" }, "an offset is converted, not stored as written");
  for (const [date, ok] of [["0042-03-01", true], ["0000-01-01", true], ["2024-02-29", true], ["2026-02-29", false], ["2100-02-29", false], ["2000-02-29", true], ["2026-04-31", false], ["2026-00-10", false]]) {
    const result = await distillMemoryClaims({ sitting, passes: 1, extract: traverseExtract(scriptedProvider([[finding({ validFrom: date })]])) });
    assert.equal(result.claims.length, ok ? 1 : 0, date);
  }
});

test("precision finer than a millisecond is refused rather than silently dropped; coarser is normalised", async () => {
  const sitting = loadSittings()[0];
  const quote = "The widget service uses PostgreSQL 15 as its primary database.";
  const finding = validFrom => ({ quote, subject: "widget service", subjectType: "service", property: "primary database", value: "PostgreSQL 15", posture: "stated", validFrom });
  const run = async validFrom => distillMemoryClaims({ sitting, passes: 1, extract: traverseExtract(scriptedProvider([[finding(validFrom)]])) });
  for (const refused of ["2026-01-01T00:00:00.0001Z", "2026-01-01T00:00:00.1234Z", "2026-01-01T00:00:00.000000001Z"]) {
    const result = await run(refused);
    assert.equal(result.claims.length, 0, refused);
    assert.equal(result.rejected.length, 1, `${refused} is reported`);
  }
  for (const [given, stored] of [["2026-01-01T00:00:00.1Z", "2026-01-01T00:00:00.100Z"], ["2026-01-01T00:00:00.12Z", "2026-01-01T00:00:00.120Z"], ["2026-01-01T00:00:00.123Z", "2026-01-01T00:00:00.123Z"]]) {
    assert.equal((await run(given)).claims[0].validTime.from, stored, given);
  }
});

test("a claim field the extractor gave no claim index cannot vanish: it is reported", () => {
  const out = assembleMemoryClaims({ proposals: [
    { fieldPath: "claims[].value", candidateValue: "x", provenance: { excerpt: "x", locator: "chars:0-1" } },
    { fieldPath: "claims[].property", candidateValue: "p", provenance: { excerpt: "x", locator: "chars:0-1" } },
  ] }, { sourceRef: "s", locate: () => ({ observedAt: "t" }) });
  assert.equal(out.claims.length, 0);
  assert.deepEqual(out.rejected, [{ index: -1, reason: "2 claim field proposal(s) carry no claim index and cannot be grouped" }]);
  const none = assembleMemoryClaims({ proposals: [{ fieldPath: "somethingElse", candidateValue: 1, provenance: { excerpt: "x", locator: "chars:0-1" } }] }, { sourceRef: "s", locate: () => ({ observedAt: "t" }) });
  assert.deepEqual(none, { claims: [], rejected: [] }, "a path outside claims[] is not ours to report");
});

test("only a stated or retracted claim can carry a supersedes edge", async () => {
  const { earlier } = await fixtureClaims();
  const claim = earlier.result.claims[0];
  const edge = [{ claimId: claim.id, kind: "succession", reason: "r" }];
  for (const posture of ["stated", "retracted"]) assert.doesNotThrow(() => assertMemoryClaim(memoryClaim({ ...claim, value: "x", posture, supersedes: edge })), posture);
  for (const posture of ["hypothetical", "proposed"]) assert.throws(() => assertMemoryClaim(memoryClaim({ ...claim, value: "x", posture, supersedes: edge })), { code: "invalid" }, posture);
});

test("a failed pass is reported and counts against agreement instead of vanishing", async () => {
  const sitting = loadSittings()[0];
  const real = traverseExtract(scriptedProvider([[{ quote: "The widget service uses PostgreSQL 15 as its primary database.", subject: "widget service", subjectType: "service", property: "primary database", value: "PostgreSQL 15", posture: "stated" }]]));
  let calls = 0;
  const result = await distillMemoryClaims({ sitting, passes: 2, extract: request => (++calls === 2 ? Promise.reject(new Error("provider unavailable")) : real(request)) });
  assert.equal(result.claims.length, 1);
  assert.deepEqual(result.agreement[result.claims[0].id], { passes: 2, agreeing: 1 });
  assert.match(result.warnings.join("\n"), /pass 2 failed: provider unavailable/);
});

test("an incomplete, postureless, ungrounded or malformed group is rejected with its reason, never proposed", async () => {
  const sitting = loadSittings()[0];
  const quote = "The widget service uses PostgreSQL 15 as its primary database.";
  const good = { quote, subject: "widget service", subjectType: "service", property: "primary database", value: "PostgreSQL 15", posture: "stated" };
  const cases = {
    "no posture": { ...good, posture: undefined },
    "unknown posture": { ...good, posture: "certain" },
    "no value": { ...good, value: undefined },
    "bad valid time": { ...good, validFrom: "next tuesday" },
    "a date Date.parse would guess at": { ...good, validFrom: "Oct 30 2026" },
    "a year alone": { ...good, validFrom: "2026" },
    "a day that is not on the calendar": { ...good, validFrom: "2026-02-30" },
    "month 13": { ...good, validFrom: "2026-13-01" },
    "a date-time without a zone": { ...good, validFrom: "2026-10-30T10:00:00" },
    "empty interval": { ...good, validFrom: "2026-10-30", validUntil: "2026-10-01" },
  };
  for (const [name, bad] of Object.entries(cases)) {
    const result = await distillMemoryClaims({ sitting, passes: 1, extract: traverseExtract(scriptedProvider([[bad]])) });
    assert.equal(result.claims.length, 0, name);
    assert.equal(result.rejected.length, 1, `${name} must be reported, not dropped`);
  }
  assert.match((await distillMemoryClaims({ sitting, passes: 1, extract: traverseExtract(scriptedProvider([[{ ...good, posture: undefined }]])) })).rejected[0].reason, /posture/);
  // Traverse drops a proposal whose excerpt is not verbatim in the text; the Kit sees no claim and a warning, not a guess.
  const invented = await distillMemoryClaims({ sitting, passes: 1, extract: traverseExtract(scriptedProvider([[{ ...good, quote: "The widget service runs on MySQL." }]])) });
  assert.equal(invented.claims.length, 0);
  assert.ok(invented.warnings.length > 0, "Traverse's own drop warning is surfaced");
});

test("two proposals for one field of one claim keep the first, the provider's primary answer", () => {
  const proposal = (fieldPath, candidateValue) => ({ fieldPath, candidateValue, provenance: { excerpt: "x", locator: "chars:0-1" }, pathIndices: [0] });
  const { claims } = assembleMemoryClaims({ proposals: [
    proposal("claims[].subject", "svc"), proposal("claims[].property", "p"), proposal("claims[].value", "first"), proposal("claims[].value", "second"), proposal("claims[].posture", "stated"),
  ] }, { sourceRef: "s", locate: () => ({ observedAt: "2026-01-01T00:00:00.000Z" }) });
  assert.equal(claims[0].value, "first");
});

test("identity is exact: a value, property or subject that differs only in case is a different claim with a different id", async () => {
  const { earlier } = await fixtureClaims();
  const claim = earlier.result.claims[0];
  for (const changed of [{ value: "postgresql 15" }, { property: "Primary Database" }, { speaker: "User" }, { claimType: "other" }, { qualifiers: { environment: "prod" } }]) {
    assert.notEqual(memoryClaim({ ...claim, ...changed }).id, claim.id, JSON.stringify(changed));
  }
  assert.equal(memoryClaim({ ...claim, visibility: { kind: "restricted", audiences: ["b", "a"] } }).id, memoryClaim({ ...claim, visibility: { kind: "restricted", audiences: ["a", "b"] } }).id, "audiences are a set");
  assert.notEqual(memoryClaim({ ...claim, visibility: { kind: "public" } }).id, memoryClaim({ ...claim, visibility: { kind: "restricted", audiences: [] } }).id, "public and sealed are different claims");
});

test("the slot is Surface's canonical claim key plus claimType", async () => {
  const { memorySlotKey } = await import("@kontourai/flow-agents/memory-claims");
  const { canonicalClaimKey } = await import("@kontourai/surface");
  const { earlier } = await fixtureClaims();
  const claim = earlier.result.claims[0];
  const surface = canonicalClaimKey({ subjectType: claim.subject.type, subjectId: claim.subject.id, fieldOrBehavior: claim.property });
  assert.ok(memorySlotKey(claim).includes(JSON.stringify(surface).slice(1, -1)), "built from Surface's key, not a parallel one");
  assert.equal(memorySlotKey({ ...claim, property: "  PRIMARY DATABASE " }), memorySlotKey(claim), "Surface lower-cases and trims the field");
  assert.notEqual(memorySlotKey({ ...claim, claimType: "other" }), memorySlotKey(claim));
  assert.notEqual(memorySlotKey({ ...claim, qualifiers: { environment: "prod" } }), memorySlotKey(claim));
  assert.notEqual(memorySlotKey({ ...claim, subject: { ...claim.subject, id: claim.subject.id.toUpperCase() } }), memorySlotKey(claim), "Surface preserves subject-id case");
});

test("the id covers provenance too: an edited excerpt, locator or timestamp is a different claim, and a copy with the old id is refused", async () => {
  const { earlier } = await fixtureClaims();
  const claim = earlier.result.claims[0];
  for (const source of [{ excerpt: "THIS WAS NEVER SAID" }, { locator: "chars:1-2" }, { observedAt: "2020-01-01T00:00:00.000Z" }, { role: "assistant" }, { extractor: "someone-else" }]) {
    const edited = { ...asDocument(claim), source: { ...claim.source, ...source } };
    assert.throws(() => assertMemoryClaim(edited), { code: "id-mismatch" }, JSON.stringify(source));
    assert.notEqual(memoryClaim({ ...claim, source: { ...claim.source, ...source } }).id, claim.id);
  }
  assert.equal(memoryClaim({ ...claim }).id, claim.id, "rebuilding the same content gives the same id");
});

test("assertMemoryClaim fails closed: edited content, missing posture, unknown fields and bad intervals are refused", async () => {
  const { earlier } = await fixtureClaims();
  const claim = asDocument(earlier.result.claims[0]);
  assert.throws(() => assertMemoryClaim({ ...claim, value: "PostgreSQL 99" }), { code: "id-mismatch" });
  const { posture: _posture, ...noPosture } = claim;
  assert.throws(() => assertMemoryClaim(noPosture), { code: "posture-missing" });
  assert.throws(() => assertMemoryClaim({ ...claim, posture: "certain" }), { code: "invalid" });
  assert.throws(() => assertMemoryClaim({ ...claim, reviewed: true }), /unknown field reviewed/);
  assert.throws(() => assertMemoryClaim(memoryClaim({ ...claim, validTime: { from: "2026-10-30", until: "2026-10-01" } })), MemoryClaimError);
  assert.throws(() => assertMemoryClaim(memoryClaim({ ...claim, validTime: { from: "soon" } })), MemoryClaimError);
});

test("visibility is Surface's closed form, and anything else is refused rather than read as open", async () => {
  const { earlier } = await fixtureClaims();
  const claim = earlier.result.claims[0];
  assert.deepEqual(claim.visibility, { kind: "restricted", audiences: ["user:fixture"] }, "distill stamps the sitting's visibility");
  for (const ok of [{ kind: "public" }, { kind: "restricted", audiences: [] }, { kind: "restricted", audiences: ["a", "b"] }]) {
    assert.doesNotThrow(() => assertMemoryClaim(memoryClaim({ ...claim, visibility: ok })), JSON.stringify(ok));
  }
  const many = n => ({ kind: "restricted", audiences: Array.from({ length: n }, (_, i) => `a${i}`) });
  assert.doesNotThrow(() => assertMemoryClaim(memoryClaim({ ...claim, visibility: many(1024) })), "1024 audiences is the largest readable list");
  assert.throws(() => assertMemoryClaim(memoryClaim({ ...claim, visibility: many(1025) })), { code: "invalid" });
  const sparse = new Array(2); sparse[0] = "a";
  assert.throws(() => assertMemoryClaim(memoryClaim({ ...claim, visibility: { kind: "restricted", audiences: sparse } })), { code: "invalid" }, "a list with a hole is unreadable");
  for (const bad of ["public", "private", { audiences: ["a"] }, { kind: "everyone" }, { kind: "public", audiences: ["a"] }, { kind: "restricted" }, { kind: "restricted", audiences: "a" }, { kind: "restricted", audiences: [""] }, { kind: "restricted", audiences: [1] }, { kind: "restricted", audiences: ["a"], extra: 1 }, { kind: "restricted", audiences: Array.from({ length: 1025 }, (_, i) => `a${i}`) }, null, []]) {
    assert.throws(() => assertMemoryClaim(memoryClaim({ ...claim, visibility: bad })), { code: "invalid" }, JSON.stringify(bad)?.slice(0, 60));
  }
  const { visibility: _v, ...bare } = asDocument(claim);
  assert.doesNotThrow(() => assertMemoryClaim(memoryClaim(bare)), "no visibility is legal: it reads as sealed");
  await assert.rejects(distillMemoryClaims({ sitting: loadSittings()[0], passes: 1, visibility: "public", extract: traverseExtract(scriptedProvider([[{ quote: "The widget service uses PostgreSQL 15 as its primary database.", subject: "widget service", subjectType: "service", property: "primary database", value: "PostgreSQL 15", posture: "stated" }]])) }), { code: "invalid" });
  await assert.rejects(distillMemoryClaims({ sitting: { sittingId: "s", turns: [] }, visibility: { kind: "restricted" }, extract: async () => ({ proposals: [] }) }), { code: "invalid" }, "refused even when there is nothing to extract");
});

test("distill refuses an unbounded number of passes", async () => {
  await assert.rejects(distillMemoryClaims({ sitting: loadSittings()[0], passes: 9, extract: async () => ({ proposals: [] }) }), MemoryClaimError);
  await assert.rejects(distillMemoryClaims({ sitting: loadSittings()[0], passes: 0, extract: async () => ({ proposals: [] }) }), MemoryClaimError);
});

// --- review round 6 ---------------------------------------------------------------------------------------------------

test("valid time is half-open: an interval that ends where another begins does not overlap it, one that begins a millisecond earlier does", () => {
  const a = { from: "2026-01-01T00:00:00.000Z", until: "2026-06-01T00:00:00.000Z" };
  const b = { from: "2026-06-01T00:00:00.000Z", until: "2026-12-01T00:00:00.000Z" };
  assert.equal(memoryIntervalsOverlap(a, b), false);
  assert.equal(memoryIntervalsOverlap(b, a), false);
  assert.equal(memoryIntervalsOverlap(a, { ...b, from: "2026-05-31T23:59:59.999Z" }), true);
  assert.equal(memoryIntervalsOverlap(a, a), true);
  assert.equal(memoryIntervalsOverlap(a, undefined), true, "no bound is unbounded");
  assert.equal(memoryIntervalsOverlap({ from: "2026-06-01T00:00:00Z" }, { until: "2026-06-01T00:00:00Z" }), false, "a bound met exactly from either side");
  assert.throws(() => memoryIntervalsOverlap({ from: "2026-06-01T00:00:00Z", until: "2026-06-01T00:00:00Z" }, undefined), MemoryClaimError, "an empty interval is refused");
});

test("qualifiers map names to strings, and anything else is refused", async () => {
  const { earlier } = await fixtureClaims();
  const claim = earlier.result.claims[0];
  assert.doesNotThrow(() => assertMemoryClaim(memoryClaim({ ...claim, qualifiers: { env: "prod", region: "eu" } })));
  for (const bad of [{ env: 1 }, { env: null }, { env: ["prod"] }, { env: { a: 1 } }, "env", ["env"], null]) {
    assert.throws(() => assertMemoryClaim(memoryClaim({ ...claim, qualifiers: bad })), { code: "invalid" }, JSON.stringify(bad));
  }
});

// --- review round 9 -------------------------------------------------------------------------------------------------------

test("distill reads the sitting once, before extraction: changing it while the model runs changes nothing in the claims", async () => {
  const sitting = structuredClone(loadSittings()[0]);
  const original = { id: sitting.sittingId, at: sitting.turns[0].at };
  const quote = "The widget service uses PostgreSQL 15 as its primary database.";
  const finding = { quote, subject: "widget service", subjectType: "service", property: "primary database", value: "PostgreSQL 15", posture: "stated" };
  const inner = traverseExtract(scriptedProvider([[finding]]));
  const seen = [];
  const extract = async request => { seen.push(request.sourceRef); sitting.sittingId = "someone else"; for (const turn of sitting.turns) turn.at = "2031-01-01T00:00:00Z"; return inner(request); };
  const result = await distillMemoryClaims({ sitting, passes: 1, extract });
  assert.equal(result.claims.length, 1);
  assert.deepEqual(seen, [original.id], "the model was given the original source reference");
  assert.equal(result.claims[0].source.ref, original.id, "and the claim names that same one");
  assert.notEqual(result.claims[0].source.observedAt, "2031-01-01T00:00:00Z");
});

test("a distill request is read without running caller code: a getter, a Proxy or an overridden turns list is refused", async () => {
  const sitting = loadSittings()[0], extract = traverseExtract(scriptedProvider([[]]));
  const getter = Object.defineProperty({ passes: 1, extract }, "sitting", { enumerable: true, get: () => sitting });
  await assert.rejects(distillMemoryClaims(getter), MemoryClaimError, "a getter for the sitting");
  await assert.rejects(distillMemoryClaims(new Proxy({ sitting, passes: 1, extract }, {})), MemoryClaimError, "a Proxy request");
  await assert.rejects(distillMemoryClaims({ sitting: new Proxy(sitting, {}), passes: 1, extract }), MemoryClaimError, "a Proxy sitting");
  const turns = [...sitting.turns]; turns.map = () => [];
  await assert.rejects(distillMemoryClaims({ sitting: { ...sitting, turns }, passes: 1, extract }), MemoryClaimError, "an own map on the turns");
  await assert.rejects(distillMemoryClaims({ sitting: { ...sitting, sittingId: " " }, passes: 1, extract }), /sittingId/);
  await assert.rejects(distillMemoryClaims({ sitting, passes: 1, extract, current: new Proxy([], {}) }), MemoryClaimError, "a Proxy list of current claims");
  await assert.rejects(distillMemoryClaims({ sitting, passes: 1, extract, visibility: new Proxy({ kind: "public" }, {}) }), MemoryClaimError, "a Proxy visibility");
  await assert.rejects(distillMemoryClaims({ sitting, passes: 1, extract, visibility: Object.defineProperty({ kind: "restricted" }, "audiences", { enumerable: true, get: () => ["a"] }) }), MemoryClaimError, "a visibility with a getter");
});

// --- review round 10 -------------------------------------------------------------------------------------------------------

test("an extractor that reuses and edits what it returned cannot change a claim after it was checked: each pass's response is copied on arrival", async () => {
  const sitting = loadSittings()[0];
  const quote = "The widget service uses PostgreSQL 15 as its primary database.";
  const shared = { fieldPath: "claims[].value", candidateValue: { engine: "PostgreSQL", version: 15 }, pathIndices: [0], provenance: { excerpt: quote, locator: "chars:0-1" }, extractor: "test" };
  const others = [["subject", "widget service"], ["subjectType", "service"], ["property", "primary database"], ["posture", "stated"]]
    .map(([name, candidateValue]) => ({ fieldPath: `claims[].${name}`, candidateValue, pathIndices: [0], provenance: { excerpt: quote, locator: "chars:0-1" }, extractor: "test" }));
  const response = { proposals: [shared, ...others] };
  let pass = 0;
  const extract = async () => { if (pass++ === 1) shared.candidateValue.version = 16; return response; };
  const result = await distillMemoryClaims({ sitting, passes: 2, extract });
  for (const claim of result.claims) assert.doesNotThrow(() => assertMemoryClaim(claim), "every returned claim still matches its id");
  assert.equal(result.claims.length, 2, "the two passes now disagree, and say so, instead of one claim changing under its id");
  assert.deepEqual(result.claims.map(claim => claim.value.version).sort(), [15, 16]);
});

test("an extraction response that is not plain data is a failed pass, reported, not a crash or a trusted claim", async () => {
  const sitting = loadSittings()[0];
  const getter = { proposals: [] }; Object.defineProperty(getter, "error", { enumerable: true, get: () => "x" });
  for (const response of [getter, new Proxy({ proposals: [] }, {})]) {
    const result = await distillMemoryClaims({ sitting, passes: 1, extract: async () => response });
    assert.deepEqual(result.claims, []);
    assert.match(result.warnings.join("\n"), /pass 1 failed/);
  }
});

test("an extraction response larger than one claim's bound is accepted: a long sitting yields many claims in one response", async () => {
  const sitting = loadSittings()[0];
  const quote = "The widget service uses PostgreSQL 15 as its primary database.";
  const at = (name, candidateValue, index) => ({ fieldPath: `claims[].${name}`, candidateValue, pathIndices: [index], provenance: { excerpt: quote, locator: "chars:0-1" }, extractor: "test" });
  const proposals = Array.from({ length: 700 }, (_, i) => [at("subject", `service ${i}`, i), at("subjectType", "service", i), at("property", "primary database", i), at("value", `PostgreSQL ${i}`, i), at("posture", "stated", i)]).flat();
  assert.ok(JSON.stringify(proposals).length > 200_000, "the premise: well over 20,000 JSON values");
  const result = await distillMemoryClaims({ sitting, passes: 1, extract: async () => ({ proposals }) });
  assert.deepEqual(result.warnings, []);
  assert.equal(result.claims.length, 700);
});

// --- review round 11 --------------------------------------------------------------------------------------------------------

test("a proposal the Kit could not route or present is rejected where it is assembled, with the reason, not returned as a claim", () => {
  const quote = "x";
  const group = fields => Object.entries({ subject: "widget service", subjectType: "service", property: "primary database", posture: "stated", ...fields })
    .map(([name, candidateValue]) => ({ fieldPath: `claims[].${name}`, candidateValue, pathIndices: [0], provenance: { excerpt: quote, locator: "chars:0-1" }, extractor: "test" }));
  const assemble = fields => assembleMemoryClaims({ proposals: group(fields) }, { sourceRef: "s", locate: () => ({ observedAt: "2026-11-01T00:00:00.000Z", role: "user" }) });
  const ok = assemble({ value: Array.from({ length: 19000 }, (_, i) => i) });
  assert.equal(ok.claims.length, 1, "a large value within the bound is a claim");
  const huge = assemble({ value: Array.from({ length: 21000 }, (_, i) => i) });
  assert.deepEqual(huge.claims, []);
  assert.match(huge.rejected[0].reason, /cannot be routed or presented.*too large/);
  let deep = "leaf"; for (let i = 0; i < 40; i++) deep = { a: deep };
  const tooDeep = assemble({ value: deep });
  assert.deepEqual(tooDeep.claims, []);
  assert.match(tooDeep.rejected[0].reason, /cannot be routed or presented.*too deep/);
});

test("a long sitting's extraction can return a claim the Kit then refuses: distill reports it as rejected, with no warnings hidden", async () => {
  const sitting = loadSittings()[0];
  const quote = "The widget service uses PostgreSQL 15 as its primary database.";
  const at = (name, candidateValue) => ({ fieldPath: `claims[].${name}`, candidateValue, pathIndices: [0], provenance: { excerpt: quote, locator: "chars:0-1" }, extractor: "test" });
  const proposals = [at("subject", "widget service"), at("subjectType", "service"), at("property", "primary database"), at("posture", "stated"), at("value", Array.from({ length: 21000 }, (_, i) => i))];
  const result = await distillMemoryClaims({ sitting, passes: 1, extract: async () => ({ proposals }) });
  assert.deepEqual(result.claims, []);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].reason, /too large/);
});

test("a value nested as deep as a claim may be survives the extraction response that carries it, which nests a few levels deeper", async () => {
  const sitting = loadSittings()[0];
  const quote = "The widget service uses PostgreSQL 15 as its primary database.";
  const nest = n => { let v = "leaf"; for (let i = 0; i < n; i++) v = { a: v }; return v; };
  const at = (name, candidateValue) => ({ fieldPath: `claims[].${name}`, candidateValue, pathIndices: [0], provenance: { excerpt: quote, locator: "chars:0-1" }, extractor: "test" });
  const fields = value => [at("subject", "widget service"), at("subjectType", "service"), at("property", "primary database"), at("posture", "stated"), at("value", value)];
  const ok = await distillMemoryClaims({ sitting, passes: 1, extract: async () => ({ proposals: fields(nest(30)) }) });
  assert.deepEqual(ok.warnings, [], "no pass failed");
  assert.equal(ok.claims.length, 1, "30 levels is within a claim's bound");
  const over = await distillMemoryClaims({ sitting, passes: 1, extract: async () => ({ proposals: fields(nest(33)) }) });
  assert.deepEqual(over.claims, []);
  assert.match(over.rejected[0].reason, /too deep/);
});

test("a sitting that yields more claims than one request carries is refused whole, with the way out, not returned as a list nothing downstream accepts", async () => {
  const sitting = loadSittings()[0];
  const quote = "The widget service uses PostgreSQL 15 as its primary database.";
  const at = (name, candidateValue, index) => ({ fieldPath: `claims[].${name}`, candidateValue, pathIndices: [index], provenance: { excerpt: quote, locator: "chars:0-1" }, extractor: "test" });
  let pass = 0;
  const extract = async () => {
    const current = pass++;
    return { proposals: Array.from({ length: 2_700 }, (_, i) => [at("subject", `service ${current}-${i}`, i), at("subjectType", "service", i), at("property", "primary database", i), at("value", `v${current}-${i}`, i), at("posture", "stated", i)]).flat() };
  };
  await assert.rejects(distillMemoryClaims({ sitting, passes: 8, extract }), /yielded 21600 claims over 8 passes, more than the 20000 one request carries; distill it in chunks/);
  pass = 0;
  const ok = await distillMemoryClaims({ sitting, passes: 7, extract });
  assert.equal(ok.claims.length, 18_900, "and the largest the limit admits is returned");
});
