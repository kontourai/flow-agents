/**
 * Installed Corpus Store -> Knowledge graph -> Surface bundle round-trip.
 *
 * CORPUS_STORE_ENTRY must point at the ESM entry of an installed packed
 * @kontourai/corpus-store (never a source deep import). SURFACE_ENTRY must name
 * an installed or built Surface public entry containing the erasure cascade.
 * This separate test is
 * explicit while the purge package is awaiting publication; it fails closed
 * when the packed entry is not supplied.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MarkdownVaultProvider } from "../markdown-vault/index.js";
import { buildKnowledgeTrustBundle } from "./index.js";
import DefaultKnowledgeStore from "../../adapters/default-store/index.js";
import ObsidianKnowledgeStore from "../../adapters/obsidian-store/index.js";

if (!process.env.CORPUS_STORE_ENTRY) throw new Error("CORPUS_STORE_ENTRY must name the installed packed Corpus Store entry");
if (!process.env.SURFACE_ENTRY) throw new Error("SURFACE_ENTRY must name the Surface entry with erasure support");
const corpus = await import(pathToFileURL(resolve(process.env.CORPUS_STORE_ENTRY)).href);
const surface = await import(pathToFileURL(resolve(process.env.SURFACE_ENTRY)).href);
for (const [profile, KitAdapter] of [["default", DefaultKnowledgeStore], ["vault", ObsidianKnowledgeStore]]) {
  test(`${profile}: purge is denied until Corpus and host authorization are selected`, async () => {
    const root = mkdtempSync(join(tmpdir(), "knowledge-purge-deny-"));
    try {
      const legacy = new KitAdapter({ storeRoot: join(root, "legacy") });
      await assert.rejects(() => legacy.purge(["id"], { agent: "owner", rationale: "request" }), { code: "READ_ONLY" });
      assert.throws(() => new KitAdapter({ storeRoot: join(root, "unadmitted"), corpusStore: { module: corpus } }), /legacyProcessesStopped/);
      const oldExport = profile === "default" ? "KitDefaultStoreAdapter" : "KitObsidianStoreAdapter";
      assert.throws(() => new KitAdapter({ storeRoot: join(root, "old"), corpusStore: {
        module: { [oldExport]: class {} }, legacyProcessesStopped: true, services: {},
      } }), /requires a package with purge support/);
      const unprivileged = new KitAdapter({ storeRoot: join(root, "corpus"), corpusStore: {
        module: corpus, legacyProcessesStopped: true, services: {
          coordinationDirectory: join(root, "coordination"), lock: corpus.standaloneFileMutationLock,
          coordinationIdentity: () => () => {},
        },
      } });
      await assert.rejects(() => unprivileged.purge(["id"], { agent: "owner", rationale: "request" }), { code: "READ_ONLY" });
      const truthy = new KitAdapter({ storeRoot: join(root, "truthy"), corpusStore: {
        module: corpus, legacyProcessesStopped: true, services: {
          coordinationDirectory: join(root, "coordination"), lock: corpus.standaloneFileMutationLock,
          coordinationIdentity: () => () => {}, allowPurge: "yes",
        },
      } });
      await assert.rejects(() => truthy.purge(["id"], { agent: "owner", rationale: "request" }), { code: "READ_ONLY" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  if (profile === "vault") test("vault: an existing kit-v1 vault refuses purge before offline migration", async () => {
    const root = mkdtempSync(join(tmpdir(), "knowledge-purge-legacy-vault-"));
    try {
      const storeRoot = join(root, "vault");
      const legacy = new KitAdapter({ storeRoot });
      const id = await legacy.create({ type: "raw", title: "Legacy", body: "legacy content",
        category: "private", provenance: { agent: "test" } });
      const selected = new KitAdapter({ storeRoot, corpusStore: {
        module: corpus, legacyProcessesStopped: true, services: {
          coordinationDirectory: join(root, "coordination"), lock: corpus.standaloneFileMutationLock,
          coordinationIdentity: () => () => {}, allowPurge: true,
        },
      } });
      await assert.rejects(() => selected.purge([id], { agent: "owner", rationale: "request" }), { code: "READ_ONLY" });
      assert.equal((await selected.get(id)).body, "legacy content");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test(`${profile}: purge round-trips to a Surface deleted claim`, async () => {
    const root = mkdtempSync(join(tmpdir(), "knowledge-surface-purge-"));
    try {
      const store = new KitAdapter({
        storeRoot: join(root, "store"),
        corpusStore: { module: corpus, legacyProcessesStopped: true, services: {
          coordinationDirectory: join(root, "coordination"), lock: corpus.standaloneFileMutationLock,
          coordinationIdentity: () => () => {}, allowPurge: true,
        } },
      });
      const id = await store.create({
        type: "raw", title: "PURGE_SURFACE_SECRET", body: "PURGE_SURFACE_SECRET",
        category: "private", aliases: ["purge-secret-alias"], provenance: { agent: "test" },
      });
      await assert.rejects(() => store.purge([id], { agent: "owner", rationale: "" }), { code: "MISSING_EVIDENCE" });
      assert.equal((await store.get(id)).body, "PURGE_SURFACE_SECRET");
      const other = await store.create({
        type: "raw", title: "Other source", body: "remaining support",
        category: "private", provenance: { agent: "test" },
      });
      await store.update(other, { links: [{ kind: "source", target_id: other }] }, { agent: "test" });
      const dependent = await store.create({
        type: "compiled", title: "Derived", body: "PURGE_SURFACE_SECRET derived",
        category: "private", links: [{ kind: "source", target_id: id }],
        provenance: { agent: "test", source_ids: [id] },
      });
      const survivor = await store.create({
        type: "concept", title: "Survives", body: "independent content", category: "private",
        links: [{ kind: "source", target_id: id }, { kind: "source", target_id: other }],
        provenance: { agent: "test", source_ids: [id, other] },
      });
      const soleProposal = await store.proposeCreate({
        type: "concept", title: "PROPOSAL_PURGE_SECRET", body: "PROPOSAL_PURGE_SECRET",
        category: "private", provenance: { agent: "test", source_ids: [id] },
      }, "proposer", { agent: "test", proposal: "PROPOSAL_PURGE_SECRET" });
      const mixedProposal = await store.proposeCreate({
        type: "concept", title: "Review needed", body: "independent candidate", category: "private",
        provenance: { agent: "test", source_ids: [id, other] },
      }, "proposer", { agent: "test", proposal: "review" });
      const provider = new MarkdownVaultProvider({ store });
      const before = await buildKnowledgeTrustBundle({ store: provider, includeRetired: true });
      assert.ok(JSON.stringify(before).includes("PURGE_SURFACE_SECRET"));
      let releaseOld, notifyOld;
      const oldGate = new Promise((resolve) => { releaseOld = resolve; });
      const oldCaptured = new Promise((resolve) => { notifyOld = resolve; });
      let pauseFirst = true;
      const racingProvider = new MarkdownVaultProvider({ store: {
        async listByType(type, options) {
          const records = await store.listByType(type, options);
          if (type === "raw" && pauseFirst) { pauseFirst = false; notifyOld(); await oldGate; }
          return records;
        },
        getLinks: (...args) => store.getLinks(...args),
      } });
      const oldRead = racingProvider.readNodes();
      await oldCaptured;
      let result, timer;
      try {
        result = await store.purge([id], { agent: "owner", rationale: "erasure request" });
        assert.ok(result.cascaded.includes(dependent), "sole dependent must cascade");
        const fresh = await Promise.race([
          racingProvider.readNodes(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("post-purge read joined pre-purge fetch")), 10000); }),
        ]);
        assert.ok(!JSON.stringify(fresh).includes("PURGE_SURFACE_SECRET"));
      } finally {
        clearTimeout(timer);
        releaseOld();
        await oldRead;
      }
      assert.ok(result.survivors.includes(survivor), "multiply supported record must survive");
      assert.ok(result.proposalsRejected.includes(soleProposal));
      assert.ok(result.proposalsScrubbed.includes(soleProposal));
      assert.ok(result.proposalsBlocked.includes(mixedProposal));
      const soleAfter = await store.getProposal(soleProposal);
      assert.equal(soleAfter.state, "rejected");
      assert.ok(!JSON.stringify(soleAfter).includes("PROPOSAL_PURGE_SECRET"));
      assert.equal((await store.getProposal(mixedProposal)).state, "pending");
      await assert.rejects(() => store.applyCreate(mixedProposal, "reviewer"), { code: "PURGED" });
      assert.equal((await store.get(id)).status, "purged");
      assert.equal((await store.get(dependent)).status, "purged");
      await assert.rejects(() => store.update(id, { body: "reintroduced" }, { agent: "test" }), { code: "PURGED" });
      assert.equal(await store.get("purge-secret-alias"), null);
      const reads = [
        await store.get(id), await store.get(dependent), await store.getLinks(id),
        await store.listByType("raw", { includeHistory: true }),
        await store.listByType("compiled", { includeHistory: true }),
        await store.listByCategory("private", { includeHistory: true }),
      ];
      assert.ok(!JSON.stringify(reads).includes("PURGE_SURFACE_SECRET"));
      // Purge itself must leave the graph safe; a repair must not mask a stale index.
      const graphReads = [await provider.readNodes(), await provider.readEdges(),
        await provider.queryByType("note"), await provider.readGraph()];
      assert.ok(!JSON.stringify(graphReads).includes("PURGE_SURFACE_SECRET"));
      await store.reindex();
      assert.ok(!JSON.stringify(await provider.readGraph()).includes("PURGE_SURFACE_SECRET"));
      const after = JSON.parse(JSON.stringify(await buildKnowledgeTrustBundle({ store: provider, includeRetired: true })));
      const claim = after.claims.find((item) => item.subjectId === id);
      assert.equal(claim.value, null);
      assert.equal(claim.metadata.surfaceRetention.state, "deleted");
      assert.equal(claim.metadata.surfaceRetention.actor, "owner");
      assert.equal(claim.metadata.surfaceRetention.rationale, "erasure request");
      assert.equal(surface.isDeletedClaim(claim), true);
      assert.equal(surface.isDeletedClaim(after.claims.find((item) => item.subjectId === dependent)), true);
      assert.equal(surface.isDeletedClaim(after.claims.find((item) => item.subjectId === survivor)), false);
      surface.validateTrustBundle(after);
      const report = surface.buildTrustReport(after);
      const survivorClaim = after.claims.find((item) => item.subjectId === survivor);
      assert.ok(report.changeRecords.some((record) => record.claimId === survivorClaim.id &&
        record.reason === "input-deleted" && record.inputClaimIds.includes(claim.id)),
      "survivor must carry Surface's deletion review signal");
      assert.ok(!JSON.stringify(after).includes("PURGE_SURFACE_SECRET"));
      assert.ok(after.evidence.every((item) => item.claimId !== claim.id));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
