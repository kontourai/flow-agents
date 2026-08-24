/**
 * Output-token attribution — ONE encoding, shared by the producer and the fold.
 *
 * `scripts/telemetry/gate-scorecard.mjs` has attributed output tokens to transitions at
 * fold time since #1274. `scripts/telemetry/enrich-transitions.mjs` now writes that same
 * attribution onto the records themselves, so a consumer that never sees the host
 * transcript (Console — console#279) can read a per-gate figure instead of reporting
 * `cost_availability: "activity_only"` forever.
 *
 * The rule lives HERE, imported by both, because this repo keeps re-learning what happens
 * when two components independently encode one contract (#1300, #1302, #1307, #1312). A
 * second encoding of "which turn paid for this transition" would drift within a release
 * and the two numbers would disagree with nothing to say which was right.
 *
 * WHAT THE NUMBER IS, AND IS NOT
 *
 * It is OUTPUT TOKENS ONLY. Priced against this repo's own pricing table over a
 * 164-transcript corpus, output tokens are 6.6% of spend; cache READ is 80%. It is also
 * not proportional to spend — a transition late in a long session pays enormous cache-read
 * for a terse output and would rank as cheap. So it is a FLOOR, it is never currency, and
 * `ATTRIBUTION_GRANULARITY` travels with it on every record that carries it so no consumer
 * has to go looking for the caveat.
 *
 * It under-attributes by construction in a second way: a turn is consumed by AT MOST ONE
 * transition. One turn routinely invokes several CLI calls; if each claimed the turn the
 * total would inflate, and letting a later transition reach further back would charge it
 * for earlier work. So the later transitions are recorded as UNATTRIBUTABLE, positively —
 * never as an attributed zero. That distinction is the whole point of the field: absent
 * cost and zero cost are different claims, and Console's own review caught the conflation
 * on the consumer side before it shipped. Recreating it on the producer side would be
 * worse, because a fabricated zero on the wire cannot be un-fabricated downstream.
 *
 * WHY THIS IS A POST-HOC ENRICHER AND NOT THE EMITTER
 *
 * `src/transition-log.ts` exists precisely because it is provider-independent and
 * wrapper-immune: it records what the CLI did without reading anything the host owns.
 * Attribution is the opposite — it reads a transcript whose format Claude Code documents
 * as internal and changing between releases. Three concrete reasons the emitter must not
 * do it:
 *
 *   1. The rule is a GLOBAL assignment, not a per-record fact. "At most one transition per
 *      turn" can only be decided against the whole set of transitions competing for that
 *      turn. A process exiting knows its own invocation and nothing else.
 *   2. The write is best-effort and must never change the outcome of the command it
 *      describes. Parsing a multi-megabyte transcript on every CLI exit trades that
 *      guarantee for a number that is available a second later anyway.
 *   3. It would couple a provider-independent record to one host's private file format.
 *      The record would then be emitted only where that host runs — reintroducing the
 *      blindness the module was built to remove.
 *
 * So the emitter never guesses, and the enricher stamps what it can prove.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** How far before a transition its invoking turn may sit before the link is a guess. */
export const TURN_GRACE_MS = 10 * 60_000;

/**
 * The label that must travel with the number. Mirrors console's
 * `EconomicsDelegationCostGranularity = "model-proxy"` precedent: name the granularity
 * rather than implying precision. Console's fold declares the identical string in
 * `GateCostAttribution.granularity`.
 */
export const ATTRIBUTION_GRANULARITY = "output-tokens-only";

/** The wire field Console's `applyTransition()` folds. Present IFF a turn was won. */
export const OUTPUT_TOKENS_FIELD = "output_tokens";

/**
 * The self-describing block beside it. Console does not read this (its wire contract
 * predates it and its validator accepts unknown fields), but its absence and its
 * `attributed: false` case are two different facts, and only this block can tell them
 * apart: a record with no block was never examined, a record with `attributed: false` was
 * examined and had no turn to charge. Deriving "without turn" from a missing
 * `output_tokens` alone silently reports an un-enriched log as a fully-measured one whose
 * every gate happened to be free.
 */
