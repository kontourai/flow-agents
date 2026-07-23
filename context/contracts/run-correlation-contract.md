# Run Correlation Contract

> Read [`context/contracts/standing-directives.md`](standing-directives.md) — ratified owner directives that override default engineering conservatism.

The run correlation envelope is the portable identity carrier for joining one
workflow execution across runtime telemetry, Flow state, trust references,
economics, delegation lineage, and terminal outcomes. Flow Agents creates or
accepts the opaque `correlation_id`; consumers treat it only as an equality key.

Every identity slot is explicit. A runtime or producer records `present` with
the authority-owned identifier, or records `unavailable`, `unsupported`, or
`not_applicable` with a non-sensitive reason. Consumers must not infer a missing
identity from paths, timestamps, working directories, process ancestry, or
similarity.

The envelope carries references; it does not replace the owning records:

- Flow remains authoritative for workflow run and step identities.
- Runtime adapters remain authoritative for session, turn, trace, and span
  support.
- The work-item provider remains authoritative for work-item identity.
- Terminal record producers remain authoritative for their outcome record.

The same envelope is embedded unchanged in each participating record. Extension
fields are not permitted in version 1. New identity classes require a new
contract version so older consumers fail visibly instead of silently dropping a
join dimension.

This is intentionally an embedded value rather than a standalone Kontour
Resource Contract. It has no independent lifecycle, desired state, authority,
or status conditions; wrapping every occurrence in resource metadata would
multiply identities and make equality joins less reliable. The telemetry,
workflow, trust, economics, delegation, and terminal records that contain it
retain their own resource or native record shapes.

Import `createRunCorrelationEnvelope`, `validateRunCorrelationEnvelope`, and the
related types from `@kontourai/flow-agents`. The JSON Schema ships at
`@kontourai/flow-agents/schemas/run-correlation-envelope.schema.json`.
