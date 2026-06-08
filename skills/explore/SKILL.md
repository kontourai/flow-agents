---
name: "explore"
description: "Parallel codebase exploration — fans out subagents to map structure, entry points, dependencies, patterns, config, and tests in one pass."
---

# Codebase Exploration

Efficiently gather context about repositories by running parallel exploration tasks.

## Harness Limit

Some harnesses cap a single delegation batch at 4 subagents.
- Respect the current harness limit.
- If the limit is unknown, assume 4.
- Never submit more than 4 subagents in one batch.
- Use multiple waves when needed rather than overfilling the first fan-out.

## Exploration Strategy

Spawn MULTIPLE subagents IN PARALLEL to investigate different dimensions:

### Wave 1A (parallel, up to 4 subagents)
1. **Structure Scout** - Map directory structure, identify key folders (src, lib, tests, config)
2. **Entry Point Finder** - Locate main files, CLI entry points, API routes, exports
3. **Dependency Analyzer** - Parse package.json, requirements.txt, go.mod, Cargo.toml, pom.xml
4. **Pattern Detective** - Identify architectural patterns, frameworks, coding conventions

### Wave 1B (parallel, after Wave 1A if needed)
5. **Config Inspector** - Find and summarize configuration files, env vars, build configs
6. **Test Mapper** - Locate test files, understand testing strategy and coverage areas
7. **Documentation Auditor** - Cross-reference all documentation against actual file system state:
   - README agent tables vs actual `agents/*.agent-spec.json` files (ghost agents? missing agents?)
   - README skill lists vs actual `skills/*/SKILL.md` files
   - README dependency lists vs `Config` file declarations
   - AGENTS.md shared sections consistency across packages (paths, naming examples, model references)
   - All `.md` and `.json` files: grep for references to agents, skills, or paths that don't exist
   - Agent spec `resources` paths: verify referenced context files exist
   - Agent spec `model` fields: verify they follow conventions (orchestrators=opus, tools=haiku/sonnet)
   - Typos and spelling errors in documentation files
   - Empty directories or dead skill/SOP stubs

### Wave 2 (after Wave 1A/1B — needs dependency list)
7. **Tech Stack Researcher** - Research the identified tech stack using web search tools (`web_search`, `web_fetch`) and `tool-dependencies-updater` (audit-only — do NOT apply updates). Goals:
   - Identify outdated or deprecated dependencies and how significant an upgrade would be (patch vs minor vs major, breaking changes)
   - Discover new features in the current stack that the project could leverage
   - Assess whether any part of the stack is irrelevant, superseded, or approaching EOL
   - Surface project-specific context (migration guides, EOL announcements, known issues)

## Execution Model

```
[User Request]
      |
      v
[Wave 1A: Spawn first 4 dimensions in parallel]
      |
      v
[Wave 1B: Spawn remaining dimensions in parallel if needed]
      |
      v
[Aggregate Wave 1 findings]
      |
      v
[Wave 2: Spawn Tech Stack Researcher with dependency list from Wave 1]
  - tool-dependencies-updater: audit-only scan for outdated packages, version gaps, security advisories
  - web search: research key frameworks/libraries for new features, deprecation, relevance
      |
      v
[Final Synthesis]
```

## Subagent Prompts (use these as templates)

Wave 1A:
- "Explore the directory structure of this repo. List key folders and their purposes. Focus on: [specific area if provided]"
- "Find all entry points in this codebase - main files, CLI commands, API routes, exported modules"
- "Analyze dependencies - what frameworks, libraries, and tools does this project use?"
- "Identify architectural patterns - is this MVC, microservices, monolith? What conventions are used?"

Wave 1B:
- "Find and summarize all configuration files - what can be configured and how?"
- "Map the test structure - where are tests, what testing frameworks, what's the coverage strategy?"
- "Audit all documentation for accuracy: (1) List every agent-spec.json file and cross-reference against README agent tables — flag any agents listed in docs but missing from disk or vice versa. (2) List every skills/*/SKILL.md and cross-reference against README skill lists. (3) Compare Config dependency declarations against README dependency sections. (4) Grep all .md and .json files for references to agent names and verify each referenced agent exists as an agent-spec.json. (5) Check AGENTS.md files across packages for inconsistent paths, naming examples, or model references. (6) Flag empty directories, typos, and dead stubs."

Wave 2 (spawn these two in parallel):
- tool-dependencies-updater: "Scan this project for all dependency manifests, check every dependency against the latest available version, run security advisory checks on outdated packages, and report findings grouped by risk level (critical/major/minor). Do NOT apply any updates — audit only."
- web search: "Research the following tech stack: [list key frameworks/libraries from Wave 1]. For each, find: (1) latest stable version and what's new, (2) any deprecation or EOL announcements, (3) notable new features that could benefit this project, (4) whether any component has been superseded by a better alternative. Cite sources."

## Output Format

After all subagents complete, synthesize into:

```
## Codebase Overview
[1-2 sentence summary]

## Key Findings
- **Tech Stack**: [languages, frameworks, tools]
- **Architecture**: [pattern, structure]
- **Entry Points**: [main files, commands]
- **Configuration**: [key config files]
- **Testing**: [strategy, frameworks]

## Tech Stack Health
- **Outdated (Critical)**: [packages with security vulnerabilities]
- **Outdated (Major)**: [packages with major version bumps available — note breaking change risk]
- **Outdated (Minor)**: [packages with minor/patch updates]
- **New Features Available**: [notable new capabilities in current stack]
- **Deprecation/EOL Warnings**: [anything approaching end of life]
- **Upgrade Effort Summary**: [overall assessment — low/medium/high effort to get current]

## Recommended Starting Points
[Files to read first for understanding]

## Potential Concerns
[Any issues, outdated deps, missing tests, etc.]

## Documentation Audit
- **Ghost references**: [agents/skills/paths mentioned in docs but not on disk]
- **Missing from docs**: [agents/skills that exist on disk but aren't documented]
- **Stale content**: [outdated descriptions, wrong dependency lists, inconsistent AGENTS.md sections]
- **Config mismatches**: [README deps vs Config file deps]
- **Path inconsistencies**: [resource paths in agent specs that don't follow conventions]
- **Empty/dead artifacts**: [empty directories, stub files with no content]
- **Typos**: [spelling errors found in documentation]
```

## Key Principles

- ALWAYS run explorations in PARALLEL within the current harness limit - this is the whole point
- Never exceed 4 subagents in one batch unless the harness explicitly allows more
- Wave 2 (Tech Stack Researcher) runs AFTER Wave 1A/1B completes because it needs the dependency list
- tool-dependencies-updater is used in AUDIT-ONLY mode — never apply updates during explore
- Be thorough but efficient - don't read entire files, scan for structure
- Focus on what helps someone GET STARTED quickly
- Flag anything unusual or concerning
- If a specific area is requested, weight exploration toward that area