export const TOKEN_ATTRIBUTION_FIELD = "token_attribution";

/** Why a transition carries no tokens. Emitted, never inferred by the reader. */
export const UNATTRIBUTED_REASONS = Object.freeze({
  NO_TURN: "no-turn-before-transition",
  OUTSIDE_GRACE: "turn-outside-grace-window",
  CONSUMED: "turn-consumed-by-earlier-transition",
  SIMULTANEOUS: "turn-claimed-by-simultaneous-transition",
  UNPARSEABLE_START: "unparseable-started-at",
});

export function readJsonl(file) {
  const records = [];
  let unparseable = 0;
  if (!fs.existsSync(file)) return { records, unparseable, missing: true };
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // A truncated final line is normal for a log being appended to live — but the count
      // is reported, because "dropped silently" is the defect these tools exist to find
      // and it should not be committed at the parse layer.
      unparseable += 1;
    }
  }
  return { records, unparseable, missing: false };
}

/**
 * A stable, path-free handle for the turn a record was charged to.
 *
 * Deliberately NOT the internal turn id: that is `<absolute transcript path>::<message
 * id>`, and an absolute path is machine-private — it names a developer's home directory
 * and, in a worktree, an unpublished branch. Hashing the session-scoped form instead keeps
 * the handle reproducible from a different checkout (which is what makes re-running the
 * enricher safe) without putting a filesystem layout on the wire.
 */
export function turnRef(session, messageId) {
  return `sha256:${crypto.createHash("sha256").update(`${session ?? ""}::${messageId ?? ""}`).digest("hex").slice(0, 32)}`;
}

/**
 * Every usage-bearing turn in the given transcripts, de-duplicated and ordered.
 *
 * Two de-duplications, both load-bearing:
 *   - one API response is logged as SEVERAL lines sharing a `message.id` and carrying
 *     IDENTICAL usage totals (one line per content block), so counting lines multiplies
 *     the tokens by however many blocks that turn happened to emit;
 *   - the key includes the FILE, because `/branch` and `--fork-session` copy a transcript
 *     and first-seen-wins would otherwise attribute one response to whichever session was
 *     read first.
 *
 * Subagent turns are logged with the PARENT's session id, so a session filter does not
 * exclude them, and "the nearest preceding turn" picks a subagent's turn instead of the
 * orchestrator's between 8% and 42% of the time on delegation-heavy sessions. Sidechain
 * turns are excluded here and COUNTED, so a reader can see which regime they are in.
 */
export function loadTurns(transcriptFiles) {
  const turns = [];
  for (const file of transcriptFiles) {
    const fallbackSession = path.basename(file).replace(/\.jsonl$/, "");
    for (const record of readJsonl(file).records) {
      const usage = record?.message?.usage;
      const at = Date.parse(record?.timestamp ?? "");
      if (!usage || Number.isNaN(at)) continue;
      const messageId = record?.message?.id ?? at;
      const session = record?.sessionId ?? record?.session_id ?? fallbackSession;
      turns.push({
        id: `${file}::${messageId}`,
        ref: turnRef(session, messageId),
        at,
        output: Number(usage.output_tokens) || 0,
        session,
        sidechain: record?.isSidechain === true,
      });
    }
  }
  const deduped = new Map();
  for (const turn of turns) if (!deduped.has(turn.id)) deduped.set(turn.id, turn);
  const all = [...deduped.values()].sort((a, b) => a.at - b.at);
  return {
    ordered: all.filter((turn) => !turn.sidechain),
    sidechainTurns: all.filter((turn) => turn.sidechain).length,
  };
}

