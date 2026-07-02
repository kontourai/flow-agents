# Review Contract

Review is report-only critique. It asks whether the changed code is maintainable, secure, consistent with project standards, and structurally sound before verification proves behavior.

## Purpose

Review and verification are separate gates:

- Review answers: should this implementation be changed before we trust it?
- Verification answers: what evidence proves the accepted behavior works?

Keep review findings in the configured critique artifact/sink; in the local sidecar workflow this is materialized as `critique.json`. Keep behavior evidence in `evidence.json`.

Review is not a canonical `state.phase` value. Machine-readable workflow state must use the canonical lifecycle phase vocabulary from the artifact contract, while review-work records its verdicts and findings through the critique artifact/sink.

## Required Inputs

- session artifact path when available
- plan artifact path or implementation summary
- modified files
- relevant project standards, including `context/code-review-standards.md` when present
- risk triggers such as auth, user input, database queries, filesystem operations, API endpoints, cryptography, payments, migrations, CI, deployment, or public contracts

## Review Lanes And Trigger Rules

Run each required lane as report-only critique. A lane is required when modified
files, the plan, or the implementation behavior match its triggers. When trigger
detection is uncertain for a substantial change, run the relevant lane or record
that lane as `not_verified` with the reason.

| Lane | Triggers | Expected reviewer or delegate |
| --- | --- | --- |
| Code | Source code, tests, scripts, generated-code inputs, public contracts, or implementation logic changed. | `tool-code-reviewer` |
| Security | Authentication, authorization, user input, query params, headers, templates, serialization, database queries, filesystem paths, uploads, downloads, archives, generated files, API endpoints, webhooks, external API calls, network operations, cryptography, tokens, secrets, payments, billing, CI, deployment, or feature flags changed. | `tool-security-reviewer` |
| Dependency | Package manifests, dependency manifests, lockfiles, dependency tooling, package manager config, container base-image dependency declarations, or dependency update policy changed. Examples include `package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `requirements.txt`, `pyproject.toml`, `poetry.lock`, `Pipfile.lock`, `Cargo.toml`, `Cargo.lock`, `go.mod`, `go.sum`, `pom.xml`, `build.gradle`, `Gemfile.lock`, `composer.lock`, and NuGet lock files. | `tool-dependencies-updater` or configured repo dependency reviewer |
| Architecture/standards | Module boundaries, ownership boundaries, shared abstractions, schemas, API compatibility, data flow, migrations, platform conventions, documented decisions, project standards, or cross-cutting behavior changed. | `tool-code-reviewer` plus configured architecture/domain reviewer when present |
| IaC/policy | Infrastructure as code, policy as code, cloud/deployment config, Terraform, OpenTofu, CloudFormation, Kubernetes manifests, Helm charts, Dockerfiles, Compose files, GitHub Actions, CI/CD permissions, IAM, OPA/Rego, Sentinel, or environment provisioning changed. | `tool-security-reviewer`, configured IaC/policy reviewer, or repo-local read-only scanner |

IaC/policy scanner guidance is vendor-neutral. Acceptable scanner classes include
Checkov, tfsec, Trivy, Semgrep, and project-configured policy scanners, but no
single vendor is required by this contract. Reviewers may reference native
scanner output or SARIF when available, but missing scanner tooling must be
recorded as `not_verified`; do not install new scanners or silently pass the
lane during review.

## Reviewers

Run the relevant report-only reviewers:

- `tool-code-reviewer` for code quality, maintainability, correctness, project standards, and architecture/standards fit
- `tool-security-reviewer` when security or IaC/policy triggers are present
- `tool-dependencies-updater` when dependency manifests, package manifests, package manager configuration, or lockfiles change
- an architecture, domain, IaC/policy, dependency, or standards reviewer when configured by the project or requested by the user

All reviewers are read-only reporters. They may inspect files, run read-only analysis commands, and write review artifacts under the workflow artifact directory. They must not modify source files, apply patches, or run autofixes.

## Review Scope

Attempt relevant perspectives and record findings:

- Code quality: readability, naming, function/file size, error handling, duplication, maintainability
- Failure handling: callers act on failure *return values*, not just exceptions — flag fail-open on any data-persisting path (per the persistence-integrity invariant in the artifact contract)
- Correctness risks: edge cases, unintended behavior, unsafe assumptions, missing tests
- Standards fit: project conventions, local architecture, public contracts, documented decisions
- Security: secrets, injection, XSS, path traversal, auth/authz, unsafe external calls, vulnerable dependencies
- Architecture: ownership boundaries, coupling, data flow, schema or API compatibility, migration risk

If a perspective is required but cannot be reviewed, record it as `not_verified` with the reason.

## Verdicts

- `pass`: no open findings that block delivery
- `comment`: non-blocking findings or suggestions only
- `fail`: at least one open critical/high finding, or a medium finding that requires code changes before delivery
- `not_verified`: required review evidence could not be collected

## Structured Critique Sidecar

When review runs as part of a workflow, write or update the configured critique artifact/sink. For the current local sidecar materialization, write or update `critique.json` beside the workflow artifacts using `schemas/workflow-critique.schema.json`.

Reviewers write critique **through** `record-critique` (or `import-critique` for a Markdown report), directly or via the orchestrating skill — never by hand-authoring `critique.json`, `evidence.json`, or `acceptance.json`. Those bespoke sidecars were retired as the source of truth by ADR 0010 Phase 4c; `trust.bundle` is the sole verification artifact and only the sidecar writer performs the evidence classification the CI trust anchor depends on (ADR 0020). `config-protection.js` blocks direct tool writes to these gate files by design.

Prefer the sidecar writer when available:

```bash
npm run workflow:sidecar -- record-critique .kontourai/flow-agents/<slug> \
  --id code-review \
  --reviewer tool-code-reviewer \
  --verdict pass \
  --summary "Code review passed."
```

For Markdown reviewer reports, import them when possible:

```bash
npm run workflow:sidecar -- import-critique .kontourai/flow-agents/<slug> \
  .kontourai/flow-agents/<slug>/<slug>--code-review.md \
  --reviewer tool-code-reviewer
```

## Gate Rules

- Critical or high findings block delivery until fixed, accepted by the user, deferred with explicit rationale, or marked false positive.
- Security critical/high findings block delivery unless the user explicitly accepts the risk.
- Medium findings that require code changes route through an execution fix pass.
- Any code change after review requires another clean review and verification pass.
- Do not mark critique `pass` while open findings remain.
