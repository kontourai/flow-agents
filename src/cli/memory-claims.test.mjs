import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Ajv } from "ajv";
import { validateExtractionTaskSpec, createExtractionTaskSpec } from "@kontourai/traverse";
import {
  MEMORY_CLAIM_POSTURES, MEMORY_CLAIM_TARGET_SCHEMA, MemoryClaimError,
  assembleMemoryClaims, assertMemoryClaim, distillMemoryClaims, memoryClaim,
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
  // The extractor is never asked for visibility: an audience is the host's, not a model's.
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
  assert.deepEqual(next.validTime, { from: "2026-10-30" });
  const owner = earlier.result.claims.find(claim => claim.property === "on-call owner");
  const retraction = later.result.claims.find(claim => claim.property === "on-call owner");
  assert.equal(retraction.posture, "retracted");
  assert.deepEqual(retraction.supersedes.map(edge => [edge.claimId, edge.kind]), [[owner.id, "correction"]]);
  // "Actually it is 8" says replace but gives no start time: it stays a plain claim, which routing will see as a conflict.
  assert.equal(later.result.claims.find(claim => claim.property === "retry budget").supersedes, undefined);
  // Hypothetical and unrelated claims never carry edges.
  assert.equal(later.result.claims.find(claim => claim.posture === "hypothetical").supersedes, undefined);
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

test("claim ids bind content, not evidence: re-finding a fact elsewhere in the sitting is the same claim, a changed value is not", async () => {
  const { earlier } = await fixtureClaims();
  const claim = earlier.result.claims[0];
  const reworded = memoryClaim({ ...claim, source: { ...claim.source, locator: "chars:1-2", excerpt: "different words", observedAt: "2026-11-01T00:00:00.000Z" } });
  assert.equal(reworded.id, claim.id);
  assert.equal(memoryClaim({ ...claim, value: "PostgreSQL 16" }).id === claim.id, false);
  assert.equal(memoryClaim({ ...claim, posture: "hypothetical" }).id === claim.id, false);
  assert.equal(memoryClaim({ ...claim, audience: ["user:a"] }).id === claim.id, false);
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

test("distill refuses an unbounded number of passes", async () => {
  await assert.rejects(distillMemoryClaims({ sitting: loadSittings()[0], passes: 9, extract: async () => ({ proposals: [] }) }), MemoryClaimError);
  await assert.rejects(distillMemoryClaims({ sitting: loadSittings()[0], passes: 0, extract: async () => ({ proposals: [] }) }), MemoryClaimError);
});
