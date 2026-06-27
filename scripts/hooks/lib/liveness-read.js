'use strict';
/**
 * liveness-read.js — shared pure-CJS liveness freshness helper
 *
 * Zero external dependencies. Consumed by:
 *   - scripts/hooks/workflow-steering.js  (CJS, direct require)
 *   - build/src/cli/workflow-sidecar.js   (ESM compiled, via createRequire)
 *
 * Exports:
 *   readLivenessEvents(streamPath)  → AnyObj[]  (tolerates malformed lines)
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

module.exports = { readLivenessEvents, freshHolders };
