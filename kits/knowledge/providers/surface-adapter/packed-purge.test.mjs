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

if (!process.env.CORPUS_STORE_ENTRY) throw new Error("CORPUS_STORE_ENTRY must name the installed packed Corpus Store entry");
if (!process.env.SURFACE_ENTRY) throw new Error("SURFACE_ENTRY must name the Surface entry with erasure support");
const corpus = await import(pathToFileURL(resolve(process.env.CORPUS_STORE_ENTRY)).href);
const surface = await import(pathToFileURL(resolve(process.env.SURFACE_ENTRY)).href);
for (const profile of ["KitDefaultStoreAdapter", "KitObsidianStoreAdapter"]) {
  test(`${profile}: purge round-trips to a Surface deleted claim`, async () => {
    const root = mkdtempSync(join(tmpdir(), "knowledge-surface-purge-"));
    try {
      const store = new corpus[profile]({
        storeRoot: join(root, "store"), coordinationDirectory: join(root, "coordination"),
        lock: corpus.standaloneFileMutationLock, coordinationIdentity: () => () => {}, allowPurge: true,
      });
      const id = await store.create({
        type: "raw", title: "PURGE_SURFACE_SECRET", body: "PURGE_SURFACE_SECRET",
        category: "private", aliases: ["purge-secret-alias"], provenance: { agent: "test" },
      });
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
      const provider = new MarkdownVaultProvider({ store });
      const before = await buildKnowledgeTrustBundle({ store: provider, includeRetired: true });
      assert.ok(JSON.stringify(before).includes("PURGE_SURFACE_SECRET"));
      const otherClaim = before.claims.find((item) => item.subjectId === other);
      assert.ok(!(otherClaim.derivedFrom ?? []).includes(otherClaim.id));
      const result = await store.purge([id], { agent: "owner", rationale: "erasure request" });
      assert.ok(result.cascaded.includes(dependent), "sole dependent must cascade");
      assert.ok(result.survivors.includes(survivor), "multiply supported record must survive");
      assert.equal((await store.get(id)).status, "purged");
      assert.equal((await store.get(dependent)).status, "purged");
      assert.equal(await store.get("purge-secret-alias"), null);
      const reads = [
        await store.get(id), await store.get(dependent), await store.getLinks(id),
        await store.listByType("raw", { includeHistory: true }),
        await store.listByType("compiled", { includeHistory: true }),
        await store.listByCategory("private", { includeHistory: true }),
      ];
      assert.ok(!JSON.stringify(reads).includes("PURGE_SURFACE_SECRET"));
      // Purge itself must leave the graph safe; a repair must not mask a stale index.
      assert.ok(!JSON.stringify(await provider.readGraph()).includes("PURGE_SURFACE_SECRET"));
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
