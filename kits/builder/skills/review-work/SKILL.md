---
name: "review-work"
description: "Review primitive - run report-only code, security, dependency, architecture/standards, and IaC/policy critique before verification; records findings through the critique artifact/sink, currently critique.json locally."
---

# Review

Session file in, critique verdict out. Delegates to review agents and records findings separately from verification evidence.

## Why This Is Separate From Verify

Verification is not critique.

Review asks whether the implementation should change: maintainability, security, architecture, standards, edge cases, and risky assumptions.

Verify asks whether the behavior is proven: build, lint/types, tests, browser/runtime evidence, acceptance criteria, and Goal Fit.

Keeping them separate makes failures route cleanly:

- The critique artifact/sink says what a reviewer thinks should be fixed or accepted; the current local sidecar materialization is `critique.json`.
- `evidence.json` says what was proven, failed, or could not be verified.

## Agents

| Agent | Role |
|---|---|
| tool-code-reviewer | Quality, maintainability, correctness, architecture fit, and project standards |
| tool-security-reviewer | Security review when risk triggers are present |
| tool-dependencies-updater | Dependency review when package manifests, dependency manifests, package manager config, or lockfiles change |
| configured architecture/domain/IaC/policy reviewer | Optional reviewer when the project or user configures one |

## Shared Contracts

Follow:
- `context/contracts/artifact-contract.md`
- `context/contracts/review-contract.md`
- `context/contracts/planning-contract.md` for acceptance criteria and Definition Of Done context

## Read-Only Rule (STRICT)

Reviewers NEVER modify source code:
- No code patches
- No format fixes
- No lint autofixes
- No "found and fixed"

If a fix is needed, report it as a finding. The orchestrator routes it back to execution.

## Input

- Session file path in `.kontourai/flow-agents/<slug>/` when available
- Plan artifact or implementation summary
- Modified files from execution progress or `git diff --name-only`
- Project standards, especially `context/code-review-standards.md` when present
- Security trigger context when present
- Dependency trigger context when package manifests, dependency manifests, package manager config, or lockfiles change
- IaC/policy trigger context when infrastructure, deployment, or policy files change

## Security Review Triggers

Run `tool-security-reviewer` when modified files or the task touch:

- authentication or authorization
- user input handling, forms, query params, headers, templates, or serialization
- database queries, migrations, schemas, or persistence
- filesystem paths, uploads, downloads, archives, or generated files
- API endpoints, webhooks, external API calls, or network operations
- cryptography, token handling, secrets, payments, billing, CI, deployment, or feature flags

If trigger detection is uncertain for a substantial change, run the security reviewer or record the security review as `not_verified`.

## Dependency Review Triggers

Delegate to `tool-dependencies-updater` when modified files include package
manifests, dependency manifests, package manager configuration, or lockfiles.
Common triggers include `package.json`, `package-lock.json`, `pnpm-lock.yaml`,
`yarn.lock`, `requirements.txt`, `pyproject.toml`, `poetry.lock`,
`Pipfile.lock`, `Cargo.toml`, `Cargo.lock`, `go.mod`, `go.sum`, `pom.xml`,
`build.gradle`, `Gemfile.lock`, `composer.lock`, NuGet lock files, Docker base
image dependency declarations, and dependency update policy files.

The dependency lane is report-only. It may inspect version, advisory, and
lockfile risk using configured read-only tooling, but review-work must not add
package-registry behavior, update dependencies, or install scanners. If the
required dependency review cannot run, record the dependency lane as
`not_verified`.

For multi-repo or cross-product work, dependency review must preserve the full
scope. Before delegating, enumerate every affected repo/package-manager root and
record one status per root:

- `pass`: dependency review ran and found no blocking issue
- `fail`: dependency review ran and found a blocking advisory, version, or
  lockfile issue
- `skip_no_manifest`: the root has no supported dependency manifest
- `not_verified`: review could not run or the result is unavailable

