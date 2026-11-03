// The dream run as a callable flow (#671): routed review, the CLI a host scheduler invokes, the opt-in hook
// trigger, operator config, and the flow definition. Everything is disabled by default.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadDreamConfig, validateDreamConfig } from "../../kits/knowledge/dream/config.js";
import { main } from "../../kits/knowledge/dream/cli.js";
import { TRIGGER_EVENTS, handleTrigger } from "../../kits/knowledge/dream/hook-trigger.js";
import { runDream } from "../../kits/knowledge/dream/run.js";
import { FakeCorpusStore, fakeRelayClaims, hostFor, noApplyStore, runOptions, scriptedExtract, tempDir, workspace } from "./dream-support.mjs";

const KIT = path.resolve(import.meta.dirname, "..", "..", "kits", "knowledge");
const CLI = path.join(KIT, "dream", "cli.js");
const HOOK = path.join(KIT, "dream", "hook-trigger.js");

// ── routed review ───────────────────────────────────────────────────────────────────────────────────────────

test("a claim that contradicts a current one is routed to review, published once with its review item, and still only proposed", async (t) => {
  const ws = workspace({ transcripts: ["codex-rollout.jsonl"] });
  t.after(ws.cleanup);
  const store = new FakeCorpusStore(ws.memoryRoot);
  const published = [];
  const claimsOf = (content) => {
    const claim = { subject: "ledger service", subjectType: "service", property: "rounding mode", posture: "stated" };
    if (content.includes("document the rounding rule")) return [{ ...claim, value: "round half up", quote: "Documented in docs/rounding.md." }];
    if (content.includes("banker's rounding")) return [{ ...claim, value: "banker's rounding", quote: "I switched to banker's rounding on the total." }];
    return [];
  };
  const host = hostFor(ws, noApplyStore(store), await scriptedExtract({ claimsOf }), { publish: (batch) => { published.push(batch); } });
  const report = await runDream(host, runOptions(ws));

  assert.equal(report.claims.routed, 1, "the second sitting's value conflicts with the first's");
  assert.equal(report.claims.uncontested, 1);
  assert.equal(report.review_items, 1);
  assert.equal(published.length, 1);
  const [batch] = published;
  assert.equal(batch.runId, report.run_id);
  assert.equal(batch.decisions.length, 2);
  assert.deepEqual(batch.decisions.filter((d) => d.outcome === "routed")[0].reasons.map((r) => r.rule), ["conflicting-current-values"]);
  assert.equal(batch.reviewItems.length, 1);
  assert.equal(batch.reviewItems[0].spec.candidates.length, 2, "a current/proposed pair for the reviewer");
  assert.equal(batch.metrics.routed, 1);
  assert.ok((await store.listProposals()).every((proposal) => proposal.state === "pending"), "routed or not, the run only proposes");
  assert.equal(store.records.size, 0);
});

test("a failed publish fails the run, and the retry republishes the decisions of sittings it finds already proposed", async (t) => {
  const ws = workspace({ transcripts: ["codex-rollout.jsonl"] });
  t.after(ws.cleanup);
  const store = new FakeCorpusStore(ws.memoryRoot);
  const published = [];
  let fail = true;
  const host = hostFor(ws, noApplyStore(store), await scriptedExtract(), { publish: (batch) => { if (fail) throw new Error("review queue down"); published.push(batch); } });
  await assert.rejects(() => runDream(host, runOptions(ws)), /review queue down/);
  assert.equal(fs.existsSync(ws.cursorFile), false);
  fail = false;
  const retry = await runDream(host, runOptions(ws));
  assert.equal(retry.status, "success");
  assert.equal(published[0].decisions.length, 2, "decisions come back out of the store, recomputed, not lost");
  assert.equal((await store.listProposals()).length, 2);
});

