/**
 * Eval: brief ranking and budget (#671, R7 and AC6).
 *
 * The brief is the injection currency for #672, so its size is bounded and the
 * claims that survive the bound are the ones the ranking rule says should. This
 * suite seeds a store with at least three times the budget and checks what the
 * compiled brief keeps, in what order, and that it is byte-for-byte reproducible.
 *
 * It renders claims through the package's own `presentMemoryClaims`
 * (`@kontourai/flow-agents/memory-routing`), so it needs `npm run build` first. It
 * therefore runs from `src/cli/dream-eval.test.mjs` under `npm run test:unit`, and
 * is not in the kit's own `evals` list, which runs from an isolated kit install.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { memoryClaim } from "../../adapters/memory-claims/index.mjs";
import { compileBrief, rankItems } from "../../dream/brief.js";
import { truncateUtf8 } from "../../dream/util.js";

const NOW = "2026-11-02T00:00:00.000Z";
const bytes = (entries) => Buffer.byteLength(entries.join("\n\n"));
let n = 0;

function item({ value, agreement = { passes: 4, agreeing: 4 }, observedAt = NOW, project = null, state = "applied", property }) {
  n += 1;
  const claim = memoryClaim({
    subject: { type: "service", id: "svc", label: "svc" },
    claimType: "knowledge.memory-claim",
    property: property ?? `property ${n}`,
    value,
    speaker: "user",
    source: { ref: "sitting:eval", locator: `chars:0-${n}`, excerpt: `excerpt ${n}`, observedAt, role: "user" },
    posture: "stated",
  });
  return { claim, project, agreement, state, routing: { outcome: "proposed" } };
}

/** 30 weak, old claims and 3 strong, fresh ones: the strong ones are the ground truth the brief must keep. */
function seed() {
  const strong = ["alpha", "beta", "gamma"].map((name) => item({ value: `must keep ${name}`, agreement: { passes: 4, agreeing: 4 } }));
  const weak = Array.from({ length: 30 }, (_, i) => item({ value: `filler ${i} ${"x".repeat(60)}`, agreement: { passes: 4, agreeing: 1 }, observedAt: "2026-01-15T00:00:00.000Z" }));
  return { strong, items: [...weak, ...strong] };
}

test("AC6: a store seeded at least 3x over budget compiles within the budget and keeps the top-ranked claims", () => {
  const { strong, items } = seed();
  const budget = 700;
  const whole = compileBrief(rankItems(items, { now: NOW }), { budget: 1_000_000 });
  assert.ok(whole.bytes >= 3 * budget, `seed is ${whole.bytes} bytes, budget ${budget}`);

  const brief = compileBrief(rankItems(items, { now: NOW }), { budget });
  assert.ok(brief.bytes <= budget);
  assert.equal(bytes(brief.entries), brief.bytes);
  assert.deepEqual(brief.claimIds.slice(0, 3).sort(), strong.map((s) => s.claim.id).sort(), "the three ground-truth claims lead the brief");
  assert.ok(brief.claimIds.length < items.length);
});

test("the same store always compiles to the same bytes, in any input order", () => {
  const { items } = seed();
  const reference = compileBrief(rankItems(items, { now: NOW }), { budget: 900 }).content;
  for (const shuffled of [[...items].reverse(), [...items.slice(10), ...items.slice(0, 10)]]) {
    assert.equal(compileBrief(rankItems(shuffled, { now: NOW }), { budget: 900 }).content, reference);
  }
});

test("rank = confidence x recency x scope: each factor moves a claim, and none is ignored", () => {
  const order = (items, project = null) => rankItems(items, { project, now: NOW }).map((i) => i.claim.value);
  const confident = item({ value: "confident", agreement: { passes: 4, agreeing: 4 } });
  const doubtful = item({ value: "doubtful", agreement: { passes: 4, agreeing: 1 } });
  assert.deepEqual(order([doubtful, confident]), ["confident", "doubtful"], "confidence");

  const recent = item({ value: "recent", observedAt: "2026-10-30T00:00:00.000Z" });
  const old = item({ value: "old", observedAt: "2026-06-01T00:00:00.000Z" });
  assert.deepEqual(order([old, recent]), ["recent", "old"], "recency");

  const own = item({ value: "own", project: "alpha" });
  const unscoped = item({ value: "unscoped" });
  const elsewhere = item({ value: "elsewhere", project: "beta" });
  assert.deepEqual(order([unscoped, elsewhere, own], "alpha"), ["own", "unscoped"], "scope: own project first, others excluded");

  const reviewed = item({ value: "reviewed", state: "applied", agreement: { passes: 4, agreeing: 0 } });
  const unreviewed = item({ value: "unreviewed", state: "pending", agreement: { passes: 4, agreeing: 4 } });
  assert.deepEqual(rankItems([unreviewed, reviewed], { now: NOW, includeUnreviewed: true }).map((i) => i.claim.value), ["reviewed", "unreviewed"], "review outranks even full extraction agreement");
});

test("truncation keeps the highest-ranked claim and never splits a multibyte character", () => {
  const top = item({ value: "🙂".repeat(400) });
  const low = item({ value: "small", agreement: { passes: 4, agreeing: 1 } });
  for (const budget of [48, 100, 160, 300]) {
    const brief = compileBrief(rankItems([top, low], { now: NOW }), { budget });
    assert.ok(brief.bytes <= budget, `${budget}`);
    assert.equal(brief.claimIds[0], top.claim.id, "the top-ranked claim is the one kept");
    for (const entry of brief.entries) {
      assert.ok(!entry.includes("�"));
      assert.equal(Buffer.from(entry, "utf8").toString("utf8"), entry);
    }
  }
  const text = "日本語🙂ab";
  for (let limit = 0; limit <= Buffer.byteLength(text); limit += 1) {
    const out = truncateUtf8(text, limit);
    assert.ok(Buffer.byteLength(out) <= limit);
    assert.ok(!out.includes("�"));
  }
});

test("a budget too small for any entry yields an empty brief, never an overrun", () => {
  const brief = compileBrief(rankItems([item({ value: "x" })], { now: NOW }), { budget: 8 });
  assert.deepEqual(brief.entries, []);
  assert.equal(brief.bytes, 0);
  assert.throws(() => compileBrief([], { budget: 0 }), /positive integer/);
});
