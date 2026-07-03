'use strict';
/**
 * liveness-read.js — shared pure-CJS liveness freshness helper
 *
 * Zero external dependencies. Consumed by:
 *   - scripts/hooks/workflow-steering.js       (CJS, direct require)
 *   - scripts/hooks/lib/liveness-heartbeat.js  (CJS, direct require)
 *   - build/src/cli/workflow-sidecar.js        (ESM compiled, via createRequire)
 *
 * Exports:
 *   readLivenessEvents(streamPath)  → AnyObj[]  (tolerates malformed lines)
 *   readLivenessEventsTail(streamPath, tailBytes?)  → AnyObj[]  (bounded I/O; see below)
 *   freshHolders(events, slug, selfActor, nowMs)  → holder[]
 *
 * freshHolders returns, for each actor (other than selfActor) with a
 * within-TTL claim/heartbeat on subjectId === slug, an object:
 *   { actor: string, lastAt: string, ttlSeconds: number, fresh: boolean }
 * Only actors where fresh === true are returned (i.e., elapsed < ttlSeconds*1000
 * and no subsequent release event).
 *
 * Freshness rule mirrors the ADR 0012 grouping logic in workflow-sidecar.ts:
 *   - Group events by subjectId::actor.
 *   - Track the latest ttlSeconds from claim events (default 1800 s).
 *   - Track the latest event.at per group.
 *   - If the last event is a release → not fresh (regardless of elapsed).
 *   - Otherwise → fresh if (nowMs - Date.parse(lastAt)) < ttlSeconds * 1000.
 */

const fs = require('fs');

/** Default bounded-tail read size, in bytes (F3, #288 fix iteration 1). */
const DEFAULT_TAIL_BYTES = 64 * 1024;

/**
 * Parse a raw newline-delimited JSONL blob into an array of parsed event objects.
 * Tolerates blank lines and malformed lines (silently skips both). Shared by
 * readLivenessEvents (full read) and readLivenessEventsTail (bounded read) so both
 * paths parse identically.
 *
 * @param {string} raw
 * @returns {object[]}
 */
function parseEventLines(raw) {
  const out = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

/**
 * Read a liveness JSONL stream from the given path.
 * Tolerates missing file (returns []) and malformed lines (silently skips).
 *
 * @param {string} streamPath  Absolute path to events.jsonl
 * @returns {object[]}
 */
function readLivenessEvents(streamPath) {
  let raw = '';
  try {
    raw = fs.readFileSync(streamPath, 'utf8');
  } catch {
    return [];
  }
  return parseEventLines(raw);
}

/**
 * Read only the last `tailBytes` (default 64KB) of a liveness JSONL stream, newline-aligned
 * so a partial line at the truncation boundary is dropped rather than mis-parsed, instead of
 * reading the whole file (F3, #288 fix iteration 1, sec-MED + cr-MED: `maybeEmitHeartbeat` in
 * liveness-heartbeat.js previously full-read `events.jsonl` on every tool call — 374ms measured
 * at an 80MB stream — a cost paid on the hot `postToolUse` path). Bounded I/O regardless of
 * total stream size: at most `tailBytes` bytes are ever read off disk.
 *
 * Because the stream is append-only, the tail of the file is always its most recent portion —
 * so if a given `(subjectId, actor)` pair's most recent event lies within the tail window, this
 * function returns it correctly every time; only an event pair whose *every* occurrence lies
 * entirely before the tail window is invisible here (the caller's job, not this function's, is
 * to fall back to `readLivenessEvents` in that rare case — see liveness-heartbeat.js).
 *
 * Tolerates a missing file (returns []) exactly like readLivenessEvents.
 *
 * @param {string} streamPath
 * @param {number} [tailBytes]  Defaults to 64KB (DEFAULT_TAIL_BYTES).
 * @returns {object[]}
 */
function readLivenessEventsTail(streamPath, tailBytes = DEFAULT_TAIL_BYTES) {
  let fd;
  try {
    const size = fs.statSync(streamPath).size;
    if (size <= 0) return [];
    const start = size > tailBytes ? size - tailBytes : 0;
    const length = size - start;
    const buffer = Buffer.alloc(length);
    fd = fs.openSync(streamPath, 'r');
    // F9 (#288 fix iteration 2, LOW): a single fs.readSync() call is not guaranteed to fill the
    // whole requested length in one shot (short reads are a documented POSIX possibility, and can
    // also occur here if the file is truncated/rotated between the statSync() above and this read).
    // Loop until either the full requested `length` has been read or EOF is hit (bytesRead === 0).
    let bytesReadTotal = 0;
    while (bytesReadTotal < length) {
      const bytesRead = fs.readSync(fd, buffer, bytesReadTotal, length - bytesReadTotal, start + bytesReadTotal);
      if (bytesRead <= 0) break; // EOF before the requested tail length was fully read
      bytesReadTotal += bytesRead;
    }
    if (bytesReadTotal < length) {
      // Short read: decoding a partially-filled buffer risks silently dropping or mis-parsing the
      // last (possibly truncated) record. Never decode zero/partial bytes here — degrade to a full
      // readFileSync of the same path instead, which re-reads the file from scratch and is immune
      // to this race entirely.
      try {
        fs.closeSync(fd);
      } catch {
        /* best-effort close only */
      }
      fd = undefined;
      return readLivenessEvents(streamPath);
    }
    let raw = buffer.toString('utf8');
    if (start > 0) {
      // Newline-aligned: the read may begin mid-line (the byte at `start` is not
      // necessarily the start of a JSON record) — drop the possibly-truncated partial
      // first line rather than risk mis-parsing (or worse, silently accepting) a
      // corrupted fragment.
      const newlineIndex = raw.indexOf('\n');
      raw = newlineIndex === -1 ? '' : raw.slice(newlineIndex + 1);
    }
    return parseEventLines(raw);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* best-effort close only */
      }
    }
  }
}

