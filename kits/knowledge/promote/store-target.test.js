/**
 * WI-2 / AC4 — store-target contract, written before the target exists.
 *
 * The store destination is deliberately exercised through runPromote so this
 * suite pins both the target selector and the proposal-only boundary. Every
 * fixture supplies private HOME/XDG_DATA_HOME values: this test must never
 * discover, scaffold, or register the operator's real personal store.
 *
 * Run: node --test kits/knowledge/promote/store-target.test.js
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import DefaultKnowledgeStore from "../adapters/default-store/index.js";
import { loadSchemas } from "../providers/lib/model.js";
import { validate } from "../providers/lib/schema-validate.js";
import { runPromote } from "./index.js";
import { snapshotDir } from "./lib.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");
const SESSION_FIXTURE = path.join(FIXTURES, "session");
const REPO_FIXTURE = path.join(FIXTURES, "repo");
const { proposal: PROPOSAL_SCHEMA } = loadSchemas();

const PROVENANCE = {
  pr: "https://github.com/kontourai/flow-agents/pull/670",
  mergeSha: "0123456789abcdef0123456789abcdef01234567",
  sessionArchivePath: ".kontourai/flow-agents/kontourai-flow-agents-287/archive/deliver.md",
};

function copyTree(source, destination) {
  fs.cpSync(source, destination, { recursive: true });
}

function makeFixture(tag) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `promote-store-target-${tag}-`));
  const home = path.join(root, "home");
  const xdg = path.join(root, "xdg");
  const session = path.join(root, "session");
  const repo = path.join(root, "repo");
  const opsKnowledge = path.join(root, "ops", "knowledge");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(xdg, { recursive: true });
  fs.mkdirSync(opsKnowledge, { recursive: true });
  fs.writeFileSync(path.join(opsKnowledge, "SENTINEL.md"), "curated ops must remain untouched\n");
  copyTree(SESSION_FIXTURE, session);
  copyTree(REPO_FIXTURE, repo);

  const slug = JSON.parse(fs.readFileSync(path.join(session, "state.json"), "utf8")).task_slug;
  return {
    root,
    home,
    xdg,
    env: { HOME: home, XDG_DATA_HOME: xdg },
    session,
    repo,
    slug,
    opsKnowledge,
    storeRoot: path.join(xdg, "knowledge-store", "knowledge"),
    pendingDir: path.join(xdg, "knowledge-store", "knowledge", "proposals", "pending", slug),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function storeRun(fixture) {
  return runPromote({
    sessionDir: fixture.session,
    repoRoot: fixture.repo,
    provenance: PROVENANCE,
    target: "store",
    env: fixture.env,
    agent: "wi2-store-target-test",
    decided: "2026-07-20",
  });
}

function jsonFiles(dir, rel = "") {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryRel = path.join(rel, entry.name);
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...jsonFiles(absolute, entryRel));
    else if (entry.isFile() && entry.name.endsWith(".json")) files.push(entryRel);
  }
  return files.sort();
}

function assertContained(root, candidate, label) {
  const relative = path.relative(root, candidate);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), `${label} escaped its root`);
}

function assertRelativeReference(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.ok(value.length > 0, `${label} must be non-empty`);
  assert.equal(path.isAbsolute(value), false, `${label} must not expose an absolute path`);
  assert.equal(value.split(/[\\/]/).includes(".."), false, `${label} must stay contained`);
}

function recordFiles(storeRoot) {
  const records = path.join(storeRoot, "records");
  if (!fs.existsSync(records)) return [];
  return fs.readdirSync(records).filter((name) => name.endsWith(".md")).sort();
}

function permissionBits(file) {
  return fs.statSync(file).mode & 0o777;
}

async function withFrozenClock(run) {
  const RealDate = globalThis.Date;
  const fixed = "2026-07-20T00:00:00.000Z";
  globalThis.Date = class FrozenDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [fixed]));
    }

    static now() {
      return new RealDate(fixed).getTime();
    }
  };
  try {
    return await run();
  } finally {
    globalThis.Date = RealDate;
  }
}

describe("AC4 / R4: explicit store target stages create proposals only", () => {
  test("stages one schema-valid DefaultKnowledgeStore.create payload per distilled record with mandatory provenance", async () => {
    const fixture = makeFixture("positive");
    try {
      const secretCanary = `sk-${"A".repeat(24)}`;
      const learningPath = path.join(fixture.session, "learning.json");
      const learning = JSON.parse(fs.readFileSync(learningPath, "utf8"));
      learning.records[0].summary = `Never persist api_key=${secretCanary}`;
      learning.records[0].source_refs.push(`api_key=${secretCanary}`);
      fs.writeFileSync(learningPath, `${JSON.stringify(learning, null, 2)}\n`, "utf8");
      const sessionBefore = snapshotDir(fixture.session);
      const repoBefore = snapshotDir(fixture.repo);
      const opsBefore = snapshotDir(fixture.opsKnowledge);

      const result = await storeRun(fixture);
      const proposalFiles = jsonFiles(fixture.pendingDir);
      const expectedProposalCount = result.decisions.length + result.vocabulary.length + result.learnings.length;

      assert.ok(fs.existsSync(path.join(fixture.storeRoot, "graph-index.json")), "store target must bootstrap the private global store");
      assertContained(fixture.storeRoot, fixture.pendingDir, "pending proposal directory");
      assert.equal(proposalFiles.length, expectedProposalCount, "every supported distilled record gets exactly one proposal");
      assert.ok(proposalFiles.length > 0, "fixture must stage proposals");
      assert.doesNotMatch(JSON.stringify(result), new RegExp(secretCanary), "store-target result content is scrubbed too");

      const registry = JSON.parse(
        fs.readFileSync(path.join(fixture.xdg, "knowledge-store", "roots.json"), "utf8"),
      );
      assert.equal(registry.roots.personal, fixture.storeRoot, "global store is registered as the reserved personal root");
      assert.equal(permissionBits(fixture.storeRoot), 0o700, "personal store metadata is private");
      assert.equal(permissionBits(path.dirname(fixture.pendingDir)), 0o700, "pending directory is private");
      assert.equal(permissionBits(fixture.pendingDir), 0o700, "session proposal directory is private");

      // Apply only to a second disposable store. The target store remains
      // proposals-only; this proves that the stored payload is unmodified
      // input compatible with the existing create contract.
      const compatibilityStore = new DefaultKnowledgeStore({
        storeRoot: path.join(fixture.root, "payload-compatibility-store"),
      });
      for (const relative of proposalFiles) {
        const proposalPath = path.join(fixture.pendingDir, relative);
        assertContained(fixture.pendingDir, proposalPath, "proposal path");
        const proposal = JSON.parse(fs.readFileSync(proposalPath, "utf8"));
        assert.equal(permissionBits(proposalPath), 0o600, "proposal files are private");
        assert.doesNotMatch(fs.readFileSync(proposalPath, "utf8"), new RegExp(secretCanary), "secret canary is scrubbed");
        const proposalValidation = validate(proposal, PROPOSAL_SCHEMA);
        assert.equal(proposalValidation.valid, true, proposalValidation.errors.join("\n"));
        assert.equal(proposal.kind, "create-node");
        assert.equal(proposal.status, "proposed");
        assert.ok(proposal.payload, "create proposal must carry the unchanged create payload");
        assert.match(proposal.payload.type, /^(raw|compiled|concept)$/);
        assert.equal(proposal.payload.provenance.session_id, fixture.slug, "record provenance requires the session id");
        assert.ok(Array.isArray(proposal.payload.provenance.source_ids), "record provenance requires transcript refs");
        assert.ok(proposal.payload.provenance.source_ids.length > 0, "record provenance requires non-empty transcript refs");
        assert.deepEqual(
          proposal.payload.provenance.source_ids,
          result.ingested.transcript_refs,
          "record provenance must preserve every ingested transcript ref",
        );
        assertRelativeReference(proposal.provenance.source, "proposal provenance source");
        assertRelativeReference(proposal.provenance.locator, "proposal provenance locator");
        await compatibilityStore.create(proposal.payload);
      }

      assert.deepEqual(recordFiles(fixture.storeRoot), [], "staging must not create live knowledge records");
      assert.deepEqual(snapshotDir(fixture.session), sessionBefore, "store target must not write the source session");
      assert.deepEqual(snapshotDir(fixture.repo), repoBefore, "store target must not write the source repo fixture");
      assert.deepEqual(snapshotDir(fixture.opsKnowledge), opsBefore, "store target must not write curated ops knowledge");
    } finally {
      fixture.cleanup();
    }
  });

  test("is deterministic on retry and fails closed rather than overwriting a mismatched proposal collision", async () => {
    const fixture = makeFixture("collision");
    try {
      await storeRun(fixture);
      const first = snapshotDir(fixture.pendingDir);
      const proposalFiles = jsonFiles(fixture.pendingDir);
      assert.ok(proposalFiles.length > 0, "first store run must stage at least one proposal");

      fs.chmodSync(path.dirname(fixture.pendingDir), 0o755);
      fs.chmodSync(fixture.pendingDir, 0o755);
      for (const relative of proposalFiles) fs.chmodSync(path.join(fixture.pendingDir, relative), 0o644);

      await storeRun(fixture);
      assert.deepEqual(snapshotDir(fixture.pendingDir), first, "same-input retry must be byte-stable");
      assert.equal(permissionBits(path.dirname(fixture.pendingDir)), 0o700, "retry tightens pending directory permissions");
      assert.equal(permissionBits(fixture.pendingDir), 0o700, "retry tightens batch directory permissions");
      for (const relative of proposalFiles) {
        assert.equal(permissionBits(path.join(fixture.pendingDir, relative)), 0o600, "retry tightens proposal permissions");
      }

      const collision = path.join(fixture.pendingDir, proposalFiles[0]);
      fs.writeFileSync(collision, '{"different":"proposal"}\n', "utf8");
      const collided = snapshotDir(fixture.pendingDir);
      await assert.rejects(storeRun(fixture), /collision|conflict|existing/i);
      assert.deepEqual(snapshotDir(fixture.pendingDir), collided, "collision must not be overwritten");
      assert.deepEqual(recordFiles(fixture.storeRoot), [], "collision handling must not apply records");
    } finally {
      fixture.cleanup();
    }
  });

  test("rejects an incomplete prior batch and a symlinked pending session without partial writes", { skip: process.platform === "win32" }, async () => {
    const fixture = makeFixture("atomic-batch");
    try {
      await storeRun(fixture);
      const files = jsonFiles(fixture.pendingDir);
      fs.unlinkSync(path.join(fixture.pendingDir, files[0]));
      const partial = snapshotDir(fixture.pendingDir);
      await assert.rejects(storeRun(fixture), /incomplete batch|collision/i);
      assert.deepEqual(snapshotDir(fixture.pendingDir), partial, "incomplete batch is not filled piecemeal");

      fs.rmSync(fixture.pendingDir, { recursive: true, force: true });
      const outside = path.join(fixture.root, "outside-proposals");
      fs.mkdirSync(outside);
      fs.symlinkSync(outside, fixture.pendingDir, "dir");
      await assert.rejects(storeRun(fixture), /symlink|unsafe proposal|pending proposal path/i);
      assert.deepEqual(fs.readdirSync(outside), [], "pending symlink is refused before proposal writes");
    } finally {
      fixture.cleanup();
    }
  });

  test("rejects an escaping session slug and an overlong residue-derived payload before staging anything", async () => {
    const unsafe = makeFixture("unsafe-slug");
    try {
      const statePath = path.join(unsafe.session, "state.json");
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      state.task_slug = "../../escaped-session";
      fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

      await assert.rejects(storeRun(unsafe), /slug|contain|path|unsafe/i);
      assert.equal(fs.existsSync(unsafe.storeRoot), false, "unsafe slug must be rejected before bootstrap/staging");
      assert.equal(fs.existsSync(path.join(unsafe.root, "escaped-session")), false, "unsafe slug must not escape the private fixture");
    } finally {
      unsafe.cleanup();
    }

    const oversized = makeFixture("oversized-residue");
    try {
      const learningPath = path.join(oversized.session, "learning.json");
      const learning = JSON.parse(fs.readFileSync(learningPath, "utf8"));
      const oversizedCanary = `sk-${"C".repeat(24)}`;
      learning.records[0].summary = `api_key=${oversizedCanary}${"x".repeat(32_769)}`;
      fs.writeFileSync(learningPath, `${JSON.stringify(learning, null, 2)}\n`, "utf8");

      await assert.rejects(storeRun(oversized), (error) => {
        assert.match(error.message, /32768|32,768|length|size/i);
        assert.doesNotMatch(error.message, new RegExp(oversizedCanary), "rejection must not echo secret-bearing oversized content");
        return true;
      });
      assert.equal(fs.existsSync(oversized.pendingDir), false, "oversized residue must not stage a partial proposal");
      assert.deepEqual(recordFiles(oversized.storeRoot), [], "oversized residue must not apply records");
    } finally {
      oversized.cleanup();
    }
  });
});

describe("AC4 / R4: repo-doc remains the default target", () => {
  test("omitted target and explicit repo-docs are result- and byte-identical", async () => {
    const fixture = makeFixture("repo-doc-parity");
    try {
      const proposals = path.join(fixture.session, "proposals");
      const sourceBefore = snapshotDir(fixture.session);
      const omitted = await withFrozenClock(() => runPromote({
        sessionDir: fixture.session,
        repoRoot: fixture.repo,
        provenance: PROVENANCE,
        agent: "wi2-store-target-test",
        decided: "2026-07-20",
      }));
      const omittedFiles = snapshotDir(proposals);
      fs.rmSync(proposals, { recursive: true, force: true });
      assert.deepEqual(snapshotDir(fixture.session), sourceBefore, "parity fixture reset must restore the source session");

      const explicit = await withFrozenClock(() => runPromote({
        sessionDir: fixture.session,
        repoRoot: fixture.repo,
        provenance: PROVENANCE,
        target: "repo-docs",
        agent: "wi2-store-target-test",
        decided: "2026-07-20",
      }));

      assert.deepEqual(explicit, omitted, "explicit repo-docs must preserve the default result exactly");
      assert.deepEqual(snapshotDir(proposals), omittedFiles, "explicit repo-docs must preserve every proposal byte");
    } finally {
      fixture.cleanup();
    }
  });

  test("rejects unknown/ambiguous targets and validates store write:false without bootstrapping", async () => {
    const fixture = makeFixture("target-controls");
    try {
      await assert.rejects(
        runPromote({ sessionDir: fixture.session, repoRoot: fixture.repo, target: "unknown" }),
        /unknown target/i,
      );
      await assert.rejects(
        runPromote({ sessionDir: fixture.session, repoRoot: fixture.repo, target: "store", outDir: path.join(fixture.root, "other") }),
        /outDir.*repo-docs/i,
      );
      const preview = await runPromote({
        sessionDir: fixture.session,
        repoRoot: fixture.repo,
        target: "store",
        env: fixture.env,
        agent: "wi2-store-target-test",
        decided: "2026-07-20",
        write: false,
      });
      assert.equal(preview.out_dir, fixture.pendingDir);
      assert.deepEqual(preview.written, []);
      assert.equal(fs.existsSync(fixture.storeRoot), false, "write:false must not bootstrap or stage the personal store");

      const registryFile = path.join(fixture.xdg, "knowledge-store", "roots.json");
      fs.mkdirSync(path.dirname(registryFile), { recursive: true });
      fs.writeFileSync(registryFile, "{ malformed preview registry\n");
      await assert.rejects(
        runPromote({
          sessionDir: fixture.session,
          repoRoot: fixture.repo,
          target: "store",
          env: fixture.env,
          agent: "wi2-store-target-test",
          write: false,
        }),
        /registry|malformed JSON/i,
      );
      fs.writeFileSync(registryFile, `${JSON.stringify({ roots: { personal: path.join(fixture.root, "other-store") } }, null, 2)}\n`);
      await assert.rejects(
        runPromote({
          sessionDir: fixture.session,
          repoRoot: fixture.repo,
          target: "store",
          env: fixture.env,
          agent: "wi2-store-target-test",
          write: false,
        }),
        /personal root conflict/i,
      );
      fs.rmSync(path.dirname(registryFile), { recursive: true, force: true });

      if (process.platform !== "win32") {
        const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "promote-preview-outside-"));
        const symlinkParent = path.join(fixture.root, "preview-link");
        fs.symlinkSync(outside, symlinkParent, "dir");
        const unsafeEnv = { ...fixture.env, XDG_DATA_HOME: path.join(symlinkParent, "xdg") };
        await assert.rejects(
          runPromote({
            sessionDir: fixture.session,
            repoRoot: fixture.repo,
            target: "store",
            env: unsafeEnv,
            agent: "wi2-store-target-test",
            write: false,
          }),
          /symlink|unsafe|ancestry/i,
        );
        assert.equal(fs.existsSync(path.join(outside, "xdg", "knowledge-store")), false, "unsafe preview stays read-only");
        fs.rmSync(outside, { recursive: true, force: true });
      }
      await assert.rejects(
        runPromote({
          sessionDir: fixture.session,
          repoRoot: fixture.repo,
          target: "store",
          env: fixture.env,
          agent: `api_key=${"sk-" + "B".repeat(24)}`,
          write: false,
        }),
        /agent contains sensitive data/i,
      );
    } finally {
      fixture.cleanup();
    }
  });

  test("write:false rejects an unsafe pending destination that write mode would refuse", { skip: process.platform === "win32" }, async () => {
    const fixture = makeFixture("preview-pending-symlink");
    try {
      await storeRun(fixture);
      fs.rmSync(path.join(fixture.storeRoot, "proposals"), { recursive: true, force: true });
      const outside = path.join(fixture.root, "outside-pending");
      fs.mkdirSync(outside);
      fs.symlinkSync(outside, path.join(fixture.storeRoot, "proposals"), "dir");

      await assert.rejects(
        runPromote({
          sessionDir: fixture.session,
          repoRoot: fixture.repo,
          target: "store",
          env: fixture.env,
          agent: "wi2-store-target-test",
          write: false,
        }),
        /symlink|unsafe proposal/i,
      );
      assert.deepEqual(fs.readdirSync(outside), [], "preview rejection never writes through the symlink");
    } finally {
      fixture.cleanup();
    }
  });
});