/**
 * Attribute per-turn OUTPUT TOKENS from a host transcript to transitions.
 *
 * A turn's timestamp is when the model EMITTED the tool call, which precedes the command
 * running — verified live: a transition at 00:45:32 was invoked by a turn stamped
 * 00:45:21. Searching forward from the transition therefore matches nothing, or worse
 * matches the NEXT turn. The invoking turn is the most recent one at or before it.
 *
 * Sibling sessions write their transcripts into the same directory, so matching on time
 * alone imports another run's spend. When the transition names its session, only that
 * session's turns may pay for it.
 *
 * `preConsumedTurnRefs` lets a second enrichment pass honour the first: a turn already
 * charged to a record on disk must not be charged again to a different one. Without it,
 * "at most one transition per turn" would hold within a run and fail across runs.
 */
export function attributeTokens(transitions, transcriptFiles, options = {}) {
  const { ordered, sidechainTurns } = loadTurns(transcriptFiles);
  const preConsumed = options.preConsumedTurnRefs ?? new Set();

  const attributed = new Map();
  const reasons = new Map();
  const ambiguousTurnClaims = [];
  const consumed = new Map();
  let matchedTurns = 0;

  const chronological = [...transitions].sort(
    (a, b) => (Date.parse(a.started_at ?? "") || 0) - (Date.parse(b.started_at ?? "") || 0),
  );
  for (const transition of chronological) {
    const start = Date.parse(transition.started_at ?? "");
    if (Number.isNaN(start)) {
      reasons.set(transition, { reason: UNATTRIBUTED_REASONS.UNPARSEABLE_START });
      continue;
    }
    const session = transition?.actor?.session_id ?? null;
    let candidate = null;
    for (const turn of ordered) {
      if (turn.at > start) break;
      if (session && turn.session && turn.session !== session) continue;
      candidate = turn;
    }
    if (!candidate) {
      reasons.set(transition, { reason: UNATTRIBUTED_REASONS.NO_TURN });
      continue;
    }
    if (start - candidate.at > TURN_GRACE_MS) {
      reasons.set(transition, { reason: UNATTRIBUTED_REASONS.OUTSIDE_GRACE, turn_ref: candidate.ref });
      continue;
    }
    if (preConsumed.has(candidate.ref)) {
      reasons.set(transition, { reason: UNATTRIBUTED_REASONS.CONSUMED, turn_ref: candidate.ref });
      continue;
    }
    const holder = consumed.get(candidate.id);
    if (holder) {
      // "Earlier" is only true when it IS earlier. Two transitions stamped at the same
      // millisecond are ordered by the sort's stability, i.e. by the order the lines
      // happen to sit in the file — which is not a property of the data. The award is
      // preserved (changing it would change every figure the fold already publishes) but
      // it is reported as order-dependent rather than presented as a derivation.
      const simultaneous = Date.parse(holder.started_at ?? "") === start;
      reasons.set(transition, {
        reason: simultaneous ? UNATTRIBUTED_REASONS.SIMULTANEOUS : UNATTRIBUTED_REASONS.CONSUMED,
        turn_ref: candidate.ref,
        ...(simultaneous ? { ambiguous: true } : {}),
      });
      if (simultaneous) {
        const claim = ambiguousTurnClaims.find((entry) => entry.turn_ref === candidate.ref);
        if (claim) claim.transitions += 1;
        else {
          ambiguousTurnClaims.push({
            turn_ref: candidate.ref,
            started_at: transition.started_at,
            transitions: 2,
            awarded_to: `${holder.command ?? "?"} ${holder.verb ?? ""}`.trim(),
            note: "two or more transitions share this instant; which one is charged depends on line order, not on the data",
          });
        }
        const winner = attributed.get(holder);
        if (winner) winner.ambiguous = true;
      }
      continue;
    }
    // The TURN object itself, not a copy: callers read `.output` and `.id` off it, and a
    // reshape here would be a silent contract change for the fold that already ships.
    consumed.set(candidate.id, transition);
    attributed.set(transition, candidate);
    matchedTurns += 1;
  }
  return {
    source: "transcript",
    attributed,
    reasons,
    ambiguousTurnClaims,
    matchedTurns,
    availableTurns: ordered.length,
    sidechainTurnsExcluded: sidechainTurns,
    transitionsWithoutTurn: transitions.length - matchedTurns,
  };
}