/**
 * Compute fresh liveness holders for a given slug.
 *
 * @param {object[]} events      Array of parsed liveness event objects
 * @param {string}   slug        Work-item subjectId to filter on
 * @param {string}   selfActor   Actor to exclude (current agent's identity)
 * @param {number}   nowMs       Current epoch ms (Date.now())
 * @returns {{ actor: string, lastAt: string, ttlSeconds: number, fresh: boolean }[]}
 */
function freshHolders(events, slug, selfActor, nowMs) {
  // Group by actor for the given slug
  /** @type {Map<string, { actor: string, ttlSeconds: number, lastAt: string, released: boolean }>} */
  const groups = new Map();

  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    if (e.subjectId !== slug) continue;
    if (!e.actor || !e.at) continue;

    const actor = String(e.actor);
    if (actor === selfActor) continue;

    let g = groups.get(actor);
    if (!g) {
      g = { actor, ttlSeconds: 1800, lastAt: String(e.at), released: false };
      groups.set(actor, g);
    }

    // Update lastAt to the latest event timestamp
    if (e.at > g.lastAt) g.lastAt = String(e.at);

    // Track TTL from claim events
    if (e.type === 'claim' && typeof e.ttlSeconds === 'number' && e.ttlSeconds > 0) {
      g.ttlSeconds = e.ttlSeconds;
    }

    // Track release — if a release event exists after all others, mark released
    if (e.type === 'release') {
      g.released = true;
    } else if (e.type === 'claim' || e.type === 'heartbeat') {
      // A new claim or heartbeat after a release re-activates
      g.released = false;
    }
  }

  const result = [];
  for (const g of groups.values()) {
    if (g.released) continue;
    const elapsed = nowMs - Date.parse(g.lastAt);
    const fresh = elapsed < g.ttlSeconds * 1000;
    if (fresh) {
      result.push({ actor: g.actor, lastAt: g.lastAt, ttlSeconds: g.ttlSeconds, fresh: true });
    }
  }
  return result;
}

module.exports = { readLivenessEvents, readLivenessEventsTail, freshHolders };
