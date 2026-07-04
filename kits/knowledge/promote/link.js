/**
 * Step 3 — LINK.
 *
 * Attach provenance to every draft delta: the pull request, the merge commit
 * SHA, the archived session artifact path, and the touched decision topics.
 * The provenance links become evidence[] refs on the draft decision topics so a
 * reader can trace each proposed delta back to the delivery that produced it.
 *
 * Rendering the decision topic is delegated to the #317 git-repo provider's
 * proposeWrite (proposals-only, never writes) so the sub-flow reuses the same
 * decision-topic renderer the provider contract defines — no forked writer.
 *
 * @module promote/link
 */

import { GitRepoProvider } from "../providers/git-repo/index.js";
import { validateDecisionDelta } from "./lib.js";
import { loadSchemas } from "../providers/lib/model.js";
import { assertValid } from "../providers/lib/schema-validate.js";

const { proposal: PROPOSAL_SCHEMA } = loadSchemas();

/**
 * @param {{decisions:object[], vocabulary:object[], learnings:object[]}} distilled
 * @param {object} provenance
 * @param {string} [provenance.pr]                 PR URL/number.
 * @param {string} [provenance.mergeSha]           merge commit SHA.
 * @param {string} [provenance.sessionArchivePath] path to the archived session artifact.
 * @param {object} [options]
 * @param {string} [options.repoRoot]              repo root for the git-repo provider.
 * @param {string} [options.agent]
 * @returns {{decisions:object[], vocabulary:object[], learnings:object[], manifest:object}}
 */
export function link(distilled, provenance = {}, options = {}) {
  const provider = new GitRepoProvider({ repoRoot: options.repoRoot || process.cwd(), agent: options.agent });
  const touchedTopics = distilled.decisions.map((d) => d.slug);

  const provEvidence = [];
  if (provenance.pr) provEvidence.push({ kind: "pr", ref: provenance.pr });
  if (provenance.mergeSha) provEvidence.push({ kind: "commit", ref: provenance.mergeSha });
  if (provenance.sessionArchivePath) provEvidence.push({ kind: "session-archive", ref: provenance.sessionArchivePath });

  const decisions = distilled.decisions.map((delta) => {
    // Fold provenance links into evidence[], de-duplicated by kind+ref.
    const seen = new Set(delta.evidence.map((e) => `${e.kind}:${e.ref}`));
    const evidence = [...delta.evidence];
    for (const e of provEvidence) {
      const key = `${e.kind}:${e.ref}`;
      if (!seen.has(key)) { evidence.push(e); seen.add(key); }
    }
    const linked = { ...delta, evidence };

    // Re-validate the linked delta before proposing (R2 discipline holds after linking too).
    const errors = validateDecisionDelta(linked);
    if (errors.length) throw new Error(`linked decision draft '${linked.slug}' failed validation: ${errors.join("; ")}`);

    // Render via the git-repo provider's proposals-only proposeWrite.
    const rendered = provider.proposeWrite({
      subject: linked.subject,
      slug: linked.slug,
      body: linked.body,
      decided: linked.decided,
      evidence: linked.evidence,
      rationale: `Promoted from session ${linked.derived ? "(derived from Definition Of Done) " : ""}— enact by writing docs/decisions/${linked.slug}.md, adding the subject noun to CONTEXT.md, and running check:decisions.`,
    });
    // provider.proposeWrite is async in the contract; call synchronously-resolved value.
    return Promise.resolve(rendered).then((prop) => {
      assertValid(prop, PROPOSAL_SCHEMA, `decision-topic proposal '${linked.slug}'`);
      return { ...linked, proposal: prop, rendered: prop.rendered };
    });
  });

  return Promise.all(decisions).then((resolvedDecisions) => ({
    decisions: resolvedDecisions,
    vocabulary: distilled.vocabulary,
    learnings: distilled.learnings,
    manifest: {
      pr: provenance.pr || null,
      merge_sha: provenance.mergeSha || null,
      session_archive: provenance.sessionArchivePath || null,
      touched_topics: touchedTopics,
    },
  }));
}
