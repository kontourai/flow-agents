'use strict';
// ---------------------------------------------------------------------------
// config-protection-remedies.js — the sanctioned-remedy table for
// scripts/hooks/config-protection.js.
//
// WS8 (AC15): extracted verbatim from config-protection.js so the remedy table has an
// independently testable, independently reviewable surface and the main hook file is
// smaller. Behavior-preserving: no message text or matching data changed.
//
// AC7 (config-protection): for sidecar/gate kill-switch paths the block message MUST name
// the sanctioned `npm run workflow:sidecar -- <command>` writer (or a human maintainer for
// host-owned files) and MUST NEVER advise disabling the config-protection hook.
// ---------------------------------------------------------------------------

const SHELL_PROFILE_REMEDY =
  'There is no sanctioned automated writer for shell profiles; ask a human maintainer to edit it directly. Never disable this hook to make the write.';

const SANCTIONED_REMEDIES = {
  '.claude/settings.json':
    'There is no sanctioned automated writer for this file. Ask a human maintainer to edit it directly. Never disable this hook to make the write.',
  '.claude/settings.local.json':
    'There is no sanctioned automated writer for this file. Ask a human maintainer to edit it directly. Never disable this hook to make the write.',
  '.kontourai/flow-agents/current.json':
    'Use `npm run workflow:sidecar -- ensure-session` (or `advance-state`), which writes this file for you. Never disable this hook to make the write.',
  '.kontourai/flow-agents/current/<actor>.json':
    'Use `npm run workflow:sidecar -- ensure-session` (or `advance-state`), which writes this file for you. Never disable this hook to make the write.',
  '.kontourai/flow-agents/.goal-fit-block-streak.json':
    'This file is only mutated internally by the goal-fit Stop hook; there is no sanctioned agent writer. Never disable this hook to make the write.',
  '.kontourai/flow-agents/<slug>/state.json':
    'Use `npm run workflow:sidecar -- advance-state <artifact-dir> --status <status> --phase <phase> --summary ... --next-action ...`. Never disable this hook to make the write.',
  '.kontourai/flow-agents/<slug>/trust.bundle':
    'Use `npm run workflow:sidecar -- record-gate-claim` or `seal-checkpoint`, not a direct write. Never disable this hook to make the write.',
  'delivery/trust.bundle':
    'This is written automatically by the delivery publish step (`npm run workflow:sidecar -- publish-delivery` / `advance-state --status delivered`). Never disable this hook to make the write.',
  'delivery/trust.checkpoint.json':
    'This is written automatically by the delivery publish step (`npm run workflow:sidecar -- publish-delivery` / `advance-state --status delivered`). Never disable this hook to make the write.',
};

/** Sanctioned remedy for a protected path name (from checkProtectedPathPattern). */
function remedyFor(name) {
  return SANCTIONED_REMEDIES[name] || SHELL_PROFILE_REMEDY;
}

/**
 * Ordered remedy lookup candidates for raw command-string (substring) matching.
 * Each entry names a SANCTIONED_REMEDIES key and the literal needle(s) that,
 * when found anywhere in the command text, identify that protected path.
 *
 * Needed because Pass 1 (in config-protection.js) tokenizes on whitespace and requires a
 * token to END at the protected basename. Real interpreter-write commands embed the
 * path inside a quoted string followed by punctuation (an inline interpreter
 * eval flag calling fs.writeFileSync with a quoted path argument), so no
 * token ends cleanly at the basename and Pass 1 never matches.
 *
 * Order matters: more specific paths (delivery/*) are listed before the
 * generic slug-scoped basenames they would otherwise collide with (both
 * the per-slug trust bundle and the delivery trust bundle share the
 * basename 'trust.bundle') -- first match wins, deterministically.
 */
const REMEDY_COMMAND_CANDIDATES = [
  { name: 'delivery/trust.checkpoint.json', needles: ['delivery/trust.checkpoint.json', 'trust.checkpoint.json'] },
  { name: 'delivery/trust.bundle', needles: ['delivery/trust.bundle'] },
  { name: '.kontourai/flow-agents/<slug>/trust.bundle', needles: ['trust.bundle'] },
  { name: '.kontourai/flow-agents/<slug>/state.json', needles: ['state.json'] },
  { name: '.kontourai/flow-agents/.goal-fit-block-streak.json', needles: ['.goal-fit-block-streak.json'] },
  // #291: the per-actor projection (current/<actor>.json) is checked BEFORE the legacy
  // current.json needle below — its needle is a directory-scoped substring
  // ('flow-agents/current/') that never overlaps with the bare 'current.json' basename, so
  // ordering between these two entries has no effect on real inputs, but keeping the more
  // specific per-actor entry first mirrors this table's existing "specific before generic"
  // convention.
  { name: '.kontourai/flow-agents/current/<actor>.json', needles: ['flow-agents/current/', '.flow-agents/current/'] },
  { name: '.kontourai/flow-agents/current.json', needles: ['current.json'] },
  { name: '.claude/settings.local.json', needles: ['settings.local.json'] },
  { name: '.claude/settings.json', needles: ['.claude/settings.json'] },
];

module.exports = { SHELL_PROFILE_REMEDY, SANCTIONED_REMEDIES, remedyFor, REMEDY_COMMAND_CANDIDATES };
