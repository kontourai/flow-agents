# Assignment Provider Contract

This contract defines the provider-neutral vocabulary for durable work-item ownership: who has
claimed a subject, how that claim is represented, and how it is read back safely. It formalizes
[ADR 0021: Assignment Leases and Stale-Claim Takeover](../../docs/adr/0021-assignment-leases-and-stale-claim-takeover.md)
as the third provider leg beside `WorkItemProvider` and `BoardProvider`
(`context/contracts/work-item-contract.md`) and `ChangeProvider`. GitHub is the first concrete
mapping for this contract, not the generic vocabulary — Linear, Jira, GitLab, and a local-file
provider for tracker-less repos and evals all map the same operations.

## Terminology: three distinct "claim" concepts

This repository uses the word "claim" for three unrelated things. Always qualify in prose; never
write bare "claim" where the meaning is not obvious from surrounding context:

| Term | Layer | Meaning | Where it lives |
| --- | --- | --- | --- |
| **assignment claim** | this contract | Durable, provider-recorded ownership of a work item | `AssignmentProvider.claim()`, this doc |
| **liveness claim** | ADR 0012 | Ephemeral, TTL-reaped presence/heartbeat event | `liveness claim` (`workflow-sidecar.ts`), `freshHolders` (`liveness-read.js`) |
| **trust claim** | ADR 0010 / ADR 0017 | A Hachure `trust.bundle` evidence claim (kit-typed, verification status) | `workflow-sidecar.ts claim <id> <dir>` (`claimLookup`) |

An assignment claim's *effective state* is never computed from the assignment layer alone — it is
always joined against a liveness claim's freshness (see the join table below).

## AssignmentProvider Operations

Provider-neutral interface, verbatim from ADR 0021 §2:

```
AssignmentProvider:
  claim(subjectId, actor, meta)         # assign + attach machine-readable claim record
  release(subjectId, actor, meta)       # unassign + handoff note
  supersede(subjectId, from, to, meta)  # reassign with audit trail
  status(subjectId) -> {assignee?, actor?, claimedAt?, meta?}
  list(actor?) -> [subjectId]
```

| Operation | Arguments | Effect | Returns |
| --- | --- | --- | --- |
| `claim` | `subjectId`, `actor`, `meta` | Records durable ownership: assignee (or local-file record), a claim marker, and a versioned claim record carrying the full actor struct. | void (caller re-reads via `status` to confirm) |
| `release` | `subjectId`, `actor`, `meta` | Clears durable ownership and leaves a handoff note. Normally invoked by the incumbent actor at clean session end. | void |
| `supersede` | `subjectId`, `from`, `to`, `meta` | Reassigns ownership from a lapsed actor to a successor, with an audit-trail note explaining why (staleness, explicit human confirmation). | void |
| `status` | `subjectId` | Reads current assignment state without joining liveness. | `{ assignee?, actor?, claimedAt?, meta? }` — the raw assignment-layer read |
| `list` | `actor?` (optional filter) | Enumerates subject ids currently claimed, optionally filtered to one actor. | `[subjectId]` |

`status()` alone is **assignment-layer truth only** — it does not tell a caller whether the claim
is fresh. Callers that need to decide "is this work available" must compute the join described
next, not call `status()` in isolation.

**Actor identity is runtime-agnostic**: `{ runtime, session_id, host, human? }`. Claude Code,
codex, opencode, and pi sessions, and humans, are all actors. Reuse the exact struct
`scripts/hooks/lib/actor-identity.js`'s `resolveActor`/`serializeActor` already define — do not
fork a second actor concept. `subject_id` reuses `workItemSlug`'s `owner/repo#id` convention
(the same string the deterministic session slug derives from) rather than inventing a second
identifier scheme.

## The assignment ⋈ liveness join

Effective claim state is always a **join** of two layers with distinct jobs. Neither layer is
trusted alone:

| Layer | Records | Lifetime | Medium |
| --- | --- | --- | --- |
| **Assignment** | intent / ownership | durable, survives crashes | provider (issue assignee/label/comment, or local-file record) |
| **Liveness** | presence / freshness | ephemeral, TTL-reaped | ADR 0012 claim stream (`freshHolders`) |

