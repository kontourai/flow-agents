# Knowledge Kit — Obsidian Store Adapter

Spike verdict: **RATIFY**

The "file is the record" thesis holds. Each Knowledge Kit record maps to exactly
one Obsidian-native markdown note. Frontmatter carries the full contract payload;
the markdown body is human-readable Obsidian rendering. The adapter passes the
full 48-test contract suite without modifications.

---

## The File-Is-the-Record Thesis

A Knowledge Kit record has a canonical identity (`id`), a structured payload
(type, category, provenance, links, mutation_log), and a human-facing body.
The Obsidian store places ALL of this in a single `.md` file:

- YAML frontmatter holds every contract field including `body`.
- The markdown section below `---` is rendered for Obsidian readability only —
  it is decorative and not read back on load.
- The file IS the record. No separate database. No shadow index for content.

This is the core claim of the spike: **a single Obsidian note can faithfully
represent a Knowledge Kit record** with zero fidelity loss.

---

## File Shape

```
---
id: <uuid>
type: raw | compiled | concept | snapshot
title: <string>
category: eng.decisions
tags: [tag-a, tag-b]
status: active | implemented | retired
created_at: <ISO8601>
updated_at: <ISO8601>
provenance:
  agent: <string>
  session_id: <optional>
  source_ids: [<optional uuid list>]
links:
  - target_id: <uuid>
    kind: related | source | proposes | supersedes | refines
    label: <optional>
mutation_log:
  - op: update
    at: <ISO8601>
    agent: <string>
    evidence:
      fields: [title, body]
body: "The full contract body text stored here for round-trip fidelity."
---

<!-- Obsidian-readable section below — decorative, not parsed on load -->

> [!note]- Raw Notes          ← raw type: collapsed callout
> Original capture text here.

## Sources                     ← compiled/concept/snapshot: wikilinks to sources

[[source-slug|Source Note]]

## Related

[[related-slug]]
```

---

## Storage Layout

```
<storeRoot>/
  <category/as/path>/<title-slug>.md     active records
  archive/<category/as/path>/<slug>.md   superseded records (moved, not deleted)
  graph-index.json                       link graph (suite §13 requirement)
  .graph-index.json                      path index (id → {path, archived})
```

- Category dots map to directory segments: `eng.decisions` → `eng/decisions/`.
- Title is slugified for the filename: `My Decision` → `my-decision.md`.
- Filename collisions (same slug, different id) get a suffix: `my-decision-2.md`.
- When a record is superseded, its file MOVES to `archive/` (supersede-not-delete
  invariant). The record remains fully queryable via `get(id)`.

---

## Spike Gaps Found

1. **Multi-file wikilink resolution**: Obsidian resolves `[[slug]]` links by
   filename across the entire vault, regardless of folder. The adapter renders
   wikilinks using the filename slug for human readability, but the canonical
   link data (stored as UUIDs in frontmatter) is what the contract uses. If a
   user clicks a wikilink in Obsidian, it navigates by slug — not by UUID —
   which may not match if slugs collide across categories.

2. **Vault-level wikilink display**: Obsidian flattens `[[slug]]` resolution.
   Two records in different categories that happen to share a slug
   (`eng/api/deploy.md` and `ops/api/deploy.md`) would cause Obsidian link
   ambiguity. The contract itself is unaffected (UUIDs in frontmatter win),
   but the human-readable `## Related` section would be ambiguous in Obsidian.
   Mitigation: use category-prefixed slugs in the Obsidian body rendering.

3. **Frontmatter `body` YAML quoting for complex content**: Bodies containing
   Obsidian callout syntax (`> [!note]`) or multi-paragraph content serialize
   correctly via the shared codec's `yamlScalar` quoting, but the result can be
   a long single-line quoted string in frontmatter. Obsidian displays this fine,
   but it is less human-editable than a literal block scalar. A future YAML block
   scalar (`|`) serializer would improve ergonomics.

4. **Obsidian sync conflicts**: If two agents write to the same record
   concurrently, Obsidian Sync may create conflict copies. The adapter uses no
   file locking. This is acceptable for a spike but would need attention in
   production use with live sync.

5. **Archive folder visibility**: The `archive/` subdirectory will appear in the
   Obsidian vault file explorer. This is intentional (superseded records remain
   inspectable) but users may want to exclude it via `.obsidianignore` or a
   dedicated vault folder setting.

---

## Spike Verdict: RATIFY

The adapter proves:

- A single Obsidian note is a sufficient and non-lossy representation of a
  Knowledge Kit record, including all Addendum A (snapshot/supersede) and
  Addendum B (status/retire) contract extensions.
- The category hierarchy maps naturally to Obsidian folder organization.
- Supersede-not-delete is expressible as an archive move within the vault.
- Human readability (callouts, Sources/Related wikilink sections) coexists with
  machine-readable frontmatter without duplication errors.
- The contract suite (48/48) passes without modification.

**Recommendation**: Proceed with the Obsidian store adapter as a supported adapter
alongside the default store. Address gap #2 (slug ambiguity) before marking the
adapter production-ready for multi-category vaults.
