---
name: "dependency-checker"
displayName: "Dependency Version Checker"
description: "Check latest versions, identify outdated packages, and find security advisories across npm, PyPI, Cargo, Maven, Go, NuGet, Ruby, PHP, Swift, Dart, Docker, Helm, Terraform, and GitHub Actions"
keywords: ["dependencies", "outdated", "update", "upgrade", "version", "security", "advisory", "cve", "vulnerability", "npm", "pypi", "cargo", "maven", "package"]
---

# Dependency Version Checker

Check package versions and security advisories across all major ecosystems.

## Available Tools
- `package-version-check` — Batch version lookups across ecosystems
- `package-registry` — GitHub Security Advisory search

## Workflow
1. Scan project for dependency manifests (package.json, requirements.txt, Cargo.toml, etc.)
2. Use `package-version-check` tools to batch-check versions by ecosystem
3. Use `package-registry` to search GitHub Security Advisories for outdated packages
4. Report grouped by risk: CRITICAL (CVEs), MAJOR (breaking), MINOR (safe updates)