Readers compute the join from `{ assignment: AssignmentStatus, freshHolders: FreshHolder[] }` to
one of five effective states:

| Assignment | Liveness | Effective state | `pull-work` treatment |
| --- | --- | --- | --- |
| assigned | fresh heartbeat | **held** | excluded |
| assigned | stale / absent | **reclaimable** | offered, via takeover protocol (ADR 0021 §5, out of this contract's scope) |
| assigned (human) | n/a (humans don't heartbeat) | **human-held** | surfaced, never auto-taken (see below) |
| unassigned | fresh (claim only) | **held** (assignment lagging) | excluded |
| unassigned | absent | **free** | offered |

This join rule is what makes lost locks structurally impossible: staleness — not assignment — is
what excludes, so an orphaned assignee/label/record from a dead session can never gate work.

The join is a pure function; reuse `scripts/hooks/lib/liveness-read.js`'s exported
`freshHolders(events, slug, selfActor, nowMs)` for the liveness half rather than re-implementing
TTL/staleness arithmetic. The join table itself (assignment status × liveness freshness →
effective state) is the only new logic — it has no other implementation in this repository.

## Lazy-correction transition table

Nothing updates the provider on a timer; every mutation has a responsible actor, invoked at a
specific lifecycle moment (ADR 0021 §4). This table names every transition for completeness; it
also records which issue implements each row so a future reader does not assume any single issue
delivers all four:

| Transition | Mutator | When | Owning issue |
| --- | --- | --- | --- |
| `claim` | the claiming session | at selection | **#290 (this issue)** |
| `claim` / `supersede` | `ensure-session`'s pre-entry ownership guard (a SECOND mutator, alongside `assignment-provider claim`) | on session entry, before any session directory is created — `free` establishes a claim, `reclaimable` requires explicit `--supersede-stale` | **#291** |
| `clean_release` | the incumbent (Stop hook / terminal `advance-state`) | session end — unassign + handoff comment | #292 |
| `supersede` | the successor, inside the takeover protocol | after the grace beat | #294 |
| `crash_no_successor` | nobody, initially; corrected by the next actor to want the subject, or the janitor | lazily, or on a janitor sweep | out of scope — the Console relay's first cross-machine duty (ADR 0021 §4/§7) |

`ensure-session`'s guard reuses this file's own `computeEffectiveState`/`performLocalClaim`/
`performLocalSupersede` (Wave 1 exports) rather than a parallel implementation — see
`docs/adr/0021-assignment-leases-and-stale-claim-takeover.md` §3 for why a second claim point
was needed (a session entered without going through `pull-work` previously got no durable claim
at all) and the canonical `actor_key` field (below) that keeps its self-recognition consistent
with every other tool that reads or writes a claim record.

Lazy correction is *safe* by the join rule above (stale assignment excludes nothing), but leaves
the human-visible board stale in the crash case until the next claim attempt or a janitor sweep
corrects it.

## Human-assignee ask-first policy

Humans do not heartbeat, so `assigned-to-human + no-liveness` is **normal, not stale** — it must
never be treated as `reclaimable`. Agents surface idle human assignments ("assigned to `brian` 3
days ago, no linked activity — reclaim?") and act only on explicit confirmation.

- Default behavior: `ask_first`.
- The threshold (`idle_threshold_days`, default `3`, matching ADR 0021 §6's own illustrative
  example) and behavior (`ask_first` | `never_reclaim`) are a policy knob in
  `assignment-provider-settings.schema.json` (`policy.human_assignee_policy`), not a hardcoded
  constant.
- **Non-goal:** never auto-supersede a human. The join function must gate on the actor struct's
  `human` field being present (not absent/null) — never on a heuristic over the GitHub login name
  — so a human assignee is always classified `human-held`, regardless of idle duration, and is
  never silently reclaimed by any automated path.
- This contract and its settings schema define the policy knob and the read-side data a caller
  needs to surface the question (assignee identity, idle duration). The actual "ask the user"
  interaction belongs to whichever skill consumes the join result (`pull-work`), which records it
  as an alignment question rather than a new UI surface.

## Versioned claim-record format

The durable claim record is a single JSON object, versioned via `schema_version` so a reader can
detect an incompatible future shape before parsing fields it does not understand:

```json
{
  "schema_version": "1.0",
  "role": "AssignmentClaimRecord",
  "subject_id": "kontourai/flow-agents#290",
  "actor": { "runtime": "claude-code", "session_id": "...", "host": "...", "human": null },
  "claimed_at": "2026-07-02T00:00:00Z",
  "ttl_seconds": 1800,
  "branch": "agent/<actor>/<slug>",
  "artifact_dir": ".kontourai/flow-agents/<slug>",
  "status": "claimed"
}
```

| Field | Required | Description |
| --- | --- | --- |
| `schema_version` | yes | Version of this record shape, `"1.0"`. |
| `role` | yes | Constant `"AssignmentClaimRecord"`, for readers scanning mixed content (e.g. a GitHub comment thread) for this record type. |
| `subject_id` | yes | The claimed work item, in `owner/repo#id` form — the same string `workItemSlug` derives the deterministic session slug from. |
| `actor` | yes | `{ runtime, session_id, host, human? }` — the exact struct `actor-identity.js` defines. `human` is set (non-null) only for a human assignee; its presence, not a username heuristic, gates the human-held join state. |
| `actor_key` | no (additive, #291) | The canonical `resolveActor(env).actor` string for the claiming actor — the same flat/bare token `liveness whoami`, `liveness claim --actor`, per-actor `current.json`, and pull-work's `--self-actor` all use. When present, `computeEffectiveState` compares against THIS (not a re-serialization of `actor`) for both self-recognition and the liveness join, because `serializeActor(actor)` and `resolveActor(env).actor` diverge for an explicit-override actor (a bare token vs. a `explicit-override:<value>:<host>` triple) while agreeing for a derived actor. Absent on any pre-#291 record or fixture — `computeEffectiveState` falls back to `serializeActor(actor)` in that case, reproducing pre-#291 behavior exactly. |
| `claimed_at` | yes | ISO-8601 timestamp the claim was recorded. Mirrors the liveness stream's own claim-event field so a reader compares freshness with one mental model across both layers, even though the two are stored in different media. |
| `ttl_seconds` | yes | Same field name/semantics as the liveness stream's `ttlSeconds` (default `1800`). |
| `branch` | yes | The branch this actor is working on, per the `agent/<actor>/<slug>` convention. |
| `artifact_dir` | yes | The deterministic workflow artifact directory for this subject, so a successor inherits the same session. |
| `status` | yes | `"claimed"` today; future transitions may add `"released"` / `"superseded"` values as the corresponding mutator (see the transition table) is implemented. |

**Versioning rule:** bump `schema_version` only on an incompatible change (matching
`artifact-contract.md`'s existing sidecar rule: "Keep `schema_version` at `1.0` until the schema
changes incompatibly"). Additive, optional fields do not require a bump.

### GitHub mapping

The GitHub implementation represents the record as:

- **assignee**: the notification/board hook.
- **a single `agent:claimed` label** (default name, configurable via
  `policy.label_name`): the board filter.
- **a machine-readable claim comment**: human-readable prose above a fenced JSON block containing
  the record above, located via a fixed marker (default
  `<!-- flow-agents:assignment-claim -->`, configurable via `policy.claim_comment_marker`) so the
  board stays legible to a human without tooling, while remaining machine-parseable.

The comment carries identity because the assignee field cannot: N agent sessions typically share
one GitHub account, so per-session identity lives in the attached record. Each provider decides
what it can natively represent versus what goes in the record.

### local-file mapping

For tracker-less repos and evals, the same record is written to a JSON file under the artifact
root (`<artifact-root>/assignment/<sanitized-subject-id>.json`), full read-modify-write, no
external process involved. This path is the one that does real I/O inside the CLI, since there is
no external mutation to defer to a skill.

**`--actor-json` asymmetry (fix-plan iteration 1, F5, intentional):** local-file `claim`/`release`
falls back to auto-resolving the actor from the live environment (`resolveActor(process.env)`) when
`--actor-json` is omitted; `render-claim`/`render-supersede` (GitHub) always require `--actor-json`
explicitly and fail loud without it. This is intentional, not a footgun to fix later — the
currently-wired `pull-work` skill always passes `--actor-json` for both provider kinds, so the
asymmetry has no effect on the shipped path today, but a future direct-CLI caller relying on
local-file `claim` to fail the same way `render-claim` does when the actor can't be determined
should pass `--actor-json` explicitly rather than relying on the auto-resolve fallback.

## Implementation Note

`schemas/assignment-provider-settings.schema.json` is the settings schema companion to this
contract — it configures `provider.kind` (`github` | `local-file`), the label name, the claim
comment marker, and the human-assignee policy knob described above.

The GitHub write path follows this repository's `publish-change-helper.ts` precedent — **render,
don't execute**: the CLI emits the exact, deterministic `gh` argv and comment body for a mutation
as a pure function; the calling skill runs that exact argv via its Bash tool (never freehand `gh`
text), then re-fetches and feeds the result back into the CLI's `status` parser to close the round
trip. This is a deliberate divergence from a literal "CLI shells out to `gh` itself" design: it
matches the one existing same-shaped precedent in this repository, keeps operational concerns
(auth, rate limiting, retries, partial-failure sequencing across separate `gh` calls) at the skill
layer where Bash-tool error handling already lives, and avoids introducing this repository's first
`execFileSync`-to-`gh` code path inside compiled code without a dedicated decision. A future
implementer of the GitHub mutation path should read this note, not re-derive the reasoning from
scratch — see the `#290` plan artifact's Design Decision 1 for the full evidence trail if more
detail is needed.

**`gh_commands` execution contract (fix-plan iteration 1, F4):** every `render-*` subcommand's
`gh_commands` field is a JSON array of **argv arrays** (one element per `gh` argument), not a
shell-command string. The calling skill MUST execute each entry as argv — every element passed as
its own separate Bash-tool argument — and MUST NOT concatenate the elements into a single shell
string or run them via `bash -c`/shell re-interpretation. This matters specifically because
`claim_comment_body` (and, for `render-supersede`, `previous_record`) can carry attacker-influenced
text: any GitHub user who can comment on the issue can post a forged claim-marker comment (see the
sanitization note below), and reconstructing a shell string from that content would reintroduce a
shell-injection surface the render/execute split is designed to avoid. This is stated explicitly in
`kits/builder/skills/pull-work/SKILL.md`'s "Assignment Claim On Selection" section as well — this
paragraph is the contract-side mirror of that instruction, not a duplicate source of truth to drift
from it.

**Untrusted claim-record fields (fix-plan iteration 1, F2):** `extractClaimRecord()` parses the
fenced JSON claim record out of *any* issue comment matching the claim marker — posting a comment
requires no elevated access, unlike the assignee/label mutations this contract otherwise gates. Its
returned record's string fields (`subject_id`, `branch`, `artifact_dir`, `actor.*`, including
`actor.human`, and each `audit_trail` entry's actor/`reason`) are therefore treated as untrusted
display input and are run through a control-character-strip + length-cap sanitizer (mirroring
`workflow-sidecar.ts`'s `stripControlCharsForDisplay`, the established #287/#320 mitigation for
this input class) before they leave the module in `status`/`list` output. This is display-only — it
never changes the assignment ⋈ liveness join's classification logic, only the surfaced string
content.

No part of this system writes to the provider on a timer or heartbeats to it (ADR 0021 §4/§7).
Every write is triggered by a specific lifecycle moment named in the transition table above. The
one optional exception is a comment-body refresh at an explicit phase transition
(`policy.comment_refresh_on_phase_transition`, default `false`) — cheap because it reuses the same
render path already built for `claim`, just called again with an updated `status`/`claimed_at`
field.