/**
 * Write one attribution onto one record, in place.
 *
 * The single writer of both fields, so they cannot disagree: `output_tokens` is present
 * IFF `token_attribution.attributed` is true, and an unattributable transition gets NO
 * `output_tokens` key at all rather than a zero. A test pins that biconditional over the
 * whole corpus in both directions, because a coupling that holds by convention is a
 * coupling that eventually does not.
 */
export function stampAttribution(record, outcome, meta = {}) {
  const block = { granularity: ATTRIBUTION_GRANULARITY, attributed: outcome.attributed === true };
  if (outcome.attributed) {
    record[OUTPUT_TOKENS_FIELD] = outcome.output;
    if (outcome.turn_ref) block.turn_ref = outcome.turn_ref;
  } else {
    delete record[OUTPUT_TOKENS_FIELD];
    block.reason = outcome.reason;
    if (outcome.turn_ref) block.turn_ref = outcome.turn_ref;
  }
  if (outcome.ambiguous) block.ambiguous = true;
  if (meta.source) block.source = meta.source;
  record[TOKEN_ATTRIBUTION_FIELD] = block;
  return record;
}

/**
 * Read attribution back off records that already carry it, in the same shape
 * `attributeTokens` returns — so the fold consumes one contract whether the numbers came
 * from a transcript it read or from a producer that read one for it.
 *
 * Three populations, kept apart on purpose:
 *   - attributed: the block says so and carries a usable integer;
 *   - without turn: the block says `attributed: false`. A real, measured absence;
 *   - NOT ENRICHED: no block at all. This is not "no turn" — nothing ever looked. Folding
 *     it into `transitionsWithoutTurn` would make an un-enriched log read as a measured
 *     one, which is the failure the whole `activity_only` state exists to prevent.
 *
 * Returns null when NOTHING carries a block: a scorecard of token zeroes over a log that
 * was never enriched is exactly the tidy-zeroes result these tools refuse to render.
 */
export function attributionFromRecords(transitions) {
  const attributed = new Map();
  const reasons = new Map();
  let matchedTurns = 0;
  let withoutTurn = 0;
  let notEnriched = 0;
  let malformed = 0;
  let ambiguous = 0;

  for (const record of transitions) {
    const block = record?.[TOKEN_ATTRIBUTION_FIELD];
    if (!block || typeof block !== "object") {
      notEnriched += 1;
      continue;
    }
    if (block.ambiguous === true) ambiguous += 1;
    if (block.attributed === true) {
      const output = record?.[OUTPUT_TOKENS_FIELD];
      // A claim of attribution with no usable number is a producer bug. Absorbing it as
      // "no turn" would convert that bug into permanently understated cost that looks
      // like an honest floor; it is counted as its own thing instead.
      if (typeof output !== "number" || !Number.isInteger(output) || output < 0) {
        malformed += 1;
        continue;
      }
      attributed.set(record, { output, turn_ref: block.turn_ref ?? null });
      matchedTurns += 1;
      continue;
    }
    reasons.set(record, { reason: block.reason ?? null, turn_ref: block.turn_ref });
    withoutTurn += 1;
  }

  if (notEnriched === transitions.length) return null;
  return {
    source: "record",
    attributed,
    reasons,
    ambiguousTurnClaims: [],
    ambiguousAttributions: ambiguous,
    matchedTurns,
    availableTurns: null,
    sidechainTurnsExcluded: null,
    transitionsWithoutTurn: withoutTurn,
    transitionsNotEnriched: notEnriched,
    malformedAttributions: malformed,
  };
}
