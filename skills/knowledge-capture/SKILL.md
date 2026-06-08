---
name: "knowledge-capture"
description: "Save durable knowledge, lightweight pointers, user corrections, decisions, lessons, relationship context, or source references into the knowledge base. Use when the user says save, remember, capture, file this, bookmark context, or when another workflow creates an artifact that should be indexed."
---

# Knowledge Capture

Capture context so it is findable later without copying every source system into notes.

## Capture Modes

### Pointer

Use a pointer when an artifact already exists elsewhere: email, CRM record, calendar event, document, issue, chat thread, or generated report.

```markdown
- [YYYY-MM-DD] [entity/topic] Summary - source:<system> id:<identifier> tool:<access method>
```

Write pointers automatically after creating or discovering important artifacts. Do not ask for permission when the pointer is purely an index entry.

### Curated Knowledge

Use curated knowledge when the note contains durable context not present in any single source:

- user corrections or preferences
- relationship context
- decisions and rationale
- lessons learned
- cross-system synthesis
- career or project milestones

Before saving proactively, state why it is worth keeping: future query, delta from source systems, shelf life, and whether it is fact or inference.

## Where To Write

Follow the knowledge base's existing structure. Prefer:

- entity folder or hub for account/project/person-specific context
- `knowledge/memories/decisions.md` for decisions
- `knowledge/memories/lessons.md` for lessons
- `knowledge/memories/preferences.md` for user preferences
- `knowledge/memories/bookmarks.md` for links
- journal/raw capture only when no durable structure exists yet

If a note belongs to a person, use the `contacts` skill. If it is a meeting note, use `meeting-notes`.

## Rules

- Always include date, source, and retrieval path for pointers.
- Save confirmed facts; label inferences explicitly.
- Do not save low-signal routine summaries.
- Do not overwrite existing notes without reading them first.
- Link from an entity hub when the knowledge base uses hubs.
- Run `post-write` after writing or updating a knowledge file.
