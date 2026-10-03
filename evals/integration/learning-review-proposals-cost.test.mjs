import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeFixtureDir } from "../../src/cli/fixture-temp-dir.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const fixtures = path.join(root, "evals/fixtures/learning-review-proposals");
const analyzer = path.join(root, "scripts/telemetry/learning-review-proposals.sh");
const decider = path.join(root, "scripts/telemetry/learning-review-decide.sh");

function runScript(script, args) {
  const result = spawnSync("bash", [script, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      LR_MIN_WINDOW_SAMPLE: "5", LR_MIN_KIT_SAMPLE: "6", LR_MIN_GATE_SAMPLE: "3",
      LR_COST_RISE_PCT: "25", LR_FLAT_FINDINGS_PCT: "10",
      LR_GATE_FALSE_BLOCK_RATE: "0.5", LR_GATE_WELL_CALIBRATED_RATE: "0.9",
    },
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout;
}

function fixture(t) {
  const directory = makeFixtureDir("learning-review-cost-");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let sequence = 0;
  return {
    ledger: path.join(directory, "proposals.jsonl"),
    analyze(costs, name = "pattern-present", ledger = path.join(directory, `ledger-${sequence}.jsonl`)) {
      const source = path.join(fixtures, name);
      const records = fs.readFileSync(path.join(source, "economics.jsonl"), "utf8")
        .trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(costs.length, records.length);
      records.forEach((record, index) => {
        if (costs[index] === undefined) delete record.cost.estimated_cost_usd;
        else record.cost.estimated_cost_usd = costs[index];
      });
      const log = path.join(directory, `economics-${sequence++}.jsonl`);
      fs.writeFileSync(log, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
      return JSON.parse(runScript(analyzer, ["--sessions-root", path.join(source, "sessions"), "--ledger", ledger, log]));
    },
  };
}

function builder(output) {
  const kit = output.aggregates.by_kit.find((entry) => entry.kit_id === "builder");
  assert.ok(kit, "the actual analyzer must retain the Builder population");
  return kit;
}

function costMeans(kit) {
  return [kit.first_half_avg_cost_usd, kit.second_half_avg_cost_usd, kit.cost_trend_pct];
}

function costCounts(kit) {
  return [kit.priced_runs, kit.unpriced_runs, kit.first_half_priced_runs, kit.second_half_priced_runs];
}

test("mixed priced, null and missing costs use priced denominators without losing outcomes or defects", (t) => {
  const output = fixture(t).analyze([0.1, null, 0.3, 0.2, undefined, 0.4]);
  const kit = builder(output);
  assert.deepEqual(costMeans(kit), [0.2, 0.3, 50]);
  assert.deepEqual(costCounts(kit), [4, 2, 2, 2]);
  assert.equal(output.records_considered, 6);
  assert.equal(output.outcome, "ok");
  assert.equal(kit.runs, 6);
  assert.deepEqual([kit.first_half_findings_total, kit.second_half_findings_total, kit.caught_false_completions_total], [6, 6, 6]);
  const proposal = output.proposals.find((entry) => entry.pattern === "kit-review-cost-inflation");
  assert.ok(proposal);
  assert.deepEqual(costCounts(proposal.evidence.cost), [4, 2, 2, 2]);
  assert.equal(proposal.evidence.defect.findings_delta_pct, 0);
});

test("unpriced halves and all-unpriced windows have null comparisons and no cost proposal", (t) => {
  const f = fixture(t);
  for (const [costs, means, counts] of [
    [[0.1, 0.1, 0.1, null, undefined, null], [0.1, null, null], [3, 3, 3, 0]],
    [[null, undefined, null, 0.2, 0.2, 0.2], [null, 0.2, null], [3, 3, 0, 3]],
    [[null, undefined, null, undefined, null, null], [null, null, null], [0, 6, 0, 0]],
  ]) {
    const output = f.analyze(costs);
    const kit = builder(output);
    assert.deepEqual(costMeans(kit), means);
    assert.deepEqual(costCounts(kit), counts);
    assert.equal(output.outcome, "ok", "the all-record sample gate must remain independent of pricing");
    assert.equal(output.records_considered, 6);
    assert.equal(kit.runs, 6);
    assert.deepEqual([kit.first_half_findings_total, kit.second_half_findings_total], [6, 6]);
    assert.equal(output.proposals.filter((entry) => entry.target.kind === "kit").length, 0);
    assert.ok(output.proposals.some((entry) => entry.pattern === "gate-false-block-review"));
  }
});

test("actual numeric zero remains a priced cost and a zero baseline has no percentage trend", (t) => {
  const f = fixture(t);
  assert.deepEqual(costMeans(builder(f.analyze([0.1, 0.1, 0.1, 0, 0, 0]))), [0.1, 0, -100]);
  assert.deepEqual(costMeans(builder(f.analyze([0, 0, 0, 0.2, 0.2, 0.2]))), [0, 0.2, null]);
});

test("ratified cost effect waits for a priced follow-up and records a real zero improvement", (t) => {
  const f = fixture(t);
  const initial = f.analyze([0.1, 0.1, 0.1, 0.2, 0.2, 0.2], "pattern-present", f.ledger);
  const proposal = initial.proposals.find((entry) => entry.pattern === "kit-review-cost-inflation");
  assert.ok(proposal);
  runScript(decider, [f.ledger, proposal.proposal_id, "--ratify", "--decided-by", "cost-contract-test"]);
  const entry = () => fs.readFileSync(f.ledger, "utf8").trim().split("\n")
    .map((line) => JSON.parse(line)).find((record) => record.proposal_id === proposal.proposal_id);
  f.analyze([null, undefined, null, undefined, null], "effect-follow-up", f.ledger);
  assert.equal(entry().effect_observed, null, "unpriced follow-up must not fabricate an observed improvement");
  assert.equal(entry().decision.status, "ratified");
  f.analyze([0, 0, 0, 0, 0], "effect-follow-up", f.ledger);
  const effect = entry().effect_observed;
  assert.deepEqual([effect.metric, effect.before, effect.after, effect.moved], ["avg_cost_usd", 0.2, 0, "improved"]);
});

test("legacy learning-review owner passes with its aggregate, schema and producer-isolation checks", () => {
  const output = runScript(path.join(root, "evals/integration/test_learning_review_proposals.sh"), []);
  assert.match(output, /test_learning_review_proposals: all checks passed\./);
  assert.match(output, /\[PASS\] legacy by_kit\[\] fields equal expected-aggregates\.json exactly/);
  assert.match(output, /\[PASS\] pattern-present output validates against learning-review-proposals\.schema\.json/);
  assert.match(output, /\[PASS\] cost-only proposal \(defect deleted\) FAILS validation/);
  assert.match(output, /\[PASS\] by_kit\[\] is byte-identical with flow_run_record rows present/);
});
