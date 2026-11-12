/**
 * The exclusive lock every writer of a `kontour.learning-review-proposals` ledger takes around its
 * read-modify-write: `flow-agents learn`, `learning-review-proposals.sh` and `learning-review-decide.sh` (the two
 * scripts through `scripts/telemetry/ledger-lock.mjs`). It is the dream run's epoch lock (`dream/lock.js`), at
 * `<ledger>.lock`, so the protocol and its stale-owner rules are the same.
 *
 * A held lock is waited for (short backoff) up to `timeoutMs`, then refused with `LEARN_LEDGER_LOCKED`.
 *
 * @module learn/ledger-lock
 */

import { acquireDreamLock } from "../dream/lock.js";

export const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
export const ledgerLockPath = (ledgerPath) => `${ledgerPath}.lock`;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function lockTimeoutFromEnv(env = process.env) {
  const value = env.LEARNING_REVIEW_LOCK_TIMEOUT_MS;
  return value !== undefined && /^[0-9]{1,7}$/.test(value) ? Number(value) : DEFAULT_LOCK_TIMEOUT_MS;
}

/**
 * @param {string} ledgerPath
 * @param {{ pid?: number, timeoutMs?: number }} [options]
 * @returns {(() => void) & { epoch: number, token: string }} release
 */
export function acquireLedgerLock(ledgerPath, { pid = process.pid, timeoutMs = DEFAULT_LOCK_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (let wait = 25; ; wait = Math.min(wait * 2, 500)) {
    try {
      return acquireDreamLock(ledgerLockPath(ledgerPath), { pid, lockedCode: "LEARN_LEDGER_LOCKED", holder: "another ledger writer" });
    } catch (error) {
      if (error?.code !== "LEARN_LEDGER_LOCKED" || Date.now() >= deadline) throw error;
      sleep(Math.min(wait, Math.max(1, deadline - Date.now())));
    }
  }
}
