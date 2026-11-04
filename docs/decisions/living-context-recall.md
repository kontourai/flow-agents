---
status: current
subject: Living Context recall contract
decided: 2026-11-03
evidence:
  - kind: issue
    ref: https://github.com/kontourai/flow-agents/issues/1131
  - kind: doc
    ref: kits/knowledge/docs/README.md
  - kind: doc
    ref: kits/knowledge/context-check/living-context.test.js
  - kind: url
    ref: https://github.com/kontourai/surface/blob/7486c6d8b3d942b1b2aa11e4cdd958f8b1b8aa9f/docs/decisions/knowledge-accumulation.md
---

# Living Context recall contract

Context Check `1.1` adds the recall contract proposed on kontourai/flow-agents#1131 to the
standalone `knowledge.context-check` flow without changing `1.0`. It is a separate flow id
(`knowledge.living-context`) and separate entry points so existing pinned consumers keep the
exact `1.0` behavior and loading the `1.0` module still needs no Surface or Survey package.

## Decision

- **Identity fails closed.** `reader` is required. A missing, blank, or unrecognised reader is
  refused at every selected root before any claim of any root is parsed or any file written, and a claim with no `visibility` is
  visible to no one. A reader must be listed by every selected root. Context Check does not
  authenticate; the host supplies an authenticated identity.
- **Visibility and per-viewer supersession are Surface's** (kontourai/surface#350, `readDeclaredVisibility`,
  `visibilityAllows`, `viewerSupersessionView`), not a local rule. A claim's `visibility` is a Surface
  declared form; unreadable or undeclared is sealed. Admission of an edge at the as-of instants (time, slot,
  kind) is this kit's; what a given reader may see of the admitted edges is Surface's. **A successor the
  reader cannot see leaves the predecessor `current` for that reader with no trace**, and a superseded claim
  is never `current` for a reader who can see a recorded, in-effect, same-slot successor along an edge they may
  see, along an acyclic chain; an edge the reader may not see leaves both claims current for them, by design, and a
  cycle through hidden claims follows Surface's rule below. This reverses an
  earlier, more conservative local rule (`unverifiable` for a hidden successor), which is no longer needed
  now that Surface defines the per-viewer view.
- **Limited disclosure, stated.** Asked for by id, hidden, absent, and not-yet-known claims return the same
  plain `no_answer`; a scan never names them; parse errors for claims the reader may not see are dropped;
  diagnostics of every parser family name the claim, never its position; a reader's view of an id uses only
  the copies they may see, so a hidden duplicate changes nothing whatever its content or file order (a group
  whose copies are all hidden and more than one is ambiguous, identical copies included: no copy stands for it and no union is safe, because it can
  create a hidden cycle that makes Surface drop a real supersession, so a visible claim whose recorded, visible
  edge chain reaches it is `unverifiable` with `supersession_ambiguous`, in any file order; the one bit this discloses
  also shows in the history, token cost and answers of the other claims on that chain)
  and two entitled copies are an error; an edge the reader may not see explains nothing. Admission of a chain through a hidden claim uses that claim's times and slot, so it can decide
  whether the chain collapses, though never what the reader is shown.
- **As-of follows the merged Surface accumulation decision** (kontourai/surface#204, Surface main
  `7486c6d`, `docs/decisions/knowledge-accumulation.md`). Knowledge time filters on a
  receiver-recorded `recorded_at` and never on an authored time; valid time is a half-open
  `[from, until)` interval (not the inclusive `validUntil` of an authority trace); a `succession`
  takes effect at the successor's valid `from`, a `correction` applies within the successor's valid interval;
a supersession edge has its own recording time and must join one slot (`slot`), else it is inert; missing or
  untrustworthy times are indeterminate, never guessed; the explicit `now` defaults both instants
  and is the instant freshness is judged at. `expiresAt`/TTL govern freshness only and are never
  used as world validity. `status` is a contextual disposition as of the stated instants, like
  Surface's projection-local `superseded`; it is not a Surface trust status and does not mutate
  one. Not modelled, and so not claimed: full slot identity (property slot, canonical qualifiers and
  claimType: only an explicit shared `slot` label is checked), authority text as of `known_at` (it is
  read at the pinned revision), cardinality and value
  equality, the admission policy (publisher and claim-owner binding, authority for a third-party
  replacement), retraction-versus-expiry, and equal-value support aggregation. The pinned Git
  commit is the only custody of the recording time and of the edge, which the manifest owner
  authors. Surface's shapes are design vectors until Hachure accepts them (hachure-org/spec#34);
  the manifest fields are this kit's, not a portable bundle extension.
- **The accumulation projection is not consumed yet.** Surface's `projectAccumulation` (kontourai/surface#359,
  main `b7d932b`) is the canonical current, superseded and contested projection, but it accepts a replacement
  only with a host-protected authority snapshot (claim owner bindings, admitted verification events,
  replacement grants) and receiver observations, which Surface says callers must not construct from unsigned
  bundle fields. A Git claim manifest supplies none of them: measured against `b7d932b`, a manifest-shaped
  supersession with no host authority projects as `contested` with the edge `pending`. So this kit admits
  edges itself (recording time, slot, kind, interval) and hands only the admitted edges to Surface's visibility
  view. That local admission is a stopgap, not a second derivation to keep, and `contested` is not reported.
  Consuming the projection is tracked in kontourai/flow-agents#1586.
- **Hidden cycles are Surface's rule.** Per Surface's `viewerSupersessionView`, "a cycle that exists only through
  hidden claims must not change what the viewer sees": with `a -> h(hidden) -> z -> a`, a reader who sees `a` and
  `z` is shown `a` as current and `z` as superseded by it. The never-current guarantee therefore holds along an
  acyclic chain, or a cycle the reader can see (which is `unverifiable`); it does not override Surface here.
- **Freshness is Surface's.** Expiry resolves through `claimIntrinsicExpiry` (`expiresAt` wins;
  `ttlSeconds` anchors on a verification at or before `known_at`, else recording) and a claim is stale when `now > expiry`,
  checked against Surface's own `reapplyVerifiedFreshness` at the boundary. A stale claim that would
  otherwise be current is `unverifiable`; a superseded one stays `superseded` with `freshness.stale: true`. Ephemeris is the time actor that wakes a Flow run at a deadline and derives
  nothing, so it is not consumed.
- **Abstention is a separate step.** Recall returns evidence and never an answer. The answer step
  sends only a `current` recall to an independent `@kontourai/survey` `SupportVerifier` and keeps
  each verdict as Survey's `CandidateVerification`. Only `supported` answers. The verifier is a
  required argument; the bundled deterministic one matches whole lines only and cannot read negation.
- **Budget keeps or drops whole results.** An explicit `max_tokens` bounds recall results by a
  named deterministic estimator. A drop is listed and makes the verdict `not_verified`;
  reconciliation is never skipped for a dropped recall.
- **Repository change observation is a shim.** `@kontourai/lookout` has no Git-revision source,
  so `observeRepositoryChange` lists the paths between two raw commits, refuses an empty or
  oversized change, and is to be replaced by a Lookout source when one exists.
- **Contextual status is not trust.** Recall statuses are contextual currentness, not Surface
  trust statuses; no second trust derivation is introduced (R6).
