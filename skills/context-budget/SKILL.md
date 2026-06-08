---
name: context-budget
description: >-
  Audit token overhead across Flow Agents bundles — agent specs, skills, context files,
  MCP servers. Produces budget report with per-component breakdown and optimization suggestions.
---

# Context Budget Audit

Scan installed Flow Agents bundles and estimate token overhead per component. Produces a structured budget report with optimization suggestions.

## Workflow

### Phase 1: Inventory

Run `bash context/scripts/context-budget/budget-scan.sh` to discover all loaded components. The script walks `~/.flow-agents/` and outputs JSON with per-bundle breakdowns.

### Phase 2: Classify

Bucket each component from the scan output:
- **Always loaded**: context files matching package dependency patterns, skill frontmatter descriptions
- **On-demand**: full SKILL.md body (loaded on skill activation), deferred context (`context/deferred/`)
- **Per-agent**: agent-spec systemPrompt, agent-specific MCP servers

### Phase 3: Detect Issues

Flag problems from the scan data:
- Heavy agent specs: systemPrompt > 200 lines
- Bloated skill descriptions: frontmatter description > 30 words
- MCP over-subscription: agent with > 10 MCP servers or > 50 total tools
- Context bloat: any single context file > 100 lines
- Deferred candidates: context files > 2% of model context that aren't safety/routing

### Phase 4: Report

Structured output:
- Per-bundle breakdown (tokens by category)
- Per-agent breakdown (what each agent loads at spawn)
- Top-N optimization suggestions ranked by token savings
- Use `--verbose` flag on budget-scan.sh for per-file token counts
