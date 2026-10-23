import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { canonicalJson } from "@kontourai/relay";
import { atomicWriteDurableFile } from "./lib/fs.js";
import { withSubjectLockAsync } from "./lib/assignment-local-store.js";
import { delegationIdV2 } from "./delegation-authority-contract.js";
import { DelegationAdmissionError } from "./delegation-authority-service.js";
import {
  validateDelegationAuthorityLedgerV3, authorityCapacityV3, AUTHORITY_V3_MAX_BYTES,
  type DelegationAuthorityLedgerV3, type DelegationAuthorityStoreV3,
} from "./delegation-authority-service-v3.js";

/**
 * The existing root must be private and host-owned, outside worker-writable storage.
 * Unix uid/mode checks do not isolate hostile workers running under this same uid.
 */
export function createLocalFileDelegationAuthorityStoreV3(artifactRoot: string): DelegationAuthorityStoreV3 {
  const root = path.resolve(artifactRoot), uid = process.getuid?.();
  function directory(file: string): void {
    const stat = fs.lstatSync(file);
    if (uid === undefined || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid
      || (stat.mode & 0o077) !== 0) throw new DelegationAdmissionError("private_host_root_required");
  }
  directory(root);
  const storage = path.join(root, "delegation-authorities-v3");
  try { fs.mkdirSync(storage, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  directory(storage);
  const lockRoot = path.join(storage, "assignment");
  try { fs.mkdirSync(lockRoot, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  directory(lockRoot);
  function location(id: string): string {
    delegationIdV2(id);
    return path.join(storage, `${createHash("sha256").update(id).digest("hex")}.json`);
  }
  function flush(fd: number): void {
    fs.fsyncSync(fd);
    for (const entry of [storage, root]) {
      const handle = fs.openSync(entry, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    }
  }
  function read(file: string): DelegationAuthorityLedgerV3 | null {
    let fd: number;
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > AUTHORITY_V3_MAX_BYTES) {
        throw new DelegationAdmissionError("unsafe_authority_file");
      }
      flush(fd);
      const ledger = validateDelegationAuthorityLedgerV3(JSON.parse(fs.readFileSync(fd, "utf8")));
      if (location(ledger.epochs[0].root.authority_id) !== file) throw new DelegationAdmissionError("authority_identity_conflict");
      return ledger;
    } finally { fs.closeSync(fd); }
  }
  return {
    async transact(id, body) {
      const file = location(id);
      directory(root); directory(storage); directory(lockRoot);
      return withSubjectLockAsync(storage, "authority-ledger", async () => {
        const previous = read(file);
        const next = await body(previous && structuredClone(previous));
        const ledger = validateDelegationAuthorityLedgerV3(next.ledger);
        if (!previous) {
          const oldFile = path.join(root, "delegation-authorities", path.basename(file));
          if (fs.existsSync(oldFile)) {
            const fd = fs.openSync(oldFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
            try {
              const stat = fs.fstatSync(fd);
              if (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > AUTHORITY_V3_MAX_BYTES) throw new DelegationAdmissionError("unsafe_authority_file");
              const snapshot = JSON.parse(fs.readFileSync(fd, "utf8"));
              if (!ledger.importedFromV2 || canonicalJson(snapshot) !== canonicalJson(ledger.importedFromV2.snapshot)) throw new DelegationAdmissionError("v2_custody_transfer_required");
            } finally { fs.closeSync(fd); }
          }
        }
        if (ledger.epochs[0].root.authority_id !== id) throw new DelegationAdmissionError("authority_identity_conflict");
        if (previous) {
          const changed = canonicalJson(previous) !== canonicalJson(ledger);
          if (ledger.revision !== previous.revision + (changed ? 1 : 0)
            || ledger.epochs.length > previous.epochs.length + 1) throw new DelegationAdmissionError("authority_revision_conflict");
          if (ledger.epochs.length > previous.epochs.length && ledger.epochs.at(-1)!.renewal?.command.expectedRevision !== previous.revision) throw new DelegationAdmissionError("authority_revision_conflict");
          if (canonicalJson(ledger.importedFromV2) !== canonicalJson(previous.importedFromV2) || ledger.maxRenewals !== previous.maxRenewals || ledger.revision < previous.revision || previous.cancelled && !ledger.cancelled
            || ledger.epochs.length < previous.epochs.length) throw new DelegationAdmissionError("immutable_authority_required");
          for (let i = 0; i < previous.epochs.length; i++) {
            const old = previous.epochs[i], current = ledger.epochs[i];
            if (canonicalJson(old.root) !== canonicalJson(current.root) || canonicalJson(old.renewal) !== canonicalJson(current.renewal)
              || (ledger.epochs.length > 1 ? canonicalJson(old.envelopes) !== canonicalJson(current.envelopes)
                : canonicalJson(current.envelopes.slice(0, old.envelopes.length)) !== canonicalJson(old.envelopes))) throw new DelegationAdmissionError("immutable_epoch_required");
          }
        }
        if (previous) {
          if (canonicalJson(ledger.origins.slice(0, previous.origins.length)) !== canonicalJson(previous.origins)) throw new DelegationAdmissionError("immutable_invocation_origin_required");
          for (const old of previous.invocations) {
            const current = ledger.invocations.find((i) => i.invocationId === old.invocationId);
            if (!current || current.envelopeId !== old.envelopeId || canonicalJson(current.allocation) !== canonicalJson(old.allocation)
              || (old.terminal && !current.terminal) || (old.usage && canonicalJson(old.usage) !== canonicalJson(current.usage))) {
              throw new DelegationAdmissionError("immutable_invocation_required");
            }
          }
        }
        const identities = new Set(ledger.epochs.at(-1)!.envelopes.map((e) => e.execution_id));
        for (const entry of fs.readdirSync(storage)) {
          const otherFile = path.join(storage, entry);
          if (!/^[a-f0-9]{64}\.json$/.test(entry) || otherFile === file) continue;
          const other = read(otherFile);
          if (!other) throw new DelegationAdmissionError("authority_disappeared");
          if (other.epochs.at(-1)!.envelopes.some((e) => identities.has(e.execution_id))) throw new DelegationAdmissionError("execution_already_bound");
        }
        const bytes = `${canonicalJson(ledger)}\n`;
        // Reserve every remaining epoch, invocation/origin entry and unknown settlement.
        const settlementCapacity = authorityCapacityV3(ledger);
        if (Buffer.byteLength(bytes) + settlementCapacity > AUTHORITY_V3_MAX_BYTES) throw new DelegationAdmissionError("authority_ledger_full");
        if (!previous || canonicalJson(previous) !== canonicalJson(ledger)) atomicWriteDurableFile(root, file, bytes, true);
        read(file);
        return next.result;
      });
    },
  };
}