test("a tampered stored decision is refused, not skipped: the run stops and says which proposal", async (t) => {
  const ws = workspace({ transcripts: ["codex-rollout.jsonl"] });
  t.after(ws.cleanup);
  const store = new FakeCorpusStore(ws.memoryRoot);
  const host = hostFor(ws, noApplyStore(store), await scriptedExtract());
  await runDream(host, runOptions(ws));
  const [first] = await store.listProposals();
  const file = path.join(store.dir, `${first.id}.json`);
  const body = JSON.parse(first.candidate.body);
  body.decision.outcome = "routed"; // an outcome its own input does not produce
  fs.writeFileSync(file, JSON.stringify({ ...first, candidate: { ...first.candidate, body: JSON.stringify(body) } }));
  await assert.rejects(() => runDream(host, runOptions(ws)), (error) => error.code === "DREAM_RECEIPT_CORRUPT" && error.proposalId === first.id);
  assert.equal(ws.reports().at(-1).status, "failed");
  // Rejecting the bad proposal in the store is the operator's way past it.
  await store.rejectCreate(first.id, "a-human-reviewer", "corrupt");
  assert.notEqual((await runDream(host, runOptions(ws))).status, "failed");
});

test("a real run needs a way to deliver routed review; without one nothing is written", async (t) => {
  const ws = workspace({ transcripts: ["codex-rollout.jsonl"] });
  t.after(ws.cleanup);
  const store = new FakeCorpusStore(ws.memoryRoot);
  const host = hostFor(ws, noApplyStore(store), await scriptedExtract(), { publish: undefined });
  await assert.rejects(() => runDream(host, runOptions(ws)), (error) => error.code === "DREAM_CONFIG_INVALID" && /publish/.test(error.message));
  assert.equal(fs.existsSync(ws.dreamDir), false);
  assert.deepEqual(await store.listProposals(), []);
  assert.equal((await runDream(host, runOptions(ws, { enabled: false, dryRun: true }))).status, "dry-run", "a dry run delivers nothing, so it does not need one");
});

// ── the model through the callable CLI ─────────────────────────────────────────────────────────────────────

function hostModule(dir, body) {
  const file = path.join(dir, "host.mjs");
  fs.writeFileSync(file, body, { mode: 0o600 });
  return file;
}
function writeConfig(ws, extra = {}) {
  const host = hostModule(ws.root, `
    import { FakeCorpusStore, scriptedExtract } from ${JSON.stringify(path.resolve(import.meta.dirname, "dream-support.mjs"))};
    export async function createDreamHost({ config, dryRun }) {
      // Like a real store opener, this creates its root unless it has been told it is a dry run.
      if (!dryRun) (await import("node:fs")).mkdirSync(${JSON.stringify(ws.memoryRoot)}, { recursive: true });
      const store = new FakeCorpusStore(${JSON.stringify(ws.memoryRoot)});
      return { store, extract: await scriptedExtract(), registerRoot() {}, publish() {}, dryRun, root: ${JSON.stringify(ws.memoryRoot)}, rootName: "memory" };
    }
  `);
  const file = path.join(ws.root, "dream.config.json");
  fs.writeFileSync(file, JSON.stringify({ enabled: true, telemetryFile: ws.telemetryFile, transcriptRoots: [ws.transcriptRoot], dreamDir: ws.dreamDir, host, ...extra }), { mode: 0o600 });
  return file;
}
const sink = () => { const chunks = []; return { write: (c) => { chunks.push(c); }, text: () => chunks.join("") }; };

test("CLI: runs the flow and prints the report; the same run again is a no-op", async (t) => {
  const ws = workspace({ transcripts: ["codex-rollout.jsonl"] });
  t.after(ws.cleanup);
  const config = writeConfig(ws);
  const out = sink();
  assert.equal(await main(["run", "--config", config, "--trigger", "station-scheduler"], { stdout: out, stderr: sink() }), 0);
  const report = JSON.parse(out.text());
  assert.equal(report.status, "success");
  assert.equal(report.trigger, "station-scheduler");
  const again = sink();
  assert.equal(await main(["run", "--config", config], { stdout: again, stderr: sink() }), 0);
  assert.equal(JSON.parse(again.text()).status, "noop");
});

