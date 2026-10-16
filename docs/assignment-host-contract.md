# Assignment coordination for hosts

Hosts can consume the kit-neutral assignment primitive through three package subpaths:

| Subpath | Contract |
| --- | --- |
| `@kontourai/flow-agents/assignment-contract` | Actor identity, `AssignmentProvider`, schema 1.0 claim codec, assignment/liveness join and takeover eligibility; no I/O imports |
| `@kontourai/flow-agents/assignment-local-file` | The CLI's locked local store and `createLocalFileAssignmentProvider` |
| `@kontourai/flow-agents/assignment-github` | The CLI's GitHub comment parser and mutation argv renderers; callers execute the returned commands |

The package version versions these exports. Claim records independently carry `schema_version: "1.0"` and `role: "AssignmentClaimRecord"`. The codec preserves unknown fields and emits two-space JSON plus a newline, matching the local writer. Its decoder checks the version envelope, with an optional role check; it is not full record validation. Hosts writing records can call `findAssignmentClaimRecordProblems` for required-field diagnostics. Byte round trips apply to canonical writer output, not arbitrary JSON whitespace. GitHub parsing applies the existing display sanitization; use the core codec for lossless record transport.

Subject identity and optional `work_item_ref` are opaque in the core. Only the GitHub renderer requires an issue-shaped reference. The local provider retains its existing sanitized, 64-character filename mapping: hosts must select subject keys that do not collide under `sanitizeSegment`.

Supply `AssignmentLivenessSource.freshHolders` from the host runtime. It returns only fresh holders, excludes the requesting actor, and uses canonical actor keys. `resolveEffectiveState` joins that reading with provider status: a live agent holds work, an absent agent makes it reclaimable, a human stays human-held, and absent assignment and liveness mean free. The stored `actor_key` takes precedence over re-serialized actor identity. Human-held work is never automatically eligible for takeover. `decideTakeover` returns eligibility and the required grace action; callers wait one heartbeat interval and re-read before superseding. The helper does not enforce a transaction or authorize a mutation. Builder retains when to claim/release and how to resume.

## Host selection remains a separate integration requirement

These exports let a host implement a shared store and supply liveness. They do not select that implementation for a Builder run. Current assignment settings accept only `github` and `local-file`; there is no public environment/MCP provider registration seam. `ensure-session --assignment-provider <kind> --effective-state-json <path>` accepts provider evidence, but still creates a local ownership mirror, and selected-work/lifecycle evidence reads that mirror. The original export proposal also leaves this path unchanged.

Consequently a host-selected Builder run with zero local claim files is **not supported by this extraction**. The bounded follow-up must define authoritative host-provider selection, selected-work provenance and lifecycle ownership/fencing together, then prove claim/release/resume use that store without a second local claim. Hosts must not infer this behavior from the provider interface or use evidence snapshots as a live authority bridge. No Station runtime or registry publication is proven here.

The detailed operations and existing CLI behavior are specified in [the assignment provider contract](../context/contracts/assignment-provider-contract.md).
