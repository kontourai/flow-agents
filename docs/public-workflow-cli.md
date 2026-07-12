# Public Workflow CLI

Flow Agents exposes its supported consumer workflow surface through the primary package binary.
Consumer repositories do not need a `package.json`, a local dependency, or a repository-owned
writer script.

Use an exact package version from an isolated npm prefix. This prevents a repository-local
dependency with the same version from intercepting the command. Generated workflow actions and
doctor remediation include this isolation automatically:

```bash
flow_agents() (
  root=$(mktemp -d) || exit 1
  trap 'rm -rf "$root"' EXIT HUP INT TERM
  npm exec --yes --prefix "$root" \
    --package=@kontourai/flow-agents@3.6.0 -- flow-agents "$@"
)

flow_agents workflow start \
  --flow builder.build \
  --work-item provider:work-item-123 \
  --assignment-provider example-provider \
  --effective-state-json .kontourai/flow-agents/provider-assignment.json

flow_agents workflow status --json

flow_agents workflow evidence \
  --session-dir .kontourai/flow-agents/example \
  --expectation implementation-plan \
  --status pass \
  --summary "Implementation plan recorded." \
  --evidence-ref-json '{"kind":"artifact","file":".kontourai/flow-agents/example/example--plan-work.md","summary":"Reviewed implementation plan with Definition Of Done and task-to-criterion mapping."}' \
  --evidence-ref-json '{"kind":"artifact","file":".kontourai/flow-agents/example/acceptance.json","summary":"Stable acceptance criteria and required evidence."}' \
  --evidence-ref-json '{"kind":"artifact","file":".kontourai/flow-agents/example/handoff.json","summary":"Execution handoff and next action."}'

flow_agents workflow critique \
  --session-dir .kontourai/flow-agents/example \
  --verdict pass \
  --summary "Report-only review found no blocking findings." \
  --artifact-ref ".kontourai/flow-agents/example/example--deliver.md" \
  --lane-json '{"id":"code-review","status":"pass","summary":"The delivered implementation was reviewed.","evidence_refs":[{"kind":"artifact","file":".kontourai/flow-agents/example/example--deliver.md","summary":"Reviewed delivery report and changed scope."}]}'
```

`builder.build` accepts the stable, human-readable Work Item reference emitted by the selected
provider adapter. Flow Agents persists that exact reference as the run subject; it does not infer
provider identity from a GitHub-shaped string. Pass the resolved `--assignment-provider`; non-local
providers also pass their standard assignment status result through `--effective-state-json`.
Flow Agents verifies that the current actor is the confirmed holder, retains that provider result
as selected-work evidence, and creates a local runtime lease mirror for atomic session mutation.
A direct local request can resume an existing bound session, but the public CLI does not invent a
provider or create an unresolvable local binding.

`builder.shape` uses a caller-supplied, safe slug. Derive it from a selected
title using lowercase ASCII words separated by single hyphens. Never inject raw
request text into a shell command or use it as a slug:

```bash
flow_agents workflow start --flow builder.shape \
  --task-slug onboarding-alerts \
  --summary "Shape onboarding alerts into independently actionable slices."
flow_agents workflow status --session-dir .kontourai/flow-agents/onboarding-alerts --json
```

For `tests-evidence`, supply one criterion object for every accepted criterion
and one or more substantive commands that were actually run. Repeat `--command`
when criteria require different checks. Every command needs a matching
top-level command reference, and every passing criterion must cite at least one
of those exact commands. A passing observation must also report a positive executed-test or
assertion count; a successful zero-test run is rejected. Do not use placeholders such as `true`
or a version command as behavior proof:

```bash
flow_agents workflow evidence \
  --session-dir .kontourai/flow-agents/example \
  --expectation tests-evidence \
  --status pass \
  --command "npm test" \
  --summary "The project test command passed for the implemented criterion." \
  --evidence-ref-json '{"kind":"command","excerpt":"npm test","summary":"Exact substantive project test command recorded for this verification result."}' \
  --criterion-json '{"id":"<criterion-id>","status":"pass","evidence_refs":[{"kind":"command","excerpt":"npm test","summary":"Exact substantive project test command run for this criterion."}]}' \
  --evidence-ref-json '{"kind":"artifact","file":".kontourai/flow-agents/example/example--plan-work.md","summary":"Accepted criterion and verification mapping."}'
```

The public lifecycle verbs are `pause`, `resume`, `release`, `cancel`, and `archive`. Pause,
resume, and release require the current assignment actor and an explicit reason. `critique`
records the `clean-critique` claim but does not independently attach it to Flow or advance a gate. Cancel and
archive require a signed user/operator authorization file. Flow owns the canonical run
transition; Flow Agents validates assignment and request binding and projects the resulting run.
Critique derives reviewer identity from the calling runtime actor. An active
implementation assignment is required, and its actor cannot review its own
work; the delegated reviewer invokes the command directly under a distinct
identity. The public interface does not accept a caller-selected reviewer
label. Every critique includes an explicit verdict, at least one substantive
`--lane-json`, and local reviewed `--artifact-ref` values. Passing critiques
require every lane to pass; reviewed files and the workspace snapshot are
hashed into the stored review target so later implementation changes invalidate
stale clean critiques.

Current local runtime actor IDs provide coordination-level separation, not a
cryptographic identity guarantee. A policy that requires externally attested
reviewer identity must keep that assurance `NOT_VERIFIED` until the runtime
supplies a trusted delegation credential.

```bash
flow_agents workflow pause --reason "Waiting for a decision"
flow_agents workflow resume --reason "Decision received"
flow_agents workflow release --reason "Handing work back"
flow_agents workflow cancel --authorization-file cancel.json
flow_agents workflow archive --authorization-file archive.json
```

`workflow status` is read-only. It reads the actor-scoped current-session pointer, the projected
state, and the canonical Flow run without rewriting either store. Its `next_action` is freshly
derived from the canonical run, so a stale sidecar projection cannot misdirect recovery.

## Compatibility Doctor

Run doctor through the exact isolated package helper defined above:

```bash
flow_agents workflow doctor --json
```

The report distinguishes the executing CLI from a repository-local dependency and reports the
workflow/writer contract, installed hook and writer package, active Kits, Builder Kit content,
Flow runtime and definition, workflow-state schema, and trust-bundle schema. Incompatible or
missing installed components produce a nonzero exit and an exact, version-pinned `init` command
that preserves the recorded runtime and active Kits.

The package may use lower-level writer modules internally. They are not a
supported consumer or skill surface. Consumer guidance and Builder skills use
`flow-agents workflow` exclusively.
