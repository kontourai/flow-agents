import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { canonicalJson } from "@kontourai/relay";
import { withSubjectLockAsync } from "./lib/assignment-local-store.js";
import { atomicWriteFile, ensureSafeDirectory } from "./lib/fs.js";
import {
  DELEGATION_GROUP_MAX_BYTES,
  DelegationGroupError,
  validateDelegationGroupLedger,
  type DelegationGroupLedger,
} from "./delegation-group-contract.js";
import type { DelegationGroupStore } from "./delegation-group.js";

/** Single-host, cooperative-process store; the caller owns the artifact-root authority. */
export function createLocalFileDelegationGroupStore(artifactRoot: string): DelegationGroupStore {
  const root = ensureSafeDirectory(artifactRoot, artifactRoot);
  const directory = ensureSafeDirectory(root, path.join(root, "delegation-groups"));
  function location(groupId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@#-]{0,127}$/.test(groupId)) throw new DelegationGroupError("invalid_group_id");
    const hash = createHash("sha256").update(groupId).digest("hex");
    return path.join(directory, `${hash}.json`);
  }
  function read(groupId: string): DelegationGroupLedger | null {
    ensureSafeDirectory(root, directory);
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
      if (!stat.isFile() || stat.size > DELEGATION_GROUP_MAX_BYTES) throw new DelegationGroupError("unsafe_ledger_file");
      const ledger = validateDelegationGroupLedger(JSON.parse(fs.readFileSync(fd, "utf8")));
      if (path.basename(file) !== path.basename(location(ledger.group_id))) throw new DelegationGroupError("group_id_mismatch");
      return ledger;
    } finally { fs.closeSync(fd); }
  }
  return {
    async read(groupId) { return read(groupId); },
    async transact(groupId, body) {
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
          atomicWriteFile(root, file, `${canonicalJson(ledger)}\n`);
        }
        // Flush replay too: an earlier caller may have lost its acknowledgement during fsync.
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        for (const directoryToFlush of [directory, root]) {
          const parent = fs.openSync(directoryToFlush, fs.constants.O_RDONLY);
          try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
        }
        return next.result;
      });
    },
  };
}
