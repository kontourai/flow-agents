import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { canonicalJson } from "@kontourai/relay";
import { atomicWriteDurableFile } from "./lib/fs.js";
import { withSubjectLockAsync } from "./lib/assignment-local-store.js";
import { delegationIdV2 } from "./delegation-authority-contract.js";
import {
  DelegationAdmissionError, validateDelegationAuthorityLedger,
  type DelegationAuthorityLedger, type DelegationAuthorityStore,
} from "./delegation-authority-service.js";

/**
 * The existing root must be private and host-owned, outside worker-writable storage.
 * Unix uid/mode checks do not isolate hostile workers running under this same uid.
 */
export function createLocalFileDelegationAuthorityStore(artifactRoot: string): DelegationAuthorityStore {
  const root = path.resolve(artifactRoot), uid = process.getuid?.();
  function directory(file: string): void {
    const stat = fs.lstatSync(file);
    if (uid === undefined || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid
      || (stat.mode & 0o077) !== 0) throw new DelegationAdmissionError("private_host_root_required");
  }
  directory(root);
  const storage = path.join(root, "delegation-authorities");
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
  function read(file: string): DelegationAuthorityLedger | null {
    let fd: number;
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > 16 * 1024 * 1024) {
        throw new DelegationAdmissionError("unsafe_authority_file");
      }
      flush(fd);
      const ledger = validateDelegationAuthorityLedger(JSON.parse(fs.readFileSync(fd, "utf8")));
      if (location(ledger.root.authority_id) !== file) throw new DelegationAdmissionError("authority_identity_conflict");
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
        const ledger = validateDelegationAuthorityLedger(next.ledger);
        if (ledger.root.authority_id !== id || (previous && (
          canonicalJson(previous.root) !== canonicalJson(ledger.root) || (previous.cancelled && !ledger.cancelled)
          || ledger.envelopes.length < previous.envelopes.length
          || canonicalJson(ledger.envelopes.slice(0, previous.envelopes.length)) !== canonicalJson(previous.envelopes)
        ))) throw new DelegationAdmissionError("immutable_authority_required");
        const identities = new Set(ledger.envelopes.map((e) => e.execution_id));
        for (const entry of fs.readdirSync(storage)) {
          const otherFile = path.join(storage, entry);
          if (!/^[a-f0-9]{64}\.json$/.test(entry) || otherFile === file) continue;
          const other = read(otherFile);
          if (!other) throw new DelegationAdmissionError("authority_disappeared");
          if (other.envelopes.some((e) => identities.has(e.execution_id))) throw new DelegationAdmissionError("execution_already_bound");
        }
        const bytes = `${canonicalJson(ledger)}\n`;
        if (Buffer.byteLength(bytes) > 16 * 1024 * 1024) throw new DelegationAdmissionError("authority_ledger_full");
        if (!previous || canonicalJson(previous) !== canonicalJson(ledger)) atomicWriteDurableFile(root, file, bytes, true);
        read(file);
        return next.result;
      });
    },
  };
}
