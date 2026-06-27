#!/usr/bin/env node
'use strict';
/**
 * repair-command-log.js — deterministic re-linearization of a concurrent-fork
 * command-log.jsonl.
 *
 * A "fork" happens when two PostToolUse captures append off the same parent tip
 * (parallel writers before the writer lock, flow-agents#232). The records are
 * all genuine and self-consistent; only their linear order is ambiguous. This
 * tool produces THE canonical order — sort chained entries by (capturedAt, then
 * hash) — and re-chains them, so any party re-running it gets the identical
 * result. It is therefore a verifiable repair, not a judgement call.
 *
 * SAFETY: it refuses to run unless verifyCommandLogChain() reports "forked".
 *   - "broken" (real tamper: edited content, reorder, deletion) → REFUSE. The
 *     repair must never be usable to launder tampering.
 *   - "ok" / "legacy" → nothing to do.
 * No record content is altered — only the _chain wrappers and line order. The
 * original is backed up, and an in-chain `chain-repair` marker records that the
 * re-linearization happened (so the repair is itself auditable).
 *
 * Usage: node scripts/repair-command-log.js <artifact-dir> [--reason "..."]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const gate = require(path.join(__dirname, 'hooks', 'stop-goal-fit.js'));
const GENESIS = gate.CHAIN_GENESIS_VERIFY;

function canon(rec) {
  const keys = Object.keys(rec).filter((k) => k !== '_chain').sort();
  const obj = {};
  for (const k of keys) obj[k] = rec[k];
  return JSON.stringify(obj);
}
function hashLink(prev, rec) {
  return crypto.createHash('sha256').update(prev + canon(rec), 'utf8').digest('hex');
}

function main() {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: repair-command-log.js <artifact-dir> [--reason "..."]'); process.exit(2); }
  const reasonIdx = process.argv.indexOf('--reason');
  const reason = reasonIdx !== -1 ? (process.argv[reasonIdx + 1] || '') : 'deterministic concurrent-fork re-linearization';

  const verdict = gate.verifyCommandLogChain(dir);
  if (verdict.status === 'ok' || verdict.status === 'legacy') {
    console.log(`nothing to repair: chain status is "${verdict.status}"`);
    return;
  }
  if (verdict.status !== 'forked') {
    console.error(`REFUSING to repair: chain status is "${verdict.status}" (entry ${verdict.brokenAt}). ` +
      'This tool only re-linearizes benign concurrent forks; it will not touch a tampered chain.');
    process.exit(1);
  }

  const file = path.join(dir, 'command-log.jsonl');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());

  // Preserve legacy prefix verbatim; collect the chained records (content only).
  const legacyPrefix = [];
  const records = [];
  let started = false;
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { if (!started) { legacyPrefix.push(line); } continue; }
    const isChained = e._chain && typeof e._chain.hash === 'string';
    if (!started && !isChained) { legacyPrefix.push(line); continue; }
    started = true;
    const rec = { ...e };
    delete rec._chain;
    records.push(rec);
  }

  // Canonical deterministic order: capturedAt asc, then a stable content hash.
  records.sort((a, b) => {
    const ta = String(a.capturedAt || ''), tb = String(b.capturedAt || '');
    if (ta !== tb) return ta < tb ? -1 : 1;
    const ha = crypto.createHash('sha256').update(canon(a)).digest('hex');
    const hb = crypto.createHash('sha256').update(canon(b)).digest('hex');
    return ha < hb ? -1 : ha > hb ? 1 : 0;
  });

  // Re-chain from genesis.
  const out = [...legacyPrefix];
  let prev = GENESIS;
  let seq = 0;
  for (const rec of records) {
    const h = hashLink(prev, rec);
    out.push(JSON.stringify({ ...rec, _chain: { seq, prevHash: prev, hash: h } }));
    prev = h; seq += 1;
  }
  // Append an in-chain repair marker so the re-linearization is itself auditable.
  const marker = {
    command: '(chain-repair marker)',
    observedResult: `re-linearized ${records.length} entries from concurrent fork`,
    exitCode: 0,
    capturedAt: new Date().toISOString(),
    source: 'chain-repair',
    repair: { reason, entries: records.length, forkAt: verdict.forkAt },
  };
  const mh = hashLink(prev, marker);
  out.push(JSON.stringify({ ...marker, _chain: { seq, prevHash: prev, hash: mh } }));

  fs.copyFileSync(file, file + '.prebackup-repair');
  fs.writeFileSync(file, out.join('\n') + '\n');

  const after = gate.verifyCommandLogChain(dir);
  console.log(`repaired: re-linearized ${records.length} entries (legacy prefix: ${legacyPrefix.length}); ` +
    `chain status now "${after.status}". backup: command-log.jsonl.prebackup-repair`);
  if (after.status !== 'ok') { console.error('repair did not produce a clean chain'); process.exit(1); }
}

main();