Do not narrow the dependency lane to only roots that failed build/test. If the
work changed shared conventions, generated artifact paths, install scripts, CI,
or workspace-wide guidance, the dependency review summary must say which product
roots were included and which were out of scope.

External advisory/audit services can disclose private dependency metadata. Before
running tools such as `npm audit`, registry lookups, or vendor advisory APIs,
record whether the user explicitly approved that disclosure for the affected
roots. If approval is absent, rejected, or too ambiguous for the local execution
policy, keep local inventory evidence and mark the external-audit portion
`not_verified` with the approval/privacy blocker. Do not convert that blocker
into a clean pass.

## IaC/Policy Review Triggers

Run security and configured IaC/policy review when modified files touch
infrastructure as code, policy as code, cloud/deployment config, Terraform,
OpenTofu, CloudFormation, Kubernetes manifests, Helm charts, Dockerfiles,
Compose files, GitHub Actions, CI/CD permissions, IAM, OPA/Rego, Sentinel, or
environment provisioning.

IaC/policy scanner guidance is vendor-neutral. Acceptable scanner classes
include Checkov, tfsec, Trivy, Semgrep, and project-configured policy scanners;
do not hard-require one vendor. Treat scanner output as report-only critique
input. If repo-local scanner tooling is unavailable, record the IaC/policy lane
as `not_verified` instead of installing tools or silently passing it.

## Workflow

1. Read the session file to find the plan artifact path and modified files.
2. Mark review as in progress. Markdown session files may use human-readable progress labels such as `reviewing`, but machine-readable workflow sidecars must use canonical `state.status` and `state.phase` values. For review-work, keep the lifecycle phase in execution and record critique results through the critique artifact/sink, currently `critique.json` locally:

   ```bash
   npm run workflow:sidecar -- advance-state <artifact-dir> \
     --status in_progress \
     --phase execution \
     --summary "Review in progress." \
     --next-action "Resolve review findings, then run verify-work."
   ```

3. Delegate in parallel:

   ```text
   tool-code-reviewer:
   - Modified files
   - Plan/acceptance criteria and user outcome
   - context/code-review-standards.md when present
   - Architecture, standards, maintainability, and correctness focus
   - todo_file path or artifact root for writing a review artifact

   tool-security-reviewer (when triggered):
   - Modified files
   - Security-sensitive areas to inspect
   - Dependency/security commands available to run read-only

   tool-dependencies-updater (when dependency triggers are present):
   - Modified package manifests, dependency manifests, package manager config, and lockfiles
   - Plan/acceptance criteria and dependency-risk context
   - Read-only dependency review focus; no dependency updates or registry behavior changes from review-work

   configured IaC/policy reviewer or repo-local scanner output (when IaC/policy triggers are present):
   - Modified Terraform, Kubernetes, Docker, Helm, GitHub Actions, policy-as-code, cloud, or deployment files
   - Read-only scanner classes such as Checkov, tfsec, Trivy, and Semgrep when already configured
   - Missing scanner or reviewer recorded as not_verified
   ```

4. Import or record reviewer results into the critique artifact/sink, currently `critique.json` locally:

   ```bash
   npm run workflow:sidecar -- import-critique <artifact-dir> <review-artifact> \
     --reviewer tool-code-reviewer
   ```

   Use `record-critique` directly when the reviewer returns structured findings instead of a Markdown artifact.

5. Route on critique status:
   - **pass/comment with no blocking findings** -> proceed to `verify-work`
   - **fail** -> route findings back to `execute-plan` or `plan-work`
   - **not_verified** -> surface the gap for user decision or run the missing reviewer

## Output

- Review artifacts written by reviewers when available
- Critique artifact/sink updated with reviewer verdicts and findings; locally this is currently `critique.json`
- Session or sidecar state updated so the next step is clear

Do not treat a clean review as proof that the feature works. It only clears the critique gate; `verify-work` still has to collect evidence.
