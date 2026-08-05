# Committed Flow Agents policy

This directory is the sole tracked exception under `.flow-agents/`. The effective
configuration is read from the immutable `HEAD` blob, never from staged or working-tree
bytes. `core.config.json` uses `schemas/flow-agents-core-config.schema.json`.

Per-Kit files use `<kit-id>.kit.config.json` (whose filename stem must exactly equal
`kit_id`) and
`schemas/flow-agents-kit-config.schema.json`. Their only proposal surface is Flow's
`gate_overrides.<gate>.expectations.<expectation>` vocabulary. They neither install nor
activate a Kit, and the inspection command calls Flow's non-mutating config-merge preview;
it does not apply the merged config or patch arbitrary Flow authority. A proposal is previewed
only when the bounded local init activation record lists that Kit as active, and it is compared
against committed `.flow/config.json` authority (or Flow defaults only when that file is
confirmed absent from `HEAD`).

Environment settings are development conveniences. In production they can only tighten
the committed goal-fit policy except `recheck`: because it executes model-supplied shell
text, it is a committed-policy opt-in and production environment values cannot enable it.
Malformed committed policy fails closed with `recheck: false`.

Goal-fit modes order `off < warn < block`; backstop values order `skip < off < block`
(`warn` remains a development environment alias for `off`). Production overrides may only
move upward in those orders.
