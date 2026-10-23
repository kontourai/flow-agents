import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { canonicalJson } from "@kontourai/relay";
import { atomicWriteDurableFile } from "./lib/fs.js";
import { withSubjectLockAsync } from "./lib/assignment-local-store.js";
import { delegationIdV2, requireDelegationV2 } from "./delegation-authority-contract.js";
import {
  ROUNDS_MAX_BYTES, ROUNDS_MAX_EVENTS, delegationRoundsCapacity, projectDelegationRounds,
  type DelegationRoundsJournal, type DelegationRoundsStore,
} from "./delegation-group-rounds.js";

/** Cooperative single-host storage. Host custody must exclude hostile writers with the same uid. */
export function createLocalFileDelegationRoundsStore(artifactRoot: string): DelegationRoundsStore {
  const uid = process.getuid?.();
  const rootPath = path.resolve(artifactRoot);
  // Resolve ambient ancestors once, but never follow an alias for an owned directory.
  const root = path.join(fs.realpathSync(path.dirname(rootPath)), path.basename(rootPath));
  const directory = path.join(root, "delegation-group-rounds"), lockRoot = path.join(directory, "assignment");
  function privateDirectory(file: string): void {
    const stat = fs.lstatSync(file);
    requireDelegationV2(uid !== undefined && stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === uid
      && (stat.mode & 0o7777) === 0o700, "private_preexisting_group_root_required");
  }
  privateDirectory(root);
  for (const file of [directory, lockRoot]) {
    try { fs.mkdirSync(file, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    privateDirectory(file);
  }
  function checkDirectories(): void { [root, directory, lockRoot].forEach(privateDirectory); }
  function location(groupId: string): string {
    delegationIdV2(groupId);
    return path.join(directory, `${createHash("sha256").update(groupId).digest("hex")}.json`);
  }
  function flush(fd?: number): void {
    if (fd !== undefined) fs.fsyncSync(fd);
    for (const file of [lockRoot, directory, root, path.dirname(root)]) {
      const handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY);
      try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    }
  }
  function read(file: string): DelegationRoundsJournal | null {
    let fd: number;
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    try {
      const stat = fs.fstatSync(fd);
      requireDelegationV2(stat.isFile() && stat.uid === uid && stat.nlink === 1
        && (stat.mode & 0o7777) === 0o600 && stat.size <= ROUNDS_MAX_BYTES, "unsafe_group_file");
      // Repair a visible but unacknowledged publication before yielding even read/replay state.
      flush(fd);
      const journal: DelegationRoundsJournal = JSON.parse(fs.readFileSync(fd, "utf8"));
      projectDelegationRounds(journal);
      requireDelegationV2(location(journal.groupId) === file, "group_file_identity_mismatch");
      return journal;
    } finally { fs.closeSync(fd); }
  }
  function all(): DelegationRoundsJournal[] {
    return fs.readdirSync(directory).sort().filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => {
      const journal = read(path.join(directory, name));
      requireDelegationV2(journal, "group_file_disappeared"); return journal;
    });
  }
  async function locked<T>(body: () => Promise<T>): Promise<T> {
    checkDirectories();
    return withSubjectLockAsync(directory, "group-rounds-journal", async () => {
      checkDirectories();
      const result = await body(); flush(); return result;
    });
  }
  return {
    async transact(groupId, body) {
      const file = location(groupId);
      return locked(async () => {
        const previous = read(file);
        const next = await body(previous && structuredClone(previous));
        const projection = projectDelegationRounds(next.journal);
        requireDelegationV2(next.journal.groupId === groupId, "group_identity_mismatch");
        if (previous) requireDelegationV2(next.journal.events.length >= previous.events.length
          && canonicalJson(next.journal.events.slice(0, previous.events.length)) === canonicalJson(previous.events), "append_only_group_required");
        else {
          // A group owns one whole ancestor-authority allocation for its lifetime in this store.
          for (const existing of all()) requireDelegationV2(projectDelegationRounds(existing).spec.rootAuthorityRef.id !== projection.spec.rootAuthorityRef.id,
            "group_authority_already_bound");
        }
        const bytes = `${canonicalJson(next.journal)}\n`, escrow = delegationRoundsCapacity(next.journal);
        requireDelegationV2(next.journal.events.length + escrow.events <= ROUNDS_MAX_EVENTS
          && Buffer.byteLength(bytes) + escrow.bytes <= ROUNDS_MAX_BYTES, "group_capacity_exhausted");
        if (!previous || canonicalJson(previous) !== canonicalJson(next.journal)) atomicWriteDurableFile(root, file, bytes, true);
        read(file);
        return next.result;
      });
    },
  };
}