test("CLI: disabled by default, strict about configuration, and --dry-run works while disabled", async (t) => {
  const ws = workspace({ transcripts: ["codex-rollout.jsonl"] });
  t.after(ws.cleanup);
  const config = writeConfig(ws, { enabled: false });
  const err = sink();
  assert.equal(await main(["run", "--config", config], { stdout: sink(), stderr: err }), 2);
  assert.match(err.text(), /DREAM_DISABLED/);
  assert.equal(fs.existsSync(ws.dreamDir), false, "a disabled run leaves nothing behind");

  const dry = sink();
  assert.equal(await main(["run", "--config", config, "--dry-run"], { stdout: dry, stderr: sink() }), 0);
  assert.equal(JSON.parse(dry.text()).status, "dry-run");
  assert.equal(fs.existsSync(ws.dreamDir), false);
  assert.equal(fs.existsSync(ws.memoryRoot), false, "a dry run through the CLI creates nothing in the memory root either");

  const noConfig = path.join(ws.root, "none.json");
  fs.writeFileSync(noConfig, JSON.stringify({ enabled: true, telemetryFile: ws.telemetryFile, transcriptRoots: [ws.transcriptRoot], host: "relative.mjs" }), { mode: 0o600 });
  assert.equal(await main(["run", "--config", noConfig], { stdout: sink(), stderr: sink() }), 2);
  assert.equal(await main(["run"], { stdout: sink(), stderr: sink() }), 2);
  assert.equal(await main(["bogus"], { stdout: sink(), stderr: sink() }), 2);
});

test("CLI: a host module another user could have changed is refused", async (t) => {
  const ws = workspace({ transcripts: ["codex-rollout.jsonl"] });
  t.after(ws.cleanup);
  const config = writeConfig(ws);
  const { host } = JSON.parse(fs.readFileSync(config, "utf8"));
  fs.chmodSync(host, 0o666);
  const err = sink();
  assert.equal(await main(["run", "--config", config], { stdout: sink(), stderr: err }), 2);
  assert.match(err.text(), /group or world writable/);
});

test("config and host trust: a writable config, a writable parent directory and a symlinked path are all refused", async (t) => {
  const ws = workspace({ transcripts: ["codex-rollout.jsonl"] });
  t.after(ws.cleanup);
  const config = writeConfig(ws);
  const refuse = async (message) => {
    const err = sink();
    assert.equal(await main(["run", "--config", config], { stdout: sink(), stderr: err }), 2);
    assert.match(err.text(), message);
  };
  fs.chmodSync(config, 0o666);
  await refuse(/config must not be group or world writable/);
  fs.chmodSync(config, 0o600);
  const sub = path.join(ws.root, "shared");
  fs.mkdirSync(sub, { mode: 0o700 });
  const moved = path.join(sub, "dream.config.json");
  fs.copyFileSync(config, moved);
  fs.chmodSync(sub, 0o770);
  const err = sink();
  assert.equal(await main(["run", "--config", moved], { stdout: sink(), stderr: err }), 2);
  assert.match(err.text(), /group or world writable directory/);
  fs.chmodSync(sub, 0o700);
  const link = path.join(ws.root, "link.json");
  fs.symlinkSync(config, link);
  const linked = sink();
  assert.equal(await main(["run", "--config", link], { stdout: sink(), stderr: linked }), 2);
  assert.match(linked.text(), /symlink/);
  // And a host module in a directory another user can write is refused even when its own mode is private.
  const hostDir = path.join(ws.root, "hostdir");
  fs.mkdirSync(hostDir, { mode: 0o700 });
  const hostCopy = path.join(hostDir, "host.mjs");
  fs.copyFileSync(JSON.parse(fs.readFileSync(config, "utf8")).host, hostCopy);
  fs.chmodSync(hostCopy, 0o600);
  fs.chmodSync(hostDir, 0o777);
  const moreConfig = path.join(ws.root, "dream.config2.json");
  fs.writeFileSync(moreConfig, JSON.stringify({ ...JSON.parse(fs.readFileSync(config, "utf8")), host: hostCopy }), { mode: 0o600 });
  const e2 = sink();
  assert.equal(await main(["run", "--config", moreConfig], { stdout: sink(), stderr: e2 }), 2);
  assert.match(e2.text(), /group or world writable directory/);
  fs.chmodSync(hostDir, 0o700);
});

test("CLI: exit code 75 when another run holds the lock", async (t) => {
  const ws = workspace({ transcripts: ["codex-rollout.jsonl"] });
  t.after(ws.cleanup);
  const config = writeConfig(ws);
  fs.mkdirSync(ws.dreamDir, { recursive: true });
  fs.writeFileSync(path.join(ws.dreamDir, "dream.lock"), JSON.stringify({ pid: process.pid, started_at: Date.now(), token: "live" }));
  assert.equal(await main(["run", "--config", config], { stdout: sink(), stderr: sink() }), 75);
});

