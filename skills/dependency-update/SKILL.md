---
name: "dependency-update"
description: "Analyze and upgrade project dependencies — latest versions, security vulnerabilities, actionable update plan across all package managers."
---

# Dependency Analysis & Upgrade

Delegate dependency analysis to `tool-dependencies-updater` which has MCP access to package registries and security advisory databases.

## When to Use

- User asks to check for outdated dependencies
- User wants to upgrade packages to latest versions
- User asks about security vulnerabilities in dependencies
- During project audits or onboarding to assess dependency health
- Before major releases to ensure dependencies are current

## Execution

Spawn `tool-dependencies-updater` with a clear task description. The subagent handles all registry lookups via MCP tools.

### Basic Audit

```
Delegate to tool-dependencies-updater:
"Scan this project for all dependency manifests, check every dependency against
the latest available version, run security advisory checks on outdated packages,
and report findings grouped by risk level (critical/major/minor)."
```

### Targeted Update

```
Delegate to tool-dependencies-updater:
"Check the latest versions for dependencies in <manifest_file>. Focus on
<specific packages or ecosystem> and flag any with known security advisories."
```

### Security-Focused

```
Delegate to tool-dependencies-updater:
"Search for known security vulnerabilities (CVEs) affecting the current
dependency versions in this project. Prioritize critical and high severity
issues. Include advisory IDs and recommended fix versions."
```

## After the Subagent Reports

Once `tool-dependencies-updater` returns its findings:

1. Review the update plan with the user before making changes
2. For CRITICAL (security) updates — recommend immediate action
3. For MAJOR version bumps — warn about potential breaking changes, check changelogs if needed
4. For MINOR/PATCH updates — generally safe to batch-apply
5. Apply updates to manifest files (package.json, requirements.txt, etc.)
6. Run install commands (`npm install`, `pip install -r requirements.txt`, etc.)
7. Run tests to verify nothing broke
8. If tests fail after updates, investigate and either fix compatibility issues or pin to last working version

## Key Principles

- ALWAYS delegate registry lookups to the subagent — it has the MCP tools, you don't
- NEVER update dependencies without showing the user the plan first
- NEVER blindly apply major version bumps — they may require migration steps
- Group related updates (e.g., all React packages together) to avoid partial upgrades
- If the subagent reports packages it couldn't check, note them for manual review
- If rate limited, suggest setting the environment variable GITHUB_TOKEN 
