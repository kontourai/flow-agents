---
status: current
subject: Workspace Kit Selection
decided: 2026-09-28
evidence:
  - kind: issue
    ref: https://github.com/kontourai/flow-agents/issues/1418
  - kind: issue
    ref: https://github.com/kontourai/flow-agents/issues/1137#issuecomment-5860248269
  - kind: session-archive
    ref: .kontourai/flow-agents/kontourai-flow-agents-1418/kontourai-flow-agents-1418--pull-work.md
---

# Workspace Kit Selection

Flow owns the Kit container and Flow semantics. Flow Agents owns explicit workspace selection, portable artifact locking and local resolution. The [v1 contract](../../context/contracts/workspace-kits.md) is directory-scoped and works without Git or Station.

V1 resolves local aliases into immutable, fully accounted artifact trees. It keeps required dependency closure and empty operational configuration explicit, publishes artifacts before the lock, and inspects without acquiring or executing code. A new framed digest leaves legacy install receipts unchanged. Existing install and activation paths are separate; neither can serve as an implicit fallback for a locked selection.

This bounded decision does not claim the workflow runtime consumes these locks. Activation, retained run bindings, other transports, first-party extraction and reclamation need their own integration evidence. A lock grants no execution, policy or publisher authority.
