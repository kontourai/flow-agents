import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { canonicalJson } from "@kontourai/relay";
import { withSubjectLockAsync } from "./lib/assignment-local-store.js";
import { atomicWriteDurableFile } from "./lib/fs.js";
import {
  DELEGATION_GROUP_MAX_BYTES,
  DelegationGroupError,
  validateDelegationGroupLedger,
  type DelegationGroupLedger,
} from "./delegation-group-contract.js";
import type { DelegationGroupStore } from "./delegation-group.js";

/** Single-host, cooperative-process store; the caller owns the artifact-root authority. */
export function createLocalFileDelegationGroupStore(artifactRoot: string): DelegationGroupStore {
  const rootPath = path.resolve(artifactRoot);
  const uid = process.getuid?.();
  if (uid === undefined || rootPath === path.parse(rootPath).root) throw new DelegationGroupError("unsafe_store_directory");
  function privateDirectory(directory: string): string {
    // Only these explicitly owned store paths are created/repaired; never chmod ancestors or peers.
    try { fs.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid) throw new DelegationGroupError("unsafe_store_directory");
    fs.chmodSync(directory, 0o700);
    return fs.realpathSync(directory);
  }
  // The parent must already exist. Resolve ambient aliases above the dedicated root once.
  const root = privateDirectory(path.join(fs.realpathSync(path.dirname(rootPath)), path.basename(rootPath)));
  const directory = privateDirectory(path.join(root, "delegation-groups"));
  function checkDirectories(): void {
    privateDirectory(root);
    privateDirectory(directory);
  }
  function flush(fd: number): void {
    try {
      fs.fsyncSync(fd);
      for (const entry of [directory, root, path.dirname(root)]) {
        const parent = fs.openSync(entry, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
      }
    } catch { throw new DelegationGroupError("durability_unavailable"); }
  }
  function location(groupId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@#-]{0,127}$/.test(groupId)) throw new DelegationGroupError("invalid_group_id");
    const hash = createHash("sha256").update(groupId).digest("hex");
    return path.join(directory, `${hash}.json`);
  }
  function read(groupId: string): DelegationGroupLedger | null {
    checkDirectories();
    const ledger = readFile(location(groupId));
    if (ledger && ledger.group_id !== groupId) throw new DelegationGroupError("group_id_mismatch");
    return ledger;
  }
  function readFile(file: string): DelegationGroupLedger | null {
    let fd: number;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1 || stat.size > DELEGATION_GROUP_MAX_BYTES) throw new DelegationGroupError("unsafe_ledger_file");
      fs.fchmodSync(fd, 0o600);
      // Every read repairs an ambiguous prior publish before any accounting can escape.
      flush(fd);
      const ledger = validateDelegationGroupLedger(JSON.parse(fs.readFileSync(fd, "utf8")));
      if (path.basename(file) !== path.basename(location(ledger.group_id))) throw new DelegationGroupError("group_id_mismatch");
      return ledger;
    } finally { fs.closeSync(fd); }
  }
  return {
    async read(groupId) { return read(groupId); },
    async transact(groupId, body) {
      checkDirectories();
      privateDirectory(path.join(directory, "assignment"));
      const file = location(groupId);
      // One store-wide lock makes envelope ownership and group append one transaction.
      return withSubjectLockAsync(directory, "group-ledger", async () => {
        const previous = read(groupId);
        const next = await body(previous && structuredClone(previous));
        const ledger = validateDelegationGroupLedger(next.ledger);
        if (ledger.group_id !== groupId || (previous && (ledger.events.length < previous.events.length
          || JSON.stringify(ledger.events.slice(0, previous.events.length)) !== JSON.stringify(previous.events)))) {
          throw new DelegationGroupError("append_only_required");
        }
        if (!previous) {
          const spec = ledger.events[0].request.action;
          if (spec.kind !== "create") throw new DelegationGroupError("group_missing");
          const identities = new Set([spec.spec.parent_envelope.envelope_id, ...spec.spec.seats.map((s) => s.envelope.envelope_id)]);
          for (const entry of fs.readdirSync(directory)) {
            if (!/^[a-f0-9]{64}\.json$/.test(entry)) continue;
            const existing = readFile(path.join(directory, entry));
            if (!existing) throw new DelegationGroupError("ledger_disappeared");
            const creation = existing.events[0].request.action;
            if (creation.kind !== "create") throw new DelegationGroupError("group_missing");
            if ([creation.spec.parent_envelope.envelope_id, ...creation.spec.seats.map((s) => s.envelope.envelope_id)].some((id) => identities.has(id))) {
              throw new DelegationGroupError("envelope_already_group_bound");
            }
          }
        }
        if (!previous || ledger.events.length !== previous.events.length) {
          atomicWriteDurableFile(root, file, `${canonicalJson(ledger)}\n`, true);
        }
        // Flush replay too: an earlier caller may have lost its acknowledgement during fsync.
        read(groupId);
        return next.result;
      });
    },
  };
}
