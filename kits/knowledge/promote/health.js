/**
 * Step 4 — HEALTH.
 *
 * Contradiction detection over the decision-registry topic files, via the #317
 * knowledge-store provider interface. The git-repo provider is the SAME reader
 * every provider shares (no forked reader): its graph is folded together with
 * the proposed draft decisions, and the provider-agnostic duplicate-detection
 * health verb flags topics whose subject nouns overlap. Where two CURRENT
 * decisions collide over one subject with divergent content, the step emits a
 * merge-repair PROPOSAL naming BOTH topics and a merge target.
 *
 * Merge-repair is a PROPOSAL, never an auto-edit. It is a schema-valid
 * knowledge-store proposal (proposals-only by construction) the operator applies
 * through the registry's own supersede/merge edit.
 *
 * @module promote/health
 */

import { GitRepoProvider } from "../providers/git-repo/index.js";
import { detectDuplicates } from "../providers/health/index.js";
import { node, proposal, provenance } from "../providers/lib/model.js";
import { loadSchemas } from "../providers/lib/model.js";
import { assertValid } from "../providers/lib/schema-validate.js";

const { proposal: PROPOSAL_SCHEMA } = loadSchemas();

/** Build draft decision nodes (same id scheme as the git-repo provider) from linked deltas. */
function draftNodes(draftDecisions, agent) {
  const now = new Date().toISOString();
  return draftDecisions.map((d) =>
    node({
      id: `decision:${d.slug}`,
      type: "decision",
      title: d.subject,
      body: d.body || "",
      attributes: { registry_status: d.status || "current", draft: true },
      provenance: provenance({ provider: "git-repo", source: `docs/decisions/${d.slug}.md`, locator: "draft", retrievedAt: now, agent }),
    }),
  );
}

function nodeStatus(n) {
  return (n.attributes && n.attributes.registry_status) || "current";
}

/**
 * @param {object} options
 * @param {string} options.repoRoot            repo whose registry is read via the git-repo provider.
 * @param {object[]} [options.draftDecisions]  linked draft decision deltas to fold in.
 * @param {string} [options.agent]
 * @param {number} [options.threshold]         duplicate similarity threshold (default 0.7).
 * @returns {Promise<{report:object, mergeProposals:object[]}>}
 */
export async function health(options = {}) {
  const { repoRoot, draftDecisions = [], agent, threshold = 0.7 } = options;
  const provider = new GitRepoProvider({ repoRoot, agent });
  const existing = await provider.readGraph();

  const nodes = [...existing.nodes, ...draftNodes(draftDecisions, agent)];
  const graph = { nodes, edges: existing.edges };

  // Reuse the provider-agnostic duplicate-detection verb: overlapping subject
  // nouns => a schema-valid duplicate-detection report naming BOTH topics.
  const report = detectDuplicates(graph, { provider: "git-repo", threshold });

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const mergeProposals = [];

  for (const finding of report.findings) {
    const [idA, idB] = finding.node_ids;
    const a = byId.get(idA);
    const b = byId.get(idB);
    if (!a || !b || a.type !== "decision" || b.type !== "decision") continue;
    // Contradiction = both current AND divergent content. A resolved pair (one
    // already a merged/superseded tombstone) is not a contradiction.
    const aCurrent = nodeStatus(a) === "current";
    const bCurrent = nodeStatus(b) === "current";
    if (!aCurrent || !bCurrent) continue;
    if ((a.body || "").trim() === (b.body || "").trim()) continue;

    // Merge target: keep the more-recently-decided topic; the other is folded in.
    const decidedA = (a.attributes && a.attributes.decided) || "";
    const decidedB = (b.attributes && b.attributes.decided) || "";
    let survivor = a, absorbed = b;
    if (decidedB > decidedA) { survivor = b; absorbed = a; }
    else if (decidedB === decidedA && b.id < a.id) { survivor = b; absorbed = a; }

    const survivorSlug = survivor.id.replace(/^decision:/, "");
    const absorbedSlug = absorbed.id.replace(/^decision:/, "");

    const rendered = [
      "---",
      "status: merged",
      `subject: ${absorbed.title}`,
      `decided: ${new Date().toISOString().slice(0, 10)}`,
      `merged_into: ${survivorSlug}`,
      "evidence:",
      "  - kind: doc",
      `    ref: docs/decisions/${survivorSlug}.md`,
      "---",
      "",
      `# ${absorbed.title}`,
      "",
      `Merged into [${survivorSlug}](./${survivorSlug}.md). This subject was carried by two`,
      `current topics with divergent content; the current answer now lives in ${survivorSlug}.`,
    ].join("\n");

    const prop = proposal({
      provider: "git-repo",
      kind: "decision-topic",
      target: {
        merge_repair: true,
        merge_into: survivorSlug,
        tombstone: absorbedSlug,
        topics: [survivorSlug, absorbedSlug],
        path: `docs/decisions/${absorbedSlug}.md`,
      },
      payload: {
        contradiction: {
          topics: [survivor.id, absorbed.id],
          subject_a: survivor.title,
          subject_b: absorbed.title,
          divergence: { survivor: survivor.body || "", absorbed: absorbed.body || "" },
          similarity: finding.evidence && finding.evidence.similarity,
        },
        merge_target: survivorSlug,
      },
      rendered,
      rationale: `Two CURRENT decision topics ('${survivor.title}' @ ${survivor.id}, '${absorbed.title}' @ ${absorbed.id}) share a subject noun with divergent content — a registry contradiction. Proposed merge target: ${survivorSlug}; fold ${absorbedSlug} in as a merged tombstone. Merge-repair is a PROPOSAL: apply it via the registry's own edit, never auto-written.`,
      provenance: provenance({ provider: "git-repo", source: `docs/decisions/${absorbedSlug}.md`, locator: "merge-repair", agent }),
    });
    assertValid(prop, PROPOSAL_SCHEMA, `merge-repair proposal (${absorbedSlug} -> ${survivorSlug})`);
    mergeProposals.push(prop);
  }

  return { report, mergeProposals };
}
