---
title: Evidence Reference Migration
---

# Evidence Reference Migration

Flow Agents sidecars now treat structured evidence reference objects as the schema contract. Legacy string refs in `acceptance.json` and `evidence.json` must be converted before validation.

Convert old strings like:

```json
"evidence_refs": ["npm run eval:static --silent"]
```

to objects like:

```json
"evidence_refs": [
  {
    "kind": "command",
    "excerpt": "npm run eval:static --silent",
    "summary": "Static eval suite passed."
  }
]
```

For source evidence, include file and line data:

```json
{
  "kind": "source",
  "url": "https://github.com/OWNER/REPO/blob/COMMIT_SHA/path/to/file.ts#L12-L24",
  "file": "path/to/file.ts",
  "line_start": 12,
  "line_end": 24,
  "excerpt": "Short excerpt that supports the acceptance claim."
}
```

Use immutable GitHub blob URLs pinned to a commit SHA when the commit/provider URL is available. Before publication, omit `url` and keep `file`, `line_start`, `line_end`, and `excerpt` as a local fallback. Upgrade local refs before provider closure whenever practical.
