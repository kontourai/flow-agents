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
    ref: https://github.com/kontourai/surface/blob/f8106dd44af9ebceee87227b5edfc4352f16ed46/docs/decisions/knowledge-accumulation.md
---

# Living Context recall contract

Context Check `1.1` adds the recall contract proposed on kontourai/flow-agents#1131 to the
standalone `knowledge.context-check` flow without changing `1.0`. It is a separate flow id
(`knowledge.living-context`) and separate entry points so existing pinned consumers keep the
exact `1.0` behavior and loading the `1.0` module still needs no Surface or Survey package.

## Decision

- **Identity fails closed.** `reader` is required. A missing, blank, or unrecognised reader is
  refused before any claim is read or any file written, and a claim with no `visibility` is
  visible to no one. A reader must be listed by every selected root. Context Check does not
  authenticate; the host supplies an authenticated identity.
- **No leak.** Hidden, absent, and not-yet-known claims return the same plain `no_answer`, and a
  hidden successor is never named.
- **A superseded claim is never current while its successor is known and in effect.** When the
  successor is not visible to the reader, or its recording time or succession boundary is
  unknown, the predecessor is `unverifiable`. This is deliberately more conservative than the
  per-viewer supersession proposed in kontourai/surface#350 ("a viewer without access sees the
  prior current value"), which is not yet accepted: serving the predecessor as `current` would
  present a claim the corpus has superseded as current. Revisit when #350 is decided.
- **As-of follows the Surface accumulation decision** (kontourai/surface#204, pinned at
  `f8106dd4`). Knowledge time filters on a receiver-recorded `recorded_at` and never on an authored
  time; valid time is a half-open `[from, until)` interval; a `succession` takes effect at the
  successor's valid `from`, a `correction` supersedes throughout; missing or untrustworthy times
  are indeterminate, never guessed; the explicit `now` defaults both instants and is the instant
  freshness is judged at. Not modelled here: slot identity (a supersession edge is not checked to
  join one property slot), custody of the recording time (the pinned Git commit is the only
  custody), and replacement-edge authority. Surface's shapes are design vectors until Hachure
  accepts them (hachure-org/spec#34); the manifest fields are this kit's, not a portable bundle
  extension.
- **Freshness is Surface's.** Expiry resolves through `claimIntrinsicExpiry` (`expiresAt` wins;
  `ttlSeconds` anchors on verification, else recording) and a claim is stale when `now > expiry`,
  checked against Surface's own `reapplyVerifiedFreshness` at the boundary. A stale claim is
  `unverifiable`. Ephemeris is the time actor that wakes a Flow run at a deadline and derives
  nothing, so it is not consumed.
- **Abstention is a separate step.** Recall returns evidence and never an answer. The answer step
  sends only a `current` recall to an independent `@kontourai/survey` `SupportVerifier` and keeps
  each verdict as Survey's `CandidateVerification`. Only `supported` answers.
- **Budget keeps or drops whole results.** An explicit `max_tokens` bounds recall results by a
  named deterministic estimator. A drop is listed and makes the verdict `not_verified`;
  reconciliation is never skipped for a dropped recall.
- **Repository change observation is a shim.** `@kontourai/lookout` has no Git-revision source,
  so `observeRepositoryChange` lists the paths between two raw commits, refuses an empty or
  oversized change, and is to be replaced by a Lookout source when one exists.
- **Contextual status is not trust.** Recall statuses are contextual currentness, not Surface
  trust statuses; no second trust derivation is introduced (R6).
