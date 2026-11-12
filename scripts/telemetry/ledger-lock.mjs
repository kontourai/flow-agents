#!/usr/bin/env node
// Take or release the learning-review-proposals ledger lock on behalf of a shell script, so
// learning-review-proposals.sh and learning-review-decide.sh hold the same lock `flow-agents learn` holds
// (kits/knowledge/learn/ledger-lock.js, the dream run's epoch lock at <ledger>.lock).
//
//   ledger-lock.mjs acquire <ledger-path> <owner-pid>   -> prints "<epoch> <token>"; exit 3 when held past the timeout
//   ledger-lock.mjs release <ledger-path> <epoch> <token>
//
// The owner pid is the calling script's ($$): the lock goes stale when that script exits, even if it never releases.
// LEARNING_REVIEW_LOCK_TIMEOUT_MS (default 10000) bounds the wait.
import path from "node:path";
import { releaseLockEpoch } from "../../kits/knowledge/dream/lock.js";
import { acquireLedgerLock, ledgerLockPath, lockTimeoutFromEnv } from "../../kits/knowledge/learn/ledger-lock.js";

const [command, ledger, ...rest] = process.argv.slice(2);
if (!ledger || !["acquire", "release"].includes(command)) {
  process.stderr.write("usage: ledger-lock.mjs acquire <ledger> <pid> | release <ledger> <epoch> <token>\n");
  process.exit(2);
}
const ledgerPath = path.resolve(ledger);
if (command === "acquire") {
  const pid = Number(rest[0]);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    process.stderr.write("ledger-lock: acquire needs the owner pid\n");
    process.exit(2);
  }
  try {
    const release = acquireLedgerLock(ledgerPath, { pid, timeoutMs: lockTimeoutFromEnv() });
    process.stdout.write(`${release.epoch} ${release.token}\n`);
  } catch (error) {
    process.stderr.write(`${error.code ?? "LEDGER_LOCK_FAILED"}: ${error.message}\n`);
    process.exit(error.code === "LEARN_LEDGER_LOCKED" ? 3 : 1);
  }
} else {
  releaseLockEpoch(ledgerLockPath(ledgerPath), rest[0], rest[1]);
}
