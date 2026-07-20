import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runDream } from "./index.js";
import DefaultKnowledgeStore from "../adapters/default-store/index.js";
import { scaffoldStore } from "../adapters/shared/store-resolve.js";

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../promote/fixtures/runtime");
function telemetry(transcript) { return { schema_version: "0.3.0", timestamp: "2026-07-20T00:00:00Z", session_id: "s", event_id: "e", event_type: "session.end", agent: { name: "dev", runtime: "codex", version: "test" }, hook: { event_name: "Stop", runtime_session_id: "s", turn_id: "", transcript_path: transcript, model: "", source: "fixture", stop_hook_active: null, last_assistant_message: "", raw_input: null } }; }
function completeStore(root) { const repo = path.join(root, "store-repo"); fs.mkdirSync(repo, { recursive: true }); return scaffoldStore(repo); }
function recordCount(storeRoot) { return fs.readdirSync(path.join(storeRoot, "records")).filter((name) => name.endsWith(".md")).length; }
test("dream commits cursor last and a second run is a no-op", async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dream-run-"));
  try {
    const transcript = path.join(root, "transcript.jsonl"); const telemetryFile = path.join(root, "telemetry.jsonl");
    fs.copyFileSync(path.join(fixtureRoot, "codex-rollout.jsonl"), transcript);
    fs.writeFileSync(telemetryFile, `${JSON.stringify(telemetry(transcript))}\n`);
    const options = { telemetryFile, transcriptRoots: [root], storeRoot: completeStore(root), applyPolicy: "auto" };
    const first = await runDream(options); assert.equal(first.status, "success");
    const cursor = path.join(options.storeRoot, "dream", "cursors", "runtime-session.cursor.json"); assert.ok(fs.existsSync(cursor));
    const second = await runDream(options); assert.equal(second.status, "noop");
    const before = fs.readFileSync(cursor, "utf8");
    fs.appendFileSync(telemetryFile, `${JSON.stringify({ ...telemetry(transcript), event_id: "e-2", session_id: "s-2", hook: { ...telemetry(transcript).hook, runtime_session_id: "s-2" } })}\n`);
    await assert.rejects(() => runDream({ ...options, faultAt: "brief" }));
    assert.equal(fs.readFileSync(cursor, "utf8"), before);
    const createdBeforeRetry = recordCount(options.storeRoot);
    const retry = await runDream(options); assert.equal(retry.status, "success");
    assert.equal(recordCount(options.storeRoot), createdBeforeRetry, "retry must reuse the deterministic record");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("skipped-only telemetry reports then advances cursor while unchanged telemetry is a true no-op", async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dream-skipped-"));
  try {
    const telemetryFile = path.join(root, "telemetry.jsonl"); const storeRoot = completeStore(root);
    fs.writeFileSync(telemetryFile, `${JSON.stringify({ ...telemetry(""), event_id: "skip", hook: {} })}\n`);
    const first = await runDream({ telemetryFile, transcriptRoots: [root], storeRoot, applyPolicy: "pending" });
    assert.equal(first.status, "success"); assert.equal(first.skipped, 1); assert.ok(first.cursor?.digest);
    const cursorFile = path.join(storeRoot, "dream", "cursors", "runtime-session.cursor.json"); const before = fs.readFileSync(cursorFile, "utf8");
    const second = await runDream({ telemetryFile, transcriptRoots: [root], storeRoot, applyPolicy: "pending" });
    assert.equal(second.status, "noop"); assert.equal(fs.readFileSync(cursorFile, "utf8"), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("skipped-only telemetry reconciles downstream review and stale briefs before cursor commit", async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dream-skipped-briefs-"));
  try {
    const transcript = path.join(root, "codex.jsonl"); const telemetryFile = path.join(root, "telemetry.jsonl"); const storeRoot = completeStore(root);
    fs.copyFileSync(path.join(fixtureRoot, "codex-rollout.jsonl"), transcript); fs.writeFileSync(telemetryFile, `${JSON.stringify(telemetry(transcript))}\n`);
    await runDream({ telemetryFile, transcriptRoots: [root], storeRoot, applyPolicy: "auto" });
    const store = new DefaultKnowledgeStore({ storeRoot }); const [raw] = await store.listByType("raw"); await store.update(raw.id, { tags: [...raw.tags, "brief-approved"] }, { agent: "downstream-review" });
    const stale = path.join(storeRoot, "dream", "briefs", "project-stale.md"); fs.writeFileSync(stale, "stale\n", { mode: 0o600 });
    const cursorFile = path.join(storeRoot, "dream", "cursors", "runtime-session.cursor.json"); const cursorBefore = fs.readFileSync(cursorFile, "utf8"); fs.appendFileSync(telemetryFile, `${JSON.stringify({ ...telemetry(""), event_id: "skip-2", session_id: "skip-2", hook: {} })}\n`);
    await assert.rejects(() => runDream({ telemetryFile, transcriptRoots: [root], storeRoot, applyPolicy: "auto", faultAt: "cursor" }));
    assert.equal(fs.readFileSync(cursorFile, "utf8"), cursorBefore, "cursor stays last after durable brief reconciliation"); assert.equal(fs.existsSync(stale), false);
    const reportsDir = path.join(storeRoot, "dream", "reports"); const failure = JSON.parse(fs.readFileSync(path.join(reportsDir, fs.readdirSync(reportsDir).sort().at(-1)), "utf8"));
    assert.equal(failure.status, "failed"); assert.ok(failure.briefs[0].record_ids.includes(raw.id)); assert.ok(failure.briefs[0].digest); assert.ok(failure.briefs[0].token_count > 0); assert.equal(failure.briefs[0].written, true); assert.deepEqual(failure.obsolete_briefs_removed, ["project-stale.md"]);
    const retry = await runDream({ telemetryFile, transcriptRoots: [root], storeRoot, applyPolicy: "auto" }); assert.equal(retry.outcome, "skipped-only"); assert.equal(retry.briefs[0].written, false); assert.notEqual(fs.readFileSync(cursorFile, "utf8"), cursorBefore);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("no-new-telemetry writes a noop report, reconciles briefs, and never rewrites the cursor", async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dream-noop-briefs-"));
  try {
    const transcript = path.join(root, "codex.jsonl"); const telemetryFile = path.join(root, "telemetry.jsonl"); const storeRoot = completeStore(root);
    fs.copyFileSync(path.join(fixtureRoot, "codex-rollout.jsonl"), transcript); fs.writeFileSync(telemetryFile, `${JSON.stringify(telemetry(transcript))}\n`);
    await runDream({ telemetryFile, transcriptRoots: [root], storeRoot, applyPolicy: "auto" });
    const reportsDir = path.join(storeRoot, "dream", "reports"); const cursorFile = path.join(storeRoot, "dream", "cursors", "runtime-session.cursor.json"); const cursorBefore = fs.readFileSync(cursorFile, "utf8"); const firstCount = fs.readdirSync(reportsDir).length;
    const unchanged = await runDream({ telemetryFile, transcriptRoots: [root], storeRoot, applyPolicy: "auto" });
    assert.equal(unchanged.status, "noop"); assert.equal(fs.readdirSync(reportsDir).length, firstCount + 1); assert.equal(unchanged.briefs[0].written, false); assert.equal(fs.readFileSync(cursorFile, "utf8"), cursorBefore);
    const store = new DefaultKnowledgeStore({ storeRoot }); const [raw] = await store.listByType("raw"); await store.update(raw.id, { tags: [...raw.tags, "brief-approved"] }, { agent: "downstream-review" });
    const approved = await runDream({ telemetryFile, transcriptRoots: [root], storeRoot, applyPolicy: "auto" });
    assert.equal(approved.status, "noop"); assert.ok(approved.briefs[0].record_ids.includes(raw.id)); assert.equal(approved.briefs[0].written, true); assert.equal(fs.readFileSync(cursorFile, "utf8"), cursorBefore);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("dry-run reads the real cursor without writing any store bytes", async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dream-dry-cursor-"));
  try {
    const transcript = path.join(root, "codex.jsonl"); const telemetryFile = path.join(root, "telemetry.jsonl"); const storeRoot = completeStore(root);
    fs.copyFileSync(path.join(fixtureRoot, "codex-rollout.jsonl"), transcript); fs.writeFileSync(telemetryFile, `${JSON.stringify(telemetry(transcript))}\n`);
    await runDream({ telemetryFile, transcriptRoots: [root], storeRoot, applyPolicy: "pending" });
    const cursor = path.join(storeRoot, "dream", "cursors", "runtime-session.cursor.json"); const before = fs.readFileSync(cursor, "utf8");
    const result = await runDream({ telemetryFile, transcriptRoots: [root], storeRoot, cursorFile: cursor, applyPolicy: "pending", dryRun: true });
    assert.equal(result.sessions, 0); assert.equal(fs.readFileSync(cursor, "utf8"), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("stored proposals preserve confidence and run link plus provider-neutral health before propose", async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dream-link-health-"));
  try {
    const transcript = path.join(root, "codex.jsonl"); const telemetryFile = path.join(root, "telemetry.jsonl"); const storeRoot = completeStore(root);
    fs.copyFileSync(path.join(fixtureRoot, "codex-rollout.jsonl"), transcript); fs.writeFileSync(telemetryFile, `${JSON.stringify(telemetry(transcript))}\n`);
    const distiller = () => [{ title: "Unreviewed candidate", body: "bounded", category: "memory.runtime", tags: ["memory"], confidence: 0.875 }];
    const result = await runDream({ telemetryFile, transcriptRoots: [root], storeRoot, applyPolicy: "auto", distiller });
    assert.equal(result.link.records_linked, 1); assert.equal(result.health.report.schema_version, "1.0");
    const store = new DefaultKnowledgeStore({ storeRoot }); const [record] = await store.listByType("raw");
    assert.ok(record.tags.includes("confidence:0.875")); assert.ok(record.tags.includes("source:runtime-session"));
    assert.equal(result.briefs[0].record_ids.includes(record.id), false, "distilled raw records remain quarantined");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("partial apply failure report includes durable receipts and exact on-disk cursor digest", async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dream-partial-report-"));
  try {
    const transcript = path.join(root, "codex.jsonl"); const telemetryFile = path.join(root, "telemetry.jsonl"); const storeRoot = completeStore(root);
    fs.copyFileSync(path.join(fixtureRoot, "codex-rollout.jsonl"), transcript); fs.writeFileSync(telemetryFile, `${JSON.stringify(telemetry(transcript))}\n`);
    const distiller = () => ["one", "two"].map((title) => ({ title, body: title, category: "memory.runtime", tags: [], confidence: 0.5 }));
    await assert.rejects(() => runDream({ telemetryFile, transcriptRoots: [root], storeRoot, applyPolicy: "auto", distiller, faultAt: "create:1" }));
    const reports = fs.readdirSync(path.join(storeRoot, "dream", "reports")).sort(); const failure = JSON.parse(fs.readFileSync(path.join(storeRoot, "dream", "reports", reports.at(-1)), "utf8"));
    assert.equal(failure.receipts.length, 1); assert.equal(failure.receipts[0].disposition, "created"); assert.ok(failure.receipts[0].record_id);
    const success = await runDream({ telemetryFile, transcriptRoots: [root], storeRoot, applyPolicy: "auto", distiller });
    const cursorBytes = fs.readFileSync(path.join(storeRoot, "dream", "cursors", "runtime-session.cursor.json"));
    assert.equal(success.cursor.digest, createHash("sha256").update(cursorBytes).digest("hex"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("created-before-receipt failure report reconciles the record and retry reuses it", async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dream-created-before-receipt-"));
  try {
    const transcript = path.join(root, "codex.jsonl"); const telemetryFile = path.join(root, "telemetry.jsonl"); const storeRoot = completeStore(root);
    fs.copyFileSync(path.join(fixtureRoot, "codex-rollout.jsonl"), transcript); fs.writeFileSync(telemetryFile, `${JSON.stringify(telemetry(transcript))}\n`);
    await assert.rejects(() => runDream({ telemetryFile, transcriptRoots: [root], storeRoot, applyPolicy: "auto", faultAt: "receipt:0" }));
    const reportsDir = path.join(storeRoot, "dream", "reports"); const failure = JSON.parse(fs.readFileSync(path.join(reportsDir, fs.readdirSync(reportsDir).sort().at(-1)), "utf8"));
    assert.equal(failure.receipts.length, 1); assert.equal(failure.receipts[0].disposition, "created"); assert.equal(failure.applies.created, 1);
    const retry = await runDream({ telemetryFile, transcriptRoots: [root], storeRoot, applyPolicy: "auto" }); assert.equal(retry.applies.reused, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("brief partial failure report reconciles completed writes and stale deletions", async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dream-brief-progress-"));
  try {
    const telemetryFile = path.join(root, "telemetry.jsonl"); const storeRoot = completeStore(root); fs.writeFileSync(telemetryFile, "");
    const store = new DefaultKnowledgeStore({ storeRoot }); await store.create({ type: "compiled", title: "Reviewed", body: "durable", category: "project.alpha", tags: ["project:alpha"], provenance: { agent: "fixture" } });
    const briefRoot = path.join(storeRoot, "dream", "briefs"); fs.mkdirSync(briefRoot, { recursive: true }); const stale = path.join(briefRoot, "project-stale.md"); fs.writeFileSync(stale, "stale\n", { mode: 0o600 });
    await assert.rejects(() => runDream({ telemetryFile, transcriptRoots: [root], storeRoot, applyPolicy: "auto", faultAt: "brief-write:0" }), /brief|injected/i);
    const reportsDir = path.join(storeRoot, "dream", "reports"); const failure = JSON.parse(fs.readFileSync(path.join(reportsDir, fs.readdirSync(reportsDir).sort().at(-1)), "utf8"));
    assert.equal(failure.status, "failed"); assert.deepEqual(failure.obsolete_briefs_removed, ["project-stale.md"]); assert.equal(fs.existsSync(stale), false); assert.equal(failure.briefs.length, 1); assert.equal(failure.briefs[0].name, "global.md"); assert.ok(failure.briefs[0].digest); assert.ok(failure.briefs[0].token_count > 0); assert.equal(failure.briefs[0].written, true);
    const content = fs.readFileSync(path.join(briefRoot, "global.md"), "utf8"); assert.equal(createHash("sha256").update(content).digest("hex"), failure.briefs[0].digest);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("rejects cursor escape and symlinked personal store ancestry", async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dream-containment-"));
  try {
    const transcript = path.join(root, "codex.jsonl"); const telemetryFile = path.join(root, "telemetry.jsonl"); fs.copyFileSync(path.join(fixtureRoot, "codex-rollout.jsonl"), transcript); fs.writeFileSync(telemetryFile, `${JSON.stringify(telemetry(transcript))}\n`);
    const storeRoot = completeStore(root); await assert.rejects(() => runDream({ telemetryFile, transcriptRoots: [root], storeRoot, cursorFile: path.join(root, "escape.json") }), /cursor.*contained/i);
    const real = completeStore(path.join(root, "real-fixture")); const linked = path.join(root, "linked"); fs.symlinkSync(real, linked);
    await assert.rejects(() => runDream({ telemetryFile, transcriptRoots: [root], storeRoot: linked }), /symlink/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const faultAt of ["ingest", "distill", "proposal", "create", "brief", "report", "cursor"]) {
  test(`AC5: ${faultAt} failure keeps cursor unadvanced and retry is idempotent`, async () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `dream-fault-${faultAt}-`));
    try {
      const transcript = path.join(root, "codex.jsonl"); const telemetryFile = path.join(root, "telemetry.jsonl");
      fs.copyFileSync(path.join(fixtureRoot, "codex-rollout.jsonl"), transcript); fs.writeFileSync(telemetryFile, `${JSON.stringify(telemetry(transcript))}\n`);
      const options = { telemetryFile, transcriptRoots: [root], storeRoot: completeStore(root), applyPolicy: "auto", faultAt };
      const cursor = path.join(options.storeRoot, "dream", "cursors", "runtime-session.cursor.json");
      await assert.rejects(() => runDream(options)); assert.equal(fs.existsSync(cursor), false, "cursor must commit after every other stage");
      const retry = await runDream({ ...options, faultAt: undefined }); assert.equal(retry.status, "success");
      assert.equal(recordCount(options.storeRoot), 1, "retry cannot duplicate a deterministic record");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test("AC10: report reconciles proposals, dispositions, brief digests, and cursor digest", async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dream-report-"));
  try {
    const transcript = path.join(root, "codex.jsonl"); const telemetryFile = path.join(root, "telemetry.jsonl");
    fs.copyFileSync(path.join(fixtureRoot, "codex-rollout.jsonl"), transcript); fs.writeFileSync(telemetryFile, `${JSON.stringify(telemetry(transcript))}\n`);
    const storeRoot = completeStore(root); const result = await runDream({ telemetryFile, transcriptRoots: [root], storeRoot, applyPolicy: "auto" });
    assert.equal(result.sessions, result.ingest.sessions_ingested); assert.equal(result.proposals, result.staged.length);
    assert.equal(result.applies.created + result.applies.reused, result.proposals);
    assert.ok(result.redaction_hits > 0, "report reconciles observed redaction markers from the WI-1 residue");
    for (const brief of result.briefs) {
      const content = fs.readFileSync(path.join(storeRoot, "dream", "briefs", brief.name), "utf8");
      assert.equal(createHash("sha256").update(content).digest("hex"), brief.digest);
    }
    assert.equal(result.cursor.commit_intent, true); assert.ok(result.cursor.digest);
    const privateFiles = [path.join(storeRoot, "dream", "cursors", "runtime-session.cursor.json"), ...result.briefs.map((brief) => path.join(storeRoot, "dream", "briefs", brief.name))];
    for (const file of privateFiles) assert.equal(fs.statSync(file).mode & 0o777, 0o600, `${file} must be private`);
    for (const directory of [storeRoot, path.join(storeRoot, "dream"), path.join(storeRoot, "records")]) assert.equal(fs.statSync(directory).mode & 0o777, 0o700, `${directory} must be private`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("dry-run is pure and refuses an incomplete requested personal store", async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dream-dry-"));
  try {
    const transcript = path.join(root, "codex.jsonl"); const telemetryFile = path.join(root, "telemetry.jsonl"); const storeRoot = path.join(root, "missing-store");
    fs.copyFileSync(path.join(fixtureRoot, "codex-rollout.jsonl"), transcript); fs.writeFileSync(telemetryFile, `${JSON.stringify(telemetry(transcript))}\n`);
    await assert.rejects(() => runDream({ telemetryFile, transcriptRoots: [root], storeRoot, dryRun: true }), /store.*incomplete|store.*valid|scaffold/i);
    assert.equal(fs.existsSync(storeRoot), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