test("config: unknown keys, relative paths and non-positive numbers are errors; enabled defaults to false", (t) => {
  const base = { telemetryFile: "/t.jsonl", transcriptRoots: ["/r"], host: "/h.mjs" };
  assert.equal(validateDreamConfig(base).enabled, false);
  for (const bad of [{ ...base, surprise: 1 }, { ...base, telemetryFile: "t.jsonl" }, { ...base, transcriptRoots: [] }, { ...base, transcriptRoots: ["rel"] }, { ...base, passes: 0 }, { ...base, enabled: "yes" }, { ...base, role: "" }, []]) {
    assert.throws(() => validateDreamConfig(bad), (error) => error.code === "DREAM_CONFIG_INVALID", JSON.stringify(bad));
  }
  const dir = tempDir("dream-config-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(`${dir}/c.json`, "{not json", { mode: 0o600 });
  assert.throws(() => loadDreamConfig(`${dir}/c.json`), /not valid JSON/);
});

// ── the opt-in hook trigger ──────────────────────────────────────────────────────────────────────────────────

function triggerFixture(t, configExtra = {}) {
  const dir = tempDir("dream-trigger-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, "dream.config.json");
  fs.writeFileSync(config, JSON.stringify({ enabled: true, telemetryFile: path.join(dir, "t.jsonl"), transcriptRoots: [dir], host: path.join(dir, "host.mjs"), dreamDir: path.join(dir, "dream"), ...configExtra }), { mode: 0o600 });
  const spawned = [];
  const spawn = (command, args, options) => { spawned.push({ command, args, options }); return { unref() {}, on() {} }; };
  const env = { FLOW_AGENTS_DREAM_TRIGGER: "1", FLOW_AGENTS_DREAM_CONFIG: config };
  return { dir, config, spawned, spawn, env };
}
const event = (name) => JSON.stringify({ hook_event_name: name, session_id: "s" });

test("trigger: SessionEnd and PreCompact spawn one detached, stdio-less run of the CLI", (t) => {
  assert.deepEqual([...TRIGGER_EVENTS], ["SessionEnd", "PreCompact"]);
  const f = triggerFixture(t);
  const result = handleTrigger({ input: event("SessionEnd"), env: f.env, spawn: f.spawn });
  assert.deepEqual(result, { triggered: true, reason: "SessionEnd" });
  assert.equal(f.spawned.length, 1);
  const [{ args, options }] = f.spawned;
  assert.equal(args[0], CLI);
  assert.deepEqual(args.slice(1, 4), ["run", "--config", f.config]);
  assert.deepEqual(args.slice(4), ["--trigger", "SessionEnd"]);
  assert.equal(options.detached, true);
  assert.equal(options.stdio, "ignore");

  const g = triggerFixture(t);
  assert.equal(handleTrigger({ input: event("PreCompact"), env: g.env, spawn: g.spawn }).triggered, true);
});

test("trigger: off by default, and for every event that is not SessionEnd or PreCompact", (t) => {
  const f = triggerFixture(t);
  assert.deepEqual(handleTrigger({ input: event("SessionEnd"), env: {}, spawn: f.spawn }), { triggered: false, reason: "disabled" });
  assert.equal(handleTrigger({ input: event("SessionEnd"), env: { FLOW_AGENTS_DREAM_TRIGGER: "1" }, spawn: f.spawn }).reason, "disabled");
  assert.equal(handleTrigger({ input: event("SessionEnd"), env: { FLOW_AGENTS_DREAM_CONFIG: f.config }, spawn: f.spawn }).reason, "disabled");
  assert.equal(handleTrigger({ input: event("SessionEnd"), env: { ...f.env, FLOW_AGENTS_DREAM_TRIGGER: "true" }, spawn: f.spawn }).reason, "disabled");
  for (const name of ["Stop", "SessionStart", "UserPromptSubmit", "PostToolUse"]) assert.equal(handleTrigger({ input: event(name), env: f.env, spawn: f.spawn }).reason, "not-a-trigger-event");
  assert.equal(handleTrigger({ input: "not json", env: f.env, spawn: f.spawn }).reason, "unreadable-input");
  assert.equal(f.spawned.length, 0);
  const off = triggerFixture(t, { enabled: false });
  assert.equal(handleTrigger({ input: event("SessionEnd"), env: off.env, spawn: off.spawn }).reason, "config-disabled", "the config must also say enabled");
  assert.equal(off.spawned.length, 0);
});

test("trigger: debounced, best effort, and never throws", (t) => {
  const f = triggerFixture(t, { triggerMinIntervalMs: 60_000 });
  let clock = 1_000_000;
  const now = () => clock;
  assert.equal(handleTrigger({ input: event("SessionEnd"), env: f.env, spawn: f.spawn, now }).triggered, true);
  // The stamp's mtime is real time; make "now" fall within the interval of it.
  assert.equal(handleTrigger({ input: event("SessionEnd"), env: f.env, spawn: f.spawn, now: () => Date.now() }).reason, "debounced");
  assert.equal(f.spawned.length, 1);

  const broken = triggerFixture(t);
  fs.writeFileSync(broken.config, "{");
  assert.deepEqual(handleTrigger({ input: event("SessionEnd"), env: broken.env, spawn: broken.spawn }), { triggered: false, reason: "error" });
  const throws = triggerFixture(t);
  assert.equal(handleTrigger({ input: event("SessionEnd"), env: throws.env, spawn: () => { throw new Error("EAGAIN"); } }).reason, "error");
});

test("trigger: as a process it exits 0 at once and starts a detached run that outlives it", (t) => {
  const ws = workspace({ transcripts: ["codex-rollout.jsonl"] });
  t.after(ws.cleanup);
  const config = writeConfig(ws);
  const run = spawnSync(process.execPath, [HOOK], {
    input: event("SessionEnd"), encoding: "utf8", timeout: 20_000,
    env: { ...process.env, FLOW_AGENTS_DREAM_TRIGGER: "1", FLOW_AGENTS_DREAM_CONFIG: config },
  });
  assert.equal(run.status, 0);
  assert.equal(run.stdout, "", "a hook that adds nothing to the session's context");
  const off = spawnSync(process.execPath, [HOOK], { input: event("SessionEnd"), encoding: "utf8", timeout: 20_000, env: { PATH: process.env.PATH } });
  assert.equal(off.status, 0);
  assert.equal(fs.existsSync(path.join(ws.dreamDir, "trigger.stamp")), true);
  // The detached child commits its cursor and rewrites its report as the last thing it does; wait for that.
  const reportsDir = path.join(ws.dreamDir, "reports");
  const committed = () => (fs.existsSync(reportsDir) ? fs.readdirSync(reportsDir).filter((name) => name.endsWith(".json")) : [])
    .map((name) => JSON.parse(fs.readFileSync(path.join(reportsDir, name), "utf8"))).filter((report) => report.cursor?.committed === true);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && committed().length === 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  const reports = committed();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].trigger, "SessionEnd");
  assert.equal(fs.readdirSync(reportsDir).filter((name) => name.endsWith(".json")).length, 1, "one trigger, one run");
});

// ── the flow definition ──────────────────────────────────────────────────────────────────────────────────────

test("the flow definition: every step has a gate and an exported claim, and the kit registers it", () => {
  const flow = JSON.parse(fs.readFileSync(path.join(KIT, "flows", "dream.flow.json"), "utf8"));
  const kit = JSON.parse(fs.readFileSync(path.join(KIT, "kit.json"), "utf8"));
  assert.equal(flow.id, "knowledge.dream");
  const stepIds = flow.steps.map((step) => step.id).filter((id) => id !== "done");
  const gated = Object.values(flow.gates).map((gate) => gate.step);
  assert.deepEqual(gated.sort(), [...stepIds].sort(), "a gate for every step: this is not a gateless definition");
  const claims = Object.values(flow.gates).flatMap((gate) => gate.expects.map((expect) => expect.bundle_claim.claimType));
  assert.deepEqual(claims.sort(), [...flow.exports].sort());
  for (const gate of Object.values(flow.gates)) for (const expect of gate.expects) assert.equal(expect.kind, "trust.bundle");
  assert.deepEqual(flow.steps.map((step) => step.next).filter(Boolean).length, flow.steps.length - 1);

  const registered = kit.flows.find((entry) => entry.id === "knowledge.dream");
  assert.equal(registered.path, "flows/dream.flow.json");
  assert.ok(fs.existsSync(path.join(KIT, registered.path)));
  const adapter = kit.adapters.find((entry) => entry.id === "knowledge.dream-runner");
  assert.ok(adapter && fs.existsSync(path.join(KIT, adapter.path)));
});

test("the flow's stages are the stages the run reports to its stage hook", async (t) => {
  const ws = workspace({ transcripts: ["codex-rollout.jsonl"] });
  t.after(ws.cleanup);
  const seen = [];
  const host = hostFor(ws, noApplyStore(new FakeCorpusStore(ws.memoryRoot)), await scriptedExtract(), { publish: () => {} });
  await runDream(host, runOptions(ws, { onStage: (name) => { if (!seen.includes(name)) seen.push(name); } }));
  assert.deepEqual(seen, ["ingest", "distill", "route", "propose", "receipt", "publish", "brief", "report", "cursor"]);
  const flow = JSON.parse(fs.readFileSync(path.join(KIT, "flows", "dream.flow.json"), "utf8"));
  const order = flow.steps.map((step) => step.id);
  for (const [a, b] of [["ingest", "distill"], ["distill", "route"], ["route", "propose"], ["propose", "brief"], ["brief", "report"], ["report", "cursor"]]) {
    assert.ok(order.indexOf(a) < order.indexOf(b));
    assert.ok(seen.indexOf(a) < seen.indexOf(b));
  }
  assert.equal(seen.at(-1), "cursor", "the cursor is the last stage");
});

test("this repo's own scheduler wiring: no boo recipe, launchd job, cron entry or standing daemon ships with the dream", () => {
  const dreamFiles = fs.readdirSync(path.join(KIT, "dream"));
  assert.ok(!dreamFiles.some((name) => /boo|launchd|cron|plist|systemd/i.test(name)), dreamFiles.join(", "));
  const sources = dreamFiles.filter((name) => name.endsWith(".js")).map((name) => fs.readFileSync(path.join(KIT, "dream", name), "utf8")).join("\n");
  assert.ok(!/\bboo\b\s+(add|run|enable)|launchctl|crontab/.test(sources));
  assert.ok(fileURLToPath(import.meta.url));
});

test("the invocation contract a host scheduler binds to is pinned: ids, exports, report fields, statuses", async (t) => {
  const index = await import("../../kits/knowledge/dream/index.js");
  for (const name of ["runDream", "defaultDreamDir", "loadDreamConfig", "handleTrigger", "createRoleRuntime", "extractForRuntime"]) assert.equal(typeof index[name], "function", name);
  const kit = JSON.parse(fs.readFileSync(path.join(KIT, "kit.json"), "utf8"));
  assert.ok(kit.flows.some((flow) => flow.id === "knowledge.dream"));
  assert.equal(kit.adapters.find((adapter) => adapter.id === "knowledge.dream-runner").path, "dream/index.js");
  assert.ok(kit.assets.some((asset) => asset.id === "knowledge.dream-cli" && asset.path === "dream/cli.js"));

  const ws = workspace({ transcripts: ["codex-rollout.jsonl"] });
  t.after(ws.cleanup);
  const host = hostFor(ws, noApplyStore(new FakeCorpusStore(ws.memoryRoot)), await scriptedExtract());
  const report = await index.runDream(host, runOptions(ws, { trigger: "station-scheduler" }));
  assert.deepEqual(Object.keys(report).sort(), [
    "brief_excluded", "briefs", "claims", "cursor", "dry_run", "finished_at", "ingest", "metrics", "obsolete_briefs_removed", "receipts",
    "redaction_hits", "review_items", "run_id", "schema_version", "sittings", "started_at", "status", "trigger", "unreadable_proposals",
  ]);
  assert.equal(report.schema_version, "1.0");
  assert.equal(report.trigger, "station-scheduler");
  assert.deepEqual(Object.keys(report.sittings).sort(), ["deferred_incomplete", "deferred_over_cap", "distilled", "resumed", "reused", "seen"]);
  assert.deepEqual(Object.keys(report.claims).sort(), ["created", "distilled", "rejected", "reused", "routed", "truncated", "uncontested"]);
  assert.ok(["success", "noop", "dry-run", "blocked", "failed"].includes(report.status));
  assert.ok(fs.existsSync(path.join(ws.dreamDir, "reports", `${report.run_id}.json`)));
});
