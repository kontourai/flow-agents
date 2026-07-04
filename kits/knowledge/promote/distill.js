/**
 * Step 2 — DISTILL.
 *
 * Turn the ingested residue into DRAFT deltas that validate BEFORE they are
 * proposed (R2): decision-registry topic files (one per decision SUBJECT, the
 * subject a CONTEXT.md vocabulary noun), CONTEXT.md vocabulary additions for any
 * new subject noun, and docs/learnings entries. Nothing is written to disk here
 * — distill returns draft objects; writing (only under <session>/proposals/)
 * happens in the orchestrator.
 *
 * @module promote/distill
 */

import { slugify, readGlossaryTerms, validateDecisionDelta } from "./lib.js";

function deriveSubject(decision) {
  if (decision.subject) return decision.subject;
  // Derive a rough noun-phrase subject from the outcome body (draft — the
  // operator refines it at apply time). Take the leading clause, title-case.
  const clause = String(decision.body || "").split(/[.;:]/)[0].trim().split(/\s+/).slice(0, 6).join(" ");
  if (!clause) return "Delivered decision";
  return clause.charAt(0).toUpperCase() + clause.slice(1);
}

/**
 * @param {object} residue from ingestSession.
 * @param {object} [options]
 * @param {string} [options.repoRoot] repo whose CONTEXT.md is checked for vocabulary gaps.
 * @param {string} [options.decided] ISO date to stamp on drafts (default: today).
 * @returns {{ decisions: object[], vocabulary: object[], learnings: object[], warnings: string[] }}
 */
export function distill(residue, options = {}) {
  const decided = options.decided || new Date().toISOString().slice(0, 10);
  const glossary = options.repoRoot ? readGlossaryTerms(options.repoRoot) : new Set();
  const warnings = [];

  const decisions = [];
  const vocabulary = [];
  const seenSlugs = new Set();
  const seenVocab = new Set();

  for (const raw of residue.decisions || []) {
    const subject = deriveSubject(raw);
    const slug = slugify(subject);
    if (!slug || seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);

    // Base provenance so the draft is already schema-valid at distill time
    // (R2: validate BEFORE proposing). link() enriches with PR + merge SHA.
    const evidence = [
      { kind: "session-archive", ref: `${residue.sessionDir}/${residue.sessionMarkdown || "state.json"}` },
    ];

    const newVocabulary = !glossary.has(subject.toLowerCase());
    const delta = {
      subject,
      slug,
      status: "current",
      decided,
      body: raw.body || subject,
      evidence,
      derived: !!raw.derived,
      newVocabulary,
    };
    const errors = validateDecisionDelta(delta);
    if (errors.length) {
      warnings.push(`decision draft '${slug}' failed pre-proposal validation: ${errors.join("; ")}`);
      continue;
    }
    decisions.push(delta);

    if (newVocabulary && !seenVocab.has(slug)) {
      seenVocab.add(slug);
      vocabulary.push({
        term: subject,
        slug,
        definition: (raw.body || subject).split(/[.;]/)[0].trim(),
      });
    }
  }

  const learnings = (residue.learnings || []).map((rec, i) => ({
    id: rec.id || `learn-${residue.slug}-${i + 1}`,
    title: rec.summary ? rec.summary.split(/[.;]/)[0].trim() : `Learning ${i + 1}`,
    body: rec.summary || "",
    outcome: rec.outcome || null,
    source_refs: Array.isArray(rec.source_refs) ? rec.source_refs : [],
    correction: rec.correction && rec.correction.needed ? {
      type: rec.correction.type || null,
      recurrence_key: rec.correction.recurrence_key || null,
      prevention: rec.correction.prevention || null,
    } : null,
  }));

  return { decisions, vocabulary, learnings, warnings };
}
