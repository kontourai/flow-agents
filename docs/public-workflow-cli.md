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
    --package=@kontourai/flow-agents@3.5.0 -- flow-agents "$@"
)

flow_agents workflow start \
  --flow builder.build \
  --work-item owner/repository#123

flow_agents workflow status --json

flow_agents workflow evidence \
  --expectation implementation-plan \
  --status pass \
  --summary "Implementation plan recorded." \
  --evidence-ref-json '{"kind":"artifact","file":".kontourai/flow-agents/example/example--plan.md"}'
```

The public lifecycle verbs are `pause`, `resume`, `release`, `cancel`, and `archive`. Pause,
resume, and release require the current assignment actor and an explicit reason. Cancel and
archive require a signed user/operator authorization file. Flow owns the canonical run
transition; Flow Agents validates assignment and request binding and projects the resulting run.

```bash
flow_agents workflow pause --reason "Waiting for a decision"
flow_agents workflow resume --reason "Decision received"
flow_agents workflow release --reason "Handing work back"
flow_agents workflow cancel --authorization-file cancel.json
flow_agents workflow archive --authorization-file archive.json
```

`workflow status` is read-only. It reads the actor-scoped current-session pointer, the projected
state, and the canonical Flow run without rewriting either store.

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

The `flow-agents-workflow-sidecar` binary is deprecated and retained only while package-internal
callers migrate. New consumer guidance must use `flow-agents workflow`.
